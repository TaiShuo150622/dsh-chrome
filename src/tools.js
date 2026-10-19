/**
 * Model-facing chrome_* tools (P1: 12 tools).
 *
 * Reads (status/snapshot/screenshot/tabs list/wait) run without approval.
 * Mutating actions (goto/click/type/press/history/tabs new|close/close_session)
 * go through ctx.approval, which follows the DSH session policy ("follow-dsh":
 * under danger-full-access / never it is allowed without a prompt).
 */
import fsp from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'

import { BridgeError } from './bridge.js'
import { appendAudit, dshHome, loadPolicy, originOf, resolvePolicy } from './policy.js'
import { createLeaseTool } from './tools-lease.js'
import { createNavigationTools } from './tools-navigation.js'
import { createCaptureTools } from './tools-capture.js'
import { createReadTools } from './tools-read.js'
import { createInputTools } from './tools-input.js'
import { createStatusTools } from './tools-status.js'
import { createScreencastTools } from './tools-screencast.js'
import { createMediaTools } from './tools-media.js'
import { createMiscTools } from './tools-misc.js'
import { createContextTool } from './tools-context.js'
import { createVerifyTool } from './tools-verify.js'
import { createLoginTool } from './tools-login.js'

const MUTATION_TIMEOUT_MS = 45000

// Page-text budget for chrome_snapshot. The snapshot exists for structure and
// refs, not for dumping a whole page: measured on a page with ~100KB of visible
// text (内部性能记录 §6), the old 100000-char default put 102.7KB on the
// wire per call (≈26k tokens) and cost 3.41ms in the driver; 20000 chars is
// 20.8KB / 1.32ms, and on a ~1MB-text page 5.86 -> 4.78ms. Two escapes cover
// callers that need the rest: maxChars (up to 200000) and chrome_get_text.
const SNAPSHOT_TEXT_DEFAULT_CHARS = 20000

function outputSchema(properties) {
  return { type: 'object', properties, additionalProperties: true }
}

function renderText(text) {
  return [{ type: 'text', text }]
}

// chrome_tabs {op:"new"} may open about:blank or an http(s) URL. Everything
// else (file:, data:, javascript:, chrome:) is refused here as well as in the
// backend, so a headless tab can never be a local-file read primitive (R-05).
function validateTabUrl(raw) {
  const text = String(raw ?? '')
  if (!text || text === 'about:blank') return 'about:blank'
  return validateHttpUrl(text)
}

function validateHttpUrl(raw) {
  let url
  try {
    url = new URL(String(raw))
  } catch {
    throw new BridgeError('NAV_FAILED', `not a valid URL: ${String(raw)}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new BridgeError('PROTECTED_PAGE', `only http(s) URLs are allowed, got ${url.protocol}`)
  }
  if (url.username || url.password) {
    throw new BridgeError('PROTECTED_PAGE', 'URLs with embedded credentials are not allowed')
  }
  return url.toString()
}

// Headless driver errors are plain Error objects carrying a machine-readable
// `code` (src/headless.js). Keep that code: collapsing every non-BridgeError into
// INTERNAL hides REF_NOT_FOUND / TAB_NOT_FOUND / TIMEOUT / CAPTURE_LOST from the
// model, which needs them to choose the next step. Desktop extension replies
// already arrive as BridgeError instances, so desktop behavior is unchanged.
// Node system errors (fs/net) carry syscall/errno and are not contract codes;
// they keep the historical INTERNAL code.
function normalize(error) {
  if (error instanceof BridgeError) return error
  const code =
    typeof error?.code === 'string' &&
    /^[A-Z][A-Z0-9_]{1,63}$/.test(error.code) &&
    !error?.syscall &&
    typeof error?.errno !== 'number'
      ? error.code
      : 'INTERNAL'
  const wrapped = new BridgeError(code, error?.message || String(error))
  wrapped.cause = error
  return wrapped
}

// LeaseError (src/lease.js) carries the same kind of stable machine code as a
// BridgeError. Translate it here so tool callers see LEASE_HELD /
// LEASE_EXPIRED / USER_TAKEOVER_REQUIRED instead of a generic INTERNAL.
function normalizeLeaseError(error) {
  if (error instanceof BridgeError) return error
  if (typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(error.code)) {
    const wrapped = new BridgeError(error.code, error?.message || String(error))
    if (error.details != null) wrapped.details = error.details
    return wrapped
  }
  return new BridgeError('INTERNAL', error?.message || String(error))
}

export function chromeTools({ bridge, attachments, assets, approval, sessionContext, userQuestions, config, contexts, leases = null, contextViewer = null, update = null, artifactStore = null }) {
  const list = []
  const ownerOf = (exec) => exec?.agent?.id ?? 'default'
  const pluginConfig = config?.() && typeof config() === 'object' ? config() : {}
  const allowEvaluate = pluginConfig.allowEvaluate === true
  const evaluateConfirmTimeoutMs = Number.isFinite(pluginConfig.evaluateConfirmTimeoutMs)
    ? Math.max(1000, Math.min(600000, Number(pluginConfig.evaluateConfirmTimeoutMs)))
    : 120000
  const captureConfirmTimeoutMs = Number.isFinite(pluginConfig.captureConfirmTimeoutMs)
    ? Math.max(1000, Math.min(600000, Number(pluginConfig.captureConfirmTimeoutMs)))
    : 120000
  // Capture start is always hard-confirmed; there is no config escape hatch.

  const sessionLabel = (exec) => {
    try {
      const services = sessionContext?.()
      const session = services?.sessions?.get?.(exec?.agent?.id)
      const cwd = session?.header?.cwd ?? session?.cwd ?? session?.meta?.cwd
      if (typeof cwd === 'string' && cwd.trim()) return path.basename(cwd)
    } catch {
      // fall through to short id in the extension
    }
    return null
  }

  async function call(method, params, timeoutMs = MUTATION_TIMEOUT_MS) {
    try {
      return await bridge.call(method, params, timeoutMs)
    } catch (error) {
      throw normalize(error)
    }
  }

  // Backend capability contract (src/capabilities.js). The provider passes a
  // BackendRouter as `bridge`, so supports() answers for the backend carried by
  // AsyncLocalStorage. Test doubles and any older bridge without supports() keep
  // the historical behavior: assume the capability is available.
  function supports(capability) {
    if (typeof bridge?.supports === 'function') return Boolean(bridge.supports(capability))
    return true
  }

  function sessionSandboxMode(exec) {
    const services = sessionContext?.()
    const session = services?.sessions?.get?.(exec?.agent?.id)
    const policy = services?.sandboxPolicy
    if (!session || !policy) return null
    try {
      return policy.resolve({ session })?.mode ?? null
    } catch {
      return null
    }
  }

  const sessionShort = (exec) => {
    const id = exec?.agent?.id || 'default'
    return String(id).slice(-8)
  }

  function sessionCwd(exec) {
    try {
      const services = sessionContext?.()
      const session = services?.sessions?.get?.(exec?.agent?.id)
      const cwd = session?.header?.cwd ?? session?.cwd ?? session?.meta?.cwd
      if (typeof cwd === 'string' && cwd.trim()) return cwd
    } catch {
      // no session directory available
    }
    return null
  }

  // Resolve the *target* page, not whichever tab happens to be active. `tabId`
  // comes from the tool call; `allowForeign` is only used by chrome_tabs claim,
  // where the tab is deliberately not owned yet.
  async function lookupSite(exec, { tabId = null, allowForeign = false } = {}) {
    const params = { owner: ownerOf(exec) }
    if (Number.isFinite(tabId)) {
      params.tabId = tabId
      if (allowForeign) params.allowForeign = true
    }
    try {
      const site = await bridge.call('browser.site', params, 5000)
      return {
        ok: true,
        site: {
          origin: site?.origin || null,
          url: site?.url || '',
          title: site?.title || '',
          tabId: site?.tabId ?? (Number.isFinite(tabId) ? tabId : null),
        },
      }
    } catch (error) {
      // A failed lookup is not "no site": the guard must not fall back to the
      // default policy (R-03).
      return {
        ok: false,
        error,
        site: { origin: null, url: '', title: '', tabId: Number.isFinite(tabId) ? tabId : null },
      }
    }
  }

  async function currentSite(exec, tabId = null) {
    return (await lookupSite(exec, { tabId })).site
  }

  function writeAudit(exec, toolName, action, site, decision, reason) {
    appendAudit(dshHome(), {
      ts: new Date().toISOString(),
      session: sessionShort(exec),
      tool: toolName,
      origin: site?.origin || null,
      tabId: site?.tabId ?? null,
      action: String(action || '').slice(0, 300),
      decision,
      reason,
    })
  }

  async function requestApproval(exec, toolName, action, site, reason) {
    if (!exec?.agent) {
      writeAudit(exec, toolName, action, site, 'denied', 'no-agent')
      throw new BridgeError('APPROVAL_DENIED', 'browser actions require a live agent session')
    }
    const service = approval?.()
    if (!service || typeof service.request !== 'function') {
      // Fail closed: a missing approval service must never mean "allowed"
      // (R-03; docs/APPROVAL.md §6).
      writeAudit(exec, toolName, action, site, 'denied', 'no-approval-service')
      throw new BridgeError('APPROVAL_DENIED', 'approval service is unavailable; refusing the browser action')
    }
    let outcome
    try {
      outcome = await service.request({
        agent: exec.agent,
        toolName,
        callId: exec.callId,
        reason: action,
        displayReason: {
          en: `Browser action on ${site?.origin || site?.url || '(unknown page)'}: ${action}`,
          zh: `浏览器操作（${site?.origin || site?.url || '未知页面'}）：${action}`,
        },
        signal: exec.signal,
      })
    } catch (error) {
      writeAudit(exec, toolName, action, site, 'denied', 'approval-unavailable')
      throw new BridgeError('APPROVAL_DENIED', `approval unavailable: ${error?.message || error}`)
    }
    if (outcome !== 'allowed-once') {
      writeAudit(exec, toolName, action, site, 'denied', `approval-${outcome}`)
      throw new BridgeError('APPROVAL_DENIED', `browser action was not approved (${outcome})`)
    }
    writeAudit(exec, toolName, action, site, 'allowed', reason)
    return site
  }

  async function guard(exec, toolName, action, { tabId = null, targetUrl = null, allowForeign = false } = {}) {
    if (!exec?.agent) {
      writeAudit(exec, toolName, action, null, 'denied', 'no-agent')
      throw new BridgeError('APPROVAL_DENIED', 'browser actions require a live agent session')
    }
    let site
    let lookupError = null
    if (targetUrl != null) {
      // goto / tabs new: judge the destination URL, not the departure page
      // (R-02). No lookup: the target is known before anything navigates.
      site = {
        origin: originOf(targetUrl),
        url: String(targetUrl || ''),
        title: '',
        tabId: Number.isFinite(tabId) ? tabId : null,
      }
    } else {
      const looked = await lookupSite(exec, { tabId, allowForeign })
      site = looked.site
      if (!looked.ok) lookupError = looked.error
    }
    const resolved = resolvePolicy(loadPolicy(dshHome()), site.origin)
    if (resolved.mode === 'block') {
      writeAudit(exec, toolName, action, site, 'denied', 'site-blocked')
      throw new BridgeError('SITE_BLOCKED', `site ${site.origin || '(unknown)'} is blocked by policy.json`)
    }
    if (lookupError) {
      // Preserve "the target tab does not exist" instead of disguising it as a
      // policy refusal: no action runs either way, and the model can recover
      // (re-list tabs) only when it sees TAB_NOT_FOUND.
      if (lookupError?.code === 'TAB_NOT_FOUND') {
        writeAudit(exec, toolName, action, site, 'denied', 'target-tab-not-found')
        throw new BridgeError('TAB_NOT_FOUND', lookupError.message || 'target tab not found')
      }
      // chrome_close_session has no page target of its own: with no session tab
      // there is nothing to judge and nothing to close (closing zero tabs is
      // the historical success path).
      if (lookupError?.code === 'NO_SESSION_TAB' && toolName === 'chrome_close_session') {
        writeAudit(exec, toolName, action, site, 'allowed', 'no-session-tab')
        return site
      }
      writeAudit(exec, toolName, action, site, 'denied', 'site-unavailable')
      throw new BridgeError(
        'APPROVAL_DENIED',
        `cannot resolve the target site (${lookupError?.message || lookupError}); refusing the browser action`,
      )
    }
    if (resolved.mode === 'allow') {
      writeAudit(exec, toolName, action, site, 'allowed', 'site-allow')
      return site
    }
    if (resolved.mode === 'ask') {
      // Explicit ask outranks danger-full-access: the human asked to be asked.
      return requestApproval(exec, toolName, action, site, 'policy-ask')
    }
    // follow-dsh: the session's sandbox preset already grants full access.
    if (sessionSandboxMode(exec) === 'danger-full-access') {
      writeAudit(exec, toolName, action, site, 'allowed', 'follow-dsh')
      return site
    }
    return requestApproval(exec, toolName, action, site, 'approval')
  }

  async function hardConfirmAsk(exec, toolName, { header, question, detail, timeoutMs, site }) {
    // `site` defaults to the current page. Pass `site: null` for a confirmation
    // that must not resolve the page first: on headless, browser.site lazily
    // creates an about:blank tab, and chrome_headless_login start refuses to run
    // while any tab is open.
    const confirmedSite = site === undefined ? await currentSite(exec) : site
    const auditConfirm = (decision, reason) => writeAudit(exec, toolName, header, confirmedSite, decision, reason)
    const service = userQuestions?.()
    if (!service || typeof service.ask !== 'function') {
      throw new BridgeError('APPROVAL_DENIED', 'hard confirmation service is unavailable; refusing sensitive action')
    }
    if (!exec?.agent) {
      throw new BridgeError('APPROVAL_DENIED', 'hard confirmation requires a live agent')
    }
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, Number.isFinite(timeoutMs) ? timeoutMs : evaluateConfirmTimeoutMs)
    const forwardAbort = () => controller.abort()
    exec.signal?.addEventListener?.('abort', forwardAbort)
    try {
      const answer = await service.ask({
        agent: exec.agent,
        signal: controller.signal,
        questions: [
          {
            id: 'confirm',
            header,
            question,
            ...(detail ? { detail } : {}),
            options: [
              { label: '允许一次', description: '只执行这一次，不持久授权' },
              { label: '拒绝', description: '不执行并返回 APPROVAL_DENIED' },
            ],
          },
        ],
      })
      const selected = answer?.answers?.[0]?.selected
      const choice = Array.isArray(selected) ? selected.join(' ') : ''
      if (!choice.includes('允许')) {
        auditConfirm('denied', 'hard-confirm-refused')
        throw new BridgeError('APPROVAL_DENIED', 'sensitive browser action was not approved')
      }
      auditConfirm('allowed', 'hard-confirm')
    } catch (error) {
      if (error instanceof BridgeError) throw error
      const code = String(error?.code || error?.name || '')
      if (timedOut) {
        auditConfirm('denied', 'hard-confirm-timeout')
        throw new BridgeError('APPROVAL_TIMEOUT', 'confirmation timed out')
      }
      if (code === 'DELEGATED_CALLER') {
        throw new BridgeError('DELEGATED_CALLER', 'delegated agents cannot confirm this browser action')
      }
      throw new BridgeError('APPROVAL_DENIED', `confirmation failed: ${error?.message || error}`)
    } finally {
      clearTimeout(timer)
      exec.signal?.removeEventListener?.('abort', forwardAbort)
    }
  }


  // Navigation tools (goto/history/tabs/close_session) live in their own module
  // (Q13). Only the shared helpers they actually use are injected; tab/owner,
  // lease-release and URL-validation semantics are unchanged.
  const navigation = createNavigationTools({
    call,
    guard,
    ownerOf,
    sessionLabel,
    validateHttpUrl,
    validateTabUrl,
    outputSchema,
    renderText,
    leases,
  })

  // Capture tools (start/stop/requests) live in their own module (Q14). The
  // hard confirmation and the 30s capture RPC timeout are preserved verbatim.
  const captureTools = createCaptureTools({
    call,
    ownerOf,
    hardConfirmAsk,
    captureConfirmTimeoutMs,
    outputSchema,
    renderText,
  })

  // Read-only page tools (snapshot/find/text/console/network/html/wait) live in
  // their own module (Q15). The snapshot text budget is injected so the default
  // stays a single constant in tools.js.
  const readTools = createReadTools({
    call,
    ownerOf,
    outputSchema,
    renderText,
    snapshotTextDefaultChars: SNAPSHOT_TEXT_DEFAULT_CHARS,
  })

  // Input tools (click/click_at/type/press/hover/scroll/select/drag/upload)
  // live in their own module (Q18). The upload allowlist moved with
  // chrome_upload; its audit writes and session-cwd lookup are injected so the
  // private-site policy behavior is unchanged.
  const inputTools = createInputTools({
    call,
    guard,
    ownerOf,
    outputSchema,
    renderText,
    hardConfirmAsk,
    evaluateConfirmTimeoutMs,
    writeAudit,
    sessionCwd,
  })

  // Status/config/policy/audit tools live in their own module (Q19). `bridge`,
  // `assets` and `update` stay injected as before; currentSite keeps the exact
  // same target-page lookup used by the approval guard.
  const statusTools = createStatusTools({
    bridge,
    assets,
    update,
    currentSite,
    outputSchema,
    renderText,
  })

  // Screencast/overlay tools (screencast/pointer/annotate/emulate) live in their
  // own module (Q20). The per-session stream guards and ownership ledger move
  // with the tool, so one provider instance still owns exactly one map each.
  const screencastTools = createScreencastTools({
    bridge,
    call,
    guard,
    supports,
    ownerOf,
    attachments,
    outputSchema,
    renderText,
  })

  // Media tools (screenshot/download/pdf/shots/frames) live in their own module
  // (Q23). The attachment service and the screenshot ownership ledger move with
  // the tools; file paths, render blocks and error codes are unchanged.
  const mediaTools = createMediaTools({
    call,
    ownerOf,
    attachments,
    outputSchema,
    renderText,
  })

  // Misc tools (evaluate/pick/resume/storage/selection) live in their own module
  // (Q24). The evaluate hard confirmation and the pick capability gate move with
  // the tools; the config flag still decides whether chrome_evaluate registers.
  const miscTools = createMiscTools({
    call,
    guard,
    supports,
    ownerOf,
    hardConfirmAsk,
    evaluateConfirmTimeoutMs,
    allowEvaluate,
    outputSchema,
    renderText,
  })

  // ---------------------------------------------------------------- 1. status
  list.push(statusTools.status)

  // ------------------------------------------------------------------ 2. goto
  list.push(navigation.goto)

  // -------------------------------------------------------------- 3. snapshot
  list.push(readTools.snapshot)

  // ------------------------------------------------------------ 4. screenshot
  list.push(readTools.find, readTools.getText, inputTools.select, inputTools.drag, screencastTools.emulate, miscTools.storage, mediaTools.pdf,
  {
    name: 'chrome_a11y',
    description:
      'Return the accessibility tree of the DSH session page (role/name/value nodes, filtered and truncated). Useful for understanding structure, dialogs and non-DOM UIs; use chrome_snapshot for clickable refs.',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max nodes, 1-400 (default 200).' },
        tabId: { type: 'number', description: 'Optional tab id owned by this session.' },
      },
      additionalProperties: false,
    },
    output: {
      schema: outputSchema({
        total: { type: 'number' },
        truncated: { type: 'boolean' },
        nodes: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              role: { type: 'string' },
              name: { type: 'string' },
              value: { type: 'string' },
            },
            additionalProperties: true,
          },
        },
      }),
      render: (_args, value) => {
        const lines = (value.nodes ?? []).map((node) =>
          `${node.role}${node.name ? ` ${JSON.stringify(node.name)}` : ''}${node.value ? ` value=${JSON.stringify(node.value)}` : ''}`,
        )
        return renderText(
          `Accessibility nodes (${lines.length}/${value.total}${value.truncated ? ', truncated' : ''}):\n${lines.join('\n') || '(none)'}`,
        )
      },
    },
    async execute(args, exec) {
      const value = await call('tab.a11y', { limit: args?.limit, tabId: args?.tabId, owner: ownerOf(exec) }, 30000)
      if (!value) throw new BridgeError('INTERNAL', 'extension returned no accessibility tree')
      return value
    },
  },
  readTools.console,
  readTools.network,
  mediaTools.screenshot)

  // ---------------------------------------------------------------- 5. hover
  list.push(inputTools.hover)

  // ------------------------------------------------------------ 4b. chrome_html
  list.push(readTools.html)

  // ---------------------------------------------------------------- 5. click
  list.push(inputTools.click)

  // --------------------------------------------------------- 4c. selection
  list.push(miscTools.selection)

  // ------------------------------------------------------- 1a. provider config
  list.push(statusTools.config)

  // ------------------------------------------------------- 1b. policy/audit
  list.push(statusTools.policy)

  list.push(statusTools.audit)


  // ------------------------------------------- 4i-2. headless login profile
  list.push(createLoginTool({ bridge, hardConfirmAsk, evaluateConfirmTimeoutMs, outputSchema, renderText }))

  list.push(createContextTool({ contexts, contextViewer, ownerOf, outputSchema, renderText }))

  list.push(createLeaseTool({ leases, ownerOf, outputSchema, renderText, normalizeLeaseError }))

  list.push(createVerifyTool({ contexts, artifactStore, ownerOf, fsp, randomUUID, outputSchema, renderText }))

  // ------------------------------------------------ 4h-2. pointer/annotate
  list.push(screencastTools.pointer)

  list.push(screencastTools.annotate)

  // ----------------------------------------------------- 4j. screencast
  list.push(screencastTools.screencast)


  // ---------------------------------------------------------- 4i. shots
  // Screenshot history (both desktop and headless roots) and the per-session
  // ownership ledger live in tools-media.js (Q23).
  list.push(mediaTools.shots)

  // ---------------------------------------------------------- 4h. resume
  list.push(miscTools.resume)

  // ------------------------------------------------------------ 4g. pick
  list.push(miscTools.pick)

  // -------------------------------------------------------- 4e. evaluate (gated)
  if (miscTools.evaluate) list.push(miscTools.evaluate)

  // ---------------------------------------------------- 4f. HTTP capture (C2a)
  list.push(...captureTools)

  // ------------------------------------------------------------ 4d. frames
  list.push(mediaTools.frames)

  // ------------------------------------------------------------ 5b. click_at
  list.push(inputTools.clickAt)

  // ----------------------------------------------------------------- 6. type
  list.push(inputTools.type)

  // ---------------------------------------------------------------- 7. press
  list.push(inputTools.press)

  // --------------------------------------------------------------- 8. scroll
  list.push(inputTools.scroll)

  // -------------------------------------------------------------- 9. history
  list.push(navigation.history)

  // ----------------------------------------------------------------- 10. tabs
  list.push(navigation.tabs)

  // ----------------------------------------------------------------- 11. upload
  list.push(inputTools.upload)

  // ----------------------------------------------------------------- 12. downloads
  list.push(mediaTools.download)

  // ----------------------------------------------------------------- 11. wait
  list.push(readTools.wait)

  // -------------------------------------------------------- 12. close session
  list.push(navigation.closeSession)

  return list
}
