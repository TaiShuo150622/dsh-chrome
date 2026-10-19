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

// Next-step hint shared by the pick capability gate and the runtime fallback
// (a backend that declares pick but fails at request time).
const PICK_UNSUPPORTED_MESSAGE =
  'chrome_pick needs a real user click on the visible desktop browser. Use backend:"desktop" for pick, or use chrome_snapshot + chrome_click/chrome_type with a selector/ref on backend:"headless".'

function outputSchema(properties) {
  return { type: 'object', properties, additionalProperties: true }
}

function renderText(text) {
  return [{ type: 'text', text }]
}



function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return 'unknown size'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
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


  async function hardConfirm(exec, toolName, expression) {
    return hardConfirmAsk(exec, toolName, {
      header: '执行页面 JavaScript',
      question: `${toolName} 将在当前页面执行一段表达式，是否允许本次执行？\n\n${String(expression).slice(0, 800)}`,
      timeoutMs: evaluateConfirmTimeoutMs,
    })
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

  // ---------------------------------------------------------------- 1. status
  list.push(statusTools.status)

  // ------------------------------------------------------------------ 2. goto
  list.push(navigation.goto)

  // -------------------------------------------------------------- 3. snapshot
  list.push(readTools.snapshot)

  // ------------------------------------------------------------ 4. screenshot
  list.push(readTools.find, readTools.getText, inputTools.select, inputTools.drag, screencastTools.emulate, {
    name: 'chrome_storage',
    mutating: true,
    description:
      'Read or change the session page storage (localStorage / sessionStorage): get one key, several keys or all entries; set/remove/clear (mutations require approval). Values are JSON-encoded when not strings.',
    parameters: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['get', 'set', 'remove', 'clear'] },
        scope: { type: 'string', enum: ['local', 'session'], description: 'Storage area (default local).' },
        key: { type: 'string', description: 'Key for get/set.' },
        value: { description: 'Value for set (string or JSON-serializable value).' },
        keys: { type: 'array', items: { type: 'string' }, description: 'Keys for get/remove batches.' },
        tabId: { type: 'number', description: 'Optional tab id owned by this session.' },
      },
      required: ['op'],
      additionalProperties: false,
    },
    output: {
      schema: outputSchema({
        ok: { type: 'boolean' },
        scope: { type: 'string' },
        value: {},
        items: { type: 'object', additionalProperties: true },
        set: { type: 'number' },
        removed: { type: 'number' },
        cleared: { type: 'boolean' },
        tabId: { type: 'number' },
      }),
      render: (_args, value) => {
        if (value.items) {
          const lines = Object.entries(value.items).map(([key, item]) => `${key}=${JSON.stringify(item)}`)
          return renderText(`${value.scope}Storage: ${lines.join(', ') || '(empty)'}`)
        }
        if (value.value !== undefined) return renderText(`${value.scope}Storage ${JSON.stringify(value.value)}`)
        if (value.set != null) return renderText(`Set ${value.set} key(s) in ${value.scope}Storage`)
        if (value.removed != null) return renderText(`Removed ${value.removed} key(s) from ${value.scope}Storage`)
        return renderText(`Cleared ${value.scope}Storage`)
      },
    },
    async execute(args, exec) {
      const op = String(args?.op ?? 'get')
      if (op !== 'get') await guard(exec, 'chrome_storage', `storage ${op}`, { tabId: args?.tabId })
      return call(
        'tab.storage',
        {
          op,
          scope: args?.scope,
          key: args?.key,
          value: args?.value,
          keys: args?.keys,
          tabId: args?.tabId,
          owner: ownerOf(exec),
        },
        30000,
      )
    },
  },
  {
    name: 'chrome_pdf',
    description:
      'Export the current DSH session page to a PDF file with CDP Page.printToPDF and return the saved path. Useful for archiving or sharing a page as it renders.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Optional absolute output path; defaults to the DSH cache pdfs directory.' },
        tabId: { type: 'number', description: 'Optional tab id owned by this session.' },
      },
      additionalProperties: false,
    },
    output: {
      schema: outputSchema({
        path: { type: 'string' },
        bytes: { type: 'number' },
      }),
      render: (_args, value) => renderText(`PDF ${(value.bytes / 1024).toFixed(1)} KiB saved to ${value.path}`),
    },
    async execute(args, exec) {
      const value = await call('tab.pdf', { tabId: args?.tabId, owner: ownerOf(exec) }, 60000)
      const cacheDir = path.join(dshHome(), 'cache', 'dsh-chrome', 'pdfs')
      const target = args?.path ? String(args.path) : path.join(cacheDir, `page-${Date.now()}.pdf`)
      // Desktop extension: the payload comes back inline and the tool writes it.
      if (value?.dataBase64) {
        await fsp.mkdir(path.dirname(target), { recursive: true })
        const bytes = Buffer.from(value.dataBase64, 'base64')
        await fsp.writeFile(target, bytes, { mode: 0o600 })
        return { path: target, bytes: bytes.length }
      }
      // Headless driver: Page.printToPDF already wrote the file and returns
      // { path, bytes }. Move it to the requested/default target so both
      // backends answer with one contract and no orphan copy is left behind in
      // the headless screenshot directory.
      const source = typeof value?.path === 'string' && value.path ? value.path : null
      if (source) {
        let stat = null
        try {
          stat = await fsp.stat(source)
        } catch {
          stat = null
        }
        if (stat?.isFile()) {
          if (path.resolve(source) === path.resolve(target)) return { path: target, bytes: stat.size }
          await fsp.mkdir(path.dirname(target), { recursive: true })
          await fsp.copyFile(source, target)
          await fsp.chmod(target, 0o600).catch(() => {})
          const copied = await fsp.stat(target)
          await fsp.rm(source, { force: true }).catch(() => {})
          return { path: target, bytes: copied.size }
        }
      }
      throw new BridgeError('INTERNAL', 'browser backend returned no pdf data')
    },
  },
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
  {
    name: 'chrome_screenshot',
    description:
      'Capture a PNG screenshot of the current DSH session page (or tabId) and return it as an image in this conversation. The file is also saved on disk. Use when layout or visual state matters; use chrome_snapshot for text.',
    parameters: {
      type: 'object',
      properties: {
        tabId: { type: 'number', description: 'Optional tab id owned by this session.' },
        ref: { type: 'number', description: 'Capture only the element with this snapshot ref.' },
        frameRef: { type: 'string', description: 'Capture only an iframe element, e.g. "f83F9D728:1" (from chrome_snapshot frames).' },
        fullPage: { type: 'boolean', description: 'Capture the full scrollable document instead of the viewport.' },
        highlight: { type: 'boolean', description: 'Overlay labeled boxes for current snapshot refs in the capture.' },
        clip: {
          type: 'object',
          description: 'Optional viewport region to capture, in CSS pixels.',
          properties: {
            x: { type: 'number' },
            y: { type: 'number' },
            width: { type: 'number' },
            height: { type: 'number' },
          },
          required: ['x', 'y', 'width', 'height'],
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: outputSchema({
        path: { type: 'string' },
        mediaType: { type: 'string' },
        width: { type: 'number' },
        height: { type: 'number' },
        bytes: { type: 'number' },
        image: { type: 'object', additionalProperties: true },
      }),
      render: (_args, value) => {
        const blocks = []
        if (value.image && value.image.attachmentId) {
          blocks.push({ type: 'image', attachment: value.image })
        }
        blocks.push({
          type: 'text',
          text: `Screenshot ${value.width}x${value.height} (${formatBytes(value.bytes)}) saved to ${value.path}`,
        })
        return blocks
      },
    },
    async execute(args, exec) {
      const shot = await call(
        'tab.screenshot',
        { tabId: args?.tabId, ref: args?.ref, frameRef: args?.frameRef, clip: args?.clip, fullPage: Boolean(args?.fullPage), highlight: Boolean(args?.highlight), owner: ownerOf(exec) },
        60000,
      )
      if (!shot?.path) throw new BridgeError('INTERNAL', 'native host did not return a screenshot path')
      await recordShotOwner(shot.path, ownerOf(exec))
      let bytes = shot.bytes
      let image = null
      try {
        const data = await fsp.readFile(shot.path)
        bytes = data.byteLength
        const service = attachments?.()
        if (service) {
          image = await service.saveImage({
            data: new Uint8Array(data),
            mediaType: shot.mediaType || 'image/png',
            name: `chrome-screenshot-${Date.now()}.png`,
          })
        }
      } catch {
        image = null
      }
      return {
        path: shot.path,
        mediaType: shot.mediaType || 'image/png',
        width: shot.width,
        height: shot.height,
        bytes,
        image,
      }
    },
  })

  // ---------------------------------------------------------------- 5. hover
  list.push(inputTools.hover)

  // ------------------------------------------------------------ 4b. chrome_html
  list.push(readTools.html)

  // ---------------------------------------------------------------- 5. click
  list.push(inputTools.click)

  // --------------------------------------------------------- 4c. selection
  list.push({
    name: 'chrome_selection',
    description:
      'Read the current page selection (or selected text inside a focused input/textarea) with its source URL and title, wrapped as untrusted page content. Password/payment/secret fields return SENSITIVE_SELECTION; no selection returns NO_SELECTION.',
    parameters: {
      type: 'object',
      properties: {
        maxChars: { type: 'number', description: 'Optional cap (10-20000, default 4000).' },
        tabId: { type: 'number', description: 'Optional tab id owned by this session.' },
      },
      additionalProperties: false,
    },
    output: {
      schema: outputSchema({
        found: { type: 'boolean' },
        text: { type: 'string' },
        url: { type: 'string' },
        title: { type: 'string' },
        truncated: { type: 'boolean' },
        source: { type: 'string' },
        tabId: { type: 'number' },
      }),
      render: (_args, value) =>
        renderText(
          `Selection from ${value.url || 'page'} (${value.title || ''}):\n${value.text || ''}${value.truncated ? '\n[truncated]' : ''}`,
        ),
    },
    async execute(args, exec) {
      return call(
        'tab.selection',
        { maxChars: args?.maxChars, tabId: args?.tabId, owner: ownerOf(exec) },
        30000,
      )
    },
  })

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
  // Screenshot history lives in two places: the desktop host writes to
  // cache/dsh-chrome/screenshots, the headless driver to
  // cache/dsh-chrome/headless/screenshots. chrome_shots reads both so the
  // history is backend-independent.
  function screenshotDirectories() {
    return [
      path.join(dshHome(), 'cache', 'dsh-chrome', 'screenshots'),
      path.join(dshHome(), 'cache', 'dsh-chrome', 'headless', 'screenshots'),
    ]
  }

  // Screenshot ownership ledger. The files are still written by the host /
  // headless driver into shared directories, so the provider records which
  // session asked for each shot and hides shots recorded for other sessions
  // (R-06). Files with no recorded owner predate the ledger and stay visible.
  function shotOwnersPath() {
    return path.join(dshHome(), 'cache', 'dsh-chrome', 'shot-owners.json')
  }

  async function readShotOwners() {
    try {
      const parsed = JSON.parse(await fsp.readFile(shotOwnersPath(), 'utf8'))
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
    } catch {
      return {}
    }
  }

  async function recordShotOwner(file, owner) {
    if (!file || !owner) return
    try {
      const owners = await readShotOwners()
      owners[path.resolve(String(file))] = String(owner)
      const keys = Object.keys(owners)
      for (const key of keys.slice(0, Math.max(0, keys.length - 2000))) delete owners[key]
      await fsp.mkdir(path.dirname(shotOwnersPath()), { recursive: true })
      await fsp.writeFile(shotOwnersPath(), `${JSON.stringify(owners)}\n`, { mode: 0o600 })
    } catch {
      // The ledger is best effort; an unwritable cache must not lose the shot.
    }
  }

  function shotVisible(owners, file, owner) {
    const recorded = owners[path.resolve(String(file))]
    return !recorded || recorded === String(owner)
  }

  list.push({
    name: 'chrome_shots',
    description:
      'List or read screenshot history saved by this provider (desktop ~/.dsh/cache/dsh-chrome/screenshots and headless ~/.dsh/cache/dsh-chrome/headless/screenshots). History is filesystem-backed, so it survives restarts. op="list" returns recent screenshots with size + PNG dimensions; op="read" returns one screenshot (path under either directory) as an image attachment. Shots recorded for another DSH session are hidden.',
    parameters: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['list', 'read'] },
        limit: { type: 'number', description: 'list: max entries (default 20, max 100).' },
        path: { type: 'string', description: 'read: absolute path under the screenshots directory.' },
      },
      required: ['op'],
      additionalProperties: false,
    },
    output: {
      schema: outputSchema({
        directory: { type: 'string' },
        directories: { type: 'array', items: { type: 'string' } },
        entries: { type: 'array', items: { type: 'object', additionalProperties: true } },
        path: { type: 'string' },
        width: {},
        height: {},
        bytes: { type: 'number' },
        image: { type: 'object', additionalProperties: true },
      }),
      render: (_args, value) => {
        if (value.image) {
          return [
            { type: 'image', attachment: value.image },
            { type: 'text', text: `Screenshot ${value.width}x${value.height} (${formatBytes(value.bytes)}) ${value.path}` },
          ]
        }
        const lines = (value.entries || []).map(
          (entry) => `- ${entry.mtime} ${entry.name} (${formatBytes(entry.bytes)}${entry.width ? `, ${entry.width}x${entry.height}` : ''})`,
        )
        return renderText(`Screenshot history (${value.entries?.length ?? 0}) in ${value.directory}\n${lines.join('\n')}`)
      },
    },
    async execute(args, exec) {
      const directories = screenshotDirectories()
      const directory = directories[0]
      const op = String(args?.op || 'list')
      const owner = ownerOf(exec)
      const shotOwners = op === 'list' || op === 'read' ? await readShotOwners() : {}
      if (op === 'list') {
        const limit = Number.isFinite(args?.limit) ? Math.max(1, Math.min(100, Number(args.limit))) : 20
        const entries = []
        const seen = new Set()
        for (const root of directories) {
          let names = []
          try {
            names = await fsp.readdir(root)
          } catch {
            continue
          }
          for (const name of names) {
            if (!/\.(png|jpe?g)$/i.test(name)) continue
            const file = path.join(root, name)
            if (seen.has(file)) continue
            seen.add(file)
            // Filter before stat/open so another session's file is never read.
            if (!shotVisible(shotOwners, file, owner)) continue
            try {
              const stat = await fsp.stat(file)
              const entry = {
                name,
                path: file,
                bytes: stat.size,
                mtime: stat.mtime.toISOString(),
                mtimeMs: stat.mtimeMs,
              }
              if (/\.png$/i.test(name)) {
                try {
                  const head = Buffer.alloc(24)
                  const handle = await fsp.open(file, 'r')
                  try {
                    await handle.read(head, 0, 24, 0)
                  } finally {
                    await handle.close()
                  }
                  if (head.readUInt32BE(0) === 0x89504e47) {
                    entry.width = head.readUInt32BE(16)
                    entry.height = head.readUInt32BE(20)
                  }
                } catch {
                  // dimensions optional
                }
              }
              entries.push(entry)
            } catch {
              // skip unreadable file
            }
          }
        }
        entries.sort((a, b) => b.mtimeMs - a.mtimeMs)
        return { directory, directories, entries: entries.slice(0, limit) }
      }
      if (op === 'read') {
        const target = path.resolve(String(args?.path || ''))
        const root = directories
          .map((candidate) => path.resolve(candidate))
          .find((candidate) => target.startsWith(`${candidate}${path.sep}`))
        if (!root) {
          throw new BridgeError('INVALID_ARGUMENT', 'path must be inside the screenshots directory')
        }
        if (!shotVisible(shotOwners, target, owner)) {
          throw new BridgeError('INVALID_ARGUMENT', 'screenshot belongs to another DSH session')
        }
        const data = await fsp.readFile(target)
        let width
        let height
        if (data.length >= 24 && data.readUInt32BE(0) === 0x89504e47) {
          width = data.readUInt32BE(16)
          height = data.readUInt32BE(20)
        }
        let image = null
        try {
          const service = attachments?.()
          if (service) {
            image = await service.saveImage({
              data: new Uint8Array(data),
              mediaType: /\.jpe?g$/i.test(target) ? 'image/jpeg' : 'image/png',
              name: path.basename(target),
            })
          }
        } catch {
          image = null
        }
        return { directory: root, path: target, bytes: data.byteLength, width, height, image }
      }
      throw new BridgeError('INVALID_ARGUMENT', `unknown shots op: ${op}`)
    },
  })

  // ---------------------------------------------------------- 4h. resume
  list.push({
    name: 'chrome_resume',
    description:
      'Resume normal browser actions after a USER_SWITCHED pause. A pause is set when the user activates another tab while the DSH session tab was the active one; the next mutating action returns USER_SWITCHED until this tool (or chrome_tabs {op:"focus"}) clears it.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: outputSchema({
        ok: { type: 'boolean' },
        tabId: {},
      }),
      render: (_args, value) => renderText(`Resumed browser session${value.tabId != null ? ` (tab ${value.tabId})` : ''}`),
    },
    async execute(_args, exec) {
      return call('tab.resume', { owner: ownerOf(exec) }, 15000)
    },
  })

  // ------------------------------------------------------------ 4g. pick
  list.push({
    name: 'chrome_pick',
    description:
      'Enter element-pick mode: an overlay appears; the user clicks one element and the tool returns {ref, selector, text, tag, box}. The returned ref can be used directly with chrome_click/chrome_type. Blocks until the pick completes, is canceled, or times out. Set cancel:true to abort an active pick.',
    parameters: {
      type: 'object',
      properties: {
        timeoutMs: { type: 'number', description: 'Pick timeout, 500-120000 ms (default 60000).' },
        cancel: { type: 'boolean', description: 'Cancel the active pick instead of starting a new one.' },
        nowait: { type: 'boolean', description: 'Start pick mode and return immediately; use poll:true later to fetch the result.' },
        poll: { type: 'boolean', description: 'Return the current pick status; pending:true means the user has not clicked yet.' },
        tabId: { type: 'number', description: 'Optional tab id owned by this session.' },
      },
      additionalProperties: false,
    },
    output: {
      schema: outputSchema({
        ref: { type: 'number' },
        selector: { type: 'string' },
        text: { type: 'string' },
        tag: { type: 'string' },
        box: { type: 'array', items: { type: 'number' } },
        canceled: { type: 'boolean' },
        started: { type: 'boolean' },
        pending: { type: 'boolean' },
        tabId: {},
      }),
      render: (_args, value) => {
        if (value.pending) return renderText('Pick pending: waiting for the user to click an element')
        if (value.started) return renderText('Pick mode started; use chrome_pick {poll:true} to fetch the result')
        if (value.canceled) return renderText('Pick canceled')
        return renderText(
          `Picked <${value.tag || 'element'}> ref=${value.ref} ${JSON.stringify(value.text || '')}\nselector: ${value.selector || ''}\nbox: [${(value.box || []).join(',')}]`,
        )
      },
    },
    async execute(args, exec) {
      if (!supports('pick')) {
        throw new BridgeError('UNSUPPORTED_BACKEND', PICK_UNSUPPORTED_MESSAGE)
      }
      const owner = ownerOf(exec)
      try {
        return await runPick(args, owner)
      } catch (error) {
        const code = error?.code || error?.name
        if (code === 'UNSUPPORTED_BACKEND' || /not implemented by the headless backend/i.test(String(error?.message || ''))) {
          throw new BridgeError('UNSUPPORTED_BACKEND', PICK_UNSUPPORTED_MESSAGE)
        }
        throw error
      }
    },
  })

  async function runPick(args, owner) {
      const tabId = args?.tabId
      if (args?.cancel) {
        await call('tab.pick_cancel', { tabId, owner }, 15000)
        return { canceled: true, tabId: tabId ?? null }
      }
      if (args?.poll) {
        const status = await call('tab.pick_status', { tabId, owner }, 15000)
        if (!status?.available) throw new BridgeError('PICK_CANCELED', 'no pick mode is active')
        if (!status.done) return { pending: true, tabId: tabId ?? null }
        if (status.canceled || !status.result) throw new BridgeError('PICK_CANCELED', 'pick was canceled')
        return { ...status.result, canceled: false, tabId: tabId ?? null }
      }
      if (args?.nowait) {
        const startedInfo = await call('tab.pick_start', { tabId, owner }, 15000)
        return { started: true, tabId: startedInfo?.tabId ?? tabId ?? null }
      }
      const timeoutMs = Number.isFinite(args?.timeoutMs)
        ? Math.max(500, Math.min(120000, Number(args.timeoutMs)))
        : 60000
      await call('tab.pick_start', { tabId, owner }, 15000)
      const started = Date.now()
      while (Date.now() - started < timeoutMs) {
        await new Promise((resolve) => setTimeout(resolve, 250))
        const status = await call('tab.pick_status', { tabId, owner }, 15000)
        if (!status?.available) {
          await call('tab.pick_cancel', { tabId, owner }, 15000).catch(() => {})
          throw new BridgeError('PICK_CANCELED', 'pick mode was closed')
        }
        if (status.done) {
          if (status.canceled || !status.result) throw new BridgeError('PICK_CANCELED', 'pick was canceled')
          return { ...status.result, canceled: false, tabId: tabId ?? null }
        }
      }
      await call('tab.pick_cancel', { tabId, owner }, 15000).catch(() => {})
      throw new BridgeError('PICK_TIMEOUT', `no element picked within ${timeoutMs}ms`)
  }

  // -------------------------------------------------------- 4e. evaluate (gated)
  if (allowEvaluate) {
    list.push({
      name: 'chrome_evaluate',
    mutating: true,
      description:
        'Evaluate a JavaScript expression in the current DSH session page through CDP Runtime.evaluate. Disabled by default: it is registered only when allowEvaluate is true in ~/.dsh/cache/dsh-chrome/config.json, and every call requires an explicit hard confirmation (userQuestions) even under danger-full-access. Page content and the result are untrusted data.',
      parameters: {
        type: 'object',
        properties: {
          expression: { type: 'string', description: 'JavaScript expression to evaluate in the page.' },
          awaitPromise: { type: 'boolean', description: 'Await a returned promise (default false).' },
          timeoutMs: { type: 'number', description: 'Evaluation timeout, 500-30000 ms (default 10000).' },
          tabId: { type: 'number', description: 'Optional tab id owned by this session.' },
        },
        required: ['expression'],
        additionalProperties: false,
      },
      output: {
        schema: outputSchema({
          ok: { type: 'boolean' },
          value: {},
          type: { type: 'string' },
          unserializable: { type: 'boolean' },
        }),
        render: (_args, value) => {
          const shown =
            value.unserializable && value.value != null
              ? String(value.value)
              : JSON.stringify(value.value)
          const clipped = shown != null && shown.length > 4000 ? `${shown.slice(0, 4000)}\n… (${shown.length} chars)` : shown
          return renderText(`evaluate (${value.type || 'unknown'}):\n${clipped ?? 'null'}`)
        },
      },
      async execute(args, exec) {
        const expression = String(args?.expression ?? '')
        if (!expression.trim()) throw new BridgeError('INVALID_ARGUMENT', 'expression must not be empty')
        await hardConfirm(exec, 'chrome_evaluate', expression)
        const value = await call(
          'tab.evaluate',
          {
            expression,
            awaitPromise: Boolean(args?.awaitPromise),
            timeoutMs: args?.timeoutMs,
            tabId: args?.tabId,
            owner: ownerOf(exec),
          },
          45000,
        )
        if (value && value.ok === false) {
          throw new BridgeError('EVAL_ERROR', value?.error?.message || 'page evaluation failed')
        }
        return value
      },
    })
  }

  // ---------------------------------------------------- 4f. HTTP capture (C2a)
  list.push(...captureTools)

  // ------------------------------------------------------------ 4d. frames
  list.push({
    name: 'chrome_frames',
    description:
      'List the frames of the current DSH session page (main frame plus iframes) via CDP Page.getFrameTree. Set probe:true to also read each frame URL/title/control count with a fixed read-only script in an isolated world (no arbitrary code injection).',
    parameters: {
      type: 'object',
      properties: {
        probe: { type: 'boolean', description: 'Read url/title/control count in every frame.' },
        tabId: { type: 'number', description: 'Optional tab id owned by this session.' },
      },
      additionalProperties: false,
    },
    output: {
      schema: outputSchema({
        tabId: { type: 'number' },
        frames: {
          type: 'array',
          items: { type: 'object', additionalProperties: true },
        },
      }),
      render: (_args, value) => {
        const lines = (value.frames || []).map((frame) => {
          const indent = frame.parentFrameId ? '  ↳ ' : ''
          const probe = frame.probe ? ` controls=${frame.probe.buttons} title=${JSON.stringify(frame.probe.title)}` : frame.probeError ? ` probeError=${frame.probeError}` : ''
          return `${indent}${String(frame.frameId || '').slice(0, 8) || '?'} ${frame.url || ''}${probe}`
        })
        return renderText(`Frames (${lines.length}):\n${lines.join('\n')}`)
      },
    },
    async execute(args, exec) {
      return call('tab.frames', { probe: Boolean(args?.probe), tabId: args?.tabId, owner: ownerOf(exec) }, 30000)
    },
  })

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
  list.push({
    name: 'chrome_download',
    description:
      'List recent Chrome downloads (filename, URL, state, bytes, start time). Use after triggering a download to find the saved file path.',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max entries, 1-100 (default 20).' },
      },
      additionalProperties: false,
    },
    output: {
      schema: outputSchema({
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'number' },
              filename: { type: 'string' },
              url: { type: 'string' },
              state: { type: 'string' },
              bytesReceived: { type: 'number' },
              totalBytes: { type: 'number' },
              startTime: { type: 'string' },
            },
            additionalProperties: true,
          },
        },
      }),
      render: (_args, value) => {
        const lines = (value.items ?? []).map(
          (item) => `${item.state} ${item.totalBytes}B ${item.filename || item.url}`,
        )
        return renderText(lines.length ? lines.join('\n') : '(no downloads)')
      },
    },
    async execute(args) {
      const value = await call('browser.downloads', { limit: args?.limit }, 30000)
      if (!value) throw new BridgeError('INTERNAL', 'extension returned no download list')
      return value
    },
  })

  // ----------------------------------------------------------------- 11. wait
  list.push(readTools.wait)

  // -------------------------------------------------------- 12. close session
  list.push(navigation.closeSession)

  return list
}
