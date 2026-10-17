/**
 * DSH Desktop Chrome — MV3 service worker (P0).
 *
 * Keeps one native messaging port to the DSH native host and executes the
 * browser requests the provider sends: status, background-tab navigation,
 * text snapshots, and screenshots via the DevTools protocol.
 */
const HOST_NAME = 'com.deepseek.dsh.chrome'
const VERSION = chrome.runtime.getManifest().version
const SESSION_TAB_KEY = 'dshSessionTabId'

let port = null
let connecting = null
let lastConnectError = null
let sessionTabId = null
let sessionTabLoaded = false

function log(...args) {
  console.log('[DSH Chrome]', ...args)
}

function bridgeError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

// ------------------------------------------------------------- session tab id
async function loadSessionTabId() {
  if (sessionTabLoaded) return sessionTabId
  sessionTabLoaded = true
  try {
    const stored = await chrome.storage.session.get(SESSION_TAB_KEY)
    sessionTabId = Number.isInteger(stored[SESSION_TAB_KEY]) ? stored[SESSION_TAB_KEY] : null
  } catch {
    sessionTabId = null
  }
  return sessionTabId
}

async function setSessionTabId(tabId) {
  sessionTabId = tabId
  sessionTabLoaded = true
  try {
    await chrome.storage.session.set({ [SESSION_TAB_KEY]: tabId })
  } catch {
    // storage.session is best effort; the in-memory value still works for this worker
  }
}

async function requireSessionTabId() {
  const tabId = await loadSessionTabId()
  if (tabId == null) {
    throw bridgeError(
      'NO_SESSION_TAB',
      'No DSH session tab yet. Call chrome_goto with a URL first.',
    )
  }
  try {
    await chrome.tabs.get(tabId)
  } catch {
    await setSessionTabId(null)
    throw bridgeError('TAB_GONE', 'The DSH session tab was closed. Call chrome_goto to open a new one.')
  }
  return tabId
}

// ------------------------------------------------------------ native messaging
function ensurePort() {
  if (port) return Promise.resolve(port)
  if (connecting) return connecting
  connecting = new Promise((resolve) => {
    let settled = false
    let nativePort
    const finish = (value) => {
      if (settled) return
      settled = true
      connecting = null
      resolve(value)
    }
    try {
      nativePort = chrome.runtime.connectNative(HOST_NAME)
    } catch (error) {
      lastConnectError = error?.message || String(error)
      log('connectNative failed', error)
      finish(null)
      return
    }
    nativePort.onMessage.addListener((message) => {
      if (message?.id == null) {
        if (message?.event) log('event', message.event)
        return
      }
      handleRequest(message)
        .then((result) => {
          try {
            nativePort.postMessage({ id: message.id, result })
          } catch (error) {
            log('postMessage result failed', error)
          }
        })
        .catch((error) => {
          try {
            nativePort.postMessage({
              id: message.id,
              error: {
                code: typeof error?.code === 'string' ? error.code : 'INTERNAL',
                message: error?.message || String(error),
              },
            })
          } catch (postError) {
            log('postMessage error failed', postError)
          }
        })
    })
    nativePort.onDisconnect.addListener(() => {
      const lastError = chrome.runtime.lastError
      if (lastError?.message) lastConnectError = lastError.message
      log('native port disconnected', lastError?.message || '')
      if (port === nativePort) port = null
      finish(null)
      // Retry while the worker is alive; the offscreen tick and alarm are the
      // fallback once Chrome evicts it.
      for (const delay of [1000, 3000, 10000]) {
        setTimeout(() => {
          if (!port) ensurePort().catch(() => {})
        }, delay)
      }
    })
    // The host answers hello-ok only after it authenticated against DSH; the
    // provider then starts sending requests. We consider the port usable now.
    port = nativePort
    lastConnectError = null
    finish(nativePort)
  })
  return connecting
}

// Force a fresh native port: used by the popup button and the reconnect alarm
// when a stale port object would otherwise keep us from reconnecting.
function forceReconnect() {
  if (port) {
    try {
      port.disconnect()
    } catch {
      // port may already be gone
    }
    port = null
  }
  return ensurePort()
}

// MV3 worker eviction is the main reason a dead native port goes unnoticed:
// keep a tiny offscreen document that pings the worker every 15s.
async function ensureOffscreen() {
  if (!chrome.offscreen?.createDocument) return
  try {
    const existing = await chrome.offscreen.hasDocument?.()
    if (existing) return
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['BLOBS'],
      justification: 'Keep the DSH native messaging reconnect loop alive.',
    })
  } catch (error) {
    log('offscreen keepalive unavailable', error?.message || error)
  }
}

// ------------------------------------------------------------------- requests
async function handleRequest(message) {
  const method = String(message.method || '')
  const params = message.params || {}
  switch (method) {
    case 'browser.status':
      return { extensionVersion: VERSION, connected: true }
    case 'tab.goto':
      return gotoUrl(String(params.url || ''))
    case 'tab.snapshot':
      return snapshot(params.maxChars)
    case 'tab.screenshot':
      return screenshot()
    default:
      throw bridgeError('UNSUPPORTED', `unknown method: ${method}`)
  }
}

async function gotoUrl(url) {
  if (!/^https?:\/\//i.test(url)) {
    throw bridgeError('PROTECTED_PAGE', 'Only http(s) URLs are allowed.')
  }
  const existing = await loadSessionTabId()
  let tab = null
  if (existing != null) {
    try {
      tab = await chrome.tabs.update(existing, { url })
    } catch {
      await setSessionTabId(null)
    }
  }
  if (!tab) {
    tab = await chrome.tabs.create({ url, active: false, pinned: false })
    await setSessionTabId(tab.id)
  }
  await waitForComplete(tab.id, 45000)
  const updated = await chrome.tabs.get(tab.id)
  return {
    tabId: tab.id,
    url: updated.url || url,
    title: updated.title || '',
    loadState: updated.status || 'complete',
  }
}

function waitForComplete(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    let done = false
    const listener = (updatedId, changeInfo) => {
      if (updatedId === tabId && changeInfo.status === 'complete') finish()
    }
    const timer = setTimeout(() => {
      cleanup()
      reject(bridgeError('TIMEOUT', `tab ${tabId} did not finish loading within ${timeoutMs}ms`))
    }, timeoutMs)
    function cleanup() {
      if (done) return false
      done = true
      clearTimeout(timer)
      chrome.tabs.onUpdated.removeListener(listener)
      return true
    }
    function finish() {
      if (cleanup()) resolve()
    }
    chrome.tabs.onUpdated.addListener(listener)
    chrome.tabs
      .get(tabId)
      .then((tab) => {
        if (tab.status === 'complete') finish()
      })
      .catch(() => {})
  })
}

async function snapshot(maxChars) {
  const tabId = await requireSessionTabId()
  const limit = Number.isFinite(maxChars)
    ? Math.max(1000, Math.min(200000, maxChars))
    : 100000
  let results
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId },
      func: pageSnapshot,
      args: [limit],
    })
  } catch (error) {
    throw bridgeError(
      'PROTECTED_PAGE',
      `cannot read this page (browser-protected or unsupported): ${error?.message || error}`,
    )
  }
  const value = results?.[0]?.result
  if (!value) throw bridgeError('INTERNAL', 'page snapshot returned no result')
  return value
}

async function screenshot() {
  const tabId = await requireSessionTabId()
  const target = { tabId }
  try {
    await chrome.debugger.attach(target, '1.3')
  } catch (error) {
    throw bridgeError('DEBUGGER_FAILED', `cannot attach debugger: ${error?.message || error}`)
  }
  try {
    const response = await chrome.debugger.sendCommand(target, 'Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false,
    })
    if (!response?.data) throw bridgeError('INTERNAL', 'empty screenshot data')
    return { dataBase64: response.data }
  } finally {
    try {
      await chrome.debugger.detach(target)
    } catch {
      // tab may have navigated or closed
    }
  }
}

// ------------------------------------------------------- injected page snapshot
/**
 * Runs inside the page. Must stay self-contained: Chrome serializes this
 * function and its arguments into the page's isolated world.
 */
function pageSnapshot(maxChars) {
  const limit = Number.isFinite(maxChars) ? maxChars : 100000
  const selectors = [
    'a[href]',
    'button',
    'input',
    'select',
    'textarea',
    '[role="button"]',
    '[role="link"]',
    '[role="checkbox"]',
    '[role="tab"]',
    '[onclick]',
  ]
  const seen = new Set()
  const elements = []
  for (const selector of selectors) {
    for (const element of document.querySelectorAll(selector)) {
      if (seen.has(element)) continue
      seen.add(element)
      elements.push(element)
    }
  }
  const isVisible = (element) => {
    const style = getComputedStyle(element)
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
      return false
    }
    if (element.closest('[hidden]')) return false
    const rect = element.getBoundingClientRect()
    return rect.width > 1 && rect.height > 1
  }
  const labelOf = (element) => {
    const aria = element.getAttribute('aria-label')
    if (aria && aria.trim()) return aria.trim().slice(0, 120)
    const text = (element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim()
    if (text) return text.slice(0, 120)
    return (
      element.getAttribute('placeholder') ||
      element.getAttribute('name') ||
      element.getAttribute('title') ||
      element.getAttribute('alt') ||
      ''
    ).slice(0, 120)
  }
  const kindOf = (element) => {
    const tag = element.tagName.toLowerCase()
    if (tag === 'input') return element.getAttribute('type') || 'text'
    if (tag === 'a') return 'link'
    return tag
  }
  const maskedValue = (element) => {
    const tag = element.tagName.toLowerCase()
    if (tag !== 'input' && tag !== 'textarea' && tag !== 'select') return undefined
    const type = (element.getAttribute('type') || '').toLowerCase()
    if (type === 'password' || type === 'hidden') return '••••'
    const autocomplete = (element.getAttribute('autocomplete') || '').toLowerCase()
    const name = (element.getAttribute('name') || '').toLowerCase()
    if (autocomplete.includes('cc-') || autocomplete.includes('password') || /card|otp|token|secret|cvv/.test(name)) {
      return '••••'
    }
    if (type === 'checkbox' || type === 'radio') return element.checked ? 'checked' : 'unchecked'
    const value = element.value
    if (value == null || value === '') return undefined
    return value.length > 80 ? value.slice(0, 80) : value
  }

  const controls = []
  for (const element of elements) {
    if (controls.length >= 400) break
    if (!isVisible(element)) continue
    const ref = controls.length + 1
    try {
      element.setAttribute('data-dsh-ref', String(ref))
    } catch {
      // read-only DOM is fine; the ref still works for this snapshot
    }
    const control = {
      ref,
      tag: element.tagName.toLowerCase(),
      kind: kindOf(element),
      label: labelOf(element),
    }
    const value = maskedValue(element)
    if (value !== undefined) control.value = value
    if (control.tag === 'a') {
      const href = element.getAttribute('href')
      if (href) control.href = href
    }
    controls.push(control)
  }

  const bodyText = (document.body ? document.body.innerText : '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+\n/g, '\n')
    .trim()
  const truncated = bodyText.length > limit
  return {
    title: document.title || '',
    url: location.href,
    controls,
    text: truncated ? bodyText.slice(0, limit) : bodyText,
    truncated,
  }
}

// --------------------------------------------------------------- worker wiring
function ensureReconnectAlarm() {
  try {
    chrome.alarms.create('dsh-chrome-reconnect', { periodInMinutes: 1 })
  } catch {
    // alarms are best effort; the port and popup button still work
  }
}

chrome.runtime.onInstalled.addListener(() => {
  ensureReconnectAlarm()
  ensureOffscreen().catch(() => {})
  ensurePort().catch(() => {})
})
chrome.runtime.onStartup.addListener(() => {
  ensureReconnectAlarm()
  ensureOffscreen().catch(() => {})
  ensurePort().catch(() => {})
})
chrome.tabs.onUpdated.addListener(() => {
  if (!port) forceReconnect().catch(() => {})
})
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== 'dsh-chrome-reconnect') return
  // Force, not "if (!port)": a killed native host can leave a stale port
  // object behind, and then a conditional reconnect never fires.
  forceReconnect().catch(() => {})
})
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'dsh-status') {
    ;(async () => {
      await loadSessionTabId()
      sendResponse({
        connected: Boolean(port),
        extensionVersion: VERSION,
        sessionTabId,
        lastError: lastConnectError,
      })
    })()
    return true
  }
  if (message?.type === 'dsh-tick') {
    if (!port) forceReconnect().catch(() => {})
    return false
  }
  if (message?.type === 'dsh-connect') {
    forceReconnect()
      .catch(() => {})
      .finally(() => {
        setTimeout(() => {
          sendResponse({
            connected: Boolean(port),
            extensionVersion: VERSION,
            sessionTabId,
            lastError: lastConnectError,
          })
        }, 600)
      })
    return true
  }
  return false
})

// Best-effort initial connection when the worker starts. Recreate the alarm on
// every start so a worker eviction cannot silently lose the reconnect timer.
ensureReconnectAlarm()
ensureOffscreen().catch(() => {})
ensurePort().catch(() => {})
