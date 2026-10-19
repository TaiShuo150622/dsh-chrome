/**
 * Scheme A prototype: a per-context browser viewer served by the Host web
 * server. No DSH client plugin or bundle is required — the user opens a
 * loopback URL with a random token and gets a small polling screenshot viewer
 * with basic input forwarding.
 *
 * Routes (all loopback-only, all token+capability checked, no CDP surface):
 *   GET  /dsh-chrome/context/:id/view?token=...&access=...   inline HTML (no external assets)
 *   GET  /dsh-chrome/context/:id/frame?token=...&access=...  one driver screenshot (JPEG/PNG)
 *   POST /dsh-chrome/context/:id/input?token=...&access=...  JSON input -> driver tab.* call
 *
 * `access` is a per-run random capability bound to one contextId. It is only
 * handed out through `urlFor(contextId)` (Host/test API) and `openFor(contextId)`
 * (which writes the URL to a 0600 local handoff file for the model), so knowing
 * the global token is not enough to reach a context the caller was not given a
 * URL for. Tool results never carry the bearer URL (H3).
 *
 * Input forwarding is read-only by default: the human opts in with
 * `contextViewer.allowInput:true`; accepted writes are appended to audit.jsonl.
 *
 * `getContext(contextId)` is injected by the caller and returns
 * `{ driver, owner? }` or null. The viewer uses the context owner (the DSH
 * session that created it) so it sees and controls the same tab as that session;
 * it falls back to the fixed `viewer` owner for standalone/test contexts.
 */
import fsp from 'node:fs/promises'

import { appendAudit } from './policy.js'
import {
  CONTEXT_ID_PATTERN,
  MAX_CONTEXT_ID_LENGTH,
  ROUTE_PREFIX,
  ViewerError,
  accessFor,
  badRequest,
  defaultHome,
  isLoopback,
  methodNotAllowed,
  normalizeToken,
  parseRoute,
  parseUrl,
  plain,
  readOrCreateToken,
  readOrigin,
  requireAccess,
  sendJson,
  tokenMatches,
  tokenPath,
} from './viewer-auth.js'
import { callDriver, resolveContext } from './viewer-driver.js'
import { serveInput } from './viewer-input.js'
import { viewerHtml } from './viewer-html.js'
import { viewerOpenHint, writeViewerUrlFile } from './viewer-open.js'

const META_CACHE_MS = 750

function screenshotFormat(searchParams) {
  const format = searchParams?.get('format') === 'png' ? 'png' : 'jpeg'
  const rawQuality = searchParams?.get('quality')
  const parsedQuality = rawQuality == null || rawQuality === '' ? Number.NaN : Number(rawQuality)
  const quality = Number.isFinite(parsedQuality) ? Math.max(1, Math.min(100, Math.round(parsedQuality))) : 70
  return { format, quality }
}

async function readScreenshotData(shot) {
  if (Buffer.isBuffer(shot)) return shot
  if (typeof shot?.path === 'string' && shot.path) {
    try {
      return await fsp.readFile(shot.path)
    } catch (error) {
      throw new ViewerError(500, 'SCREENSHOT_UNAVAILABLE', `cannot read screenshot ${shot.path}: ${error?.message || String(error)}`)
    }
  }
  if (Buffer.isBuffer(shot?.data)) return shot.data
  if (typeof shot?.data === 'string' && shot.data) return Buffer.from(shot.data, 'base64')
  throw new ViewerError(500, 'SCREENSHOT_UNAVAILABLE', 'driver returned no screenshot data or path')
}

function captureFrame(contextId, driver, params, state) {
  const key = `${contextId}:${params.format}:${params.quality}`
  const pending = state.inflight.get(key)
  if (pending) return pending
  const promise = callDriver(driver, 'tab.screenshot', params).finally(() => state.inflight.delete(key))
  state.inflight.set(key, promise)
  return promise
}

async function readTabMeta(contextId, driver, state) {
  const cached = state.metaCache.get(contextId)
  if (cached && Date.now() - cached.at < META_CACHE_MS) return cached.value
  const list = await callDriver(driver, 'tab.tabs', { op: 'list' })
  const tabs = Array.isArray(list?.tabs) ? list.tabs : []
  const active =
    list?.activeTabId != null
      ? tabs.find((tab) => tab.tabId === list.activeTabId)
      : tabs.find((tab) => tab.active === true)
  const value = active
    ? { tabId: active.tabId ?? null, url: String(active.url || ''), title: String(active.title || '') }
    : null
  state.metaCache.set(contextId, { at: Date.now(), value })
  return value
}

function encodedHeader(value, maxChars) {
  return encodeURIComponent(String(value || '').slice(0, maxChars))
}

async function serveView(res, contextId, { getContext, state }) {
  await resolveContext(contextId, getContext)
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-security-policy':
      "default-src 'none'; img-src blob: data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'none'; base-uri 'none'",
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
  })
  res.end(viewerHtml({ contextId, token: state.token, access: accessFor(state, contextId) }))
}

async function serveFrame(res, contextId, searchParams, { getContext, state, logger }) {
  const { driver } = await resolveContext(contextId, getContext)
  const { format, quality } = screenshotFormat(searchParams)
  let meta = null
  if (searchParams.get('meta') === '1') {
    try {
      meta = await readTabMeta(contextId, driver, state)
    } catch (error) {
      logger?.warn?.('dsh-chrome: context viewer metadata failed for %s: %s', contextId, error?.message || String(error))
    }
  }
  const shot = await captureFrame(contextId, driver, { format, quality }, state)
  const data = await readScreenshotData(shot)
  const headers = {
    'content-type': shot?.mediaType === 'image/png' || shot?.mediaType === 'image/jpeg' ? shot.mediaType : format === 'png' ? 'image/png' : 'image/jpeg',
    'cache-control': 'no-store, max-age=0',
    'content-length': data.byteLength,
    'x-content-type-options': 'nosniff',
  }
  if (Number.isFinite(Number(shot?.width)) && Number(shot.width) > 0) headers['x-dsh-view-width'] = String(Math.round(Number(shot.width)))
  if (Number.isFinite(Number(shot?.height)) && Number(shot.height) > 0) headers['x-dsh-view-height'] = String(Math.round(Number(shot.height)))
  if (meta?.url) headers['x-dsh-context-url'] = encodedHeader(meta.url, 2000)
  if (meta?.title) headers['x-dsh-context-title'] = encodedHeader(meta.title, 200)
  if (meta?.tabId != null) headers['x-dsh-context-tab'] = String(meta.tabId)
  res.writeHead(200, headers)
  res.end(data)
}

async function dispatch(req, res, deps) {
  let asJson = false
  try {
    if (!isLoopback(req)) throw new ViewerError(403, 'LOOPBACK_ONLY', 'the context viewer only accepts loopback requests')
    const parsed = parseUrl(req?.url)
    if (!parsed) throw badRequest('BAD_URL', 'invalid request URL')
    if (!tokenMatches(parsed.token, deps.state.token)) {
      throw new ViewerError(403, 'INVALID_TOKEN', 'invalid or missing viewer token')
    }
    const route = parseRoute(parsed.pathname)
    if (!route) throw new ViewerError(404, 'NOT_FOUND', 'not found')
    requireAccess(deps.state, route.contextId, parsed.access)
    if (route.action === 'view') {
      if (req.method !== 'GET') throw methodNotAllowed('GET')
      await serveView(res, route.contextId, deps)
      return
    }
    if (route.action === 'frame') {
      if (req.method !== 'GET') throw methodNotAllowed('GET')
      await serveFrame(res, route.contextId, parsed.searchParams, deps)
      return
    }
    if (req.method !== 'POST') throw methodNotAllowed('POST')
    asJson = true
    // Input is a browser write. Default read-only: the human must opt in with
    // `contextViewer.allowInput:true`, and every accepted write is audited.
    if (!deps.state.allowInput) {
      deps.audit?.({ action: 'viewer-input', decision: 'denied', reason: 'viewer-read-only' })
      throw new ViewerError(
        403,
        'VIEWER_READ_ONLY',
        'context viewer input is disabled (read-only); set contextViewer.allowInput=true in the provider config to opt in',
      )
    }
    await serveInput(req, res, route.contextId, {
      ...deps,
      audit: (entry) =>
        deps.audit?.({
          action: `viewer-input:${entry.kind}`,
          decision: 'allowed',
          reason: 'viewer-input-opt-in',
          owner: entry.owner,
        }),
    })
  } catch (error) {
    if (res.writableEnded) return
    const status = error instanceof ViewerError ? error.status : 500
    const code = error instanceof ViewerError ? error.code : 'INTERNAL'
    const message = error instanceof ViewerError ? error.message : `context viewer failed: ${error?.message || String(error)}`
    if (status >= 500) deps.logger?.warn?.('dsh-chrome: context viewer request failed (%s): %s', code, message)
    if (asJson) sendJson(res, status, { ok: false, error: { code, message } })
    else plain(res, status, message, error instanceof ViewerError ? error.headers : null)
  }
}

function disabledViewer() {
  return { enabled: false, token: null, urlFor: () => null, openFor: () => null, dispose: () => {} }
}

/**
 * Register the per-context viewer routes on the Host web server.
 *
 * @param {object} options
 * @param {{register: Function, getOrigin?: Function}} options.webServer Host web server service.
 * @param {(contextId: string) => ({driver: object, owner?: string} | null | Promise<...>)} options.getContext Context lookup.
 * @param {string} [options.token] Optional existing token (memory only); generated/persisted otherwise.
 * @param {boolean} [options.allowInput] Explicit opt-in for viewer click/type/key input (default false: read-only).
 * @param {{info?: Function, warn?: Function}} [options.logger]
 * @param {string} [options.home] DSH home for the token file (defaults to DSH_HOME or ~/.dsh).
 * @returns {{enabled: boolean, token: string|null, urlFor: (contextId: string) => string|null, openFor: (contextId: string) => ({urlFile: string, hint: string}|null), dispose: () => void}}
 */
export function registerContextViewer({ webServer, getContext, token, allowInput = false, logger = null, home = defaultHome() } = {}) {
  if (!webServer || typeof webServer.register !== 'function') {
    logger?.warn?.('dsh-chrome: context viewer disabled (Host webServer is unavailable)')
    return disabledViewer()
  }
  if (typeof getContext !== 'function') {
    logger?.warn?.('dsh-chrome: context viewer disabled (getContext is required)')
    return disabledViewer()
  }
  const callerToken = normalizeToken(token)
  let viewerToken = callerToken
  if (token != null && !viewerToken) logger?.warn?.('dsh-chrome: context viewer ignored an invalid token and generated a new one')
  if (!viewerToken) viewerToken = readOrCreateToken(home)

  const state = {
    token: viewerToken,
    origin: readOrigin(webServer),
    allowInput: allowInput === true,
    disposed: false,
    inflight: new Map(),
    metaCache: new Map(),
    access: new Map(),
  }
  // Viewer input is a browser write outside the tool layer; keep it in the
  // same audit log as guarded chrome_* writes. Audit failures never block.
  const audit = (record) => {
    appendAudit(home, {
      ts: new Date().toISOString(),
      session: record.owner ? String(record.owner) : null,
      tool: 'context-viewer',
      origin: null,
      tabId: null,
      action: String(record.action || '').slice(0, 300),
      decision: record.decision === 'allowed' ? 'allowed' : 'denied',
      reason: String(record.reason || '').slice(0, 300),
    })
  }
  let disposeRoute
  try {
    disposeRoute = webServer.register({
      kind: 'prefix',
      path: ROUTE_PREFIX,
      handler: (req, res) => dispatch(req, res, { getContext, logger, state, audit }),
    })
  } catch (error) {
    logger?.warn?.('dsh-chrome: context viewer registration failed: %s', error?.message || String(error))
    return disabledViewer()
  }

  logger?.info?.(
    'dsh-chrome: context viewer registered at %s (token file %s, input %s)',
    `${state.origin || '<origin unavailable>'}${ROUTE_PREFIX}/:id/view`,
    callerToken != null ? '<memory only>' : tokenPath(home),
    state.allowInput ? 'opt-in' : 'read-only',
  )

  function issueUrl(contextId) {
    if (state.disposed) return null
    const id = String(contextId ?? '')
    if (!id || id.length > MAX_CONTEXT_ID_LENGTH || !CONTEXT_ID_PATTERN.test(id)) return null
    const origin = state.origin || readOrigin(webServer)
    if (!origin) return null
    state.origin = origin
    const access = accessFor(state, id)
    return `${origin}${ROUTE_PREFIX}/${encodeURIComponent(id)}/view?token=${encodeURIComponent(viewerToken)}&access=${encodeURIComponent(access)}`
  }

  return {
    enabled: true,
    token: viewerToken,
    urlFor: issueUrl,
    openFor(contextId) {
      const url = issueUrl(contextId)
      if (!url) return null
      try {
        const urlFile = writeViewerUrlFile(home, `context-${String(contextId)}`, url)
        return { urlFile, hint: viewerOpenHint(urlFile, 'context viewer') }
      } catch {
        return null
      }
    },
    dispose() {
      if (state.disposed) return
      state.disposed = true
      state.inflight.clear()
      state.metaCache.clear()
      state.access.clear()
      try {
        disposeRoute?.()
      } catch {
        // unloading continues
      }
    },
  }
}

