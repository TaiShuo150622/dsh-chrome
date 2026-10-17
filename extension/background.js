/**
 * DSH Desktop Chrome — MV3 service worker (P0).
 *
 * Keeps one native messaging port to the DSH native host and executes the
 * browser requests the provider sends: status, background-tab navigation,
 * text snapshots, and screenshots via the DevTools protocol.
 */
const HOST_NAME = 'com.deepseek.dsh.chrome'
const VERSION = chrome.runtime.getManifest().version

let port = null
let connecting = null
let lastConnectError = null
let lastNativeSignalAt = 0

function log(...args) {
  console.log('[DSH Chrome]', ...args)
}

function bridgeError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

// --------------------------------------------------------------- session state
// owner (DSH session id) -> { tabIds, groupId, activeTabId }
const SESSIONS_KEY = 'dshSessions'
let sessionsCache = null
let sessionsLoaded = false

async function loadSessions() {
  if (sessionsLoaded) return sessionsCache
  sessionsLoaded = true
  try {
    const stored = await chrome.storage.session.get(SESSIONS_KEY)
    sessionsCache =
      stored[SESSIONS_KEY] && typeof stored[SESSIONS_KEY] === 'object' ? stored[SESSIONS_KEY] : {}
  } catch {
    sessionsCache = {}
  }
  return sessionsCache
}

async function saveSessions() {
  try {
    await chrome.storage.session.set({ [SESSIONS_KEY]: sessionsCache || {} })
  } catch {
    // storage.session is best effort; in-memory state still works for this worker
  }
}

function ownerKey(owner) {
  return String(owner || 'default')
}

function ownerShort(owner) {
  return ownerKey(owner).slice(-6)
}

async function tabExists(tabId) {
  try {
    await chrome.tabs.get(tabId)
    return true
  } catch {
    return false
  }
}

async function getSessionEntry(owner) {
  const sessions = await loadSessions()
  const key = ownerKey(owner)
  let entry = sessions[key]
  if (!entry) {
    entry = { tabIds: [], groupId: null, activeTabId: null }
    sessions[key] = entry
  }
  if (!Array.isArray(entry.tabIds)) entry.tabIds = []
  const alive = []
  for (const id of entry.tabIds) {
    if (await tabExists(id)) alive.push(id)
  }
  entry.tabIds = alive
  if (entry.activeTabId != null && !alive.includes(entry.activeTabId)) {
    entry.activeTabId = alive.length ? alive[alive.length - 1] : null
  }
  if (entry.activeTabId == null && alive.length) entry.activeTabId = alive[alive.length - 1]
  if (!alive.length) entry.groupId = null
  return entry
}

async function attachGroup(owner, entry, tabIds) {
  try {
    if (entry.groupId != null) {
      try {
        await chrome.tabs.group({ tabIds, groupId: entry.groupId })
        return
      } catch {
        entry.groupId = null
      }
    }
    const groupId = await chrome.tabs.group({ tabIds })
    entry.groupId = groupId
    await chrome.tabGroups.update(groupId, {
      title: `DSH · ${ownerShort(owner)}`,
      color: 'blue',
      collapsed: true,
    })
  } catch (error) {
    log('tab group unavailable', error?.message || error)
  }
}

async function addTabToSession(owner, tab, { activate = true } = {}) {
  const entry = await getSessionEntry(owner)
  entry.tabIds.push(tab.id)
  if (activate) entry.activeTabId = tab.id
  await attachGroup(owner, entry, [tab.id])
  await saveSessions()
  return entry
}

async function requireTabId(owner) {
  const entry = await getSessionEntry(owner)
  if (entry.activeTabId == null) {
    throw bridgeError('NO_SESSION_TAB', 'No DSH session tab yet. Call chrome_goto with a URL first.')
  }
  return entry.activeTabId
}

async function resolveOwnedTabId(owner, tabId) {
  if (tabId == null) return requireTabId(owner)
  const entry = await getSessionEntry(owner)
  if (!entry.tabIds.includes(tabId)) {
    throw bridgeError('TAB_NOT_FOUND', `tab ${tabId} is not owned by this session`)
  }
  return tabId
}

async function firstActiveTabId() {
  const sessions = await loadSessions()
  for (const entry of Object.values(sessions)) {
    if (entry && entry.activeTabId != null) return entry.activeTabId
  }
  return null
}

async function closeSessionTabs(owner) {
  const sessions = await loadSessions()
  const key = ownerKey(owner)
  const entry = sessions[key]
  if (!entry) return { closed: 0 }
  let closed = 0
  for (const id of entry.tabIds) {
    try {
      await chrome.tabs.remove(id)
      closed += 1
    } catch {
      // already gone
    }
  }
  delete sessions[key]
  await saveSessions()
  return { closed }
}

// Development auto-reload: the native host watches extension/ and emits
// ext.changed; debounce so a burst of file writes reloads once.
let extensionReloadTimer = null
function scheduleExtensionReload() {
  if (extensionReloadTimer) clearTimeout(extensionReloadTimer)
  extensionReloadTimer = setTimeout(() => {
    extensionReloadTimer = null
    try {
      chrome.runtime.reload()
    } catch (error) {
      log('extension reload failed', error?.message || error)
    }
  }, 800)
}

// Native-port self-heal: if Chrome keeps refusing to relaunch the host after a
// crash, reload the extension once (a reload always restores the port in real
// testing). Capped so a broken native-host manifest cannot cause a reload loop.
let nativeFailureTimes = []
let selfHealTimer = null

async function maybeSelfHeal() {
  const now = Date.now()
  nativeFailureTimes = nativeFailureTimes.filter((time) => now - time < 120000)
  nativeFailureTimes.push(now)
  if (nativeFailureTimes.length < 2 || selfHealTimer) return
  let attempts = 0
  try {
    const stored = await chrome.storage.local.get('dshSelfHeal')
    attempts = stored?.dshSelfHeal?.count || 0
  } catch {
    attempts = 0
  }
  if (attempts >= 5) {
    log('native port keeps failing; self-heal limit reached')
    return
  }
  try {
    await chrome.storage.local.set({ dshSelfHeal: { count: attempts + 1, at: now } })
  } catch {
    // storage unavailable; rely on in-memory guard
  }
  log('native port keeps failing; reloading extension to restore it')
  selfHealTimer = setTimeout(() => {
    selfHealTimer = null
    try {
      chrome.runtime.reload()
    } catch (error) {
      log('self-heal reload failed', error?.message || error)
    }
  }, 1200)
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
      lastNativeSignalAt = Date.now()
      if (message?.id == null) {
        if (message?.event === 'ext.changed') {
          log('extension files changed; reloading', message.params?.file || '')
          scheduleExtensionReload()
          return
        }
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
      // Do NOT reconnect from inside this dying worker context: Chrome tears
      // down the freshly spawned host together with the old context. A fresh
      // wake-up (alarm / keepalive message / tab update) reconnects instead.
      try {
        chrome.alarms.create('dsh-chrome-reconnect-once', { delayInMinutes: 0.2 })
      } catch {
        // alarms unavailable; content-script keepalive still wakes us
      }
      maybeSelfHeal().catch(() => {})
    })
    // The host answers hello-ok only after it authenticated against DSH; the
    // provider then starts sending requests. We consider the port usable now.
    port = nativePort
    lastNativeSignalAt = Date.now()
    lastConnectError = null
    finish(nativePort)
  })
  return connecting
}

// Force a fresh native port: used by the popup button and the reconnect alarm
// when a stale port object would otherwise keep us from reconnecting.
function forceReconnect({ force = false } = {}) {
  if (port && !force) return Promise.resolve(port)
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
  const owner = params.owner ?? 'default'
  switch (method) {
    case 'browser.status':
      return { extensionVersion: VERSION, connected: true }
    case 'tab.goto':
      return gotoUrl(owner, String(params.url || ''))
    case 'tab.snapshot':
      return snapshot(owner, params)
    case 'tab.screenshot':
      return screenshot(owner, params)
    case 'tab.find':
      return find(owner, params)
    case 'tab.hover':
      return hover(owner, params)
    case 'tab.click':
      return click(owner, params)
    case 'tab.type':
      return typeText(owner, params)
    case 'tab.press':
      return press(owner, params)
    case 'tab.scroll':
      return scroll(owner, params)
    case 'tab.history':
      return history(owner, params)
    case 'tab.tabs':
      return tabs(owner, params)
    case 'tab.claim':
      return claimTab(owner, params)
    case 'tab.upload':
      return uploadFiles(owner, params)
    case 'browser.downloads':
      return listDownloads(params)
    case 'tab.select':
      return selectAgent(owner, params)
    case 'tab.get_text':
      return getTextAgent(owner, params)
    case 'tab.console':
      return readConsoleAgent(owner, params)
    case 'tab.network':
      return readNetworkAgent(owner, params)
    case 'tab.wait':
      return wait(owner, params)
    case 'tab.close_session':
      return closeSessionTabs(owner)
    default:
      throw bridgeError('UNSUPPORTED', `unknown method: ${method}`)
  }
}

async function gotoUrl(owner, url) {
  if (!/^https?:\/\//i.test(url)) {
    throw bridgeError('PROTECTED_PAGE', 'Only http(s) URLs are allowed.')
  }
  const entry = await getSessionEntry(owner)
  let tabId = entry.activeTabId
  if (tabId == null) {
    const tab = await chrome.tabs.create({ url, active: false, pinned: false })
    tabId = tab.id
    await addTabToSession(owner, tab)
  } else {
    await chrome.tabs.update(tabId, { url })
  }
  await waitForComplete(tabId, 45000)
  const updated = await chrome.tabs.get(tabId)
  return {
    tabId,
    url: updated.url || url,
    title: updated.title || '',
    loadState: updated.status || 'complete',
  }
}

// Page actions run through the DevTools protocol. Content-script messaging and
// chrome.scripting both proved unreliable for background/collapsed-group tabs
// (messages queued forever); CDP Runtime.evaluate stays responsive and is the
// same channel that already captures screenshots.
const PAGE_ACTIONS = {
  snapshot: pageSnapshot,
  hover: hoverByRef,
  click: clickByRef,
  type: typeIntoRef,
  press: pressKey,
  scroll: scrollPage,
  find: findInPage,
  getText,
  select: selectByRef,
  console: readConsole,
  consoleClear: clearConsoleBuffer,
  network: readNetwork,
  hasText,
}

// Virtual cursor: a small DSH-colored pointer injected into the page so the
// user can see where the agent is acting (Codex-style "own cursor"). It is a
// DOM overlay; screenshots taken right after an action include it.
const CURSOR_HELPER_SRC = `
(() => {
  if (window.__dshCursor) return
  const ID = '__dsh_cursor__'
  window.__dshCursor = (x, y, kind) => {
    try {
      let cursor = document.getElementById(ID)
      if (!cursor) {
        cursor = document.createElement('div')
        cursor.id = ID
        cursor.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none;opacity:0;transition:transform .22s cubic-bezier(.2,.8,.2,1),opacity .2s'
        const ring = document.createElement('div')
        ring.style.cssText = 'position:absolute;left:-14px;top:-14px;width:28px;height:28px;border-radius:50%;border:2px solid rgba(0,122,255,.55);opacity:0;transition:opacity .2s,transform .3s'
        const dot = document.createElement('div')
        dot.style.cssText = 'position:absolute;left:-7px;top:-7px;width:14px;height:14px;border-radius:50%;background:rgba(0,122,255,.95);border:2px solid #fff;box-shadow:0 1px 6px rgba(0,0,0,.35)'
        cursor.appendChild(ring)
        cursor.appendChild(dot)
        document.documentElement.appendChild(cursor)
      }
      cursor.style.transform = 'translate(' + x + 'px,' + y + 'px)'
      cursor.style.opacity = '1'
      if (kind === 'click' || kind === 'type' || kind === 'key') {
        const ring = cursor.firstChild
        ring.style.transition = 'none'
        ring.style.opacity = '1'
        ring.style.transform = 'scale(.6)'
        requestAnimationFrame(() => {
          ring.style.transition = 'opacity .35s,transform .35s'
          ring.style.opacity = '0'
          ring.style.transform = 'scale(2.4)'
        })
      }
      clearTimeout(cursor.__dshTimer)
      cursor.__dshTimer = setTimeout(() => { cursor.style.opacity = '0' }, 900)
    } catch {}
  }
})();
`

function withTimeout(promise, timeoutMs, code, message) {
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => setTimeout(() => reject(bridgeError(code, message)), timeoutMs)),
  ])
}

function dialogPolicy(dialogOptions, opening) {
  const options = dialogOptions && typeof dialogOptions === 'object' ? dialogOptions : {}
  const type = String(opening?.type || 'alert')
  if (typeof options.accept === 'boolean') {
    return { accept: options.accept, promptText: String(options.promptText ?? '') }
  }
  // Safe defaults: alerts are dismissed (they carry no decision); confirms and
  // prompts are dismissed unless the model explicitly opts into accepting.
  if (type === 'alert') return { accept: true, promptText: '' }
  return { accept: false, promptText: '' }
}

async function evalInTab(tabId, fn, args, timeoutMs, dialogOptions) {
  const target = { tabId }
  let attached = false
  const dialogs = []
  const onEvent = (source, method, params) => {
    if (source?.tabId !== tabId || method !== 'Page.javascriptDialogOpening') return
    const policy = dialogPolicy(dialogOptions, params)
    dialogs.push({
      type: String(params?.type || 'alert'),
      message: String(params?.message || '').slice(0, 500),
      accepted: policy.accept,
    })
    chrome.debugger
      .sendCommand(target, 'Page.handleJavaScriptDialog', {
        accept: policy.accept,
        promptText: policy.promptText,
      })
      .catch(() => {})
  }
  try {
    await chrome.debugger.attach(target, '1.3')
    attached = true
  } catch {
    // A previous detach may have raced; try to use the existing session.
  }
  try {
    try {
      await chrome.debugger.sendCommand(target, 'Page.enable')
      chrome.debugger.onEvent.addListener(onEvent)
    } catch {
      // dialog interception unavailable; evaluation still works
    }
    const expression = `(() => { ${CURSOR_HELPER_SRC}
      return (${fn.toString()})(...${JSON.stringify(args)})
    })()`
    const response = await withTimeout(
      chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
      }),
      timeoutMs,
      'TIMEOUT',
      `page action timed out after ${timeoutMs}ms`,
    )
    if (response?.exceptionDetails) {
      const text = response.exceptionDetails.exception?.description || response.exceptionDetails.text || 'page action failed'
      throw bridgeError('INTERNAL', String(text))
    }
    return { value: response?.result?.value, dialogs }
  } finally {
    try {
      chrome.debugger.onEvent.removeListener(onEvent)
    } catch {
      // listener may not have been added
    }
    if (attached) {
      try {
        await chrome.debugger.detach(target)
      } catch {
        // tab may have closed or detached already
      }
    }
  }
}

async function callInPage(tabId, action, args = [], timeoutMs = 15000, dialogOptions = null) {
  const fn = PAGE_ACTIONS[action]
  if (!fn) throw bridgeError('UNSUPPORTED', `unknown page action: ${action}`)
  let result
  try {
    result = await evalInTab(tabId, fn, args, timeoutMs, dialogOptions)
  } catch (error) {
    if (error?.code !== 'TIMEOUT') throw error
    // First attach after a page load / worker wake can be slow; retry once.
    await new Promise((resolve) => setTimeout(resolve, 400))
    result = await evalInTab(tabId, fn, args, timeoutMs, dialogOptions)
  }
  const value = result?.value
  if (value && typeof value === 'object' && Array.isArray(result.dialogs) && result.dialogs.length > 0) {
    value.dialogs = result.dialogs
  }
  return value
}

async function snapshot(owner, params) {
  const tabId = await resolveOwnedTabId(owner, params.tabId)
  const limit = Number.isFinite(params.maxChars)
    ? Math.max(1000, Math.min(200000, params.maxChars))
    : 100000
  const value = await callInPage(tabId, 'snapshot', [limit])
  if (!value) throw bridgeError('INTERNAL', 'page snapshot returned no result')
  return value
}

async function screenshot(owner, params) {
  const tabId = await resolveOwnedTabId(owner, params?.tabId)
  const target = { tabId }
  let clip
  const rawClip = params?.clip
  if (rawClip && typeof rawClip === 'object') {
    const x = Number(rawClip.x)
    const y = Number(rawClip.y)
    const width = Number(rawClip.width)
    const height = Number(rawClip.height)
    if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) {
      throw bridgeError('INVALID_ARGUMENT', 'clip must be {x,y,width,height} with positive width/height')
    }
    clip = { x, y, width, height, scale: 1 }
  }
  try {
    await chrome.debugger.attach(target, '1.3')
  } catch (error) {
    throw bridgeError('DEBUGGER_FAILED', `cannot attach debugger: ${error?.message || error}`)
  }
  try {
    const response = await chrome.debugger.sendCommand(target, 'Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false,
      ...(clip ? { clip } : {}),
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

async function find(owner, params) {
  const tabId = await resolveOwnedTabId(owner, params.tabId)
  const query = String(params.query ?? '')
  if (!query.trim()) throw bridgeError('INVALID_ARGUMENT', 'query must not be empty')
  const limit = Number.isFinite(params.maxResults) ? Math.min(50, Math.max(1, params.maxResults)) : 20
  const value = await callInPage(tabId, 'find', [query, limit])
  if (!value) throw bridgeError('INTERNAL', 'page find returned no result')
  return value
}

async function hover(owner, params) {
  const tabId = await resolveOwnedTabId(owner, params.tabId)
  const ref = Number(params.ref)
  if (!Number.isFinite(ref)) throw bridgeError('REF_STALE', 'ref must be a snapshot number')
  const result = await callInPage(tabId, 'hover', [ref])
  if (!result?.ok) {
    throw bridgeError(result?.reason || 'REF_STALE', result?.message || `ref ${ref} is stale; take a new snapshot`)
  }
  return { ...result, tabId }
}

async function click(owner, params) {
  const tabId = await resolveOwnedTabId(owner, params.tabId)
  const ref = Number(params.ref)
  if (!Number.isFinite(ref)) throw bridgeError('REF_STALE', 'ref must be a snapshot number')
  const result = await callInPage(tabId, 'click', [ref], 15000, params.dialog)
  if (!result?.ok) {
    throw bridgeError(result?.reason || 'REF_STALE', result?.message || `ref ${ref} is stale; take a new snapshot`)
  }
  return { ...result, tabId }
}

async function typeText(owner, params) {
  const tabId = await resolveOwnedTabId(owner, params.tabId)
  const ref = Number(params.ref)
  if (!Number.isFinite(ref)) throw bridgeError('REF_STALE', 'ref must be a snapshot number')
  const result = await callInPage(
    tabId,
    'type',
    [ref, String(params.text ?? ''), Boolean(params.replace), Boolean(params.submit)],
    15000,
    params.dialog,
  )
  if (!result?.ok) {
    throw bridgeError(result?.reason || 'REF_STALE', result?.message || `ref ${ref} is stale; take a new snapshot`)
  }
  return { ...result, tabId }
}

async function press(owner, params) {
  const tabId = await resolveOwnedTabId(owner, params.tabId)
  const key = String(params.key || '')
  if (!key) throw bridgeError('INTERNAL', 'key is required')
  const result = await callInPage(tabId, 'press', [key], 15000, params.dialog)
  return { ...result, tabId }
}

async function scroll(owner, params) {
  const tabId = await resolveOwnedTabId(owner, params.tabId)
  const direction = String(params.direction || 'down')
  const amount = Number.isFinite(params.amount) ? Number(params.amount) : 600
  const result = await callInPage(tabId, 'scroll', [direction, amount])
  return { ...result, tabId }
}

async function history(owner, params) {
  const tabId = await resolveOwnedTabId(owner, params.tabId)
  const op = String(params.op || 'reload')
  if (op === 'back') await chrome.tabs.goBack(tabId)
  else if (op === 'forward') await chrome.tabs.goForward(tabId)
  else if (op === 'reload') await chrome.tabs.reload(tabId)
  else throw bridgeError('UNSUPPORTED', `unknown history op: ${op}`)
  await waitForComplete(tabId, 45000).catch(() => {})
  const tab = await chrome.tabs.get(tabId)
  return { tabId, url: tab.url || '', title: tab.title || '', loadState: tab.status || 'complete' }
}

async function tabs(owner, params) {
  const op = String(params.op || 'list')
  const entry = await getSessionEntry(owner)
  if (op === 'list') {
    const list = []
    for (const id of entry.tabIds) {
      try {
        const tab = await chrome.tabs.get(id)
        list.push({
          tabId: id,
          title: tab.title || '',
          url: tab.url || '',
          active: id === entry.activeTabId,
        })
      } catch {
        // dropped between cleanup and listing
      }
    }
    return { tabs: list, groupId: entry.groupId }
  }
  if (op === 'new') {
    const url = params.url ? String(params.url) : 'about:blank'
    if (url !== 'about:blank' && !/^https?:\/\//i.test(url)) {
      throw bridgeError('PROTECTED_PAGE', 'Only http(s) URLs are allowed.')
    }
    const tab = await chrome.tabs.create({ url, active: false, pinned: false })
    await addTabToSession(owner, tab, { activate: false })
    if (url !== 'about:blank') await waitForComplete(tab.id, 45000).catch(() => {})
    const created = await chrome.tabs.get(tab.id)
    return { tabId: tab.id, url: created.url || url, title: created.title || '' }
  }
  if (op === 'close') {
    const tabId = await resolveOwnedTabId(owner, params.tabId)
    await chrome.tabs.remove(tabId)
    const after = await getSessionEntry(owner)
    await saveSessions()
    return { closed: tabId, remaining: after.tabIds.length }
  }
  throw bridgeError('UNSUPPORTED', `unknown tabs op: ${op}`)
}

async function selectAgent(owner, params) {
  const tabId = await resolveOwnedTabId(owner, params.tabId)
  const ref = Number(params.ref)
  if (!Number.isFinite(ref)) throw bridgeError('INVALID_ARGUMENT', 'ref is required')
  const value = params.value == null ? '' : String(params.value)
  const checked = params.checked
  if (value === '' && typeof checked !== 'boolean') {
    throw bridgeError('INVALID_ARGUMENT', 'provide value (select/radio) or checked (checkbox)')
  }
  return callInPage(tabId, 'select', [ref, value, checked])
}

async function claimTab(owner, params) {
  let tab
  if (Number.isFinite(params.tabId)) {
    tab = await chrome.tabs.get(params.tabId)
  } else {
    const active = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
    tab = active[0]
  }
  if (!tab?.id) throw bridgeError('NO_ACTIVE_TAB', 'no active tab to claim')
  if (!/^https?:/i.test(tab.url || '')) {
    throw bridgeError('PROTECTED_PAGE', 'only http(s) tabs can be claimed')
  }
  await addTabToSession(owner, tab, { activate: false })
  const claimed = await chrome.tabs.get(tab.id)
  return { tabId: tab.id, url: claimed.url || '', title: claimed.title || '', claimed: true }
}

async function uploadFiles(owner, params) {
  const tabId = await resolveOwnedTabId(owner, params.tabId)
  const ref = Number(params.ref)
  if (!Number.isFinite(ref)) throw bridgeError('INVALID_ARGUMENT', 'ref is required')
  const files = Array.isArray(params.files) ? params.files.map(String) : []
  if (files.length === 0) throw bridgeError('INVALID_ARGUMENT', 'files must be a non-empty array of local paths')
  const target = { tabId }
  try {
    await chrome.debugger.attach(target, '1.3')
  } catch (error) {
    throw bridgeError('DEBUGGER_FAILED', `cannot attach debugger: ${error?.message || error}`)
  }
  try {
    const { root } = await chrome.debugger.sendCommand(target, 'DOM.getDocument', { depth: 0 })
    const { nodeId } = await chrome.debugger.sendCommand(target, 'DOM.querySelector', {
      nodeId: root.nodeId,
      selector: `[data-dsh-ref="${ref}"]`,
    })
    if (!nodeId) throw bridgeError('REF_STALE', `ref ${ref} not found; take a new snapshot`)
    await chrome.debugger.sendCommand(target, 'DOM.setFileInputFiles', { nodeId, files })
    return { ok: true, ref, files: files.length }
  } finally {
    try {
      await chrome.debugger.detach(target)
    } catch {
      // tab may have navigated
    }
  }
}

async function listDownloads(params) {
  if (!chrome.downloads?.search) {
    throw bridgeError('UNSUPPORTED', 'downloads permission is not available')
  }
  const limit = Number.isFinite(params.limit) ? Math.min(100, Math.max(1, params.limit)) : 20
  const items = await chrome.downloads.search({ limit, orderBy: ['-startTime'] })
  return {
    items: items.map((item) => ({
      id: item.id,
      filename: item.filename || '',
      url: item.url || '',
      state: item.state || '',
      bytesReceived: item.bytesReceived || 0,
      totalBytes: item.totalBytes || 0,
      startTime: item.startTime || '',
    })),
  }
}

async function getTextAgent(owner, params) {
  const tabId = await resolveOwnedTabId(owner, params.tabId)
  const maxChars = Number.isFinite(params.maxChars) ? Math.min(200000, Math.max(500, params.maxChars)) : 20000
  const selector = params.selector ? String(params.selector) : ''
  return callInPage(tabId, 'getText', [selector, maxChars])
}

async function readConsoleAgent(owner, params) {
  const tabId = await resolveOwnedTabId(owner, params.tabId)
  const limit = Number.isFinite(params.limit) ? Math.min(120, Math.max(1, params.limit)) : 50
  const level = params.level ? String(params.level) : ''
  if (params.clear) await callInPage(tabId, 'consoleClear', []).catch(() => null)
  return callInPage(tabId, 'console', [level, limit])
}

async function readNetworkAgent(owner, params) {
  const tabId = await resolveOwnedTabId(owner, params.tabId)
  const limit = Number.isFinite(params.limit) ? Math.min(200, Math.max(1, params.limit)) : 50
  const filter = params.filter ? String(params.filter) : ''
  return callInPage(tabId, 'network', [filter, limit])
}

async function wait(owner, params) {
  const tabId = await resolveOwnedTabId(owner, params.tabId)
  const until = String(params.until || 'load')
  const timeoutMs = Number.isFinite(params.timeoutMs)
    ? Math.max(500, Math.min(120000, Number(params.timeoutMs)))
    : 30000
  if (until === 'load') {
    await waitForComplete(tabId, timeoutMs)
  } else if (until === 'networkidle') {
    await waitForComplete(tabId, timeoutMs)
    await new Promise((resolve) => setTimeout(resolve, 800))
  } else if (until === 'text') {
    const text = String(params.text || '')
    if (!text) throw bridgeError('INTERNAL', 'text is required when until=text')
    const started = Date.now()
    let found = false
    while (Date.now() - started < timeoutMs) {
      found = Boolean(await callInPage(tabId, 'hasText', [text], 5000))
      if (found) break
      await new Promise((resolve) => setTimeout(resolve, 300))
    }
    if (!found) throw bridgeError('TIMEOUT', `text not found within ${timeoutMs}ms: ${text}`)
  } else {
    throw bridgeError('UNSUPPORTED', `unknown wait target: ${until}`)
  }
  const tab = await chrome.tabs.get(tabId)
  return { tabId, url: tab.url || '', title: tab.title || '', loadState: tab.status || 'complete' }
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

// ------------------------------------------------------- injected page actions
/** Runs inside the page; self-contained. */
function hoverByRef(ref) {
  const element = document.querySelector(`[data-dsh-ref="${ref}"]`)
  if (!element) return { ok: false, reason: 'REF_STALE', message: `ref ${ref} not found; take a new snapshot` }
  element.scrollIntoView({ block: 'center', inline: 'center' })
  const rect = element.getBoundingClientRect()
  const x = rect.left + rect.width / 2
  const y = rect.top + rect.height / 2
  try {
    window.__dshCursor?.(x, y, 'hover')
  } catch {}
  const base = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, view: window }
  try { element.dispatchEvent(new PointerEvent('pointerover', { ...base, pointerId: 1, pointerType: 'mouse', isPrimary: true })) } catch {}
  element.dispatchEvent(new MouseEvent('mouseover', base))
  try { element.dispatchEvent(new PointerEvent('pointerenter', { ...base, bubbles: false, pointerId: 1, pointerType: 'mouse', isPrimary: true })) } catch {}
  element.dispatchEvent(new MouseEvent('mouseenter', { ...base, bubbles: false }))
  element.dispatchEvent(new MouseEvent('mousemove', base))
  return {
    ok: true,
    tag: element.tagName.toLowerCase(),
    label: (element.innerText || element.getAttribute('aria-label') || '').trim().slice(0, 80),
  }
}

function clickByRef(ref) {
  const element = document.querySelector(`[data-dsh-ref="${ref}"]`)
  if (!element) return { ok: false, reason: 'REF_STALE', message: `ref ${ref} not found; take a new snapshot` }
  element.scrollIntoView({ block: 'center', inline: 'center' })
  const rect = element.getBoundingClientRect()
  const x = rect.left + rect.width / 2
  const y = rect.top + rect.height / 2
  const base = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, view: window }
  window.__dshCursor?.(x, y, 'click')
  const pointer = { ...base, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0 }
  try { element.dispatchEvent(new PointerEvent('pointerdown', pointer)) } catch {}
  element.dispatchEvent(new MouseEvent('mousedown', base))
  try { element.dispatchEvent(new PointerEvent('pointerup', pointer)) } catch {}
  element.dispatchEvent(new MouseEvent('mouseup', base))
  element.dispatchEvent(new MouseEvent('click', base))
  return {
    ok: true,
    tag: element.tagName.toLowerCase(),
    label: (element.innerText || element.getAttribute('aria-label') || '').trim().slice(0, 80),
  }
}

/** Runs inside the page; self-contained. */
function typeIntoRef(ref, text, replace, submit) {
  const element = document.querySelector(`[data-dsh-ref="${ref}"]`)
  if (!element) return { ok: false, reason: 'REF_STALE', message: `ref ${ref} not found; take a new snapshot` }
  element.focus()
  try {
    const rect = element.getBoundingClientRect()
    window.__dshCursor?.(rect.left + rect.width / 2, rect.top + rect.height / 2, 'type')
  } catch {}
  const tag = element.tagName.toLowerCase()
  if (tag !== 'input' && tag !== 'textarea') {
    return { ok: false, reason: 'UNSUPPORTED', message: `ref ${ref} is a ${tag}, not a text field` }
  }
  const proto = tag === 'textarea' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
  const next = `${replace ? '' : element.value || ''}${text}`
  if (setter) setter.call(element, next)
  else element.value = next
  element.dispatchEvent(new Event('input', { bubbles: true }))
  element.dispatchEvent(new Event('change', { bubbles: true }))
  let submitted = false
  if (submit) {
    const form = element.form
    try {
      if (form && typeof form.requestSubmit === 'function') {
        form.requestSubmit()
        submitted = true
      }
    } catch {
      submitted = false
    }
    if (!submitted) {
      for (const type of ['keydown', 'keypress', 'keyup']) {
        element.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }))
      }
    }
  }
  return { ok: true, value: element.value, submitted }
}

/** Runs inside the page; self-contained. */
function pressKey(key) {
  const target = document.activeElement && document.activeElement !== document.body
    ? document.activeElement
    : document.body
  try {
    const rect = target.getBoundingClientRect()
    window.__dshCursor?.(rect.left + rect.width / 2, rect.top + rect.height / 2, 'key')
  } catch {}
  const options = { key, bubbles: true, cancelable: true, composed: true }
  target.dispatchEvent(new KeyboardEvent('keydown', options))
  target.dispatchEvent(new KeyboardEvent('keypress', options))
  target.dispatchEvent(new KeyboardEvent('keyup', options))
  return { ok: true, key, target: target.tagName.toLowerCase() }
}

/** Runs inside the page; self-contained. */
function scrollPage(direction, amount) {
  const step = Number.isFinite(amount) ? amount : 600
  const maxY = Math.max(0, document.documentElement.scrollHeight - window.innerHeight)
  const deltas = { down: step, up: -step, top: -maxY, bottom: maxY }
  try {
    window.__dshCursor?.(window.innerWidth / 2, window.innerHeight / 2, 'scroll')
  } catch {}
  window.scrollBy({ top: deltas[direction] ?? step, left: 0, behavior: 'instant' })
  return {
    ok: true,
    y: window.scrollY,
    viewportHeight: window.innerHeight,
    documentHeight: document.documentElement.scrollHeight,
  }
}

/** Runs inside the page; self-contained. */
function findInPage(query, limit) {
  const needle = String(query || '').toLowerCase()
  if (!needle.trim()) return { query: '', matches: [], truncated: false }
  const max = Number.isFinite(limit) ? Math.max(1, Math.min(50, limit)) : 20
  const root = document.body || document.documentElement
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const matches = []
  const seen = new Set()
  let node
  while ((node = walker.nextNode())) {
    if (matches.length >= max) break
    const value = node.nodeValue || ''
    if (!value.toLowerCase().includes(needle)) continue
    const element = node.parentElement
    if (!element || seen.has(element)) continue
    const style = getComputedStyle(element)
    if (style.display === 'none' || style.visibility === 'hidden') continue
    const rect = element.getBoundingClientRect()
    if (rect.width < 1 || rect.height < 1) continue
    seen.add(element)
    const interactive = element.closest('a[href],button,input,select,textarea,[role="button"],[role="link"],[onclick]')
    const target = interactive || element
    let ref = Number(target.getAttribute('data-dsh-ref')) || 0
    if (!ref) {
      ref = 900 + matches.length + 1
      try {
        target.setAttribute('data-dsh-ref', String(ref))
      } catch {
        // read-only DOM: match still reports coordinates
      }
    }
    try {
      const previousOutline = target.style.outline
      const previousOffset = target.style.outlineOffset
      target.style.outline = '2px solid rgba(0,122,255,.8)'
      target.style.outlineOffset = '2px'
      setTimeout(() => {
        target.style.outline = previousOutline
        target.style.outlineOffset = previousOffset
      }, 1500)
    } catch {}
    matches.push({
      ref,
      text: value.trim().slice(0, 160),
      tag: target.tagName.toLowerCase(),
      x: Math.round(rect.left + rect.width / 2),
      y: Math.round(rect.top + rect.height / 2),
    })
  }
  return { query, matches, truncated: matches.length >= max }
}

function selectByRef(ref, value, checked) {
  const element = document.querySelector(`[data-dsh-ref="${ref}"]`)
  if (!element) return { ok: false, reason: 'REF_STALE', message: `ref ${ref} not found; take a new snapshot` }
  const tag = element.tagName.toLowerCase()
  try {
    const rect = element.getBoundingClientRect()
    window.__dshCursor?.(rect.left + rect.width / 2, rect.top + rect.height / 2, 'click')
  } catch {}
  if (tag === 'select') {
    const options = Array.from(element.options || [])
    const match = options.find((option) => option.value === value) || options.find((option) => (option.textContent || '').trim() === value)
    if (!match) return { ok: false, reason: 'NO_OPTION', message: `no option matching ${value}` }
    element.value = match.value
    element.dispatchEvent(new Event('input', { bubbles: true }))
    element.dispatchEvent(new Event('change', { bubbles: true }))
    return { ok: true, tag, value: element.value }
  }
  if (tag === 'input' && (element.type === 'checkbox' || element.type === 'radio')) {
    const next = typeof checked === 'boolean' ? checked : !element.checked
    if (element.checked !== next) element.click()
    if (element.checked !== next) {
      element.checked = next
      element.dispatchEvent(new Event('input', { bubbles: true }))
      element.dispatchEvent(new Event('change', { bubbles: true }))
    }
    return { ok: true, tag, value: element.checked ? 'checked' : 'unchecked' }
  }
  return { ok: false, reason: 'UNSUPPORTED', message: `ref ${ref} is a ${tag}, not a select/checkbox/radio` }
}

function getText(selector, maxChars) {
  const limit = Number.isFinite(maxChars) ? maxChars : 20000
  let node = null
  try {
    node = selector ? document.querySelector(selector) : document.querySelector('main,article,[role="main"]') || document.body
  } catch {
    return { found: false, error: 'INVALID_SELECTOR', text: '', truncated: false }
  }
  if (!node) return { found: false, text: '', truncated: false }
  const raw = (node.innerText || node.textContent || '').replace(/\n{3,}/g, '\n\n').trim()
  return { found: true, text: raw.slice(0, limit), truncated: raw.length > limit }
}

function readConsole(level, limit) {
  const state = window.__dshConsole
  if (!state) return { available: false, entries: [] }
  const max = Number.isFinite(limit) ? Math.max(1, Math.min(120, limit)) : 50
  let list = state.entries
  if (level) list = list.filter((entry) => entry.level === level)
  return { available: true, entries: list.slice(-max) }
}

function clearConsoleBuffer() {
  window.__dshConsole?.clear?.()
  return { ok: true }
}

function readNetwork(filter, limit) {
  const max = Number.isFinite(limit) ? Math.max(1, Math.min(200, limit)) : 50
  const needle = String(filter || '').toLowerCase()
  let entries = performance.getEntriesByType('resource') || []
  if (needle) entries = entries.filter((entry) => String(entry.name || '').toLowerCase().includes(needle))
  return {
    available: true,
    entries: entries.slice(-max).map((entry) => ({
      url: String(entry.name || '').slice(0, 500),
      type: entry.initiatorType || '',
      durationMs: Math.round(entry.duration || 0),
      transferSize: entry.transferSize || 0,
    })),
  }
}

function hasText(text) {
  return (document.body ? document.body.innerText : '').includes(text)
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
chrome.runtime.onConnect.addListener((keepalivePort) => {
  if (keepalivePort.name !== 'dsh-keepalive') return
  keepalivePort.onMessage.addListener(() => {
    if (!port) forceReconnect().catch(() => {})
  })
})
// Every service-worker start (install/startup/event wake) should try to
// re-open the native port; this is the last line of the reconnect defense.
if (!port) forceReconnect().catch(() => {})

chrome.alarms.onAlarm.addListener((alarm) => {
  if (!alarm.name.startsWith('dsh-chrome-reconnect')) return
  // Force, not "if (!port)": a killed native host can leave a stale port
  // object behind, and then a conditional reconnect never fires.
  forceReconnect().catch(() => {})
})
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'dsh-page-tick') {
    if (!port) forceReconnect().catch(() => {})
    sendResponse({ ok: true })
    return
  }
  if (message?.type === 'dsh-status') {
    ;(async () => {
      const sessionTabId = await firstActiveTabId()
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
    // Silence for 30s (provider heartbeats every 10s) means the port object is
    // stale even though Chrome never fired onDisconnect.
    if (!port || Date.now() - lastNativeSignalAt > 30000) forceReconnect().catch(() => {})
    return false
  }
  if (message?.type === 'dsh-connect') {
    forceReconnect()
      .catch(() => {})
      .finally(() => {
        setTimeout(async () => {
          sendResponse({
            connected: Boolean(port),
            extensionVersion: VERSION,
            sessionTabId: await firstActiveTabId(),
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
