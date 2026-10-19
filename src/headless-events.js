/**
 * Console buffer and CDP event mapping for the headless backend.
 *
 * Kept out of `headless.js` so the console/network capture contract (buffer
 * limit, text truncation, URL redaction, body budgets) is a small unit that can
 * be tested without a live driver. Behavior is intentionally unchanged:
 * `test/headless.mjs` and `test/capture-parity.mjs` are the regression net.
 *
 * The driver still owns the state (`consoleBuffers`, `captureByTab`, `cdp`);
 * these functions only mutate the buffer/capture objects they are handed.
 */
import {
  CAPTURE_REQUEST_BODY_CHARS,
  CAPTURE_RESPONSE_BODY_CHARS,
  materializeCaptureBody,
  redactUrl,
} from './headless-redact.js'

export const CONSOLE_BUFFER_LIMIT = 200
const CONSOLE_TEXT_LIMIT = 2000

/** Append one console entry, keeping the newest CONSOLE_BUFFER_LIMIT entries. */
export function recordConsole(buffers, tab, entry) {
  if (!buffers || !tab) return
  const list = buffers.get(tab.tabId) || []
  list.push({ ...entry, time: Date.now() })
  while (list.length > CONSOLE_BUFFER_LIMIT) list.shift()
  buffers.set(tab.tabId, list)
}

/**
 * Map Runtime.consoleAPICalled / Runtime.exceptionThrown into the console
 * buffer. Returns true when the event was consumed.
 */
export function handleConsoleEvent(buffers, tab, method, params = {}) {
  if (method === 'Runtime.consoleAPICalled') {
    const text = (params.args || [])
      .map((arg) => (arg.value != null ? String(arg.value) : arg.description || arg.type || 'undefined'))
      .join(' ')
    recordConsole(buffers, tab, { level: String(params.type || 'log'), text: text.slice(0, CONSOLE_TEXT_LIMIT) })
    return true
  }
  if (method === 'Runtime.exceptionThrown') {
    const details = params.exceptionDetails || {}
    const text = details.exception?.description || details.text || 'uncaught exception'
    recordConsole(buffers, tab, { level: 'error', text: String(text).slice(0, CONSOLE_TEXT_LIMIT) })
    return true
  }
  return false
}

/**
 * Map a Network.* CDP event into the active capture for `tab`.
 *
 * `send(method, params, sessionId)` performs the CDP round trip; body reads are
 * best-effort and tracked so a burst of requests cannot fan out unbounded.
 */
export function handleNetworkEvent(tab, capture, send, method, params = {}) {
  if (!tab || !capture || !capture.active) return
  const requestId = params.requestId
  if (method === 'Network.requestWillBeSent') {
    const resourceType = String(params.type || 'other').toLowerCase()
    if (!capture.resourceTypes.includes(resourceType)) return
    if (capture.entries.length >= capture.maxEntries) {
      // Keep the newest requests: drop the oldest entry, like the extension.
      const removed = capture.entries.shift()
      if (removed) capture.byId.delete(String(removed.id))
      capture.dropped += 1
    }
    const wallTime = Number(params.wallTime)
    const entry = {
      id: String(requestId),
      method: String(params.request?.method || 'GET'),
      url: redactUrl(params.request?.url),
      resourceType,
      timestamp: Number.isFinite(wallTime) ? Math.round(wallTime * 1000) : Date.now(),
      startTime: Date.now(),
      wallTime: Number.isFinite(wallTime) ? wallTime : null,
      startMono: params.timestamp ?? null,
      documentURL: params.documentURL ? redactUrl(params.documentURL) : null,
      hasPostData: Boolean(params.request?.hasPostData || params.request?.postData),
    }
    capture.byId.set(String(requestId), entry)
    capture.entries.push(entry)
    if (params.request?.postData) entry._postDataRaw = String(params.request.postData)
    return
  }
  const entry = capture.byId.get(String(requestId))
  if (!entry) return
  if (method === 'Network.responseReceived') {
    const response = params.response || {}
    entry.status = response.status
    entry.statusText = String(response.statusText || '')
    entry.mimeType = String(response.mimeType || '')
    entry.fromServiceWorker = Boolean(response.fromServiceWorker)
    if (Number.isFinite(response.encodedDataLength)) entry.encodedDataLength = response.encodedDataLength
    if (response.fromDiskCache || response.fromMemoryCache || response.fromPrefetchCache) entry.fromCache = true
    entry.responseAt = Date.now()
    return
  }
  if (method === 'Network.requestServedFromCache') {
    entry.fromCache = true
    return
  }
  if (method === 'Network.loadingFailed') {
    entry.failed = true
    entry.canceled = Boolean(params.canceled)
    entry.errorText = String(params.errorText || '')
    entry.durationMs = entry.startMono != null ? Math.round((params.timestamp - entry.startMono) * 1000) : null
    return
  }
  if (method === 'Network.loadingFinished') {
    entry.durationMs = entry.startMono != null ? Math.round((params.timestamp - entry.startMono) * 1000) : null
    entry.finishedAt = Date.now()
    if (Number.isFinite(params.encodedDataLength)) entry.encodedDataLength = params.encodedDataLength
    if (!capture.storeBodies) return
    if (!['xhr', 'fetch', 'document'].includes(entry.resourceType)) return
    if (capture.bodyTasks >= 4) {
      entry.bodyUnavailable = 'burst'
      return
    }
    capture.bodyTasks += 1
    const bodyTask = (async () => {
      try {
        const response = await send('Network.getResponseBody', { requestId: String(requestId) }, tab.sessionId)
        const raw = response?.base64Encoded
          ? Buffer.from(response.body || '', 'base64').toString('utf8')
          : String(response?.body ?? '')
        const materialized = materializeCaptureBody(capture, raw, entry.mimeType, CAPTURE_RESPONSE_BODY_CHARS)
        if (materialized) {
          entry.responseBody = materialized.text
          entry.bodyTruncated = materialized.truncated
          entry.redacted = true
        }
      } catch {
        entry.bodyUnavailable = 'evicted'
      }
      if (entry._postDataRaw == null && entry.hasPostData) {
        try {
          const request = await send('Network.getRequestPostData', { requestId: String(requestId) }, tab.sessionId)
          if (request?.postData) entry._postDataRaw = String(request.postData)
        } catch {
          // request body unavailable
        }
      }
      if (entry._postDataRaw != null) {
        const requestMime = /^{|^\[/.test(String(entry._postDataRaw).trim())
          ? 'application/json'
          : 'application/x-www-form-urlencoded'
        const materialized = materializeCaptureBody(capture, entry._postDataRaw, requestMime, CAPTURE_REQUEST_BODY_CHARS)
        if (materialized) {
          entry.requestBody = materialized.text
          entry.redacted = true
        }
        delete entry._postDataRaw
      }
      capture.bodyTasks -= 1
    })()
    capture.bodyTasksSet = capture.bodyTasksSet || new Set()
    capture.bodyTasksSet.add(bodyTask)
    bodyTask.finally(() => capture.bodyTasksSet.delete(bodyTask))
  }
}
