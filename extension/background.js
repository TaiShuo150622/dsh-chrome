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
let lastDiskVersion = null
let lastConnectError = null
let lastNativeSignalAt = 0

function log(...args) {
  console.log('[DSH Chrome]', ...args)
}

const DIAG_KEY = 'dshDiag'

// Structured diagnostics persisted to chrome.storage.local so the reconnect
// behaviour can be inspected after the worker has been evicted (console logs
// alone are lost when the worker dies).
function diag(event, extra = {}) {
  const entry = { t: new Date().toISOString(), event, ...extra }
  try {
    console.log('[DSH Chrome][diag]', JSON.stringify(entry))
  } catch {}
  try {
    chrome.storage.local
      .get(DIAG_KEY)
      .then((stored) => {
        const list = Array.isArray(stored?.[DIAG_KEY]) ? stored[DIAG_KEY] : []
        list.push(entry)
        while (list.length > 80) list.shift()
        return chrome.storage.local.set({ [DIAG_KEY]: list })
      })
      .catch(() => {})
  } catch {
    // storage unavailable
  }
}

function bridgeError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

// --------------------------------------------------------------- session state
// owner (DSH session id) -> { tabIds, groupId, activeTabId }
const SESSIONS_KEY = 'dshSessions'
const SESSION_AREA = 'local'
let sessionsCache = null
let sessionsLoaded = false

async function loadSessions() {
  if (sessionsLoaded) return sessionsCache
  sessionsLoaded = true
  try {
    const stored = await chrome.storage.local.get(SESSIONS_KEY)
    sessionsCache =
      stored[SESSIONS_KEY] && typeof stored[SESSIONS_KEY] === 'object' ? stored[SESSIONS_KEY] : {}
  } catch {
    sessionsCache = {}
  }
  return sessionsCache
}

async function saveSessions() {
  try {
    await chrome.storage.local.set({ [SESSIONS_KEY]: sessionsCache || {} })
  } catch {
    // storage.local persists across extension reloads (auto-update friendly)
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

function groupTitle(owner) {
  return `DSH · ${ownerShort(owner)}`
}

function sessionGroupTitle(owner, entry) {
  const label = typeof entry?.label === 'string' ? entry.label.trim().slice(0, 40) : ''
  return label ? `DSH · ${label}` : groupTitle(owner)
}

async function reconcileGroups(owner, entry) {
  try {
    const title = sessionGroupTitle(owner, entry)
    const legacyTitle = groupTitle(owner)
    const all = await chrome.tabGroups.query({})
    const groups = all.filter((group) => {
      const current = String(group.title || '')
      return current === title || current === legacyTitle
    })
    if (groups.length === 0) return
    const canonical = groups.find((group) => group.id === entry.groupId) ?? groups[0]
    for (const group of groups) {
      if (group.id === canonical.id) continue
      // Merge tabs from duplicate groups (usually created after an extension
      // reload lost the old group id) into one canonical group.
      const tabs = await chrome.tabs.query({ groupId: group.id })
      const ids = tabs.map((tab) => tab.id).filter((id) => Number.isFinite(id))
      if (ids.length > 0) await chrome.tabs.group({ tabIds: ids, groupId: canonical.id })
    }
    entry.groupId = canonical.id
    if (String(canonical.title || '') !== title) {
      try {
        await chrome.tabGroups.update(canonical.id, { title, color: 'blue', collapsed: true })
      } catch {
        // renaming is best effort
      }
    }
    // Sync tracked tab ids with the actual group contents: after reloads the
    // stored list can miss tabs, which would make close_session leave orphans.
    try {
      const groupTabs = await chrome.tabs.query({ groupId: canonical.id })
      const ids = groupTabs.map((tab) => tab.id).filter((id) => Number.isFinite(id))
      entry.tabIds = ids
      if (!ids.includes(entry.activeTabId)) entry.activeTabId = ids[0] ?? null
    } catch {
      // keep stored ids
    }
    await saveSessions()
    diag('groups-reconciled', { owner: ownerShort(owner), groups: groups.length, canonical: canonical.id })
  } catch (error) {
    log('group reconcile failed', error?.message || error)
  }
}

async function reconcileAllGroups() {
  try {
    const sessions = await loadSessions()
    for (const owner of Object.keys(sessions || {})) {
      const entry = await getSessionEntry(owner)
      if (entry) await reconcileGroups(owner, entry)
    }
  } catch (error) {
    log('group reconcile-all failed', error?.message || error)
  }
}

async function attachGroup(owner, entry, tabIds, label) {
  if (typeof label === 'string' && label.trim()) entry.label = label.trim().slice(0, 40)
  try {
    await reconcileGroups(owner, entry)
    const title = sessionGroupTitle(owner, entry)
    if (entry.groupId != null) {
      try {
        await chrome.tabs.group({ tabIds, groupId: entry.groupId })
        return
      } catch {
        entry.groupId = null
      }
    }
    // Reuse an existing group with our title (current or legacy short id).
    const all = await chrome.tabGroups.query({})
    const existing = all.find((group) => {
      const current = String(group.title || '')
      return current === title || current === groupTitle(owner)
    })
    if (existing) {
      entry.groupId = existing.id
      await chrome.tabs.group({ tabIds, groupId: existing.id })
      if (String(existing.title || '') !== title) {
        await chrome.tabGroups.update(existing.id, { title, color: 'blue', collapsed: true }).catch(() => {})
      }
      return
    }
    const groupId = await chrome.tabs.group({ tabIds })
    entry.groupId = groupId
    await chrome.tabGroups.update(groupId, {
      title,
      color: 'blue',
      collapsed: true,
    })
  } catch (error) {
    log('tab group unavailable', error?.message || error)
  }
}

async function addTabToSession(owner, tab, { activate = true, label = null } = {}) {
  const entry = await getSessionEntry(owner)
  if (!entry.tabIds.includes(tab.id)) entry.tabIds.push(tab.id)
  if (activate) entry.activeTabId = tab.id
  await attachGroup(owner, entry, [tab.id], label)
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
  diag('self-heal-reload', { attempts })
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
  diag('ensure-port-enter', { hasPort: Boolean(port), connecting: Boolean(connecting) })
  if (port) return Promise.resolve(port)
  if (connecting) return connecting
  // NOTE: create the deferred before touching chrome.runtime.connectNative, and
  // never assign `connecting` inside the executor — the executor runs
  // synchronously, so a later assignment would overwrite the `connecting = null`
  // performed by finish() and leave a permanently "connecting" worker.
  let resolveConnecting
  let settled = false
  const promise = new Promise((resolve) => {
    resolveConnecting = resolve
  })
  connecting = promise
  const finish = (value) => {
    if (settled) return
    settled = true
    if (connecting === promise) connecting = null
    resolveConnecting(value)
  }
  let nativePort
  try {
    nativePort = chrome.runtime.connectNative(HOST_NAME)
    diag('connect-start')
  } catch (error) {
    lastConnectError = error?.message || String(error)
    log('connectNative failed', error)
    diag('connect-fail', { error: lastConnectError })
    finish(null)
    maybeSelfHeal().catch(() => {})
    return promise
  }
  nativePort.onMessage.addListener((message) => {
    lastNativeSignalAt = Date.now()
    if (message?.id == null) {
      if (message?.event === 'ext.changed') {
        log('extension files changed; reloading', message.params?.file || '')
        scheduleExtensionReload()
        return
      }
      if (message?.event === 'ext.state') {
        const diskVersion = String(message.params?.version || '')
        lastDiskVersion = diskVersion || null
        if (diskVersion && diskVersion !== VERSION) {
          log('disk extension version differs; reloading', diskVersion)
          scheduleExtensionReload()
        }
        return
      }
      if (message?.event === 'dsh.ping') return
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
    diag('disconnect', { error: lastError?.message || '' })
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
  return promise
}

// Force a fresh native port: used by the popup button and the reconnect alarm
// when a stale port object would otherwise keep us from reconnecting.
function forceReconnect({ force = false } = {}) {
  diag('force-reconnect', { force, hasPort: Boolean(port), connecting: Boolean(connecting) })
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

// ------------------------------------------------------------------- requests
async function handleRequest(message) {
  const method = String(message.method || '')
  const params = message.params || {}
  const owner = params.owner ?? 'default'
  switch (method) {
    case 'browser.status': {
      let groupCount = null
      let groups = []
      try {
        const all = await chrome.tabGroups.query({})
        const ours = all.filter((group) => String(group.title || '').startsWith('DSH · '))
        groupCount = ours.length
        for (const group of ours) {
          const tabs = await chrome.tabs.query({ groupId: group.id })
          groups.push({ id: group.id, title: group.title, collapsed: group.collapsed, tabs: tabs.length })
        }
      } catch {
        groupCount = null
      }
      return {
        extensionVersion: VERSION,
        connected: true,
        diskVersion: lastDiskVersion,
        autoReload: Boolean(lastDiskVersion),
        groupCount,
        groups,
      }
    }
    case 'tab.goto':
      return gotoUrl(owner, String(params.url || ''), params.ownerLabel || null)
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
    case 'tab.clickAt':
      return clickAt(owner, params)
    case 'tab.html':
      return html(owner, params)
    case 'tab.frames':
      return frames(owner, params)
    case 'tab.selection':
      return selection(owner, params)
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
    case 'tab.storage':
      return storage(owner, params)
    case 'tab.emulate':
      return emulate(owner, params)
    case 'tab.drag':
      return drag(owner, params)
    case 'tab.pdf':
      return pdf(owner, params)
    case 'tab.a11y':
      return a11y(owner, params)
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

async function gotoUrl(owner, url, label = null) {
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
  clickAt: clickAtPoint,
  type: typeIntoRef,
  press: pressKey,
  scroll: scrollPage,
  find: findInPage,
  getText,
  getMarkdown,
  select: selectByRef,
  storage: pageStorage,
  drag: dragByRef,
  elementBox,
  html: outerHtml,
  selection: readSelection,
  overlay: drawRefOverlay,
  overlayRemove: removeRefOverlay,
  hasSelector,
  urlMatches,
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

const DEEP_HELPERS_SRC = `
(() => {
  // Version bump so a page that still holds an older injected helper (e.g.
  // during a dev auto-reload) gets the current implementation.
  if (window.__dshDeep && window.__dshDeepVersion === 2) return
  window.__dshDeepVersion = 2
  const roots = (root) => {
    const out = [root]
    const visit = (node) => {
      let elements = []
      try { elements = node.querySelectorAll ? node.querySelectorAll('*') : [] } catch { elements = [] }
      for (const element of elements) {
        if (element.shadowRoot) {
          out.push(element.shadowRoot)
          visit(element.shadowRoot)
        }
      }
    }
    visit(root)
    return out
  }
  const all = (selector) => {
    const out = []
    const seen = new Set()
    for (const root of roots(document)) {
      let found = []
      try { found = root.querySelectorAll(selector) } catch { found = [] }
      for (const element of found) {
        if (seen.has(element)) continue
        seen.add(element)
        out.push(element)
      }
    }
    return out
  }
  const one = (selector) => {
    for (const root of roots(document)) {
      let found = null
      try { found = root.querySelector(selector) } catch { found = null }
      if (found) return found
    }
    return null
  }
  const byRef = (ref) => {
    const selector = '[data-dsh-ref="' + ref + '"]'
    return document.querySelector(selector) || one(selector)
  }
  const collectText = (root) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    const parts = []
    let current
    while ((current = walker.nextNode())) {
      const parent = current.parentElement
      if (!parent) continue
      const tag = parent.tagName.toLowerCase()
      if (tag === 'style' || tag === 'script' || tag === 'noscript' || tag === 'template') continue
      const value = (current.nodeValue || '').trim()
      if (value) parts.push(value)
    }
    return parts.join('\\n')
  }
  const text = (node) => {
    const parts = []
    const own = node.innerText || ''
    if (own) parts.push(own)
    else {
      const fallback = collectText(node)
      if (fallback) parts.push(fallback)
    }
    for (const root of roots(node).slice(1)) {
      const shadowText = collectText(root)
      if (shadowText) parts.push(shadowText)
    }
    return parts.join('\\n')
  }
  window.__dshDeep = { all, one, byRef, roots, text }
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

const debuggerSessions = new Map()

function sessionFor(tabId) {
  let session = debuggerSessions.get(tabId)
  if (!session) {
    session = {
      target: { tabId },
      refs: 0,
      capture: null,
      pageEnabled: false,
      interceptDialogs: false,
      dialogOptions: null,
      dialogs: [],
    }
    debuggerSessions.set(tabId, session)
  }
  return session
}

async function withDebugger(tabId, fn, options = {}) {
  const session = sessionFor(tabId)
  const { interceptDialogs = false, dialogOptions = null } = options
  if (session.refs === 0 && !session.capture) {
    try {
      await chrome.debugger.attach(session.target, '1.3')
    } catch (error) {
      debuggerSessions.delete(tabId)
      throw bridgeError('DEBUGGER_FAILED', `cannot attach debugger: ${error?.message || error}`)
    }
  }
  session.refs += 1
  session.interceptDialogs = interceptDialogs
  session.dialogOptions = dialogOptions
  try {
    if (interceptDialogs && !session.pageEnabled) {
      await chrome.debugger.sendCommand(session.target, 'Page.enable').catch(() => {})
      session.pageEnabled = true
    }
    return await fn(session)
  } finally {
    session.refs -= 1
    session.interceptDialogs = false
    session.dialogOptions = null
    if (session.refs === 0 && !session.capture) {
      debuggerSessions.delete(tabId)
      await chrome.debugger.detach(session.target).catch(() => {})
    }
  }
}

async function evalInTarget(target, fn, args, timeoutMs = 10000) {
  const expression = `(() => { ${CURSOR_HELPER_SRC}
    ${DEEP_HELPERS_SRC}
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
  return response?.result?.value
}

// C2a fills this in; C0 keeps the hook so a later capture can pin the session.
function routeNetworkEvent() {}

// C2a fills this in; C0 keeps the hook so onDetach can close capture state.
function endCapture() {}

async function evalInTab(tabId, fn, args, timeoutMs, dialogOptions) {
  return withDebugger(
    tabId,
    async (session) => {
      const expression = `(() => { ${CURSOR_HELPER_SRC}
      ${DEEP_HELPERS_SRC}
      return (${fn.toString()})(...${JSON.stringify(args)})
    })()`
      const response = await withTimeout(
        chrome.debugger.sendCommand(session.target, 'Runtime.evaluate', {
          expression,
          returnByValue: true,
          awaitPromise: true,
        }),
        timeoutMs,
        'TIMEOUT',
        `page action timed out after ${timeoutMs}ms`,
      )
      if (response?.exceptionDetails) {
        const text =
          response.exceptionDetails.exception?.description || response.exceptionDetails.text || 'page action failed'
        throw bridgeError('INTERNAL', String(text))
      }
      return { value: response?.result?.value, dialogs: session.dialogs.slice() }
    },
    { interceptDialogs: true, dialogOptions },
  )
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

async function attachSnapshotIfRequested(tabId, result, params, timeoutMs = 8000) {
  if (!params?.snapshot) return result
  try {
    const page = await callInPage(tabId, 'snapshot', [20000, false, 'full'], timeoutMs)
    return { ...result, page }
  } catch (error) {
    return { ...result, pageError: error?.message || String(error) }
  }
}

async function snapshot(owner, params) {
  const tabId = await resolveOwnedTabId(owner, params.tabId)
  const limit = Number.isFinite(params.maxChars)
    ? Math.max(1000, Math.min(200000, params.maxChars))
    : 100000
  if (params.frames !== 'main') {
    try {
      return await snapshotAllFrames(tabId, { ...params, maxChars: limit })
    } catch (error) {
      log('snapshot all frames failed; falling back to main frame', error?.message || error)
    }
  }
  const value = await callInPage(tabId, 'snapshot', [limit, Boolean(params.boxes), String(params.mode || 'full')])
  if (!value) throw bridgeError('INTERNAL', 'page snapshot returned no result')
  return value
}

async function frameOffsetInViewport(target, frameId, tree) {
  const byId = new Map(tree.map((frame) => [frame.frameId, frame]))
  const chain = []
  let current = frameId
  while (current) {
    const frame = byId.get(current)
    if (!frame || !frame.parentFrameId) break
    chain.push(current)
    current = frame.parentFrameId
  }
  let offsetX = 0
  let offsetY = 0
  for (const id of chain) {
    let owner = null
    try {
      owner = await chrome.debugger.sendCommand(target, 'DOM.getFrameOwner', { frameId: id })
    } catch (error) {
      throw bridgeError('FRAME_OFFSET_UNAVAILABLE', `cannot locate frame owner: ${error?.message || error}`)
    }
    const backendNodeId = owner?.backendNodeId
    if (!Number.isFinite(backendNodeId)) {
      throw bridgeError('FRAME_OFFSET_UNAVAILABLE', 'frame owner has no backendNodeId')
    }
    let model = null
    try {
      model = await chrome.debugger.sendCommand(target, 'DOM.getBoxModel', { backendNodeId })
    } catch (error) {
      throw bridgeError('FRAME_OFFSET_UNAVAILABLE', `cannot measure frame owner: ${error?.message || error}`)
    }
    const quad = model?.model?.content
    if (!Array.isArray(quad) || quad.length < 8) {
      throw bridgeError('FRAME_OFFSET_UNAVAILABLE', 'frame owner has no content quad')
    }
    offsetX += Math.min(quad[0], quad[2], quad[4], quad[6])
    offsetY += Math.min(quad[1], quad[3], quad[5], quad[7])
  }
  return { x: offsetX, y: offsetY }
}

async function elementBoxInFrame(tabId, frameRef) {
  const parsed = parseFrameRef(frameRef)
  if (!parsed) throw bridgeError('INVALID_ARGUMENT', `invalid frameRef: ${frameRef}`)
  const frameId = frameIdForPrefix(tabId, parsed.prefix)
  if (!frameId) throw bridgeError('FRAME_STALE', 'frame registry is stale; take a new snapshot')
  return withDebugger(tabId, async (session) => {
    const target = session.target
    await chrome.debugger.sendCommand(target, 'DOM.enable').catch(() => {})
    const tree = await readFrameTree(target)
    const offset = await frameOffsetInViewport(target, frameId, tree)
    const box = await evalInFrameContext(target, frameId, elementBox, [parsed.ref, ''], 10000)
    if (!box || box.width <= 0 || box.height <= 0) {
      throw bridgeError('REF_STALE', `frameRef ${frameRef} has no visible box`)
    }
    return {
      x: box.x + offset.x,
      y: box.y + offset.y,
      width: box.width,
      height: box.height,
      frameRef,
      frameId,
    }
  })
}

async function screenshot(owner, params) {
  const tabId = await resolveOwnedTabId(owner, params?.tabId)
  const target = { tabId }
  const highlight = Boolean(params?.highlight)
  const fullPage = Boolean(params?.fullPage)
  const elementRef = Number(params?.ref)
  if (highlight) await callInPage(tabId, 'overlay', [], 10000).catch(() => null)
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
  let effectiveClip = clip
  if (!effectiveClip && params?.frameRef) {
    const box = await elementBoxInFrame(tabId, String(params.frameRef))
    effectiveClip = { x: box.x, y: box.y, width: box.width, height: box.height, scale: 1 }
  }
  try {
    return await withDebugger(tabId, async (session) => {
      const target = session.target
      let finalClip = effectiveClip
      if (!finalClip && Number.isFinite(elementRef)) {
        const box = await evalInTarget(target, elementBox, [elementRef, ''], 10000)
        if (!box || box.width <= 0 || box.height <= 0) {
          throw bridgeError('REF_STALE', `ref ${elementRef} has no visible box`)
        }
        finalClip = { x: box.x, y: box.y, width: box.width, height: box.height, scale: 1 }
      }
      if (fullPage) {
        const dims = await chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
          expression:
            '({ width: Math.max(document.documentElement.scrollWidth, document.body ? document.body.scrollWidth : 0), height: Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0) })',
          returnByValue: true,
        })
        const width = Math.min(20000, Math.max(1, Math.round(Number(dims?.result?.value?.width) || 0)))
        const height = Math.min(20000, Math.max(1, Math.round(Number(dims?.result?.value?.height) || 0)))
        finalClip = { x: 0, y: 0, width, height, scale: 1 }
      }
      const response = await chrome.debugger.sendCommand(target, 'Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: fullPage,
        ...(finalClip ? { clip: finalClip } : {}),
      })
      if (!response?.data) throw bridgeError('INTERNAL', 'empty screenshot data')
      return { dataBase64: response.data }
    })
  } finally {
    if (highlight) await callInPage(tabId, 'overlayRemove', [], 10000).catch(() => null)
  }
}

async function find(owner, params) {
  const tabId = await resolveOwnedTabId(owner, params.tabId)
  const query = String(params.query ?? '')
  const useRegex = Boolean(params.regex)
  if (!query.trim()) throw bridgeError('INVALID_ARGUMENT', 'query must not be empty')
  const limit = Number.isFinite(params.maxResults) ? Math.min(50, Math.max(1, params.maxResults)) : 20
  const value = await findAcrossFrames(tabId, query, limit, useRegex)
  if (!value) throw bridgeError('INTERNAL', 'page find returned no result')
  return value
}

async function hover(owner, params) {
  const tabId = await resolveOwnedTabId(owner, params.tabId)
  const ref = Number(params.ref)
  const selector = params.selector ? String(params.selector) : ''
  const frameRef = params.frameRef ? String(params.frameRef) : ''
  if (!Number.isFinite(ref) && !selector && !frameRef) {
    throw bridgeError('INVALID_ARGUMENT', 'ref, frameRef or selector is required')
  }
  let result
  if (frameRef) {
    const parsed = parseFrameRef(frameRef)
    if (!parsed) throw bridgeError('INVALID_ARGUMENT', `invalid frameRef: ${frameRef}`)
    const frameId = frameIdForPrefix(tabId, parsed.prefix)
    if (!frameId) throw bridgeError('FRAME_STALE', 'frame registry is stale; take a new snapshot')
    result = await callInFrame(tabId, frameId, 'hover', [parsed.ref, selector])
    if (result) result.frameRef = frameRef
  } else {
    result = await callInPage(tabId, 'hover', [Number.isFinite(ref) ? ref : null, selector])
  }
  if (!result?.ok) {
    throw bridgeError(result?.reason || 'REF_STALE', result?.message || `ref ${ref} is stale; take a new snapshot`)
  }
  return attachSnapshotIfRequested(tabId, { ...result, tabId }, params)
}

async function click(owner, params) {
  const tabId = await resolveOwnedTabId(owner, params.tabId)
  const ref = Number(params.ref)
  const selector = params.selector ? String(params.selector) : ''
  const frameRef = params.frameRef ? String(params.frameRef) : ''
  if (!Number.isFinite(ref) && !selector && !frameRef) {
    throw bridgeError('INVALID_ARGUMENT', 'ref, frameRef or selector is required')
  }
  let result
  if (frameRef) {
    const parsed = parseFrameRef(frameRef)
    if (!parsed) throw bridgeError('INVALID_ARGUMENT', `invalid frameRef: ${frameRef}`)
    const frameId = frameIdForPrefix(tabId, parsed.prefix)
    if (!frameId) throw bridgeError('FRAME_STALE', 'frame registry is stale; take a new snapshot')
    result = await callInFrame(
      tabId,
      frameId,
      'click',
      [parsed.ref, selector, String(params.button || 'left'), Number(params.clickCount) || 1],
      15000,
    )
    if (result) result.frameRef = frameRef
  } else {
    result = await callInPage(
      tabId,
      'click',
      [Number.isFinite(ref) ? ref : null, selector, String(params.button || 'left'), Number(params.clickCount) || 1],
      15000,
      params.dialog,
    )
  }
  if (!result?.ok) {
    throw bridgeError(result?.reason || 'REF_STALE', result?.message || `ref ${ref} is stale; take a new snapshot`)
  }
  return attachSnapshotIfRequested(tabId, { ...result, tabId }, params)
}

async function clickAt(owner, params) {
  const tabId = await resolveOwnedTabId(owner, params.tabId)
  const x = Number(params.x)
  const y = Number(params.y)
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw bridgeError('INVALID_ARGUMENT', 'x and y are required')
  }
  const result = await callInPage(
    tabId,
    'clickAt',
    [x, y, String(params.button || 'left'), Number(params.clickCount) || 1],
    15000,
    params.dialog,
  )
  if (!result?.ok) {
    throw bridgeError(result?.reason || 'INTERNAL', result?.message || 'click_at failed')
  }
  return attachSnapshotIfRequested(tabId, { ...result, tabId }, params)
}

async function html(owner, params) {
  const tabId = await resolveOwnedTabId(owner, params.tabId)
  const selector = params.selector ? String(params.selector) : ''
  const mode = params.mode === 'simplified' ? 'simplified' : 'outer'
  const maxChars = Number(params.maxChars)
  const result = await callInPage(tabId, 'html', [selector, mode, Number.isFinite(maxChars) ? maxChars : null], 15000)
  if (!result?.found) {
    throw bridgeError(result?.error || 'SELECTOR_NOT_FOUND', result?.message || `selector not found: ${selector || '(document)'}`)
  }
  return { ...result, tabId }
}

const frameRegistry = new Map()

function framePrefix(frameId) {
  return String(frameId || '').slice(0, 8)
}

async function readFrameTree(target) {
  const tree = await chrome.debugger.sendCommand(target, 'Page.getFrameTree')
  const out = []
  const visit = (node, parentId) => {
    const frame = node?.frame
    if (!frame) return
    out.push({
      frameId: String(frame.id || ''),
      parentFrameId: parentId || null,
      url: String(frame.url || ''),
      domainAndRegistry: String(frame.domainAndRegistry || ''),
      mimeType: String(frame.mimeType || ''),
    })
    for (const child of node.childFrames || []) visit(child, String(frame.id || ''))
  }
  visit(tree?.frameTree, null)
  return out
}

function frameExpression(fn, args) {
  return `(() => { ${CURSOR_HELPER_SRC}
    ${DEEP_HELPERS_SRC}
    return (${fn.toString()})(...${JSON.stringify(args)})
  })()`
}

async function evalInFrameContext(target, frameId, fn, args, timeoutMs = 15000) {
  const world = await chrome.debugger.sendCommand(target, 'Page.createIsolatedWorld', {
    frameId,
    worldName: 'dsh-frame-actions',
  })
  const response = await withTimeout(
    chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
      expression: frameExpression(fn, args),
      contextId: world.executionContextId,
      returnByValue: true,
      awaitPromise: true,
    }),
    timeoutMs,
    'TIMEOUT',
    `frame action timed out after ${timeoutMs}ms`,
  )
  if (response?.exceptionDetails) {
    const text = response.exceptionDetails.exception?.description || response.exceptionDetails.text || 'frame action failed'
    throw bridgeError('INTERNAL', String(text))
  }
  return response?.result?.value
}

function parseFrameRef(value) {
  if (typeof value !== 'string') return null
  const match = /^f([0-9a-f]{1,16}):(\d+)$/i.exec(value.trim())
  if (!match) return null
  return { prefix: match[1].toLowerCase(), ref: Number(match[2]) }
}

function frameIdForPrefix(tabId, prefix) {
  const registry = frameRegistry.get(tabId)
  if (!registry) return null
  return registry.get(prefix) ?? null
}

async function callInFrame(tabId, frameId, action, args, timeoutMs = 15000) {
  const fn = PAGE_ACTIONS[action]
  if (!fn) throw bridgeError('UNSUPPORTED', `unknown page action: ${action}`)
  return withDebugger(tabId, async (session) =>
    evalInFrameContext(session.target, frameId, fn, args, timeoutMs),
  )
}

async function withDebuggerFrames(tabId, visitor, timeoutMs = 15000) {
  return withDebugger(tabId, async (session) => {
    const target = session.target
    const tree = await readFrameTree(target)
    const results = []
    for (const frame of tree) {
      try {
        results.push({
          frame,
          value: await evalInFrameContext(target, frame.frameId, visitor.fn, visitor.args, timeoutMs),
        })
      } catch (error) {
        results.push({ frame, error: String(error?.message || error) })
      }
    }
    return results
  })
}

async function probeFrames(tabId, fn, args, timeoutMs = 5000) {
  const results = await withDebuggerFrames(tabId, { fn, args }, timeoutMs)
  const hit = results.find((entry) => entry.value)
  if (!hit) return null
  return {
    frameId: hit.frame.frameId,
    prefix: framePrefix(hit.frame.frameId).toLowerCase(),
    url: hit.frame.url,
    parentFrameId: hit.frame.parentFrameId,
  }
}

async function findAcrossFrames(tabId, query, limit, useRegex) {
  const results = await withDebuggerFrames(tabId, { fn: findInPage, args: [query, limit, useRegex] })
  const matches = []
  let failedFrames = 0
  for (const entry of results) {
    if (!entry.value || !Array.isArray(entry.value.matches)) {
      if (entry.error) failedFrames += 1
      continue
    }
    const isMain = !entry.frame.parentFrameId
    const prefix = framePrefix(entry.frame.frameId).toLowerCase()
    for (const match of entry.value.matches) {
      if (matches.length >= limit) break
      matches.push(
        isMain
          ? match
          : { ...match, frameRef: `f${prefix}:${match.ref}`, frame: prefix, frameId: entry.frame.frameId },
      )
    }
  }
  return {
    query,
    matches: matches.slice(0, limit),
    truncated: matches.length >= limit,
    frameCount: results.length,
    ...(failedFrames > 0 ? { failedFrames } : {}),
  }
}

async function getTextAcrossFrames(tabId, selector, maxChars) {
  const results = await withDebuggerFrames(tabId, { fn: getText, args: [selector, maxChars] })
  const parts = []
  let found = false
  let framesWithText = 0
  for (const entry of results) {
    if (!entry.value || entry.value.found === false) continue
    found = true
    framesWithText += 1
    if (!entry.frame.parentFrameId) {
      parts.unshift(entry.value.text || '')
      continue
    }
    const prefix = framePrefix(entry.frame.frameId).toLowerCase()
    parts.push(`\n\n[f${prefix}] ${entry.frame.url}\n${entry.value.text || ''}`)
  }
  const text = parts.join('')
  return {
    found,
    text: text.slice(0, maxChars),
    truncated: text.length > maxChars,
    frames: framesWithText,
  }
}

async function snapshotAllFrames(tabId, params) {
  const limit = Number.isFinite(params.maxChars) ? Math.max(1000, Math.min(200000, params.maxChars)) : 100000
  const boxes = Boolean(params.boxes)
  const mode = String(params.mode || 'full')
  return withDebugger(tabId, async (session) => {
    const target = session.target
    const tree = await readFrameTree(target)
    const frames = []
    let mainRaw = null
    for (const frame of tree) {
      const prefix = framePrefix(frame.frameId).toLowerCase()
      try {
        const value = await evalInFrameContext(target, frame.frameId, pageSnapshot, [limit, boxes, mode], 15000)
        const isMain = !frame.parentFrameId
        if (isMain) mainRaw = value
        const controls = Array.isArray(value?.controls)
          ? value.controls.map((control) =>
              isMain
                ? control
                : { ...control, frameRef: `f${prefix}:${control.ref}`, frame: prefix },
            )
          : []
        frames.push({
          frameId: frame.frameId,
          prefix,
          parentFrameId: frame.parentFrameId,
          url: value?.url || frame.url,
          title: value?.title || '',
          controls,
          text: isMain ? value?.text || '' : '',
          truncated: Boolean(value?.truncated),
        })
      } catch (error) {
        frames.push({
          frameId: frame.frameId,
          prefix,
          parentFrameId: frame.parentFrameId,
          url: frame.url,
          title: '',
          controls: [],
          error: String(error?.message || error),
        })
      }
    }
    const registry = new Map(frames.map((frame) => [frame.prefix, frame.frameId]))
    frameRegistry.set(tabId, registry)
    const main = frames.find((frame) => !frame.parentFrameId) ?? frames[0] ?? null
    const result = {
      title: main?.title || '',
      url: main?.url || '',
      mode,
      controls: main?.controls || [],
      text: main?.text || '',
      truncated: Boolean(main?.truncated),
      frameCount: frames.length,
    }
    if (mode === 'delta') {
      result.changedCount = Number.isFinite(mainRaw?.changedCount) ? mainRaw.changedCount : result.controls.length
      result.sameCount = Number.isFinite(mainRaw?.sameCount) ? mainRaw.sameCount : 0
      result.removedRefs = Array.isArray(mainRaw?.removedRefs) ? mainRaw.removedRefs : []
    }
    if (frames.length > 1) {
      result.frames = frames.map((frame) => ({
        frameId: frame.frameId,
        prefix: frame.prefix,
        parentFrameId: frame.parentFrameId,
        url: frame.url,
        title: frame.title,
        controls: frame.controls,
        ...(frame.error ? { error: frame.error } : {}),
      }))
    }
    return result
  })
}

async function frames(owner, params) {
  const tabId = await resolveOwnedTabId(owner, params.tabId)
  return withDebugger(tabId, async (session) => {
    const target = session.target
    const out = await readFrameTree(target)
    if (params?.probe) {
      for (const frame of out) {
        try {
          const world = await chrome.debugger.sendCommand(target, 'Page.createIsolatedWorld', {
            frameId: frame.frameId,
            worldName: 'dsh-frame-probe',
          })
          const probe = await chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
            contextId: world.executionContextId,
            expression:
              '({ url: location.href, title: document.title, buttons: document.querySelectorAll("button, input, select, textarea, a[href]").length })',
            returnByValue: true,
          })
          frame.probe = probe?.result?.value ?? null
        } catch (error) {
          frame.probeError = error?.message || String(error)
        }
      }
    }
    return { tabId, frames: out }
  })
}

async function selection(owner, params) {
  const tabId = await resolveOwnedTabId(owner, params.tabId)
  const maxChars = Number(params.maxChars)
  const result = await callInPage(tabId, 'selection', [Number.isFinite(maxChars) ? maxChars : null], 15000)
  if (!result?.found) {
    throw bridgeError(result?.reason || 'NO_SELECTION', result?.message || 'no page selection')
  }
  return { ...result, tabId }
}

async function typeText(owner, params) {
  const tabId = await resolveOwnedTabId(owner, params.tabId)
  const ref = Number(params.ref)
  const selector = params.selector ? String(params.selector) : ''
  const frameRef = params.frameRef ? String(params.frameRef) : ''
  if (!Number.isFinite(ref) && !selector && !frameRef) {
    throw bridgeError('INVALID_ARGUMENT', 'ref, frameRef or selector is required')
  }
  let result
  if (frameRef) {
    const parsed = parseFrameRef(frameRef)
    if (!parsed) throw bridgeError('INVALID_ARGUMENT', `invalid frameRef: ${frameRef}`)
    const frameId = frameIdForPrefix(tabId, parsed.prefix)
    if (!frameId) throw bridgeError('FRAME_STALE', 'frame registry is stale; take a new snapshot')
    result = await callInFrame(
      tabId,
      frameId,
      'type',
      [parsed.ref, String(params.text ?? ''), Boolean(params.replace), Boolean(params.submit), selector],
      15000,
    )
    if (result) result.frameRef = frameRef
  } else {
    result = await callInPage(
      tabId,
      'type',
      [Number.isFinite(ref) ? ref : null, String(params.text ?? ''), Boolean(params.replace), Boolean(params.submit), selector],
      15000,
      params.dialog,
    )
  }
  if (!result?.ok) {
    throw bridgeError(result?.reason || 'REF_STALE', result?.message || `ref ${ref} is stale; take a new snapshot`)
  }
  return attachSnapshotIfRequested(tabId, { ...result, tabId }, params)
}

async function press(owner, params) {
  const tabId = await resolveOwnedTabId(owner, params.tabId)
  const key = String(params.key || '')
  if (!key) throw bridgeError('INTERNAL', 'key is required')
  const result = await callInPage(tabId, 'press', [key], 15000, params.dialog)
  return attachSnapshotIfRequested(tabId, { ...result, tabId }, params)
}

async function scroll(owner, params) {
  const tabId = await resolveOwnedTabId(owner, params.tabId)
  const direction = String(params.direction || 'down')
  const amount = Number.isFinite(params.amount) ? Number(params.amount) : 600
  const result = await callInPage(tabId, 'scroll', [direction, amount])
  return attachSnapshotIfRequested(tabId, { ...result, tabId }, params)
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
  const result = { tabId, url: tab.url || '', title: tab.title || '', loadState: tab.status || 'complete' }
  if (params.frameHit) {
    result.frame = {
      prefix: params.frameHit.prefix,
      frameId: params.frameHit.frameId,
      url: params.frameHit.url,
      parentFrameId: params.frameHit.parentFrameId,
    }
  }
  return result
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
    await addTabToSession(owner, tab, { activate: false, label: params.ownerLabel || null })
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
  if (op === 'claim') {
    return claimTab(owner, params)
  }
  if (op === 'focus') {
    const tabId = await resolveOwnedTabId(owner, params.tabId)
    await chrome.tabs.update(tabId, { active: true })
    const tab = await chrome.tabs.get(tabId)
    return { tabId, url: tab.url || '', title: tab.title || '', focused: true }
  }
  throw bridgeError('UNSUPPORTED', `unknown tabs op: ${op}`)
}

async function selectAgent(owner, params) {
  const tabId = await resolveOwnedTabId(owner, params.tabId)
  const ref = Number(params.ref)
  const selector = params.selector ? String(params.selector) : ''
  if (!Number.isFinite(ref) && !selector) throw bridgeError('INVALID_ARGUMENT', 'ref or selector is required')
  const value = params.value == null ? '' : String(params.value)
  const checked = params.checked
  if (value === '' && typeof checked !== 'boolean') {
    throw bridgeError('INVALID_ARGUMENT', 'provide value (select/radio) or checked (checkbox)')
  }
  return callInPage(tabId, 'select', [Number.isFinite(ref) ? ref : null, value, checked, selector])
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
  await addTabToSession(owner, tab, { activate: false, label: params.ownerLabel || null })
  const claimed = await chrome.tabs.get(tab.id)
  return { tabId: tab.id, url: claimed.url || '', title: claimed.title || '', claimed: true }
}

async function uploadFiles(owner, params) {
  const tabId = await resolveOwnedTabId(owner, params.tabId)
  const ref = Number(params.ref)
  const selector = params.selector ? String(params.selector) : ''
  if (!Number.isFinite(ref) && !selector) throw bridgeError('INVALID_ARGUMENT', 'ref or selector is required')
  const files = Array.isArray(params.files) ? params.files.map(String) : []
  if (files.length === 0) throw bridgeError('INVALID_ARGUMENT', 'files must be a non-empty array of local paths')
  return withDebugger(tabId, async (session) => {
    const target = session.target
    const { root } = await chrome.debugger.sendCommand(target, 'DOM.getDocument', { depth: 0 })
    const { nodeId } = await chrome.debugger.sendCommand(target, 'DOM.querySelector', {
      nodeId: root.nodeId,
      selector: Number.isFinite(ref) ? `[data-dsh-ref="${ref}"]` : selector,
    })
    if (!nodeId) throw bridgeError('REF_STALE', `ref ${ref} not found; take a new snapshot`)
    await chrome.debugger.sendCommand(target, 'DOM.setFileInputFiles', { nodeId, files })
    return { ok: true, ...(Number.isFinite(ref) ? { ref } : {}), selector: selector || undefined, files: files.length }
  })
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

async function storage(owner, params) {
  const tabId = await resolveOwnedTabId(owner, params.tabId)
  const op = String(params.op || 'get')
  const scope = params.scope === 'session' ? 'session' : 'local'
  const key = params.key == null ? '' : String(params.key)
  const rawValue = params.value
  const keys = Array.isArray(params.keys) ? params.keys.map(String) : []
  const result = await callInPage(tabId, 'storage', [op, scope, key, rawValue, keys], 10000)
  if (!result?.ok) {
    throw bridgeError(result?.reason || 'INTERNAL', result?.message || 'storage operation failed')
  }
  return { ...result, tabId }
}

async function emulate(owner, params) {
  const tabId = await resolveOwnedTabId(owner, params?.tabId)
  return withDebugger(tabId, async (session) => {
    const target = session.target
    if (params?.reset) {
      let clearError = null
      try {
        await chrome.debugger.sendCommand(target, 'Emulation.clearDeviceMetricsOverride')
      } catch (error) {
        clearError = error?.message || String(error)
      }
      // Chromium keeps the overridden layout viewport for the renderer even
      // after clearDeviceMetricsOverride; a reload is what actually restores it.
      try {
        await chrome.tabs.reload(tabId)
        await waitForComplete(tabId, 15000)
      } catch {
        // reload may be blocked; report what we have
      }
      const viewport = await chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
        expression:
          '({ innerWidth: window.innerWidth, innerHeight: window.innerHeight, outerWidth: window.outerWidth, outerHeight: window.outerHeight, screenWidth: screen.width, screenHeight: screen.height, dpr: devicePixelRatio })',
        returnByValue: true,
      })
      return { width: null, height: null, applied: false, clearError, reloaded: true, viewport: viewport?.result?.value ?? null }
    }
    const width = Math.round(Number(params?.width))
    const height = Math.round(Number(params?.height))
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 100 || height < 100) {
      throw bridgeError('INVALID_ARGUMENT', 'width/height must be >= 100')
    }
    await chrome.debugger.sendCommand(target, 'Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: Boolean(params?.mobile),
    })
    const viewport = await chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
      expression: '({ innerWidth: window.innerWidth, innerHeight: window.innerHeight })',
      returnByValue: true,
    })
    return { width, height, applied: true, viewport: viewport?.result?.value ?? null }
  })
}

async function drag(owner, params) {
  const tabId = await resolveOwnedTabId(owner, params.tabId)
  const fromRef = Number(params.fromRef)
  const toRef = Number(params.toRef)
  if (!Number.isFinite(fromRef) || !Number.isFinite(toRef)) {
    throw bridgeError('INVALID_ARGUMENT', 'fromRef and toRef are required')
  }
  const result = await callInPage(tabId, 'drag', [fromRef, toRef], 15000)
  if (!result?.ok) {
    throw bridgeError(result?.reason || 'REF_STALE', result?.message || 'drag failed')
  }
  return { ...result, tabId }
}

async function pdf(owner, params) {
  const tabId = await resolveOwnedTabId(owner, params?.tabId)
  return withDebugger(tabId, async (session) => {
    const response = await chrome.debugger.sendCommand(session.target, 'Page.printToPDF', {
      printBackground: true,
      preferCSSPageSize: true,
    })
    if (!response?.data) throw bridgeError('INTERNAL', 'empty pdf data')
    return { dataBase64: response.data }
  })
}

async function a11y(owner, params) {
  const tabId = await resolveOwnedTabId(owner, params.tabId)
  const limit = Number.isFinite(params.limit) ? Math.min(400, Math.max(1, params.limit)) : 200
  return withDebugger(tabId, async (session) => {
    const target = session.target
    await chrome.debugger.sendCommand(target, 'Accessibility.enable')
    const response = await chrome.debugger.sendCommand(target, 'Accessibility.getFullAXTree')
    const asString = (value) => {
      if (typeof value === 'string') return value
      if (value && typeof value.value === 'string') return value.value
      return ''
    }
    const nodes = (response?.nodes ?? [])
      .filter((node) => node.ignored !== true)
      .map((node) => ({
        role: asString(node.role),
        name: asString(node.name),
        value: node.value?.value ?? undefined,
      }))
      .filter((node) => node.role || node.name)
    return {
      nodes: nodes.slice(0, limit).map((node) => ({
        role: node.role,
        name: String(node.name).slice(0, 160),
        ...(node.value != null ? { value: String(node.value).slice(0, 160) } : {}),
      })),
      total: nodes.length,
      truncated: nodes.length > limit,
    }
  })
}

async function getTextAgent(owner, params) {
  const tabId = await resolveOwnedTabId(owner, params.tabId)
  const maxChars = Number.isFinite(params.maxChars) ? Math.min(200000, Math.max(500, params.maxChars)) : 20000
  const selector = params.selector ? String(params.selector) : ''
  if (String(params.format || 'text') === 'markdown') {
    return callInPage(tabId, 'getMarkdown', [selector, maxChars])
  }
  if (params.frames === 'all') {
    const value = await getTextAcrossFrames(tabId, selector, maxChars)
    if (!value) throw bridgeError('INTERNAL', 'get_text returned no result')
    return value
  }
  return callInPage(tabId, 'getText', [selector, maxChars])
}

async function readConsoleAgent(owner, params) {
  const tabId = await resolveOwnedTabId(owner, params.tabId)
  const limit = Number.isFinite(params.limit) ? Math.min(120, Math.max(1, params.limit)) : 50
  const level = params.level ? String(params.level) : ''
  const filter = params.filter ? String(params.filter) : ''
  if (params.clear) await callInPage(tabId, 'consoleClear', []).catch(() => null)
  return callInPage(tabId, 'console', [level, limit, filter])
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
    let hit = null
    while (Date.now() - started < timeoutMs) {
      hit = await probeFrames(tabId, hasText, [text], 5000)
      if (hit) break
      await new Promise((resolve) => setTimeout(resolve, 300))
    }
    if (!hit) throw bridgeError('TIMEOUT', `text not found within ${timeoutMs}ms: ${text}`)
    params = { ...params, frameHit: hit }
  } else if (until === 'selector') {
    const selector = String(params.selector || '')
    if (!selector) throw bridgeError('INVALID_ARGUMENT', 'selector is required when until=selector')
    const started = Date.now()
    let hit = null
    while (Date.now() - started < timeoutMs) {
      hit = await probeFrames(tabId, hasSelector, [selector], 5000)
      if (hit) break
      await new Promise((resolve) => setTimeout(resolve, 300))
    }
    if (!hit) throw bridgeError('TIMEOUT', `selector not found within ${timeoutMs}ms: ${selector}`)
    params = { ...params, frameHit: hit }
  } else if (until === 'change') {
    const started = Date.now()
    let changed = false
    while (Date.now() - started < timeoutMs) {
      const delta = await callInPage(tabId, 'snapshot', [1000, false, 'delta'], 5000)
      if ((delta?.changedCount ?? 0) > 0 || (delta?.removedRefs ?? []).length > 0) {
        changed = true
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 300))
    }
    if (!changed) throw bridgeError('TIMEOUT', `no DOM change within ${timeoutMs}ms`)
  } else if (until === 'url') {
    const needle = String(params.url || '')
    if (!needle) throw bridgeError('INVALID_ARGUMENT', 'url is required when until=url')
    const started = Date.now()
    let found = false
    while (Date.now() - started < timeoutMs) {
      found = Boolean(await callInPage(tabId, 'urlMatches', [needle], 5000))
      if (found) break
      await new Promise((resolve) => setTimeout(resolve, 300))
    }
    if (!found) throw bridgeError('TIMEOUT', `url did not contain ${needle} within ${timeoutMs}ms`)
  } else {
    throw bridgeError('UNSUPPORTED', `unknown wait target: ${until}`)
  }
  const tab = await chrome.tabs.get(tabId)
  const result = { tabId, url: tab.url || '', title: tab.title || '', loadState: tab.status || 'complete' }
  if (params.frameHit) {
    result.frame = {
      prefix: params.frameHit.prefix,
      frameId: params.frameHit.frameId,
      url: params.frameHit.url,
      parentFrameId: params.frameHit.parentFrameId,
    }
  }
  return result
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
function pageSnapshot(maxChars, withBoxes, mode) {
  const deepAll = (selector) => (window.__dshDeep ? window.__dshDeep.all(selector) : Array.from(document.querySelectorAll(selector)))
  const deepOne = (selector) => (window.__dshDeep ? window.__dshDeep.one(selector) : document.querySelector(selector))
  const limit = Number.isFinite(maxChars) ? maxChars : 100000
  const deltaMode = String(mode || 'full') === 'delta'
  // Refs are stable across snapshots: an element that already has one keeps it;
  // only new elements get the next number. (Adopted from browser-use's stable
  // backend-node handles and Playwright MCP's per-page refs.)
  const nextRef = () => {
    if (!window.__dshRefSeq) {
      let max = 0
      for (const element of deepAll('[data-dsh-ref]')) {
        const value = Number(element.getAttribute('data-dsh-ref'))
        if (Number.isFinite(value) && value > max) max = value
      }
      window.__dshRefSeq = max + 1
    }
    const ref = window.__dshRefSeq
    window.__dshRefSeq += 1
    return ref
  }
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
    '[draggable="true"]',
    '[ondrop]',
    '[ondragover]',
  ]
  const seen = new Set()
  const elements = []
  for (const selector of selectors) {
    for (const element of deepAll(selector)) {
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
    let ref = Number(element.getAttribute('data-dsh-ref')) || 0
    const isNew = ref === 0
    if (isNew) {
      ref = nextRef()
      try {
        element.setAttribute('data-dsh-ref', String(ref))
      } catch {
        // read-only DOM is fine; the ref still works for this snapshot
      }
    }
    const control = {
      ref,
      tag: element.tagName.toLowerCase(),
      kind: kindOf(element),
      label: labelOf(element),
    }
    if (isNew) control.new = true
    if (withBoxes) {
      const box = element.getBoundingClientRect()
      control.box = [
        Math.round(box.left),
        Math.round(box.top),
        Math.round(box.width),
        Math.round(box.height),
      ]
    }
    const value = maskedValue(element)
    if (value !== undefined) control.value = value
    if (control.tag === 'a') {
      const href = element.getAttribute('href')
      if (href) control.href = href
    }
    controls.push(control)
  }

  const currentMap = new Map(controls.map((control) => [control.ref, control]))
  const previousMap = window.__dshLastMap instanceof Map ? window.__dshLastMap : new Map()
  window.__dshLastMap = currentMap
  if (deltaMode) {
    const changed = controls.filter((control) => {
      const previous = previousMap.get(control.ref)
      if (!previous) return true
      return previous.label !== control.label || previous.value !== control.value || previous.kind !== control.kind
    })
    const removedRefs = []
    for (const ref of previousMap.keys()) {
      if (!currentMap.has(ref)) removedRefs.push(ref)
    }
    return {
      title: document.title || '',
      url: location.href,
      mode: 'delta',
      controls: changed,
      changedCount: changed.length,
      removedRefs,
      sameCount: controls.length - changed.length,
      text: '',
      truncated: false,
    }
  }
  const bodyText = (document.body ? document.body.innerText : '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+\n/g, '\n')
    .trim()
  const truncated = bodyText.length > limit
  return {
    title: document.title || '',
    url: location.href,
    mode: 'full',
    controls,
    text: truncated ? bodyText.slice(0, limit) : bodyText,
    truncated,
  }
}

// ------------------------------------------------------- injected page actions
/** Runs inside the page; self-contained. */
function hoverByRef(ref, selector) {
  const element = ref
    ? window.__dshDeep?.byRef(ref) || document.querySelector(`[data-dsh-ref="${ref}"]`)
    : selector
      ? (() => {
          try {
            return window.__dshDeep?.one(String(selector)) || document.querySelector(String(selector))
          } catch {
            return null
          }
        })()
      : null
  if (!element) {
    return {
      ok: false,
      reason: ref ? 'REF_STALE' : 'SELECTOR_NOT_FOUND',
      message: ref ? `ref ${ref} not found; take a new snapshot` : `selector not found: ${selector}`,
    }
  }
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

function pageStorage(op, scope, key, value, keys) {
  const area = scope === 'session' ? sessionStorage : localStorage
  const encode = (input) => (typeof input === 'string' ? input : JSON.stringify(input))
  try {
    if (op === 'get') {
      if (key) return { ok: true, scope, value: area.getItem(key) }
      if (keys.length > 0) {
        const items = {}
        for (const name of keys) items[name] = area.getItem(name)
        return { ok: true, scope, items }
      }
      const items = {}
      for (let index = 0; index < area.length && index < 100; index += 1) {
        const name = area.key(index)
        items[name] = area.getItem(name)
      }
      return { ok: true, scope, items }
    }
    if (op === 'set') {
      if (keys.length > 0) {
        let count = 0
        for (const name of keys) {
          if (key === '') break
          area.setItem(name, encode(value))
          count += 1
        }
        return { ok: true, scope, set: count }
      }
      if (!key) return { ok: false, reason: 'INVALID_ARGUMENT', message: 'key is required for set' }
      area.setItem(key, encode(value))
      return { ok: true, scope, set: 1 }
    }
    if (op === 'remove') {
      const names = keys.length ? keys : key ? [key] : []
      for (const name of names) area.removeItem(name)
      return { ok: true, scope, removed: names.length }
    }
    if (op === 'clear') {
      area.clear()
      return { ok: true, scope, cleared: true }
    }
    return { ok: false, reason: 'UNSUPPORTED', message: `unsupported storage op: ${op}` }
  } catch (error) {
    return { ok: false, reason: 'STORAGE_ERROR', message: error?.message || String(error) }
  }
}

function dragByRef(fromRef, toRef) {
  const from = window.__dshDeep?.byRef(fromRef) || document.querySelector(`[data-dsh-ref="${fromRef}"]`)
  const to = window.__dshDeep?.byRef(toRef) || document.querySelector(`[data-dsh-ref="${toRef}"]`)
  if (!from || !to) {
    return { ok: false, reason: 'REF_STALE', message: `ref ${fromRef}/${toRef} not found; take a new snapshot` }
  }
  const startRect = from.getBoundingClientRect()
  const endRect = to.getBoundingClientRect()
  const x0 = startRect.left + startRect.width / 2
  const y0 = startRect.top + startRect.height / 2
  const x1 = endRect.left + endRect.width / 2
  const y1 = endRect.top + endRect.height / 2
  try {
    window.__dshCursor?.(x0, y0, 'click')
  } catch {}
  const dataTransfer = (() => {
    try {
      return new DataTransfer()
    } catch {
      return null
    }
  })()
  const base = { bubbles: true, cancelable: true, composed: true, view: window, dataTransfer }
  try {
    from.dispatchEvent(new PointerEvent('pointerdown', { ...base, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1, clientX: x0, clientY: y0 }))
  } catch {}
  from.dispatchEvent(new MouseEvent('mousedown', { ...base, button: 0, buttons: 1, clientX: x0, clientY: y0 }))
  if (typeof from.dragstart === 'object' || from.getAttribute('draggable') === 'true') {
    from.dispatchEvent(new DragEvent('dragstart', { ...base, clientX: x0, clientY: y0 }))
  }
  const steps = 6
  for (let index = 1; index <= steps; index += 1) {
    const x = x0 + ((x1 - x0) * index) / steps
    const y = y0 + ((y1 - y0) * index) / steps
    try {
      from.dispatchEvent(new PointerEvent('pointermove', { ...base, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1, clientX: x, clientY: y }))
      to.dispatchEvent(new PointerEvent('pointermove', { ...base, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1, clientX: x, clientY: y }))
    } catch {}
    to.dispatchEvent(new MouseEvent('mousemove', { ...base, button: 0, buttons: 1, clientX: x, clientY: y }))
    to.dispatchEvent(new DragEvent('dragenter', { ...base, clientX: x, clientY: y }))
    to.dispatchEvent(new DragEvent('dragover', { ...base, clientX: x, clientY: y }))
  }
  to.dispatchEvent(new DragEvent('drop', { ...base, clientX: x1, clientY: y1 }))
  from.dispatchEvent(new DragEvent('dragend', { ...base, clientX: x1, clientY: y1 }))
  try {
    to.dispatchEvent(new PointerEvent('pointerup', { ...base, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 0, clientX: x1, clientY: y1 }))
  } catch {}
  to.dispatchEvent(new MouseEvent('mouseup', { ...base, button: 0, buttons: 0, clientX: x1, clientY: y1 }))
  to.dispatchEvent(new MouseEvent('click', { ...base, button: 0, clientX: x1, clientY: y1 }))
  return { ok: true, from: fromRef, to: toRef }
}

function clickAtPoint(x, y, buttonName, clickCount) {
  const px = Number(x)
  const py = Number(y)
  if (!Number.isFinite(px) || !Number.isFinite(py)) {
    return { ok: false, reason: 'INVALID_ARGUMENT', message: 'x and y must be finite numbers' }
  }
  if (px < 0 || py < 0 || px > window.innerWidth || py > window.innerHeight) {
    return {
      ok: false,
      reason: 'OUT_OF_VIEWPORT',
      message: `(${px}, ${py}) is outside the ${window.innerWidth}x${window.innerHeight} viewport`,
    }
  }
  const target = document.elementFromPoint(px, py) || document.body
  const button = buttonName === 'right' ? 2 : buttonName === 'middle' ? 1 : 0
  const count = Number.isFinite(clickCount) ? Math.max(1, Math.min(3, clickCount)) : 1
  try {
    window.__dshCursor?.(px, py, 'click')
  } catch {}
  const base = { bubbles: true, cancelable: true, composed: true, view: window, clientX: px, clientY: py, button, detail: count }
  const pointer = { ...base, pointerId: 1, pointerType: 'mouse', isPrimary: button === 0, button, buttons: 1 }
  try { target.dispatchEvent(new PointerEvent('pointerdown', pointer)) } catch {}
  target.dispatchEvent(new MouseEvent('mousedown', base))
  try { target.dispatchEvent(new PointerEvent('pointerup', { ...pointer, buttons: 0 })) } catch {}
  target.dispatchEvent(new MouseEvent('mouseup', base))
  if (button === 2) {
    target.dispatchEvent(new MouseEvent('contextmenu', base))
  } else {
    target.dispatchEvent(new MouseEvent('click', base))
    if (count === 2) target.dispatchEvent(new MouseEvent('dblclick', base))
  }
  return {
    ok: true,
    x: px,
    y: py,
    tag: target.tagName.toLowerCase(),
    label: ((target.innerText || target.getAttribute('aria-label') || '') + '').trim().slice(0, 80),
  }
}

function clickByRef(ref, selector, buttonName, clickCount) {
  const element = ref
    ? window.__dshDeep?.byRef(ref) || document.querySelector(`[data-dsh-ref="${ref}"]`)
    : selector
      ? (() => {
          try {
            return window.__dshDeep?.one(String(selector)) || document.querySelector(String(selector))
          } catch {
            return null
          }
        })()
      : null
  if (!element) {
    return {
      ok: false,
      reason: ref ? 'REF_STALE' : 'SELECTOR_NOT_FOUND',
      message: ref ? `ref ${ref} not found; take a new snapshot` : `selector not found: ${selector}`,
    }
  }
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
function typeIntoRef(ref, text, replace, submit, selector) {
  const element = ref
    ? window.__dshDeep?.byRef(ref) || document.querySelector(`[data-dsh-ref="${ref}"]`)
    : selector
      ? (() => {
          try {
            return window.__dshDeep?.one(String(selector)) || document.querySelector(String(selector))
          } catch {
            return null
          }
        })()
      : null
  if (!element) {
    return {
      ok: false,
      reason: ref ? 'REF_STALE' : 'SELECTOR_NOT_FOUND',
      message: ref ? `ref ${ref} not found; take a new snapshot` : `selector not found: ${selector}`,
    }
  }
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
function findInPage(query, limit, useRegex) {
  const raw = String(query || '')
  if (!raw.trim()) return { query: '', matches: [], truncated: false }
  let matcher
  if (useRegex) {
    try {
      matcher = new RegExp(raw, 'i')
    } catch {
      return { query: raw, matches: [], truncated: false, error: 'INVALID_REGEX' }
    }
  } else {
    const needle = raw.toLowerCase()
    matcher = { test: (value) => String(value).toLowerCase().includes(needle) }
  }
  const max = Number.isFinite(limit) ? Math.max(1, Math.min(50, limit)) : 20
  const roots = window.__dshDeep ? window.__dshDeep.roots(document.body || document.documentElement) : [document.body || document.documentElement]
  const matches = []
  const seen = new Set()
  for (const root of roots) {
    if (matches.length >= max) break
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    let node
    while ((node = walker.nextNode())) {
      if (matches.length >= max) break
      const value = node.nodeValue || ''
      if (!matcher.test(value)) continue
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
      if (!window.__dshRefSeq) {
        let max = 0
        const scan = window.__dshDeep ? window.__dshDeep.all('[data-dsh-ref]') : document.querySelectorAll('[data-dsh-ref]')
        for (const element of scan) {
          const value = Number(element.getAttribute('data-dsh-ref'))
          if (Number.isFinite(value) && value > max) max = value
        }
        window.__dshRefSeq = max + 1
      }
      ref = window.__dshRefSeq
      window.__dshRefSeq += 1
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
  }
  return { query, matches, truncated: matches.length >= max }
}

function selectByRef(ref, value, checked, selector) {
  const element = ref
    ? window.__dshDeep?.byRef(ref) || document.querySelector(`[data-dsh-ref="${ref}"]`)
    : selector
      ? (() => {
          try {
            return window.__dshDeep?.one(String(selector)) || document.querySelector(String(selector))
          } catch {
            return null
          }
        })()
      : null
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

function getMarkdown(selector, maxChars) {
  const limit = Number.isFinite(maxChars) ? maxChars : 20000
  let root
  try {
    root = selector
      ? window.__dshDeep?.one(selector) || document.querySelector(selector)
      : window.__dshDeep?.one('main,article,[role="main"]') || document.querySelector('main,article,[role="main"]') || document.body
  } catch {
    return { found: false, error: 'INVALID_SELECTOR', text: '', truncated: false }
  }
  if (!root) return { found: false, text: '', truncated: false }
  const inline = (node) => {
    if (node.nodeType === Node.TEXT_NODE) return node.nodeValue || ''
    if (node.nodeType !== Node.ELEMENT_NODE) return ''
    const tag = node.tagName.toLowerCase()
    if (['script', 'style', 'noscript', 'template', 'svg', 'head'].includes(tag)) return ''
    if (tag === 'br') return '\n'
    if (tag === 'img') return `![${node.getAttribute('alt') || ''}](${node.getAttribute('src') || ''})`
    if (tag === 'a') {
      const text = Array.from(node.childNodes).map(inline).join('')
      return node.getAttribute('href') ? `[${text}](${node.getAttribute('href')})` : text
    }
    if (tag === 'code') return `\`${node.textContent || ''}\``
    if (tag === 'strong' || tag === 'b') return `**${Array.from(node.childNodes).map(inline).join('')}**`
    if (tag === 'em' || tag === 'i') return `*${Array.from(node.childNodes).map(inline).join('')}*`
    const shadow = node.shadowRoot ? Array.from(node.shadowRoot.childNodes).map(inline).join('') : ''
    return Array.from(node.childNodes).map(inline).join('') + shadow
  }
  const block = (node, depth = 0) => {
    if (node.nodeType === Node.TEXT_NODE) return (node.nodeValue || '').trim()
    if (node.nodeType !== Node.ELEMENT_NODE) return ''
    const tag = node.tagName.toLowerCase()
    const children = () => Array.from(node.children || []).map((child) => block(child, depth)).filter(Boolean)
    if (/^h[1-6]$/.test(tag)) return `${'#'.repeat(Number(tag[1]))} ${(node.textContent || '').trim()}`
    if (tag === 'p') return blockChildrenInline(node)
    if (tag === 'ul' || tag === 'ol') {
      const items = Array.from(node.children).filter((child) => child.tagName.toLowerCase() === 'li')
      return items
        .map((li, index) => `${'  '.repeat(depth)}${tag === 'ol' ? `${index + 1}.` : '-'} ${blockChildrenInline(li).replace(/\n/g, ' ')}`)
        .join('\n')
    }
    if (tag === 'pre') return `\n\`\`\`\n${(node.textContent || '').replace(/\n+$/, '')}\n\`\`\`\n`
    if (tag === 'blockquote') return `> ${blockChildrenInline(node)}`
    if (tag === 'hr') return '---'
    if (['script', 'style', 'noscript', 'svg'].includes(tag)) return ''
    if (['div', 'section', 'article', 'main', 'header', 'footer', 'nav', 'aside', 'form', 'li'].includes(tag)) {
      const shadow = node.shadowRoot ? blockChildrenInline(node.shadowRoot) : ''
      return [children().join('\n\n'), shadow].filter(Boolean).join('\n\n')
    }
    const shadowText = node.shadowRoot ? blockChildrenInline(node.shadowRoot) : ''
    return [blockChildrenInline(node), shadowText].filter(Boolean).join(' ')
  }
  const blockChildrenInline = (node) => Array.from(node.childNodes).map(inline).join('').replace(/[ \t]+/g, ' ').trim()
  const markdown = block(root)
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  const truncated = markdown.length > limit
  return { found: true, text: truncated ? markdown.slice(0, limit) : markdown, truncated }
}

function getText(selector, maxChars) {
  const limit = Number.isFinite(maxChars) ? maxChars : 20000
  let node = null
  try {
    node = selector
      ? window.__dshDeep?.one(selector) || document.querySelector(selector)
      : window.__dshDeep?.one('main,article,[role="main"]') || document.querySelector('main,article,[role="main"]') || document.body
  } catch {
    return { found: false, error: 'INVALID_SELECTOR', text: '', truncated: false }
  }
  if (!node) return { found: false, text: '', truncated: false }
  const raw = (window.__dshDeep ? window.__dshDeep.text(node) : node.innerText || node.textContent || '').replace(/\n{3,}/g, '\n\n').trim()
  return { found: true, text: raw.slice(0, limit), truncated: raw.length > limit }
}

function readConsole(level, limit, filter) {
  const state = window.__dshConsole
  if (!state) return { available: false, entries: [] }
  const max = Number.isFinite(limit) ? Math.max(1, Math.min(120, limit)) : 50
  const needle = String(filter || '').toLowerCase()
  let list = state.entries
  if (level) list = list.filter((entry) => entry.level === level)
  if (needle) list = list.filter((entry) => String(entry.text || '').toLowerCase().includes(needle))
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
      ...(Number.isFinite(entry.responseStatus) ? { status: entry.responseStatus } : {}),
    })),
  }
}

function outerHtml(selector, mode, maxChars) {
  const limit = Number.isFinite(maxChars) ? Math.max(500, Math.min(200000, maxChars)) : 20000
  let root = null
  try {
    root = selector
      ? window.__dshDeep?.one(String(selector)) || document.querySelector(String(selector))
      : document.documentElement
  } catch {
    return { found: false, error: 'INVALID_SELECTOR', message: 'invalid selector' }
  }
  if (!root) return { found: false, error: 'SELECTOR_NOT_FOUND', message: `selector not found: ${selector}` }
  const simplify = mode === 'simplified'
  let raw = root.outerHTML || ''
  if (simplify) {
    raw = raw
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
      .replace(/\sstyle\s*=\s*("[^"]*"|'[^']*')/gi, '')
      .replace(/\s+/g, ' ')
      .trim()
  }
  // Never let credential-shaped attributes reach the model. Values are
  // masked even in "outer" mode; script/style text is removed in simplified.
  raw = raw
    .replace(/\bvalue\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, 'value="••••"')
    .replace(
      /\b(?:[a-z0-9_-]*(?:token|secret|csrf|password|passwd|authorization|cookie|session|api[-_]?key)[a-z0-9_-]*)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi,
      (match) => match.replace(/=\s*("[^"]*"|'[^']*'|[^\s>]+)$/, '="••••"'),
    )
  const truncated = raw.length > limit
  return {
    found: true,
    mode: simplify ? 'simplified' : 'outer',
    html: truncated ? raw.slice(0, limit) : raw,
    truncated,
    length: raw.length,
  }
}

function readSelection(maxChars) {
  const limit = Number.isFinite(maxChars) ? Math.max(10, Math.min(20000, maxChars)) : 4000
  const active = document.activeElement
  const sensitive = (element) => {
    if (!element) return false
    const tag = String(element.tagName || '').toLowerCase()
    const type = String(element.getAttribute('type') || '').toLowerCase()
    const autocomplete = String(element.getAttribute('autocomplete') || '').toLowerCase()
    const name = String(element.getAttribute('name') || '').toLowerCase()
    if (type === 'password' || type === 'hidden') return true
    if (autocomplete.includes('cc-') || autocomplete.includes('password')) return true
    return /pass(word)?|card|otp|token|secret|cvv|payment/.test(name)
  }
  if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA') && sensitive(active)) {
    return { found: false, reason: 'SENSITIVE_SELECTION', message: 'selection is inside a sensitive field' }
  }
  if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) {
    const start = Number(active.selectionStart)
    const end = Number(active.selectionEnd)
    const value = typeof active.value === 'string' ? active.value : ''
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
      const text = value.slice(start, end)
      return {
        found: true,
        text: text.slice(0, limit),
        url: location.href,
        title: document.title,
        truncated: text.length > limit,
        source: 'input',
      }
    }
  }
  const selection = window.getSelection()
  const text = selection ? String(selection) : ''
  if (!text.trim()) return { found: false, reason: 'NO_SELECTION', message: 'no text is selected on the page' }
  return {
    found: true,
    text: text.slice(0, limit),
    url: location.href,
    title: document.title,
    truncated: text.length > limit,
    source: 'page',
  }
}

function elementBox(ref, selector) {
  const element = ref
    ? window.__dshDeep?.byRef(ref) || document.querySelector(`[data-dsh-ref="${ref}"]`)
    : selector
      ? (() => {
          try {
            return window.__dshDeep?.one(String(selector)) || document.querySelector(String(selector))
          } catch {
            return null
          }
        })()
      : null
  if (!element) return null
  const rect = element.getBoundingClientRect()
  return {
    x: Math.round(rect.left),
    y: Math.round(rect.top),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  }
}

function drawRefOverlay() {
  const existing = document.getElementById('__dsh_ref_overlay__')
  if (existing) existing.remove()
  const overlay = document.createElement('div')
  overlay.id = '__dsh_ref_overlay__'
  overlay.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647'
  let count = 0
  const refElements = window.__dshDeep ? window.__dshDeep.all('[data-dsh-ref]') : document.querySelectorAll('[data-dsh-ref]')
  for (const element of refElements) {
    const ref = element.getAttribute('data-dsh-ref')
    const rect = element.getBoundingClientRect()
    if (rect.width < 2 || rect.height < 2) continue
    if (rect.bottom < 0 || rect.top > window.innerHeight || rect.right < 0 || rect.left > window.innerWidth) continue
    const box = document.createElement('div')
    box.style.cssText =
      'position:absolute;border:2px solid rgba(0,122,255,.9);border-radius:3px;box-sizing:border-box;left:' +
      Math.round(rect.left) +
      'px;top:' +
      Math.round(rect.top) +
      'px;width:' +
      Math.round(rect.width) +
      'px;height:' +
      Math.round(rect.height) +
      'px'
    const label = document.createElement('div')
    label.textContent = ref
    label.style.cssText =
      'position:absolute;left:0;top:-16px;background:rgba(0,122,255,.95);color:#fff;font:11px/14px -apple-system,sans-serif;padding:0 4px;border-radius:3px'
    box.appendChild(label)
    overlay.appendChild(box)
    count += 1
  }
  document.documentElement.appendChild(overlay)
  return { count }
}

function removeRefOverlay() {
  document.getElementById('__dsh_ref_overlay__')?.remove()
  return { ok: true }
}

function hasSelector(selector) {
  try {
    return Boolean(window.__dshDeep?.one(String(selector)) || document.querySelector(String(selector)))
  } catch {
    return false
  }
}

function urlMatches(needle) {
  return location.href.includes(String(needle))
}

function hasText(text) {
  return (document.body ? document.body.innerText : '').includes(text)
}

// --------------------------------------------------------------- worker wiring
function ensureReconnectAlarm() {
  try {
    chrome.alarms.create('dsh-chrome-reconnect', { periodInMinutes: 1 })
    // Independent watchdog: even when no other event wakes the worker, retry
    // the native port every 30s and let the self-heal path reload if needed.
    chrome.alarms.create('dsh-chrome-watchdog', { periodInMinutes: 1 })
  } catch {
    // alarms are best effort; the port and popup button still work
  }
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source?.tabId
  if (tabId == null) return
  const session = debuggerSessions.get(tabId)
  if (!session) return
  if (method === 'Page.javascriptDialogOpening') {
    if (!session.interceptDialogs) return
    const policy = dialogPolicy(session.dialogOptions, params)
    session.dialogs.push({
      type: String(params?.type || 'alert'),
      message: String(params?.message || '').slice(0, 500),
      accepted: policy.accept,
    })
    chrome.debugger
      .sendCommand(session.target, 'Page.handleJavaScriptDialog', {
        accept: policy.accept,
        promptText: policy.promptText,
      })
      .catch(() => {})
    return
  }
  if (String(method).startsWith('Network.')) {
    routeNetworkEvent(session, method, params)
  }
})

chrome.debugger.onDetach.addListener((source, reason) => {
  const tabId = source?.tabId
  if (tabId == null) return
  const session = debuggerSessions.get(tabId)
  if (session?.capture) endCapture(session.capture, `debugger-detached:${reason}`)
  debuggerSessions.delete(tabId)
})

chrome.tabs.onRemoved.addListener((tabId) => {
  const session = debuggerSessions.get(tabId)
  if (session?.capture) endCapture(session.capture, 'tab-closed')
  debuggerSessions.delete(tabId)
  frameRegistry.delete(tabId)
})

chrome.runtime.onInstalled.addListener(() => {
  ensureReconnectAlarm()
  ensurePort().catch(() => {})
})
chrome.runtime.onStartup.addListener(() => {
  ensureReconnectAlarm()
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
  diag('alarm', { name: alarm.name, hasPort: Boolean(port) })
  try {
  if (alarm.name === 'dsh-chrome-watchdog') {
    if (!port) {
      forceReconnect().catch(() => {})
    }
    return
  }
  if (!alarm.name.startsWith('dsh-chrome-reconnect')) return
  // Force, not "if (!port)": a killed native host can leave a stale port
  // object behind, and then a conditional reconnect never fires.
  forceReconnect().catch(() => {})
  } catch (error) {
    diag('alarm-error', { name: alarm.name, error: error?.message || String(error) })
  }
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
  if (message?.type === 'dsh-focus-tab') {
    ;(async () => {
      const sessions = await loadSessions()
      let tabId = null
      for (const entry of Object.values(sessions || {})) {
        if (Number.isFinite(entry?.activeTabId)) {
          tabId = entry.activeTabId
          break
        }
      }
      if (!tabId) {
        sendResponse({ ok: false, error: 'no session tab yet' })
        return
      }
      try {
        await chrome.tabs.update(tabId, { active: true })
        const tab = await chrome.tabs.get(tabId)
        sendResponse({ ok: true, tabId, url: tab.url || '', title: tab.title || '' })
      } catch (error) {
        sendResponse({ ok: false, error: error?.message || String(error) })
      }
    })()
    return true
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
diag('worker-start', { version: VERSION, hasPort: Boolean(port) })
ensureReconnectAlarm()
ensurePort().catch(() => {})
setTimeout(() => {
  reconcileAllGroups().catch(() => {})
}, 1200)
