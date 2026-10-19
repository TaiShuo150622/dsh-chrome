/**
 * Viewer input forwarding (Q28): request-body parsing and the click/type/key/
 * scroll/navigate/history mapping onto driver tab.* calls. Input validation,
 * normalization and error codes are unchanged; the HTML poller in viewer-html
 * still posts the same payloads.
 */
import { ViewerError, badRequest, sendJson } from './viewer-auth.js'
import { callDriver, resolveContext } from './viewer-driver.js'

const MAX_BODY_BYTES = 64 * 1024

async function readJsonBody(req) {
  const chunks = []
  let size = 0
  try {
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += buffer.byteLength
      if (size > MAX_BODY_BYTES) throw new ViewerError(413, 'BODY_TOO_LARGE', `request body exceeds ${MAX_BODY_BYTES} bytes`)
      chunks.push(buffer)
    }
  } catch (error) {
    if (error instanceof ViewerError) throw error
    throw badRequest('READ_FAILED', `cannot read request body: ${error?.message || String(error)}`)
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim()
  if (!raw) throw badRequest('INVALID_JSON', 'request body must be a JSON object')
  let value
  try {
    value = JSON.parse(raw)
  } catch {
    throw badRequest('INVALID_JSON', 'request body is not valid JSON')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw badRequest('INVALID_JSON', 'request body must be a JSON object')
  return value
}

function normalizeHttpUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null
  let parsed
  try {
    parsed = new URL(value.trim())
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  if (!parsed.hostname) return null
  return parsed.toString()
}

async function performInput(payload, driver) {
  const kind = typeof payload.kind === 'string' ? payload.kind : ''
  if (kind === 'click') {
    const x = Number(payload.x)
    const y = Number(payload.y)
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw badRequest('INVALID_CLICK', 'click needs finite x and y')
    const requested = Number(payload.clickCount)
    const clickCount = Number.isFinite(requested) ? Math.max(1, Math.min(3, Math.trunc(requested))) : 1
    const result = await callDriver(driver, 'tab.clickAt', { x, y, clickCount })
    return { x, y, clickCount, tabId: result?.tabId ?? null }
  }
  if (kind === 'type') {
    if (typeof payload.text !== 'string') throw badRequest('INVALID_TYPE', 'type needs a text string')
    if (payload.text.length === 0 && payload.replace !== true) throw badRequest('INVALID_TYPE', 'type text is empty; set replace=true to clear the field')
    const params = { text: payload.text }
    if (typeof payload.selector === 'string' && payload.selector) params.selector = payload.selector
    else if (Number.isFinite(Number(payload.ref))) params.ref = Number(payload.ref)
    else params.selector = ':focus'
    if (payload.replace != null) params.replace = Boolean(payload.replace)
    if (payload.submit != null) params.submit = Boolean(payload.submit)
    const result = await callDriver(driver, 'tab.type', params)
    return { value: result?.value ?? null, submitted: result?.submitted === true }
  }
  if (kind === 'key') {
    const key = typeof payload.key === 'string' ? payload.key : ''
    if (!key || key.length > 32 || /[\u0000-\u001f\u007f]/.test(key)) throw badRequest('INVALID_KEY', 'key needs a short printable string')
    await callDriver(driver, 'tab.press', { key })
    return { key }
  }
  if (kind === 'scroll') {
    const deltaY = Number(payload.deltaY)
    if (!Number.isFinite(deltaY) || deltaY === 0) throw badRequest('INVALID_SCROLL', 'scroll needs a non-zero finite deltaY')
    const amount = Math.max(1, Math.min(5000, Math.round(Math.abs(deltaY))))
    const direction = deltaY > 0 ? 'down' : 'up'
    const result = await callDriver(driver, 'tab.scroll', { direction, amount })
    return { direction, amount, x: result?.x ?? null, y: result?.y ?? null }
  }
  if (kind === 'navigate') {
    const url = normalizeHttpUrl(payload.url)
    if (!url) throw badRequest('INVALID_URL', 'navigate needs an http(s) url')
    const result = await callDriver(driver, 'tab.goto', { url })
    return { url: String(result?.url || url), title: result?.title ?? null, loadState: result?.loadState ?? null }
  }
  if (kind === 'history') {
    // Extension beyond the five documented input kinds: the viewer's
    // back/forward/reload buttons map to the driver's history operation.
    const op = typeof payload.op === 'string' ? payload.op : 'reload'
    if (op !== 'back' && op !== 'forward' && op !== 'reload') throw badRequest('INVALID_HISTORY', 'history op must be back, forward or reload')
    const result = await callDriver(driver, 'tab.history', { op })
    return { op, url: result?.url ?? null, title: result?.title ?? null }
  }
  throw badRequest('INVALID_KIND', 'kind must be one of click, type, key, scroll, navigate, history')
}

async function serveInput(req, res, contextId, { getContext, state }) {
  const { driver } = await resolveContext(contextId, getContext)
  const payload = await readJsonBody(req)
  const result = await performInput(payload, driver)
  state.metaCache.delete(contextId)
  sendJson(res, 200, { ok: true, kind: payload.kind, ...result })
}

export { MAX_BODY_BYTES, readJsonBody, normalizeHttpUrl, performInput, serveInput }
