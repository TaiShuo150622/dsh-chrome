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
const RECONNECT_ALARM = 'dsh-chrome-reconnect'
const RECONNECT_ONCE_ALARM = 'dsh-chrome-reconnect-once'

// Structured diagnostics persisted to chrome.storage.local so the reconnect
// behaviour can be inspected after the worker has been evicted (console logs
// alone are lost when the worker dies).
//
// Writes are serialized: concurrent calls used to race on the read-modify-write
// of the 80-slot ring, so when two entries landed in the same turn the later
// write won and the earlier one vanished. Measured 2026-10-18 in the real
// browser: the ring held 80/80 no-op "force-reconnect" heartbeats while every
// real transition (worker-start / connect-start) had been pushed out of it.
let diagWriteChain = Promise.resolve()
function diag(event, extra = {}) {
  const entry = { t: new Date().toISOString(), event, ...extra }
  try {
    console.log('[DSH Chrome][diag]', JSON.stringify(entry))
  } catch {}
  diagWriteChain = diagWriteChain
    .then(async () => {
      const stored = await chrome.storage.local.get(DIAG_KEY)
      const list = Array.isArray(stored?.[DIAG_KEY]) ? stored[DIAG_KEY] : []
      list.push(entry)
      while (list.length > 80) list.shift()
      await chrome.storage.local.set({ [DIAG_KEY]: list })
    })
    .catch(() => {})
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

async function syncTabsFromGroup(entry) {
  if (entry?.groupId == null) return
  try {
    const groupTabs = await chrome.tabs.query({ groupId: entry.groupId })
    const ids = groupTabs.map((tab) => tab.id).filter((id) => Number.isFinite(id))
    const changed = ids.some((id) => !entry.tabIds.includes(id)) || entry.tabIds.some((id) => !ids.includes(id))
    if (!changed) return
    entry.tabIds = ids
    if (entry.activeTabId != null && !ids.includes(entry.activeTabId)) entry.activeTabId = ids[0] ?? null
    if (entry.activeTabId == null && ids.length) entry.activeTabId = ids[0]
    await saveSessions()
  } catch {
    // keep stored ids
  }
}

async function getSessionEntry(owner) {
  const sessions = await loadSessions()
  const key = ownerKey(owner)
  let entry = sessions[key]
  if (!entry) {
    entry = {
      tabIds: [],
      groupId: null,
      activeTabId: null,
      paused: false,
      pausedAt: null,
      pausedUrl: '',
      // H4: downloads are scoped to tabs this session owns. The timestamp is
      // diagnostic only; an entry restored from an older extension version gets
      // a fresh start so the session never inherits another session's history.
      startedAt: Date.now(),
    }
    sessions[key] = entry
  } else if (!Number.isFinite(entry.startedAt)) {
    entry.startedAt = Date.now()
    await saveSessions()
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
  // Always keep the owner short id in a labelled title: two sessions with the
  // same working directory used to produce the same title and share one group,
  // which let each session close the other's tabs (R-12).
  return label ? `DSH · ${label} · ${ownerShort(owner)}` : groupTitle(owner)
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
  entry.paused = false
  entry.pausedAt = null
  entry.pausedUrl = ''
  expectedActivations.add(tab.id)
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

const expectedActivations = new Set()
const lastActiveByWindow = new Map()

async function persistActiveWindows() {
  try {
    await chrome.storage.local.set({ dshActiveWindows: Object.fromEntries(lastActiveByWindow) })
  } catch {
    // best effort
  }
}

async function initActiveWindows() {
  try {
    const stored = await chrome.storage.local.get('dshActiveWindows')
    for (const [windowId, tabId] of Object.entries(stored?.dshActiveWindows || {})) {
      const id = Number(windowId)
      const tab = Number(tabId)
      if (Number.isFinite(id) && Number.isFinite(tab)) lastActiveByWindow.set(id, tab)
    }
  } catch {
    // ignore
  }
  try {
    const activeTabs = await chrome.tabs.query({ active: true })
    for (const tab of activeTabs) {
      if (Number.isFinite(tab.windowId) && Number.isFinite(tab.id)) lastActiveByWindow.set(tab.windowId, tab.id)
    }
    await persistActiveWindows()
  } catch {
    // ignore
  }
}

async function ensureNotPaused(owner) {
  const entry = await getSessionEntry(owner)
  if (entry.paused) {
    throw bridgeError(
      'USER_SWITCHED',
      `user switched to ${entry.pausedUrl || 'another tab'}; call chrome_tabs {op:"focus"} or chrome_resume to continue`,
    )
  }
}

async function resumeSession(owner) {
  const entry = await getSessionEntry(owner)
  entry.paused = false
  entry.pausedAt = null
  entry.pausedUrl = ''
  await saveSessions()
  return { ok: true, tabId: entry.activeTabId }
}

async function onTabActivated(info) {
  const tabId = Number(info?.tabId)
  const windowId = Number(info?.windowId)
  if (!Number.isFinite(tabId) || !Number.isFinite(windowId)) return
  const sessions = await loadSessions()
  const previous = lastActiveByWindow.get(windowId)
  lastActiveByWindow.set(windowId, tabId)
  persistActiveWindows().catch(() => {})
  const expected = expectedActivations.delete(tabId)
  const ownerOfTab = Object.entries(sessions).find(([, entry]) => Array.isArray(entry?.tabIds) && entry.tabIds.includes(tabId))
  if (ownerOfTab) {
    const entry = ownerOfTab[1]
    if (entry.paused) {
      entry.paused = false
      entry.pausedAt = null
      entry.pausedUrl = ''
      await saveSessions()
    }
    return
  }
  if (expected || previous == null || previous === tabId) return
  const ownerOfPrevious = Object.entries(sessions).find(([, entry]) => entry?.activeTabId === previous)
  if (!ownerOfPrevious) return
  const entry = ownerOfPrevious[1]
  if (Array.isArray(entry.tabIds) && entry.tabIds.includes(tabId)) return
  entry.paused = true
  entry.pausedAt = Date.now()
  try {
    const tab = await chrome.tabs.get(tabId)
    entry.pausedUrl = tab.url || ''
  } catch {
    entry.pausedUrl = ''
  }
  await saveSessions()
  diag('user-switched', { owner: ownerShort(ownerOfPrevious[0]), pausedUrl: entry.pausedUrl })
}

async function closeSessionTabs(owner) {
  const sessions = await loadSessions()
  const key = ownerKey(owner)
  const entry = sessions[key]
  if (!entry) return { closed: 0 }
  await syncTabsFromGroup(entry)
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
    // A reload tears the worker down; detach every debuggee first so Chrome
    // does not keep a "being debugged" session that no worker owns.
    prepareForReload()
      .catch(() => {})
      .finally(() => {
        try {
          chrome.runtime.reload()
        } catch (error) {
          log('extension reload failed', error?.message || error)
        }
      })
  }, 800)
}

// Native-port self-heal: if Chrome keeps refusing to relaunch the host after a
// crash, reload the extension once (a reload always restores the port in real
// testing). Capped so a broken native-host manifest cannot cause a reload loop.
let nativeFailureTimes = []
let selfHealTimer = null
// The stored counter only matters after a failure episode. `selfHealStored`
// starts true so a fresh worker clears a counter left behind by the previous
// one; after that a healthy port does not rewrite it on every message
// (measured 2026-10-18: 3 small chrome.storage writes/min while completely
// idle, from the provider's 20s keepalive ping).
let selfHealStored = true

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
    selfHealStored = true
  } catch {
    // storage unavailable; rely on in-memory guard
  }
  log('native port keeps failing; reloading extension to restore it')
  diag('self-heal-reload', { attempts })
  selfHealTimer = setTimeout(() => {
    selfHealTimer = null
    prepareForReload()
      .catch(() => {})
      .finally(() => {
        try {
          chrome.runtime.reload()
        } catch (error) {
          log('self-heal reload failed', error?.message || error)
        }
      })
  }, 1200)
}

function notePortAlive() {
  nativeFailureTimes = []
  if (!selfHealStored) return
  selfHealStored = false
  try {
    chrome.storage.local
      .set({ dshSelfHeal: { count: 0, at: Date.now() } })
      .catch(() => {})
  } catch {
    // storage unavailable; in-memory reset is still useful
  }
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
    notePortAlive()
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
    // The provider that owned these captures/screencasts is gone: drop every
    // debuggee now instead of leaving Chrome attached to a tab no live client
    // can read. The next provider starts from a clean session table.
    releaseAllDebuggerSessions('provider-disconnected').catch(() => {})
    // Do NOT reconnect from inside this dying worker context: Chrome tears
    // down the freshly spawned host together with the old context. A fresh
    // wake-up (alarm / keepalive message / tab update) reconnects instead.
    try {
      chrome.alarms.create(RECONNECT_ONCE_ALARM, { delayInMinutes: 0.2 })
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
  // Healthy port: this call is a no-op, so do not persist a diag entry for it
  // (the 1-minute alarm called this every minute while idle).
  if (port && !force) return Promise.resolve(port)
  diag('force-reconnect', { force, hasPort: Boolean(port), connecting: Boolean(connecting) })
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
      // The periodic reconnect alarm is the only way back when the worker is
      // evicted and no page is open to run the keepalive script, so expose what
      // is actually scheduled (chrome_status renders it).
      let alarms = []
      try {
        alarms = (await chrome.alarms.getAll())
          .filter((alarm) => String(alarm?.name || '').startsWith('dsh-chrome-'))
          .map((alarm) => ({
            name: alarm.name,
            periodInMinutes: alarm.periodInMinutes ?? null,
            scheduledTime: alarm.scheduledTime ?? null,
          }))
      } catch {
        alarms = []
      }
      return {
        extensionVersion: VERSION,
        connected: true,
        diskVersion: lastDiskVersion,
        autoReload: Boolean(lastDiskVersion),
        groupCount,
        groups,
        alarms,
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
    case 'tab.evaluate':
      return evaluate(owner, params)
    case 'browser.site':
      return siteInfo(owner, params)
    case 'tab.resume':
      return resumeSession(owner)
    case 'tab.pick_start':
      return pickStartAgent(owner, params)
    case 'tab.pick_status':
      return pickStatusAgent(owner, params)
    case 'tab.pick_cancel':
      return pickCancelAgent(owner, params)
    case 'tab.capture_start':
      return startCapture(owner, params)
    case 'tab.capture_stop':
      return stopCapture(owner, params)
    case 'tab.capture_requests':
      return captureRequests(owner, params)
    case 'tab.screencast_start':
      return startScreencast(owner, params)
    case 'tab.screencast_stop':
      return stopScreencast(owner)
    case 'tab.screencast_status':
      return screencastStatus(owner)
    case 'tab.debug_diag':
      return readDiag()
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
      return listDownloads(owner, params)
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
    case 'tab.overlay':
      return overlayAction(owner, params)
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
  await ensureNotPaused(owner)
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
  overlay: (params) => (window.__dshOverlay ? window.__dshOverlay.handle(params) : { ok: false, error: 'OVERLAY_NOT_READY' }),
  selection: readSelection,
  pickStart,
  pickStatus,
  pickCancel,
  overlayDraw: drawRefOverlay,
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
  const ID = '__dsh_cursor__'
  if (window.__dshCursor && window.__dshCursorVersion === 2) return
  if (window.__dshCursor) {
    try { document.getElementById(ID)?.remove() } catch {}
    window.__dshCursor = null
  }
  window.__dshCursorVersion = 2
  window.__dshCursor = (x, y, kind) => {
    try {
      let cursor = document.getElementById(ID)
      if (!cursor) {
        cursor = document.createElement('div')
        cursor.id = ID
        cursor.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none;opacity:0;transition:transform .22s cubic-bezier(.2,.8,.2,1),opacity .2s'
        const ring = document.createElement('div')
        ring.style.cssText = 'position:absolute;left:-18px;top:-18px;width:36px;height:36px;border-radius:50%;border:2px solid rgba(0,122,255,.55);opacity:0;transition:opacity .2s,transform .3s'
        const dot = document.createElement('div')
        dot.style.cssText = 'position:absolute;left:0;top:0;width:30px;height:30px;filter:drop-shadow(0 2px 3px rgba(0,0,0,.35))'
        dot.innerHTML = '<svg width="30" height="30" viewBox="0 0 50 50"><path d="M48.8354 10.0479C48.3232 9.79199 48.1025 10.2798 47.8032 10.5278C47.7007 10.6079 47.6143 10.7119 47.5273 10.8076C46.7793 11.624 45.9048 12.1597 44.7622 12.0957C43.0923 12 41.666 12.5356 40.4058 13.8398C40.1377 12.2319 39.2476 11.272 37.8926 10.6558C37.1836 10.3359 36.4668 10.0156 35.9702 9.31982C35.6235 8.82373 35.5293 8.27197 35.356 7.72754C35.2456 7.3999 35.1353 7.06396 34.7651 7.00781C34.3633 6.94385 34.2056 7.2876 34.0479 7.57568C33.418 8.75195 33.1733 10.0479 33.1973 11.3599C33.2524 14.312 34.4736 16.6641 36.8999 18.3359C37.1758 18.5278 37.2466 18.7197 37.1597 19C36.9946 19.5757 36.7974 20.1357 36.624 20.7119C36.5137 21.0801 36.3486 21.1597 35.9624 21C34.6309 20.4321 33.481 19.5918 32.4644 18.5757C30.7393 16.8721 29.1792 14.9917 27.2334 13.52C26.7764 13.1758 26.3193 12.856 25.8467 12.5518C23.8618 10.584 26.1069 8.96777 26.627 8.77588C27.1704 8.57568 26.8159 7.8877 25.0591 7.896C23.3022 7.90381 21.6953 8.50391 19.647 9.30371C19.3477 9.42383 19.0322 9.51172 18.7095 9.58398C16.8501 9.22363 14.9199 9.14355 12.9033 9.37598C9.10596 9.80762 6.07275 11.6396 3.84326 14.7681C1.16455 18.5278 0.53418 22.7998 1.30664 27.2559C2.11768 31.9521 4.46582 35.8398 8.07373 38.8799C11.8159 42.0322 16.1255 43.5762 21.041 43.2803C24.0269 43.104 27.3516 42.6963 31.1016 39.4561C32.0469 39.936 33.0396 40.1279 34.686 40.272C35.9546 40.3921 37.1758 40.208 38.1211 40.0078C39.6021 39.688 39.4995 38.2881 38.9639 38.0322C34.623 35.9678 35.5762 36.8081 34.71 36.1279C36.9155 33.4639 40.2402 30.6958 41.54 21.728C41.6426 21.0161 41.5557 20.5679 41.54 19.9917C41.5322 19.6396 41.6108 19.5039 42.0049 19.4639C43.0923 19.3359 44.1479 19.0317 45.1167 18.4878C47.9292 16.9199 49.064 14.3438 49.3315 11.2559C49.3711 10.7837 49.3237 10.2959 48.8354 10.0479ZM24.3262 37.8398C20.1196 34.4639 18.0791 33.3521 17.2358 33.3999C16.4482 33.4482 16.5898 34.3682 16.7632 34.9678C16.9443 35.5601 17.1812 35.9683 17.5117 36.4878C17.7402 36.832 17.8979 37.3442 17.2832 37.728C15.9282 38.584 13.5728 37.4399 13.4624 37.3838C10.7207 35.7358 8.42822 33.5601 6.81348 30.584C5.25342 27.7197 4.34766 24.6479 4.19775 21.3677C4.1582 20.5757 4.38672 20.2959 5.15869 20.1519C6.17529 19.96 7.22314 19.9199 8.23926 20.0718C12.5327 20.7119 16.1885 22.6719 19.2529 25.7759C21.002 27.5439 22.3252 29.6558 23.6885 31.7202C25.1377 33.9121 26.6978 36 28.6831 37.7119C29.3843 38.312 29.9434 38.7681 30.479 39.104C28.8643 39.2881 26.1699 39.3281 24.3262 37.8398ZM26.3433 24.6001C26.3433 24.248 26.6191 23.9678 26.9658 23.9678C27.0444 23.9678 27.1152 23.9839 27.1782 24.0078C27.2651 24.04 27.3438 24.0879 27.4067 24.1602C27.5171 24.272 27.5801 24.4321 27.5801 24.6001C27.5801 24.9521 27.3042 25.2319 26.9575 25.2319C26.6108 25.2319 26.3433 24.9521 26.3433 24.6001ZM32.6064 27.8799C32.2046 28.0479 31.8027 28.1919 31.4165 28.208C30.8179 28.2397 30.1641 27.9922 29.8096 27.688C29.2583 27.2158 28.8643 26.9521 28.6987 26.1279C28.6279 25.7759 28.6675 25.2319 28.7305 24.9199C28.8721 24.248 28.7144 23.8159 28.2495 23.4238C27.8716 23.104 27.3911 23.0161 26.8633 23.0161C26.666 23.0161 26.4849 22.9277 26.3511 22.856C26.1304 22.7441 25.9492 22.4639 26.1226 22.1201C26.1777 22.0078 26.4458 21.7358 26.5088 21.688C27.2256 21.272 28.0527 21.4077 28.8169 21.7197C29.5259 22.0161 30.0615 22.5601 30.834 23.3281C31.6216 24.2559 31.7632 24.5117 32.2124 25.208C32.5669 25.752 32.8901 26.312 33.1104 26.9521C33.2446 27.3521 33.0713 27.6802 32.6064 27.8799Z" fill="#007aff" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/></svg>'
        const label = document.createElement('div')
        label.style.cssText = 'position:absolute;left:24px;top:18px;padding:2px 7px;border-radius:6px;background:#007aff;color:#fff;font:600 11px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,.25)'
        cursor.appendChild(ring)
        cursor.appendChild(dot)
        cursor.appendChild(label)
        document.documentElement.appendChild(cursor)
      }
      cursor.style.transform = 'translate(' + x + 'px,' + y + 'px)'
      cursor.style.opacity = '1'
      const label = cursor.lastChild
      if (label && label !== cursor.firstChild) label.textContent = 'DSH · ' + kind
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
      try {
        if (window.__dshOverlay && window.__dshOverlay.auto !== false) {
          window.__dshOverlay.handle({ op: 'follow', x, y, label: 'DSH · ' + kind, pulse: kind === 'click' || kind === 'type' || kind === 'key' })
        }
      } catch {}
      clearTimeout(cursor.__dshTimer)
      cursor.__dshTimer = setTimeout(() => { cursor.style.opacity = '0' }, 900)
    } catch {}
  }
})();
`

// Shared page-side detector for password/OTP/payment fields. The function body
// is self-contained and injected into every page evaluation through
// PAGE_HELPER_SRC, so typeIntoRef/pressKey never touch a field without asking
// the provider for a hard confirmation first (H5). The descriptor carries only
// tag/type/reason: never the field value, label, name or id.
function sensitiveInputInfo(element) {
  if (!element) return null
  const tag = String(element.tagName || '').toLowerCase()
  if (tag !== 'input' && tag !== 'textarea') return null
  const attr = (name) => String(element.getAttribute?.(name) || '').toLowerCase()
  const type = attr('type')
  const autocomplete = attr('autocomplete')
  const hay = `${attr('name')} ${attr('id')} ${attr('placeholder')} ${attr('aria-label')} ${autocomplete}`
  if (type === 'password' || autocomplete.includes('password')) {
    return { tag, type: type || 'text', sensitive: 'password' }
  }
  if (
    autocomplete.startsWith('cc-') ||
    /(^|[^a-z])(?:card|cc-?num|cc-?name|cc-?exp|cvv2?|cvc|payment|billing)([^a-z]|$)/.test(hay)
  ) {
    return { tag, type: type || 'text', sensitive: 'payment' }
  }
  if (/(^|[^a-z])(?:otp|totp|one[-_ ]?time|verification[-_ ]?code|auth(?:entication)?[-_ ]?code|mfa|2fa)([^a-z]|$)/.test(hay)) {
    return { tag, type: type || 'text', sensitive: 'otp' }
  }
  if (/(^|[^a-z])(?:pass(?:word|wd|phrase)?|pwd)([^a-z]|$)/.test(hay)) {
    return { tag, type: type || 'text', sensitive: 'password' }
  }
  return null
}

// Injected before every serialized page action. A function declaration cannot
// cross the Runtime.evaluate boundary, so its source is embedded as a local
// binding under the name the page actions call.
const PAGE_HELPER_SRC = `const sensitiveInputInfo = ${sensitiveInputInfo.toString()};`

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
      screencast: null,
      pageEnabled: false,
      interceptDialogs: false,
      dialogOptions: null,
      dialogs: [],
    }
    debuggerSessions.set(tabId, session)
  }
  return session
}

async function detachOrphanedTargets() {
  try {
    if (!chrome.debugger?.getTargets) return
    const targets = await chrome.debugger.getTargets()
    for (const target of targets || []) {
      if (!target?.attached || !Number.isFinite(target.tabId)) continue
      if (debuggerSessions.has(target.tabId)) continue
      try {
        await chrome.debugger.detach({ tabId: target.tabId })
        diag('orphan-debugger-detached', { tabId: target.tabId })
      } catch {
        // another debugger owns it (DevTools); leave it alone
      }
    }
  } catch {
    // debugger API unavailable; nothing to recover
  }
}

// A screencast owns a 10-minute auto-stop timer and (for the local frame
// state) nothing else. Clearing the state and its timer is the single path
// used by stop, start-failure, tab close, debugger detach, provider disconnect
// and extension reload, so no timer can outlive its session.
function clearSessionScreencast(session) {
  if (!session) return null
  const state = session.screencast
  if (state?.timer) {
    clearTimeout(state.timer)
    state.timer = null
  }
  session.screencast = null
  return state
}

// Detach the debugger only when nothing else owns the session. The stop timer
// of a capture/screencast calls this after it releases its state; without it
// a timed-out capture would leave the "Chrome is being debugged" session
// attached for the rest of the worker's life.
function releaseDebuggerIfIdle(tabId, { detach = true } = {}) {
  const session = debuggerSessions.get(tabId)
  if (!session || session.refs > 0 || session.capture || session.screencast) return false
  debuggerSessions.delete(tabId)
  if (detach) {
    try {
      Promise.resolve(chrome.debugger.detach(session.target)).catch(() => {})
    } catch {
      // already detached
    }
  }
  return true
}

// Release one tab's debugger session. Capture data is discarded for tab
// close / provider disconnect (nobody can read it anymore); a debugger detach
// keeps the frozen summary so chrome_capture_requests still works.
async function releaseDebuggerSession(tabId, reason, { detach = true } = {}) {
  const session = debuggerSessions.get(tabId)
  if (!session) return false
  // Remove the map entry first: an in-flight response for this generation must
  // not resurrect or reuse the session we are tearing down.
  debuggerSessions.delete(tabId)
  if (session.capture) {
    if (reason === 'tab-closed' || reason === 'provider-disconnected' || reason === 'extension-reload') {
      discardCapture(session.capture, reason)
    } else {
      endCapture(session.capture, reason)
    }
  }
  clearSessionScreencast(session)
  if (detach) {
    try {
      await chrome.debugger.detach(session.target)
    } catch {
      // target/tab already gone
    }
  }
  return true
}

// Provider disconnect / extension reload: every session and every capture
// belongs to the process that is going away, so drop the state before the
// native port dies. Detaches are best effort (a closed tab has no target).
async function releaseAllDebuggerSessions(reason) {
  const targets = []
  for (const [tabId, session] of [...debuggerSessions.entries()]) {
    debuggerSessions.delete(tabId)
    if (session.capture) discardCapture(session.capture, reason)
    clearSessionScreencast(session)
    targets.push(session.target)
  }
  for (const capture of [...captures.values()]) discardCapture(capture, reason)
  clearCaptureMeta()
  await Promise.allSettled(
    targets.map((target) => {
      try {
        return Promise.resolve(chrome.debugger.detach(target)).catch(() => {})
      } catch {
        return Promise.resolve()
      }
    }),
  )
}

async function prepareForReload() {
  // Detach before chrome.runtime.reload(): a reload tears down the worker but
  // the debuggee can stay attached, and the next worker would then have to
  // recover an orphan it cannot attribute to any live capture/screencast.
  await releaseAllDebuggerSessions('extension-reload')
}

function clearCaptureMeta() {
  try {
    Promise.resolve(chrome.storage?.session?.set?.({ dshCaptureMeta: null })).catch(() => {})
  } catch {
    // session storage unavailable; metadata is optional
  }
}

async function withDebugger(tabId, fn, options = {}) {
  const session = sessionFor(tabId)
  const { interceptDialogs = false, dialogOptions = null } = options
  if (session.refs === 0 && !session.capture && !session.screencast) {
    try {
      await chrome.debugger.attach(session.target, '1.3')
    } catch (error) {
      const message = error?.message || String(error)
      let recovered = false
      if (/Another debugger is already attached/i.test(message)) {
        // A previous worker died while its session stayed attached. Detach the
        // orphan (only succeeds when this extension owns it) and retry once.
        try {
          await chrome.debugger.detach({ tabId })
          await chrome.debugger.attach(session.target, '1.3')
          recovered = true
          diag('orphan-debugger-reattached', { tabId })
        } catch {
          recovered = false
        }
      }
      if (!recovered) {
        debuggerSessions.delete(tabId)
        throw bridgeError('DEBUGGER_FAILED', `cannot attach debugger: ${message}`)
      }
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
    if (session.refs === 0 && !session.capture && !session.screencast) {
      debuggerSessions.delete(tabId)
      await chrome.debugger.detach(session.target).catch(() => {})
    }
  }
}

async function evalInTarget(target, fn, args, timeoutMs = 10000) {
  const expression = `(() => { ${CURSOR_HELPER_SRC}
    ${DEEP_HELPERS_SRC}
    ${PAGE_HELPER_SRC}
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

async function readDiag() {
  const stored = await chrome.storage.local.get(DIAG_KEY)
  const list = Array.isArray(stored?.[DIAG_KEY]) ? stored[DIAG_KEY] : []
  return { entries: list.slice(-50) }
}

// ------------------------------------------------ screencast tab visibility
// Chrome only composites frames for a tab that is actually visible: the active
// tab of a non-minimized window. A desktop session tab normally sits in the
// background (the live viewer is another window/tab), and there
// `Page.startScreencast` attaches successfully but never emits a frame — the
// host keeps serving the previous latest.jpg and the viewer looks frozen.
// `start` therefore brings the target tab to the front and reports what it did.
async function readTabVisibility(tabId) {
  let tab = null
  try {
    tab = await chrome.tabs.get(tabId)
  } catch {
    return null
  }
  let window = null
  try {
    window = chrome.windows?.get ? await chrome.windows.get(tab.windowId) : null
  } catch {
    window = null
  }
  const tabActive = Boolean(tab.active)
  const windowState = window?.state || 'normal'
  const windowMinimized = windowState === 'minimized'
  // Session tabs live in a collapsed "DSH · …" group; a tab that stays inside a
  // collapsed group is not rendered either.
  const groupId = Number(tab.groupId)
  const tabGroupId = Number.isFinite(groupId) && groupId >= 0 ? groupId : null
  let tabGroupCollapsed = null
  if (tabGroupId != null && chrome.tabGroups?.get) {
    try {
      const group = await chrome.tabGroups.get(tabGroupId)
      tabGroupCollapsed = Boolean(group?.collapsed)
    } catch {
      tabGroupCollapsed = null
    }
  }
  return {
    tabActive,
    windowId: Number.isFinite(tab.windowId) ? tab.windowId : null,
    windowFocused: Boolean(window?.focused),
    windowState,
    windowMinimized,
    tabGroupId,
    tabGroupCollapsed,
    // What Page.startScreencast needs before it emits frames. Window focus is
    // reported separately: an unfocused-but-on-screen window can still
    // composite (fully occluded windows cannot be detected from the extension).
    visible: tabActive && !windowMinimized && tabGroupCollapsed !== true,
  }
}

async function makeTabVisibleForScreencast(tabId) {
  let activated = false
  let expandedGroup = false
  let focusedWindow = false
  let restoredWindow = false
  let visibilityError = null
  try {
    const tab = await chrome.tabs.get(tabId)
    if (!tab.active) {
      // Mark the activation as expected so the tab listener does not read it as
      // the user switching away (same convention as chrome_tabs {op:"focus"}).
      expectedActivations.add(tabId)
      await chrome.tabs.update(tabId, { active: true })
      activated = true
    }
    const groupId = Number(tab.groupId)
    if (Number.isFinite(groupId) && groupId >= 0 && chrome.tabGroups?.get && chrome.tabGroups?.update) {
      try {
        const group = await chrome.tabGroups.get(groupId)
        if (group?.collapsed) {
          await chrome.tabGroups.update(groupId, { collapsed: false })
          expandedGroup = true
        }
      } catch {
        // group API unavailable; the visibility check below reports the outcome
      }
    }
    if (chrome.windows?.update && Number.isFinite(tab.windowId)) {
      let window = null
      try {
        window = await chrome.windows.get(tab.windowId)
      } catch {
        window = null
      }
      if (window?.state === 'minimized') {
        await chrome.windows.update(tab.windowId, { state: 'normal' })
        restoredWindow = true
      }
      if (window && !window.focused) {
        await chrome.windows.update(tab.windowId, { focused: true })
        focusedWindow = true
      }
    }
  } catch (error) {
    visibilityError = error?.message || String(error)
  }
  const after = await readTabVisibility(tabId)
  const visible = Boolean(after?.visible)
  const moved = activated || expandedGroup || focusedWindow || restoredWindow
  return {
    activated,
    expandedGroup,
    focusedWindow,
    restoredWindow,
    visible,
    tabActive: Boolean(after?.tabActive),
    windowFocused: Boolean(after?.windowFocused),
    windowState: after?.windowState ?? null,
    tabGroupCollapsed: after?.tabGroupCollapsed ?? null,
    visibilityError,
    hint: visible
      ? moved
        ? 'screencast needs a visible tab; DSH brought the session tab to the front automatically'
        : null
      : 'screencast needs a visible tab (active tab in a non-minimized window); automatic activation failed — bring the session tab to the front manually',
  }
}

async function startScreencast(owner, params) {
  const tabId = await resolveOwnedTabId(owner, params.tabId)
  return withDebugger(tabId, async (session) => {
    // Attach first: if another debugger (DevTools) owns the tab, do not steal
    // focus only to fail the start afterwards.
    const sessionEntry = await getSessionEntry(owner)
    const pausedBefore = Boolean(sessionEntry.paused)
    const visibility = await makeTabVisibleForScreencast(tabId)
    // Bringing the session tab to the front is exactly what chrome_resume /
    // chrome_tabs {op:"focus"} do, so a pending USER_SWITCHED pause no longer
    // applies: clear it and report the auto-resume rather than failing the start.
    let resumedFromPause = false
    if (pausedBefore && (visibility.activated || visibility.visible)) {
      sessionEntry.paused = false
      sessionEntry.pausedAt = null
      sessionEntry.pausedUrl = ''
      await saveSessions()
      resumedFromPause = true
      diag('screencast-auto-resume', { owner: ownerShort(owner), tabId })
    }
    const startState = { ...visibility, resumedFromPause }
    if (visibility.activated || visibility.expandedGroup || visibility.focusedWindow || visibility.restoredWindow) {
      diag('screencast-autofocus', {
        owner: ownerShort(owner),
        tabId,
        activated: visibility.activated,
        expandedGroup: visibility.expandedGroup,
        focusedWindow: visibility.focusedWindow,
        restoredWindow: visibility.restoredWindow,
        visible: visibility.visible,
      })
    }
    if (session.screencast) {
      return { active: true, alreadyActive: true, tabId, format: session.screencast.format, ...startState }
    }
    await chrome.debugger.sendCommand(session.target, 'Page.enable').catch(() => {})
    const format = params.format === 'png' ? 'png' : 'jpeg'
    const quality = Number.isFinite(params.quality) ? Math.max(1, Math.min(100, params.quality)) : 60
    const everyNthFrame = Number.isFinite(params.everyNthFrame)
      ? Math.max(1, Math.min(10, Math.trunc(params.everyNthFrame)))
      : 2
    // Set the state BEFORE starting: the first frame can arrive while the
    // command promise is still pending, and an unacked first frame stalls the
    // whole screencast (Chrome sends no further frames until ack).
    session.screencast = { active: true, format, frames: 0, startedAt: Date.now(), lastAt: null, owner: ownerKey(owner) }
    session.screencast.timer = setTimeout(() => {
      const state = clearSessionScreencast(session)
      if (!state) return
      try {
        chrome.debugger.sendCommand(session.target, 'Page.stopScreencast').catch(() => {})
      } catch {
        // target already gone
      }
      // A screencast keeps the debugger attached by itself; once the auto-stop
      // releases it, an idle session must not stay attached forever.
      releaseDebuggerIfIdle(tabId)
      diag('screencast-auto-stop', { owner: ownerShort(owner), tabId, frames: state.frames })
    }, 10 * 60 * 1000)
    session.screencast.timer.unref?.()
    try {
      await chrome.debugger.sendCommand(session.target, 'Page.startScreencast', {
        format,
        quality,
        maxWidth: 1280,
        maxHeight: 800,
        everyNthFrame,
      })
    } catch (error) {
      // The armed auto-stop timer must not outlive a failed start.
      clearSessionScreencast(session)
      throw error
    }
    diag('screencast-start', {
      owner: ownerShort(owner),
      tabId,
      format,
      everyNthFrame,
      activated: visibility.activated,
      visible: visibility.visible,
    })
    return { active: true, alreadyActive: false, tabId, format, everyNthFrame, ...startState }
  })
}

async function stopScreencast(owner) {
  const tabId = await resolveOwnedTabId(owner)
  return withDebugger(tabId, async (session) => {
    const state = clearSessionScreencast(session)
    await chrome.debugger.sendCommand(session.target, 'Page.stopScreencast').catch(() => {})
    diag('screencast-stop', { owner: ownerShort(owner), tabId, frames: state?.frames || 0 })
    return {
      active: false,
      tabId,
      frames: state?.frames || 0,
      elapsedMs: state ? Date.now() - state.startedAt : 0,
    }
  })
}

async function screencastStatus(owner) {
  const tabId = await resolveOwnedTabId(owner)
  // Visibility is reported even when no screencast is running: it is the single
  // most common reason for "frames=0 / viewer shows an old frame".
  const visibility = await readTabVisibility(tabId)
  const visibilityFields = {
    visible: Boolean(visibility?.visible),
    tabActive: Boolean(visibility?.tabActive),
    windowFocused: Boolean(visibility?.windowFocused),
    windowState: visibility?.windowState ?? null,
    tabGroupCollapsed: visibility?.tabGroupCollapsed ?? null,
  }
  const session = debuggerSessions.get(tabId)
  const state = session?.screencast
  if (!state) {
    return {
      active: false,
      tabId,
      frames: 0,
      ...visibilityFields,
      frameAt: null,
      frameAgeMs: null,
      hint: visibilityFields.visible
        ? null
        : 'screencast needs a visible tab; op:"start" activates the session tab automatically',
    }
  }
  return {
    active: true,
    tabId,
    frames: state.frames,
    startedAt: new Date(state.startedAt).toISOString(),
    lastAt: state.lastAt ? new Date(state.lastAt).toISOString() : null,
    frameAt: state.lastAt || null,
    frameAgeMs: state.lastAt ? Math.max(0, Date.now() - state.lastAt) : null,
    format: state.format,
    ...visibilityFields,
    hint: !visibilityFields.visible
      ? 'screencast needs a visible tab (active tab in a non-minimized window); bring the session tab to the front to receive frames'
      : state.frames === 0
        ? 'waiting for the first frame; Chrome only emits frames when the page changes'
        : null,
  }
}

const captures = new Map()
let nextCaptureSeq = 1
const CAPTURE_MAX_DURATION_MS = 10 * 60 * 1000
const CAPTURE_DEFAULT_MAX_ENTRIES = 300
const CAPTURE_HARD_MAX_ENTRIES = 1000
// A stopped capture keeps its redacted entries readable for a bounded time and
// count (mirrors HeadlessDriver CAPTURE_SUMMARY_TTL_MS / CAPTURE_SUMMARY_LIMIT).
// Without both, a session that start/stops captures in a loop pins every
// entries map (and every body byte) for the life of the worker.
const CAPTURE_SUMMARY_TTL_MS = 10 * 60 * 1000
const CAPTURE_SUMMARY_LIMIT = 8
// Query/form/JSON key names that must never carry a value into a capture.
// `pwd`/`otp`/`cvv` match as whole key segments (delimited, exact or trailing)
// so ordinary words such as `author` stay readable. This list is shared with
// src/headless-redact.js (test/capture-parity.mjs checks both).
const CAPTURE_SECRET_PARAM =
  /(pass(word|wd|phrase)?|secret|token|api[-_]?key|access[-_]?token|refresh[-_]?token|authorization|cookie|session[-_]?id|csrf|xsrf|signature|sig|credential|private[-_]?key|(?:^|[-_.])auth(?:[-_.]|$)|(?:^|[-_.])(?:pwd|otp|cvv2?)(?:[-_.]|$)|(?:pwd|otp|cvv2?)$)/i
// `key=value` / `key: value` inside free text (a plain text body, a JSON string
// value, a URL fragment). The value ends at the usual body delimiters.
const CAPTURE_INLINE_SECRET =
  /(pass(?:word|wd|phrase)?|pwd|otp|cvv2?|secret|token|api[-_]?key|access[-_]?token|refresh[-_]?token|authorization|cookie|session[-_]?id|csrf|xsrf|signature|sig|credential|private[-_]?key|\bauth\b)(["']?\s*[:=]\s*["']?)([^\s,;"'&}]{1,256})/gi

// Fragments can carry OAuth tokens (`#access_token=…`) or a bare secret. Apply
// the query-parameter rule to key/value pairs and the inline token masks to the
// rest, so `#section` and other harmless anchors survive unchanged.
function redactFragment(fragment) {
  const body = String(fragment || '').replace(/^#/, '')
  if (!body) return fragment
  const parts = body.split('&').map((part) => {
    const index = part.indexOf('=')
    if (index < 0) return maskSecretsInText(part)
    const name = part.slice(0, index)
    const value = part.slice(index + 1)
    return CAPTURE_SECRET_PARAM.test(name) ? `${name}=«redacted»` : `${name}=${maskSecretsInText(value)}`
  })
  return `#${parts.join('&')}`
}

function redactUrl(rawUrl) {
  let url = String(rawUrl || '')
  try {
    const parsed = new URL(url)
    if (parsed.username) parsed.username = '«redacted»'
    if (parsed.password) parsed.password = '«redacted»'
    for (const name of [...parsed.searchParams.keys()]) {
      if (CAPTURE_SECRET_PARAM.test(name)) parsed.searchParams.set(name, '«redacted»')
    }
    if (parsed.hash) parsed.hash = redactFragment(parsed.hash)
    url = parsed.toString().replace(/%C2%ABredacted%C2%BB/gi, '«redacted»')
  } catch {
    // keep raw for non-URL strings
  }
  return url.length > 2048 ? `${url.slice(0, 2048)}…` : url
}

const CAPTURE_BODY_TOTAL_LIMIT = 8 * 1024 * 1024
const CAPTURE_RESPONSE_BODY_CHARS = 4096
const CAPTURE_REQUEST_BODY_CHARS = 2048
const CAPTURE_BODY_MAX_INFLIGHT = 4
const CAPTURE_TEXT_MIME = /^text\/|json|xml|javascript|x-www-form-urlencoded|graphql/i

function maskSecretsInText(text) {
  return String(text)
    .replace(/\b(Bearer\s+)[A-Za-z0-9._\-]{6,}/gi, '$1«redacted»')
    .replace(/\bsk-[A-Za-z0-9]{10,}\b/g, '«redacted»')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g, '«redacted»')
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, '«redacted»')
    .replace(CAPTURE_INLINE_SECRET, '$1$2«redacted»')
}

function redactJsonValue(value) {
  if (Array.isArray(value)) return value.map((item) => redactJsonValue(item))
  if (value && typeof value === 'object') {
    const out = {}
    for (const [key, item] of Object.entries(value)) {
      out[key] = CAPTURE_SECRET_PARAM.test(key) ? '«redacted»' : redactJsonValue(item)
    }
    return out
  }
  if (typeof value === 'string') return maskSecretsInText(value)
  return value
}

function redactBodyText(text, mimeType, maxChars) {
  let out = String(text ?? '')
  const trimmed = out.trim()
  const isJson = /json/i.test(String(mimeType || '')) || trimmed.startsWith('{') || trimmed.startsWith('[')
  if (isJson) {
    try {
      out = JSON.stringify(redactJsonValue(JSON.parse(trimmed)))
    } catch {
      out = maskSecretsInText(out)
    }
  } else if (/x-www-form-urlencoded/i.test(String(mimeType || ''))) {
    out = out
      .split('&')
      .map((pair) => {
        const [name, ...rest] = pair.split('=')
        if (CAPTURE_SECRET_PARAM.test(decodeURIComponent(name || ''))) return `${name}="«redacted»"`
        return `${name}${rest.length ? `=${rest.join('=')}` : ''}`
      })
      .join('&')
  } else {
    out = maskSecretsInText(out)
  }
  const truncated = out.length > maxChars
  return {
    text: truncated ? `${out.slice(0, maxChars)}… <truncated>` : out,
    truncated,
  }
}

function decodeBase64Body(data) {
  try {
    const binary = atob(String(data || ''))
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  } catch {
    return ''
  }
}

function materializeCaptureBody(capture, raw, mimeType, maxChars) {
  if (raw == null) return null
  const textual = CAPTURE_TEXT_MIME.test(String(mimeType || ''))
  let text
  if (!textual) {
    text = `<binary ${String(raw).length} chars>`
  } else {
    const result = redactBodyText(raw, mimeType, maxChars)
    text = result.text
  }
  const bytes = text.length
  if (capture.bodyBytes + bytes > CAPTURE_BODY_TOTAL_LIMIT) {
    capture.bodiesDropped += 1
    return { text: '<body not captured: capture body budget exceeded>', truncated: false }
  }
  capture.bodyBytes += bytes
  return { text, truncated: text.length >= maxChars }
}

function scheduleCaptureBodies(capture, session, entry, requestId) {
  if (!capture?.active || !capture.storeBodies) return
  if (!['xhr', 'fetch', 'document'].includes(entry.resourceType)) return
  if (entry.bodyScheduled) return
  entry.bodyScheduled = true
  if (capture.bodyTasks.size >= CAPTURE_BODY_MAX_INFLIGHT) {
    entry.bodyUnavailable = 'burst'
    return
  }
  // One request can be dropped by maxEntries while its body fetch is still in
  // flight; writing into an entry no longer in the buffer would keep that
  // body (and its bytes) alive through a reference the capture no longer
  // indexes. The active check covers stop/timeout.
  const stillCurrent = () => capture.active && capture.requests.get(String(requestId)) === entry
  const task = (async () => {
    try {
      const response = await chrome.debugger.sendCommand(session.target, 'Network.getResponseBody', {
        requestId,
      })
      if (!stillCurrent()) return
      const raw = response?.base64Encoded ? decodeBase64Body(response.body) : String(response?.body ?? '')
      const materialized = materializeCaptureBody(capture, raw, entry.mimeType, CAPTURE_RESPONSE_BODY_CHARS)
      if (materialized) {
        entry.responseBody = materialized.text
        entry.bodyTruncated = materialized.truncated
        entry.redacted = true
      }
    } catch {
      if (stillCurrent()) entry.bodyUnavailable = 'evicted'
    }
    if (!stillCurrent()) return
    if (entry.postDataRaw == null && entry.hasPostData) {
      try {
        const request = await chrome.debugger.sendCommand(session.target, 'Network.getRequestPostData', {
          requestId,
        })
        if (request?.postData && stillCurrent()) entry.postDataRaw = String(request.postData)
      } catch {
        // request body unavailable
      }
    }
    if (!stillCurrent()) return
    if (entry.postDataRaw != null) {
      const requestMime = /^{|^\[/.test(String(entry.postDataRaw).trim())
        ? 'application/json'
        : 'application/x-www-form-urlencoded'
      const materialized = materializeCaptureBody(capture, entry.postDataRaw, requestMime, CAPTURE_REQUEST_BODY_CHARS)
      if (materialized) {
        entry.requestBody = materialized.text
        entry.redacted = true
      }
      delete entry.postDataRaw
    }
  })()
  capture.bodyTasks.add(task)
  task.finally(() => capture.bodyTasks.delete(task))
}

function captureForSession(session) {
  const capture = session?.capture
  return capture && capture.active ? capture : null
}

function clearCaptureTimers(capture) {
  if (!capture) return
  if (capture.timer) {
    clearTimeout(capture.timer)
    capture.timer = null
  }
  if (capture.expireTimer) {
    clearTimeout(capture.expireTimer)
    capture.expireTimer = null
  }
}

// Free the raw parts of a capture while keeping the already-redacted entries
// readable: the unredacted request-body scratch, the by-id event index and
// in-flight body-task handles are only needed while Network events arrive.
// `entries: true` also frees the entries themselves (summary expiry, tab close,
// provider disconnect), so nothing keeps a body buffer alive after its TTL.
function releaseCaptureData(capture, { entries = false } = {}) {
  if (!capture) return
  for (const entry of capture.requests?.values?.() || []) {
    delete entry.postDataRaw
    delete entry._postDataRaw
  }
  capture.bodyBytes = 0
  capture.bodyTasks?.clear()
  if (entries) {
    capture.requests?.clear()
    if (Array.isArray(capture.order)) capture.order.length = 0
  }
}

function armCaptureExpiry(capture) {
  if (!capture || capture.active) return
  if (capture.expireTimer) clearTimeout(capture.expireTimer)
  capture.stoppedAt = capture.stoppedAt || Date.now()
  capture.expireTimer = setTimeout(() => {
    capture.expireTimer = null
    dropCaptureSummary(capture)
  }, CAPTURE_SUMMARY_TTL_MS)
  capture.expireTimer.unref?.()
  pruneCaptureSummaries()
}

function dropCaptureSummary(capture) {
  if (!capture) return false
  clearCaptureTimers(capture)
  if (captures.get(capture.captureId) !== capture) return false
  captures.delete(capture.captureId)
  const session = debuggerSessions.get(capture.tabId)
  if (session?.capture === capture) session.capture = null
  releaseCaptureData(capture, { entries: true })
  releaseDebuggerIfIdle(capture.tabId)
  return true
}

// Drop an expired stopped summary lazily as well: the TTL timer is unref'd, so
// a worker kept alive by other work must not serve a capture past its TTL just
// because the timer has not fired yet.
function pruneExpiredCaptures(now = Date.now()) {
  for (const capture of [...captures.values()]) {
    if (capture.active) continue
    const stoppedAt = capture.stoppedAt || capture.endedAt || capture.startedAt || 0
    if (now - stoppedAt >= CAPTURE_SUMMARY_TTL_MS) dropCaptureSummary(capture)
  }
}

function pruneCaptureSummaries() {
  const stopped = [...captures.values()].filter((capture) => !capture.active)
  if (stopped.length <= CAPTURE_SUMMARY_LIMIT) return
  stopped.sort((a, b) => (a.stoppedAt || a.startedAt || 0) - (b.stoppedAt || b.startedAt || 0))
  while (stopped.length > CAPTURE_SUMMARY_LIMIT) dropCaptureSummary(stopped.shift())
}

// Tab close / provider disconnect / reload: nobody can read this buffer after
// the tab or provider is gone, so remove the summary and every entry now.
function discardCapture(capture, reason) {
  if (!capture) return false
  const wasActive = capture.active
  clearCaptureTimers(capture)
  capture.active = false
  capture.endedReason = capture.endedReason || String(reason || 'discarded')
  if (captures.get(capture.captureId) === capture) captures.delete(capture.captureId)
  const session = debuggerSessions.get(capture.tabId)
  if (session?.capture === capture) session.capture = null
  releaseCaptureData(capture, { entries: true })
  // The stored metadata claims an active debug/capture session; clearing it is
  // the observable half of "tab closed / provider gone" for the next worker.
  if (wasActive) clearCaptureMeta()
  return true
}

function endCapture(capture, reason) {
  if (!capture || !capture.active) return capture
  capture.active = false
  capture.endedAt = Date.now()
  capture.stoppedAt = capture.endedAt
  capture.endedReason = String(reason || 'stopped')
  clearCaptureTimers(capture)
  const session = debuggerSessions.get(capture.tabId)
  if (session?.capture === capture) session.capture = null
  // The redacted entries stay readable through chrome_capture_requests until
  // the TTL/count prunes this summary; raw scratch and body-task handles go now.
  releaseCaptureData(capture)
  armCaptureExpiry(capture)
  clearCaptureMeta()
  diag('capture-stop', {
    owner: ownerShort(capture.owner),
    tabId: capture.tabId,
    entries: capture.order.length,
    dropped: capture.dropped,
    reason: capture.endedReason,
  })
  // The stop timer runs outside withDebugger(): without this the debugger
  // would stay attached after a 10-minute auto-stop.
  releaseDebuggerIfIdle(capture.tabId)
  return capture
}

function routeNetworkEvent(session, method, params) {
  const capture = captureForSession(session)
  if (!capture || capture.tabId !== session.target.tabId) return
  const requestId = String(params?.requestId || '')
  if (!requestId) return
  if (method === 'Network.requestWillBeSent') {
    const request = params.request || {}
    const type = String(params.type || 'Other').toLowerCase()
    if (!capture.resourceTypes.has(type)) return
    let entry = capture.requests.get(requestId)
    if (entry) {
      entry.redirects = (entry.redirects || 0) + 1
    } else {
      entry = { id: requestId }
      capture.requests.set(requestId, entry)
      capture.order.push(requestId)
    }
    entry.method = String(request.method || 'GET')
    entry.url = redactUrl(request.url)
    entry.resourceType = type
    entry.startTime = Date.now()
    entry.timestamp = Number(params.timestamp) || null
    entry.startMono = Number(params.timestamp) || null
    entry.documentURL = params.documentURL ? redactUrl(params.documentURL) : entry.documentURL
    entry.wallTime = Number(params.wallTime) || null
    entry.hasPostData = Boolean(request.hasPostData)
    // A request body is the most sensitive part of a capture: only keep the
    // raw text when this capture explicitly opted into bodies. Otherwise the
    // unredacted postData would sit in memory until the entry is evicted even
    // though chrome_capture_requests would never return it.
    if (capture.storeBodies && typeof request.postData === 'string') entry.postDataRaw = request.postData
    else delete entry.postDataRaw
    while (capture.order.length > capture.maxEntries) {
      const droppedId = capture.order.shift()
      const dropped = capture.requests.get(droppedId)
      if (dropped) {
        delete dropped.postDataRaw
        delete dropped._postDataRaw
      }
      capture.requests.delete(droppedId)
      capture.dropped += 1
    }
    return
  }
  const entry = capture.requests.get(requestId)
  if (!entry) return
  if (method === 'Network.responseReceived') {
    const response = params.response || {}
    entry.status = Number(response.status) || null
    entry.statusText = String(response.statusText || '')
    entry.mimeType = String(response.mimeType || '')
    entry.fromCache = Boolean(response.fromDiskCache || response.fromPrefetchCache)
    entry.fromServiceWorker = Boolean(response.fromServiceWorker)
    entry.encodedDataLength = Number(response.encodedDataLength) || null
    entry.responseAt = Date.now()
    return
  }
  if (method === 'Network.loadingFinished') {
    const finishedMono = Number(params.timestamp)
    entry.finishedAt = Date.now()
    if (Number.isFinite(finishedMono) && Number.isFinite(entry.startMono)) {
      entry.durationMs = Math.max(0, Math.round((finishedMono - entry.startMono) * 1000))
    } else {
      entry.durationMs = entry.startTime ? Math.max(0, entry.finishedAt - entry.startTime) : null
    }
    if (!capture.storeBodies) {
      // No body will be materialized, so the raw request text has no reader.
      delete entry.postDataRaw
      return
    }
    scheduleCaptureBodies(capture, session, entry, requestId)
    return
  }
  if (method === 'Network.loadingFailed') {
    entry.failed = true
    entry.errorText = String(params.errorText || '').slice(0, 300)
    entry.canceled = Boolean(params.canceled)
    // A failed request never reaches loadingFinished, so its raw request body
    // would otherwise stay in the buffer until TTL/eviction.
    delete entry.postDataRaw
    return
  }
  if (method === 'Network.requestServedFromCache') {
    entry.fromCache = true
  }
}

function normalizeResourceTypes(value) {
  const defaults = ['xhr', 'fetch', 'document']
  if (!Array.isArray(value) || value.length === 0) return new Set(defaults)
  return new Set(value.map((item) => String(item).toLowerCase()))
}

async function startCapture(owner, params) {
  const tabId = await resolveOwnedTabId(owner, params.tabId)
  pruneExpiredCaptures()
  const maxEntries = Number.isFinite(params.maxEntries)
    ? Math.max(1, Math.min(CAPTURE_HARD_MAX_ENTRIES, Math.trunc(params.maxEntries)))
    : CAPTURE_DEFAULT_MAX_ENTRIES
  return withDebugger(tabId, async (session) => {
    if (session.capture?.active) {
      return {
        alreadyActive: true,
        captureId: session.capture.captureId,
        tabId,
        startedAt: new Date(session.capture.startedAt).toISOString(),
        requests: session.capture.order.length,
      }
    }
    await chrome.debugger.sendCommand(session.target, 'Network.enable', {
      maxPostDataSize: 65536,
      maxTotalBufferSize: 8388608,
      maxResourceBufferSize: 2097152,
    })
    const capture = {
      captureId: `cap-${Date.now().toString(36)}-${nextCaptureSeq++}`,
      owner,
      tabId,
      startedAt: Date.now(),
      endedAt: null,
      stoppedAt: null,
      active: true,
      endedReason: null,
      maxEntries,
      resourceTypes: normalizeResourceTypes(params.resourceTypes),
      requests: new Map(),
      order: [],
      dropped: 0,
      bodiesDropped: 0,
      bodyBytes: 0,
      bodyTasks: new Set(),
      // H1/M3: bodies are explicit opt-in. The tool layer always sends false
      // unless the caller asked for bodies; a direct bridge caller must send
      // storeBodies:true as well, otherwise the capture is metadata-only.
      storeBodies: params.storeBodies === true,
      timer: null,
      expireTimer: null,
    }
    capture.timer = setTimeout(() => endCapture(capture, 'timeout'), CAPTURE_MAX_DURATION_MS)
    capture.timer?.unref?.()
    captures.set(capture.captureId, capture)
    session.capture = capture
    try {
      chrome.storage.session.set({ dshCaptureMeta: { captureId: capture.captureId, owner, tabId, startedAt: capture.startedAt, active: true } })
    } catch {
      // optional
    }
    diag('capture-start', { owner: ownerShort(owner), tabId, maxEntries, storeBodies: capture.storeBodies })
    return {
      captureId: capture.captureId,
      tabId,
      startedAt: new Date(capture.startedAt).toISOString(),
      resourceTypes: [...capture.resourceTypes],
      maxEntries,
      storeBodies: capture.storeBodies,
      active: true,
    }
  })
}

function findCapture(owner, params) {
  // A stopped capture is only readable within its TTL; drop anything older
  // before lookup so an unref'd timer cannot leave an expired buffer visible.
  pruneExpiredCaptures()
  const captureId = params.captureId ? String(params.captureId) : ''
  if (captureId) {
    const capture = captures.get(captureId)
    if (!capture) throw bridgeError('CAPTURE_LOST', 'capture buffer is not available (worker restarted?)')
    if (capture.owner !== owner) throw bridgeError('CAPTURE_NOT_FOUND', 'capture belongs to another session')
    return capture
  }
  let latest = null
  for (const capture of captures.values()) {
    if (capture.owner !== owner) continue
    if (capture.active) return capture
    if (!latest || capture.startedAt > latest.startedAt) latest = capture
  }
  if (latest) return latest
  throw bridgeError('NO_ACTIVE_CAPTURE', 'no capture for this session; call chrome_capture_start first')
}

async function stopCapture(owner, params) {
  const capture = findCapture(owner, params)
  if (!capture.active) {
    // Idempotent stop: make sure a frozen summary still has a TTL (e.g. after
    // a worker wake that restored the object without its timer).
    armCaptureExpiry(capture)
    return captureSummary(capture, false)
  }
  const tabId = capture.tabId
  return withDebugger(tabId, async (session) => {
    if (capture.bodyTasks.size > 0) {
      await Promise.race([
        Promise.allSettled([...capture.bodyTasks]),
        new Promise((resolve) => setTimeout(resolve, 2000)),
      ])
    }
    await chrome.debugger.sendCommand(session.target, 'Network.disable').catch(() => {})
    endCapture(capture, 'stopped')
    return captureSummary(capture, false)
  })
}

function captureSummary(capture, active) {
  return {
    captureId: capture.captureId,
    tabId: capture.tabId,
    startedAt: new Date(capture.startedAt).toISOString(),
    endedAt: capture.endedAt ? new Date(capture.endedAt).toISOString() : null,
    durationMs: capture.endedAt ? capture.endedAt - capture.startedAt : Date.now() - capture.startedAt,
    requests: capture.order.length,
    dropped: capture.dropped,
    bodiesDropped: capture.bodiesDropped,
    active: Boolean(active && capture.active),
    endedReason: capture.endedReason,
  }
}

function captureRequests(owner, params) {
  const capture = findCapture(owner, params)
  const includeBodies = params.includeBodies !== false
  const maxBodyChars = Number.isFinite(params.maxBodyChars)
    ? Math.max(64, Math.min(65536, Number(params.maxBodyChars)))
    : 4096
  const limit = Number.isFinite(params.limit) ? Math.max(1, Math.min(200, Number(params.limit))) : 50
  const filter = String(params.filter || '').toLowerCase()
  const types = Array.isArray(params.resourceTypes) && params.resourceTypes.length > 0
    ? new Set(params.resourceTypes.map(String))
    : null
  const entries = []
  for (const id of capture.order) {
    const entry = capture.requests.get(id)
    if (!entry) continue
    if (types && !types.has(entry.resourceType)) continue
    if (filter && !`${entry.method} ${entry.url}`.toLowerCase().includes(filter)) continue
    const copy = { ...entry }
    delete copy.postDataRaw
    if (!includeBodies) {
      delete copy.requestBody
      delete copy.responseBody
    } else {
      for (const key of ['requestBody', 'responseBody']) {
        if (typeof copy[key] === 'string' && copy[key].length > maxBodyChars) {
          copy[key] = `${copy[key].slice(0, maxBodyChars)}… <truncated>`
          copy.bodyTruncated = true
        }
      }
    }
    entries.push(copy)
  }
  if (!capture.active) {
    // A frozen capture's read never needs the unredacted scratch or in-flight
    // body handles again; the redacted entries themselves stay until TTL.
    releaseCaptureData(capture)
  }
  return {
    available: true,
    lost: false,
    active: capture.active,
    captureId: capture.captureId,
    tabId: capture.tabId,
    entries: entries.slice(-limit),
    total: entries.length,
    truncated: entries.length > limit,
    dropped: capture.dropped,
    bodiesDropped: capture.bodiesDropped,
  }
}

async function evalInTab(tabId, fn, args, timeoutMs, dialogOptions) {
  return withDebugger(
    tabId,
    async (session) => {
      const expression = `(() => { ${CURSOR_HELPER_SRC}
      ${DEEP_HELPERS_SRC}
      ${PAGE_HELPER_SRC}
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
  if (highlight) await callInPage(tabId, 'overlayDraw', [], 10000).catch(() => null)
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
  await ensureNotPaused(owner)
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
  await ensureNotPaused(owner)
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
  await ensureNotPaused(owner)
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
    ${PAGE_HELPER_SRC}
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

async function pickStartAgent(owner, params) {
  const tabId = await resolveOwnedTabId(owner, params.tabId)
  const result = await callInPage(tabId, 'pickStart', [], 15000)
  if (!result?.started) throw bridgeError('INTERNAL', 'pick mode did not start')
  return { ...result, tabId }
}

async function pickStatusAgent(owner, params) {
  const tabId = await resolveOwnedTabId(owner, params.tabId)
  return callInPage(tabId, 'pickStatus', [], 15000)
}

async function pickCancelAgent(owner, params) {
  const tabId = await resolveOwnedTabId(owner, params.tabId)
  return callInPage(tabId, 'pickCancel', [], 15000)
}

async function siteInfo(owner, params) {
  let tab
  if (params?.allowForeign === true) {
    // chrome_tabs {op:"claim"} needs the origin of a tab that is not owned yet
    // (the provider would otherwise judge the departure page, R-01). Only the
    // provider can ask for this via allowForeign; ordinary lookups keep the
    // owned-tab check.
    if (Number.isFinite(params?.tabId)) {
      tab = await chrome.tabs.get(params.tabId)
    } else {
      const active = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
      tab = active[0]
      if (!tab?.id) throw bridgeError('NO_ACTIVE_TAB', 'no active tab to inspect')
    }
  } else {
    const tabId = await resolveOwnedTabId(owner, params?.tabId)
    tab = await chrome.tabs.get(tabId)
  }
  const url = tab.url || ''
  let origin = null
  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') origin = parsed.origin
  } catch {
    origin = null
  }
  return { tabId: tab.id, url, title: tab.title || '', origin }
}

async function evaluate(owner, params) {
  const tabId = await resolveOwnedTabId(owner, params.tabId)
  const expression = String(params.expression ?? '')
  if (!expression.trim()) throw bridgeError('INVALID_ARGUMENT', 'expression must not be empty')
  const timeoutMs = Number.isFinite(params.timeoutMs)
    ? Math.max(500, Math.min(30000, Number(params.timeoutMs)))
    : 10000
  return withDebugger(tabId, async (session) => {
    let response
    try {
      response = await chrome.debugger.sendCommand(session.target, 'Runtime.evaluate', {
        expression,
        awaitPromise: Boolean(params.awaitPromise),
        returnByValue: true,
        timeout: timeoutMs,
      })
    } catch (error) {
      throw bridgeError('EVAL_ERROR', error?.message || String(error))
    }
    if (response?.exceptionDetails) {
      const details = response.exceptionDetails
      const message =
        details.exception?.description || details.exception?.value || details.text || 'evaluation threw'
      return {
        ok: false,
        error: {
          message: String(message).slice(0, 2000),
          line: Number(details.lineNumber) || 0,
          column: Number(details.columnNumber) || 0,
        },
      }
    }
    const result = response?.result
    if (!result) return { ok: true, value: null, type: 'undefined' }
    if (typeof result.unserializableValue === 'string') {
      return { ok: true, value: result.unserializableValue, type: result.type || 'unserializable', unserializable: true }
    }
    if ('value' in result) {
      return { ok: true, value: result.value, type: result.type || typeof result.value }
    }
    return { ok: true, value: null, type: result.type || 'object', unserializable: true }
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
  await ensureNotPaused(owner)
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
      [parsed.ref, String(params.text ?? ''), Boolean(params.replace), Boolean(params.submit), selector, params.sensitiveApproved === true],
      15000,
    )
    if (result) result.frameRef = frameRef
  } else {
    result = await callInPage(
      tabId,
      'type',
      [Number.isFinite(ref) ? ref : null, String(params.text ?? ''), Boolean(params.replace), Boolean(params.submit), selector, params.sensitiveApproved === true],
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
  await ensureNotPaused(owner)
  const tabId = await resolveOwnedTabId(owner, params.tabId)
  const key = String(params.key || '')
  if (!key) throw bridgeError('INTERNAL', 'key is required')
  const result = await callInPage(tabId, 'press', [key, params.sensitiveApproved === true], 15000, params.dialog)
  if (!result?.ok) {
    throw bridgeError(result?.reason || 'INTERNAL', result?.message || 'press failed')
  }
  return attachSnapshotIfRequested(tabId, { ...result, tabId }, params)
}

async function scroll(owner, params) {
  await ensureNotPaused(owner)
  const tabId = await resolveOwnedTabId(owner, params.tabId)
  const direction = String(params.direction || 'down')
  const amount = Number.isFinite(params.amount) ? Number(params.amount) : 600
  const result = await callInPage(tabId, 'scroll', [direction, amount])
  return attachSnapshotIfRequested(tabId, { ...result, tabId }, params)
}

async function history(owner, params) {
  await ensureNotPaused(owner)
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
    await syncTabsFromGroup(entry)
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
    expectedActivations.add(tabId)
    await chrome.tabs.update(tabId, { active: true })
    const entry = await getSessionEntry(owner)
    entry.paused = false
    entry.pausedAt = null
    entry.pausedUrl = ''
    await saveSessions()
    const tab = await chrome.tabs.get(tabId)
    return { tabId, url: tab.url || '', title: tab.title || '', focused: true }
  }
  throw bridgeError('UNSUPPORTED', `unknown tabs op: ${op}`)
}

async function overlayAction(owner, params) {
  await ensureNotPaused(owner)
  const tabId = await resolveOwnedTabId(owner, params.tabId)
  if (params.frame) {
    const payload = { ...params }
    delete payload.frame
    delete payload.owner
    try {
      await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['overlay.js'], world: 'MAIN' })
      const results = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        world: 'MAIN',
        args: [payload],
        func: (value) => (window.__dshOverlay ? window.__dshOverlay.handle(value) : { ok: false, error: 'OVERLAY_NOT_READY' }),
      })
      const hit = (results || []).find((entry) => entry?.result?.ok)
      if (hit) return { ...hit.result, frameId: hit.frameId }
      return (results || [])[0]?.result || { ok: false, error: 'FRAME_TARGET_NOT_FOUND' }
    } catch (error) {
      throw bridgeError('OVERLAY_FAILED', `cannot inject overlay into frames: ${error?.message || error}`)
    }
  }
  let result = await callInPage(tabId, 'overlay', [params])
  if (result?.error === 'OVERLAY_NOT_READY') {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['overlay.js'], world: 'MAIN' })
    } catch (error) {
      throw bridgeError('OVERLAY_FAILED', `cannot inject overlay: ${error?.message || error}`)
    }
    result = await callInPage(tabId, 'overlay', [params])
  }
  return result
}

async function selectAgent(owner, params) {
  await ensureNotPaused(owner)
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
  // A tab already tracked by another DSH session belongs to that session: claim
  // must not transfer ownership (R-12). The tab is only accepted when no other
  // session lists it; an untracked user tab stays claimable.
  const sessions = await loadSessions()
  for (const [key, other] of Object.entries(sessions || {})) {
    if (key === ownerKey(owner)) continue
    if (Array.isArray(other?.tabIds) && other.tabIds.includes(tab.id)) {
      throw bridgeError('TAB_NOT_FOUND', `tab ${tab.id} belongs to another DSH session; it cannot be claimed`)
    }
  }
  await addTabToSession(owner, tab, { activate: false, label: params.ownerLabel || null })
  const claimed = await chrome.tabs.get(tab.id)
  return { tabId: tab.id, url: claimed.url || '', title: claimed.title || '', claimed: true }
}

async function uploadFiles(owner, params) {
  await ensureNotPaused(owner)
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

function downloadItem(item) {
  return {
    id: item.id,
    filename: item.filename || '',
    url: item.url || '',
    state: item.state || '',
    bytesReceived: item.bytesReceived || 0,
    totalBytes: item.totalBytes || 0,
    startTime: item.startTime || '',
    // Keep the initiating tab id: it is the ownership evidence for the default
    // session-scoped view and is intentionally not returned for foreign items.
    tabId: Number.isFinite(item.tabId) ? item.tabId : null,
  }
}

// H4: `chrome.downloads.search` is machine-wide. Without `includeHistory`, only
// downloads initiated by a tab tracked for this DSH session are returned; the
// provider only reaches this path after its own hard confirmation. An empty or
// missing session therefore yields no downloads instead of falling back to the
// machine-wide list.
async function listDownloads(owner, params) {
  if (!chrome.downloads?.search) {
    throw bridgeError('UNSUPPORTED', 'downloads permission is not available')
  }
  const limit = Number.isFinite(params.limit) ? Math.min(100, Math.max(1, params.limit)) : 20
  if (params.includeHistory === true) {
    const items = await chrome.downloads.search({ limit, orderBy: ['-startTime'] })
    return { items: items.map(downloadItem), scope: 'history' }
  }
  const entry = await getSessionEntry(owner)
  const owned = new Set(Array.isArray(entry.tabIds) ? entry.tabIds : [])
  if (owned.size === 0) return { items: [], scope: 'session' }
  // Scan more than `limit` because downloads from other sessions/windows are
  // interleaved; the result is filtered down before it is sliced.
  const scanLimit = Math.min(100, Math.max(limit * 5, 50))
  const items = await chrome.downloads.search({ limit: scanLimit, orderBy: ['-startTime'] })
  const ownedItems = items.filter((item) => Number.isFinite(item?.tabId) && owned.has(item.tabId))
  return { items: ownedItems.slice(0, limit).map(downloadItem), scope: 'session' }
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
  await ensureNotPaused(owner)
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
function typeIntoRef(ref, text, replace, submit, selector, sensitiveApproved) {
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
  const tag = element.tagName.toLowerCase()
  if (tag !== 'input' && tag !== 'textarea') {
    return { ok: false, reason: 'UNSUPPORTED', message: `ref ${ref} is a ${tag}, not a text field` }
  }
  // H5: a password/OTP/payment field is never filled from plaintext model input
  // without a provider-side hard confirmation. This is the final fail-closed
  // boundary: without the approval flag it returns before focus, value write or
  // any event, and the descriptor never carries the field value.
  const field = sensitiveInputInfo(element)
  if (field && sensitiveApproved !== true) {
    return {
      ok: false,
      reason: 'SENSITIVE_FIELD',
      sensitive: field.sensitive,
      field: { tag: field.tag, type: field.type, sensitive: field.sensitive },
      message: `target is a sensitive ${field.sensitive} field; hard confirmation is required before typing`,
    }
  }
  element.focus()
  try {
    const rect = element.getBoundingClientRect()
    window.__dshCursor?.(rect.left + rect.width / 2, rect.top + rect.height / 2, 'type')
  } catch {}
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
  if (field) return { ok: true, submitted, sensitive: field.sensitive }
  return { ok: true, value: element.value, submitted }
}

/** Runs inside the page; self-contained. */
function pressKey(key, sensitiveApproved) {
  const target = document.activeElement && document.activeElement !== document.body
    ? document.activeElement
    : document.body
  // H5: a key press while a password/OTP/payment field holds focus can enter or
  // submit a secret just like typing. Refuse before dispatching anything unless
  // the provider already obtained a hard confirmation for this call.
  const field = sensitiveInputInfo(target)
  if (field && sensitiveApproved !== true) {
    return {
      ok: false,
      reason: 'SENSITIVE_FIELD',
      sensitive: field.sensitive,
      field: { tag: field.tag, type: field.type, sensitive: field.sensitive },
      message: `key press targets a sensitive ${field.sensitive} field; hard confirmation is required`,
    }
  }
  try {
    const rect = target.getBoundingClientRect()
    window.__dshCursor?.(rect.left + rect.width / 2, rect.top + rect.height / 2, 'key')
  } catch {}
  const options = { key, bubbles: true, cancelable: true, composed: true }
  target.dispatchEvent(new KeyboardEvent('keydown', options))
  target.dispatchEvent(new KeyboardEvent('keypress', options))
  target.dispatchEvent(new KeyboardEvent('keyup', options))
  return { ok: true, key, target: target.tagName.toLowerCase(), ...(field ? { sensitive: field.sensitive } : {}) }
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

function pickStart() {
  if (window.__dshPick?.active) return { started: true, alreadyActive: true }
  const state = { active: true, done: false, canceled: false, result: null, cleanup: null }
  window.__dshPick = state
  const ensureRefSeq = () => {
    if (window.__dshRefSeq) return
    let max = 0
    const scan = window.__dshDeep ? window.__dshDeep.all('[data-dsh-ref]') : document.querySelectorAll('[data-dsh-ref]')
    for (const element of scan) {
      const value = Number(element.getAttribute('data-dsh-ref'))
      if (Number.isFinite(value) && value > max) max = value
    }
    window.__dshRefSeq = max + 1
  }
  const interactiveSelector =
    'a[href],button,input,select,textarea,[role="button"],[role="link"],[role="checkbox"],[onclick],[contenteditable="true"]'
  const targetFor = (element) => {
    if (!element) return null
    try {
      return element.closest(interactiveSelector) || element
    } catch {
      return element
    }
  }
  const selectorFor = (element) => {
    if (!element) return ''
    if (element.id) return `#${CSS.escape(element.id)}`
    const parts = []
    let current = element
    while (current && current !== document.documentElement && parts.length < 3) {
      let part = current.tagName.toLowerCase()
      if (current.classList && current.classList.length > 0) {
        part += '.' + [...current.classList].slice(0, 2).map((name) => CSS.escape(name)).join('.')
      }
      const parent = current.parentElement
      if (parent) {
        const siblings = [...parent.children].filter((child) => child.tagName === current.tagName)
        if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(current) + 1})`
      }
      parts.unshift(part)
      current = parent
    }
    return parts.join(' > ')
  }
  const overlay = document.createElement('div')
  overlay.id = '__dsh_pick_overlay__'
  overlay.style.cssText =
    'position:fixed;inset:0;z-index:2147483646;pointer-events:none;background:rgba(0,122,255,.06);transition:background .1s'
  const box = document.createElement('div')
  box.style.cssText =
    'position:fixed;border:2px solid rgba(0,122,255,.95);border-radius:3px;background:rgba(0,122,255,.10);display:none;z-index:2147483647;pointer-events:none;box-sizing:border-box'
  const hint = document.createElement('div')
  hint.textContent = 'DSH pick: click an element · Esc to cancel'
  hint.style.cssText =
    'position:fixed;left:50%;bottom:18px;transform:translateX(-50%);background:rgba(10,10,10,.86);color:#fff;font:13px/1.4 -apple-system,sans-serif;padding:6px 12px;border-radius:6px;z-index:2147483647;pointer-events:none'
  overlay.appendChild(box)
  overlay.appendChild(hint)
  document.documentElement.appendChild(overlay)

  const highlight = (element) => {
    if (!element) {
      box.style.display = 'none'
      return
    }
    const rect = element.getBoundingClientRect()
    box.style.display = 'block'
    box.style.left = `${Math.max(0, rect.left)}px`
    box.style.top = `${Math.max(0, rect.top)}px`
    box.style.width = `${Math.max(1, rect.width)}px`
    box.style.height = `${Math.max(1, rect.height)}px`
  }
  const onMove = (event) => {
    try {
      highlight(targetFor(document.elementFromPoint(event.clientX, event.clientY)))
    } catch {
      highlight(null)
    }
  }
  const finish = (canceled, result) => {
    state.done = true
    state.canceled = Boolean(canceled)
    state.active = false
    state.result = result || null
    try {
      cleanup()
    } catch {}
  }
  const onClick = (event) => {
    event.preventDefault()
    event.stopPropagation()
    try {
      ensureRefSeq()
      const raw = document.elementFromPoint(event.clientX, event.clientY) || event.target
      const target = targetFor(raw)
      if (!target) {
        finish(true, null)
        return
      }
      let ref = Number(target.getAttribute('data-dsh-ref')) || 0
      if (!ref) {
        ref = window.__dshRefSeq
        window.__dshRefSeq += 1
        try {
          target.setAttribute('data-dsh-ref', String(ref))
        } catch {}
      }
      const rect = target.getBoundingClientRect()
      finish(false, {
        ref,
        selector: selectorFor(target),
        text: (target.innerText || target.getAttribute('aria-label') || target.value || '').trim().slice(0, 160),
        tag: target.tagName.toLowerCase(),
        box: [Math.round(rect.left), Math.round(rect.top), Math.round(rect.width), Math.round(rect.height)],
      })
    } catch (error) {
      finish(true, null)
    }
  }
  const onKey = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      finish(true, null)
    }
  }
  const cleanup = () => {
    document.removeEventListener('mousemove', onMove, true)
    document.removeEventListener('click', onClick, true)
    document.removeEventListener('keydown', onKey, true)
    overlay.remove()
  }
  state.cleanup = cleanup
  document.addEventListener('mousemove', onMove, true)
  document.addEventListener('click', onClick, true)
  document.addEventListener('keydown', onKey, true)
  return { started: true, alreadyActive: false }
}

function pickStatus() {
  const state = window.__dshPick
  if (!state) return { available: false, active: false, done: false, canceled: false, result: null }
  return {
    available: true,
    active: Boolean(state.active),
    done: Boolean(state.done),
    canceled: Boolean(state.canceled),
    result: state.result,
  }
}

function pickCancel() {
  const state = window.__dshPick
  if (!state) return { ok: true, wasActive: false }
  const wasActive = Boolean(state.active)
  state.canceled = true
  state.done = true
  state.active = false
  try {
    state.cleanup?.()
  } catch {}
  return { ok: true, wasActive }
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
// One periodic alarm is enough. The old code also created `dsh-chrome-watchdog`
// with the same 1-minute period, and both handlers did the same "no port ->
// ensurePort" work: two wake-ups and two diag storage writes per minute for the
// whole life of the browser.
function ensureReconnectAlarm() {
  try {
    chrome.alarms.create(RECONNECT_ALARM, { periodInMinutes: 1 })
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
  if (method === 'Page.screencastFrame') {
    if (!session.screencast) return
    session.screencast.frames += 1
    session.screencast.lastAt = Date.now()
    chrome.debugger
      .sendCommand(session.target, 'Page.screencastFrameAck', { sessionId: params?.sessionId })
      .catch(() => {})
    try {
      port?.postMessage({
        type: 'screencast-frame',
        data: params?.data,
        format: session.screencast.format,
        metadata: params?.metadata || null,
        frames: session.screencast.frames,
        owner: session.screencast.owner || null,
      })
    } catch {
      // native port unavailable; frames are dropped
    }
    return
  }
  if (String(method).startsWith('Network.')) {
    routeNetworkEvent(session, method, params)
  }
})

chrome.debugger.onDetach.addListener((source, reason) => {
  const tabId = source?.tabId
  if (tabId == null) return
  // The target is already gone; keep the frozen capture summary readable but
  // clear the screencast timer that would otherwise fire against a dead
  // session. Do not call detach again: onDetach is the detach itself.
  releaseDebuggerSession(tabId, `debugger-detached:${reason}`, { detach: false }).catch(() => {})
})

chrome.tabs.onRemoved.addListener((tabId) => {
  // Tab close is terminal: discard the capture (no reader can reach it) and
  // clear the screencast timer before deleting the session.
  releaseDebuggerSession(tabId, 'tab-closed').catch(() => {})
  frameRegistry.delete(tabId)
})

chrome.runtime.onInstalled.addListener(() => {
  ensureReconnectAlarm()
  ensurePort().catch(() => {})
  // A reload/update starts with an empty in-memory table; recover any debugger
  // target the previous worker left attached and clear stale capture metadata.
  detachOrphanedTargets().catch(() => {})
  clearCaptureMeta()
  initActiveWindows().catch(() => {})
})
chrome.runtime.onStartup.addListener(() => {
  ensureReconnectAlarm()
  ensurePort().catch(() => {})
})
chrome.tabs.onActivated.addListener((info) => {
  onTabActivated(info).catch(() => {})
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
// re-open the native port and (re)create the periodic alarms. Runtime reloads
// clear alarms, so this cannot live only in onInstalled/onStartup: after a
// reload race a dead worker with no alarm would never wake again.
ensureReconnectAlarm()
detachOrphanedTargets().catch(() => {})
// A worker start means captures from the previous generation are gone (the
// in-memory table is empty); a dshCaptureMeta left in session storage would
// claim an active capture that no longer exists.
clearCaptureMeta()
initActiveWindows().catch(() => {})
if (!port) forceReconnect().catch(() => {})

chrome.alarms.onAlarm.addListener((alarm) => {
  const name = String(alarm?.name || '')
  if (name !== RECONNECT_ALARM && name !== RECONNECT_ONCE_ALARM) return
  // A connected port makes this wake-up a no-op. Do not diag it: every diag is
  // a full read-modify-write of the 80-entry ring (measured 25.7 KB/min of
  // LevelDB churn while idle, ~1.5 MB/h) and it used to push every real
  // transition out of the ring. forceReconnect() reconnects a dead port and
  // logs only when it actually does something.
  if (port) return
  forceReconnect().catch((error) => diag('alarm-error', { name, error: error?.message || String(error) }))
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
