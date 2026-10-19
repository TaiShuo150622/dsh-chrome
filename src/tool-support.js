/**
 * Shared helpers for the chrome_* tools (Q30): URL validation, error
 * normalization, schema/render helpers, and the approval/policy/owner/session
 * plumbing one tool call needs. tools.js stays the registration/assembly
 * module; error codes, approval decisions, audits, lease-release behavior and
 * tool schemas are unchanged.
 */
import path from 'node:path'

import { BridgeError } from './bridge.js'
import { appendAudit, dshHome, loadPolicy, originOf, resolvePolicy } from './policy.js'

const MUTATION_TIMEOUT_MS = 45000

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

export function createToolSupport({ bridge, approval, sessionContext, userQuestions, config }) {
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

  async function guard(exec, toolName, action, { tabId = null, targetUrl = null, allowForeign = false, site: providedSite = null } = {}) {
    if (!exec?.agent) {
      writeAudit(exec, toolName, action, null, 'denied', 'no-agent')
      throw new BridgeError('APPROVAL_DENIED', 'browser actions require a live agent session')
    }
    let site
    let lookupError = null
    if (providedSite) {
      // Callers that own the page (chrome_verify's isolated context) resolve the
      // site from their own driver; the desktop bridge's active tab is not the
      // page the action runs on and must not be consulted.
      site = {
        origin: providedSite.origin ?? originOf(providedSite.url),
        url: String(providedSite.url || ''),
        title: String(providedSite.title || ''),
        tabId: providedSite.tabId ?? (Number.isFinite(tabId) ? tabId : null),
      }
    } else if (targetUrl != null) {
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

  return {
    ownerOf,
    sessionLabel,
    call,
    supports,
    sessionSandboxMode,
    sessionShort,
    sessionCwd,
    lookupSite,
    currentSite,
    writeAudit,
    requestApproval,
    guard,
    hardConfirmAsk,
    allowEvaluate,
    evaluateConfirmTimeoutMs,
    captureConfirmTimeoutMs,
  }
}

export {
  MUTATION_TIMEOUT_MS,
  outputSchema,
  renderText,
  validateTabUrl,
  validateHttpUrl,
  normalize,
  normalizeLeaseError,
}
