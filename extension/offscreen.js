// Offscreen native-port owner.
//
// MV3 service workers are evicted aggressively; a native messaging port owned
// by the worker dies with it, and reconnecting from inside a dying worker has
// proven unreliable (Chrome tears the fresh host down again). The offscreen
// document is a normal extension page that outlives the worker, so it owns the
// native port: requests from the provider are relayed to the worker, and the
// port is re-opened here whenever the host dies.

const HOST_NAME = 'com.deepseek.dsh.chrome'

let nativePort = null
let connecting = false
let lastError = null
let lastPingAt = 0
let retryDelay = 500
let retryTimer = null

function status() {
  return { connected: Boolean(nativePort), lastError, lastPingAt }
}

function notifyStatus() {
  try {
    chrome.runtime.sendMessage({ type: 'dsh-native-status-changed', status: status() }, () => {
      void chrome.runtime.lastError
    })
  } catch {
    // worker asleep; it will query us when needed
  }
}

function scheduleReconnect() {
  if (retryTimer) return
  const delay = retryDelay
  retryDelay = Math.min(retryDelay * 2, 5000)
  retryTimer = setTimeout(() => {
    retryTimer = null
    connectNative()
  }, delay)
}

function connectNative() {
  if (nativePort || connecting) return
  connecting = true
  let port
  try {
    port = chrome.runtime.connectNative(HOST_NAME)
  } catch (error) {
    connecting = false
    lastError = error?.message || String(error)
    notifyStatus()
    scheduleReconnect()
    return
  }
  nativePort = port
  connecting = false
  lastError = null
  retryDelay = 500
  lastPingAt = Date.now()
  notifyStatus()

  port.onMessage.addListener((message) => {
    lastPingAt = Date.now()
    if (message?.id == null) {
      if (message?.event === 'ext.changed') {
        try {
          chrome.runtime.sendMessage(
            { type: 'dsh-ext-changed', file: message.params?.file || '' },
            () => {
              void chrome.runtime.lastError
            },
          )
        } catch {
          // worker asleep; the host will report again on the next change
        }
      }
      return
    }
    forwardToWorker(port, message)
  })

  port.onDisconnect.addListener(() => {
    const error = chrome.runtime.lastError
    lastError = error?.message || 'native port disconnected'
    nativePort = null
    notifyStatus()
    scheduleReconnect()
  })
}

function forwardToWorker(port, message) {
  let answered = false
  const timer = setTimeout(() => {
    if (answered) return
    answered = true
    try {
      port.postMessage({
        id: message.id,
        error: { code: 'TIMEOUT', message: 'service worker did not answer the browser request' },
      })
    } catch {
      // port already gone
    }
  }, 30000)

  const respond = (payload) => {
    if (answered) return
    answered = true
    clearTimeout(timer)
    try {
      port.postMessage({ id: message.id, ...payload })
    } catch {
      // port already gone
    }
  }

  try {
    chrome.runtime.sendMessage({ type: 'dsh-native-request', message }, (response) => {
      const lastError = chrome.runtime.lastError
      if (lastError) {
        respond({ error: { code: 'WORKER_UNAVAILABLE', message: lastError.message } })
        return
      }
      if (!response) {
        respond({ error: { code: 'WORKER_UNAVAILABLE', message: 'service worker returned no response' } })
        return
      }
      if (response.ok) respond({ result: response.result })
      else respond({ error: response.error || { code: 'INTERNAL', message: 'browser request failed' } })
    })
  } catch (error) {
    respond({ error: { code: 'WORKER_UNAVAILABLE', message: error?.message || String(error) } })
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'dsh-native-status') {
    sendResponse(status())
    return false
  }
  if (message?.type === 'dsh-native-reconnect') {
    if (nativePort && !message.force) {
      sendResponse({ ok: true, connected: true })
      return false
    }
    if (nativePort && message.force) {
      try {
        nativePort.disconnect()
      } catch {
        // already gone
      }
      nativePort = null
    }
    lastError = null
    retryDelay = 500
    connectNative()
    sendResponse({ ok: true })
    return false
  }
  return false
})

// Health check: if the port is missing, keep trying even when no worker event
// arrives (e.g. right after Chrome re-launches the extension).
setInterval(() => {
  if (!nativePort && !connecting) connectNative()
}, 10000)

connectNative()
