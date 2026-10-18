/**
 * Extension logic test — runs extension/background.js inside a VM with a
 * mocked chrome.* API. No Chrome required.
 *
 * Covers the parts that previously only failed in real Chrome:
 *   - request dispatch for every extension method (tool name -> handler)
 *   - owner -> tab resolution and session state
 *   - CDP page actions, attach/detach, dialog interception defaults
 */
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = fs.readFileSync(path.join(root, 'extension', 'background.js'), 'utf8')

let failures = 0
function check(name, condition, detail = '') {
  if (condition) console.log(`PASS ${name}${detail ? ` — ${detail}` : ''}`)
  else {
    failures += 1
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

// ------------------------------------------------------------------ chrome mock
const tabs = new Map([
  [7, { id: 7, url: 'https://example.com/', title: 'Example Domain', active: true, status: 'complete', windowId: 1 }],
])
const debuggerCalls = []
const dialogCommands = []
const eventListeners = new Set()
let nextPageValue = { ok: true, tag: 'button', label: 'OK' }
let nextTabId = 100

const runtimeMessageListeners = []
const debuggerDetachListeners = []
const alarmCreates = []
const storageSets = []
const tabRemovedListeners = []
const tabGroupUpdates = []
const tabActivatedListeners = []
let connectNativeCalls = 0
let runtimeReloads = 0
const nativePortListeners = { message: [], disconnect: [] }
const fakeNativePort = {
  posted: [],
  onMessage: {
    addListener(listener) {
      nativePortListeners.message.push(listener)
    },
  },
  onDisconnect: {
    addListener(listener) {
      nativePortListeners.disconnect.push(listener)
    },
  },
  postMessage(message) {
    this.posted.push(message)
  },
  disconnect() {},
}

const chrome = {
  runtime: {
    id: 'test-extension',
    lastError: undefined,
    getManifest: () => ({ version: 'test-logic' }),
    connectNative: () => {
      connectNativeCalls += 1
      return fakeNativePort
    },
    reload: () => {
      runtimeReloads += 1
    },
    onConnect: { addListener() {} },
    onInstalled: { addListener() {} },
    onStartup: { addListener() {} },
    onMessage: {
      addListener(listener) {
        runtimeMessageListeners.push(listener)
      },
    },
  },
  storage: {
    session: {
      async get() {
        return { dshSessions: { s1: { tabIds: [7], groupId: 5, activeTabId: 7 } } }
      },
      async set() {},
    },
    local: {
      async get(key) {
        if (key === 'dshSessions') return { dshSessions: { s1: { tabIds: [7], groupId: 5, activeTabId: 7 } } }
        return {}
      },
      async set(value) {
        storageSets.push(value)
      },
    },
  },
  tabs: {
    onActivated: {
      addListener(listener) {
        tabActivatedListeners.push(listener)
      },
    },
    async get(tabId) {
      const tab = tabs.get(tabId)
      if (!tab) throw new Error(`no tab ${tabId}`)
      return tab
    },
    async query() {
      return [...tabs.values()]
    },
    async create({ url }) {
      const tab = { id: ++nextTabId, url: url || 'about:blank', title: '', active: false, status: 'complete', windowId: 1 }
      tabs.set(tab.id, tab)
      return tab
    },
    async update(tabId, props) {
      const tab = tabs.get(tabId)
      if (!tab) throw new Error(`no tab ${tabId}`)
      Object.assign(tab, props)
      return tab
    },
    async remove(tabId) {
      tabs.delete(tabId)
    },
    async group() {
      return 5
    },
    async goBack() {},
    async goForward() {},
    async reload() {},
    onUpdated: { addListener() {}, removeListener() {} },
    onRemoved: {
      addListener(listener) {
        tabRemovedListeners.push(listener)
      },
      removeListener() {},
    },
  },
  tabGroups: {
    async query() {
      return []
    },
    async update(id, props) {
      tabGroupUpdates.push({ id, ...props })
    },
  },
  alarms: {
    create(name, info) {
      alarmCreates.push({ name, info })
    },
    onAlarm: { addListener() {} },
  },
  offscreen: {
    async hasDocument() {
      return false
    },
    async createDocument() {},
  },
  downloads: {
    async search() {
      return [{ id: 1, filename: '/tmp/report.pdf', url: 'https://example.com/report.pdf', state: 'complete' }]
    },
  },
  debugger: {
    async attach(target) {
      debuggerCalls.push({ method: 'attach', target })
    },
    async detach() {
      debuggerCalls.push({ method: 'detach' })
    },
    async sendCommand(target, method, params) {
      debuggerCalls.push({ method, target, params })
      if (method === 'Page.enable') return {}
      if (method === 'Page.startScreencast') return {}
      if (method === 'Page.stopScreencast') return {}
      if (method === 'Page.screencastFrameAck') return {}
      if (method === 'Network.enable') return {}
      if (method === 'Network.disable') return {}
      if (method === 'Network.getResponseBody') {
        return { body: JSON.stringify({ ok: true, user: 'u1', token: 'T0K3N', nested: { apiKey: 'NESTED' } }), base64Encoded: false }
      }
      if (method === 'Network.getRequestPostData') {
        return { postData: JSON.stringify({ user: 'u1', token: 'T0K3N' }) }
      }
      if (method === 'Page.getFrameTree') {
        return {
          frameTree: {
            frame: {
              id: 'a1b2c3d4e5f6a7b8',
              url: 'https://example.test/',
              domainAndRegistry: 'example.test',
              mimeType: 'text/html',
            },
            childFrames: [],
          },
        }
      }
      if (method === 'Page.createIsolatedWorld') return { executionContextId: 7 }
      if (method === 'Page.captureScreenshot') return { data: 'iVBORw0KGgo=' }
      if (method === 'Page.handleJavaScriptDialog') {
        dialogCommands.push(params)
        return {}
      }
      if (method === 'Emulation.setDeviceMetricsOverride') return {}
      if (method === 'Emulation.clearDeviceMetricsOverride') return {}
      if (method === 'DOM.getDocument') return { root: { nodeId: 1 } }
      if (method === 'DOM.querySelector') return { nodeId: 2 }
      if (method === 'DOM.setFileInputFiles') return {}
      if (method === 'Runtime.evaluate') {
        for (const listener of eventListeners) {
          listener({ tabId: target.tabId }, 'Page.javascriptDialogOpening', {
            type: 'confirm',
            message: 'Delete this item?',
          })
        }
        return { result: { value: nextPageValue } }
      }
      throw new Error(`unexpected CDP command ${method}`)
    },
    onEvent: {
      addListener(listener) {
        eventListeners.add(listener)
      },
      removeListener(listener) {
        eventListeners.delete(listener)
      },
    },
    onDetach: {
      addListener(listener) {
        debuggerDetachListeners.push(listener)
      },
    },
  },
}

const sandbox = {
  chrome,
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  Date,
  JSON,
  Promise,
  Number,
  String,
  Boolean,
  Array,
  Object,
  Math,
  Error,
  URL,
  URLSearchParams,
}
vm.createContext(sandbox)
vm.runInContext(source, sandbox, { filename: 'background.js' })

check('background.js evaluates with mocked chrome', typeof sandbox.handleRequest === 'function')
check(
  'worker start recreates the reconnect alarm (runtime reload clears alarms)',
  alarmCreates.some((call) => call.name === 'dsh-chrome-reconnect'),
)

for (const listener of nativePortListeners.message) listener({ event: 'dsh.ping' })
check(
  'first native message resets the self-heal attempt counter',
  storageSets.some((value) => value?.dshSelfHeal?.count === 0),
)


const PAGE_ACTIONS = vm.runInContext('PAGE_ACTIONS', sandbox)
check(
  'PAGE_ACTIONS has the expected page actions',
  ['snapshot', 'click', 'type', 'press', 'scroll', 'find', 'hover', 'select', 'getText', 'console', 'network'].every(
    (name) => typeof PAGE_ACTIONS[name] === 'function',
  ),
)

// ------------------------------------------------------- per-method dispatch
const pageCases = [
  ['tab.snapshot', { maxChars: 1000, owner: 's1' }, { title: 'T', url: 'u', controls: [], text: 'x', truncated: false }],
  ['tab.find', { query: 'Example', owner: 's1' }, { query: 'Example', matches: [{ ref: 901, text: 'Example Domain', tag: 'h1', x: 1, y: 2 }], truncated: false }],
  ['tab.click', { ref: 1, owner: 's1' }, { ok: true, tag: 'button', label: 'OK' }],
  ['tab.hover', { ref: 1, owner: 's1' }, { ok: true, tag: 'button', label: 'OK' }],
  ['tab.type', { ref: 3, text: 'DSH', replace: true, submit: false, owner: 's1' }, { ok: true, value: 'DSH', submitted: false }],
  ['tab.press', { key: 'Enter', owner: 's1' }, { ok: true, key: 'Enter', target: 'input' }],
  ['tab.scroll', { direction: 'down', amount: 100, owner: 's1' }, { ok: true, y: 100, viewportHeight: 800, documentHeight: 2000 }],
  ['tab.get_text', { maxChars: 1000, owner: 's1' }, { found: true, text: 'body', truncated: false }],
  ['tab.select', { ref: 4, checked: true, owner: 's1' }, { ok: true, tag: 'input', value: 'checked' }],
  ['tab.console', { limit: 5, owner: 's1' }, { available: true, entries: [] }],
  ['tab.network', { limit: 5, owner: 's1' }, { available: true, entries: [] }],
]

for (const [method, params, value] of pageCases) {
  nextPageValue = value
  const result = await sandbox.handleRequest({ method, params, id: method })
  const ok =
    result != null &&
    Object.entries(value).every(([key, expected]) =>
      key === 'matches' || key === 'controls'
        ? JSON.stringify(result[key]) === JSON.stringify(expected)
        : result[key] === expected,
    )
  check(`${method} dispatches`, ok, JSON.stringify(result)?.slice(0, 120))
}

// non-page methods (tabs/history/wait/claim/downloads/upload)
const tabList = await sandbox.handleRequest({ method: 'tab.tabs', params: { op: 'list', owner: 's1' }, id: 'tabs-list' })
check('tab.tabs list returns session tabs', Array.isArray(tabList?.tabs) && tabList.tabs[0]?.tabId === 7)

const tabNew = await sandbox.handleRequest({ method: 'tab.tabs', params: { op: 'new', url: 'https://example.com/b', owner: 's1' }, id: 'tabs-new' })
check('tab.tabs new creates a background tab', Number.isFinite(tabNew?.tabId) && tabs.get(tabNew.tabId)?.active === false)

const tabClose = await sandbox.handleRequest({ method: 'tab.tabs', params: { op: 'close', tabId: tabNew.tabId, owner: 's1' }, id: 'tabs-close' })
check('tab.tabs close removes the tab', tabClose?.closed === tabNew.tabId)

const history = await sandbox.handleRequest({ method: 'tab.history', params: { op: 'reload', owner: 's1' }, id: 'history' })
check('tab.history reload returns tab state', history?.tabId === 7)

const waited = await sandbox.handleRequest({ method: 'tab.wait', params: { until: 'load', owner: 's1' }, id: 'wait' })
check('tab.wait load returns ready state', waited?.loadState === 'complete')

nextPageValue = true
const waitedSelector = await sandbox.handleRequest({
  method: 'tab.wait',
  params: { until: 'selector', selector: '#x', owner: 's1' },
  id: 'wait-selector',
})
check('tab.wait selector polls the page helper', waitedSelector?.loadState === 'complete')

nextPageValue = true
const waitedUrl = await sandbox.handleRequest({
  method: 'tab.wait',
  params: { until: 'url', url: 'example.com', owner: 's1' },
  id: 'wait-url',
})
check('tab.wait url polls the page helper', waitedUrl?.loadState === 'complete')

nextPageValue = { width: 120, height: 240 }
const fullShot = await sandbox.handleRequest({
  method: 'tab.screenshot',
  params: { owner: 's1', fullPage: true },
  id: 'shot-full',
})
check('tab.screenshot fullPage returns base64 data', typeof fullShot?.dataBase64 === 'string')

nextPageValue = { count: 2 }
const highlightedShot = await sandbox.handleRequest({
  method: 'tab.screenshot',
  params: { owner: 's1', highlight: true },
  id: 'shot-highlight',
})
check('tab.screenshot highlight still returns base64 data', typeof highlightedShot?.dataBase64 === 'string')

const claim = await sandbox.handleRequest({ method: 'tab.claim', params: { owner: 's2' }, id: 'claim' })
check('tab.claim claims the active tab', claim?.claimed === true && tabs.get(claim.tabId) != null)

const claimViaTabs = await sandbox.handleRequest({ method: 'tab.tabs', params: { op: 'claim', owner: 's3' }, id: 'tabs-claim' })
check('tab.tabs op=claim routes to claim', claimViaTabs?.claimed === true)

const downloads = await sandbox.handleRequest({ method: 'browser.downloads', params: { limit: 5 }, id: 'downloads' })
check('browser.downloads lists items', downloads?.items?.[0]?.filename === '/tmp/report.pdf')

const upload = await sandbox.handleRequest({
  method: 'tab.upload',
  params: { ref: 5, files: ['/tmp/x'], owner: 's1' },
  id: 'upload',
})
check('tab.upload returns ok', upload?.ok === true)

const shot = await sandbox.handleRequest({
  method: 'tab.screenshot',
  params: { owner: 's1', clip: { x: 0, y: 0, width: 10, height: 10 } },
  id: 'shot',
})
check('tab.screenshot returns base64 data', typeof shot?.dataBase64 === 'string')

check('find resolves the owner tab', debuggerCalls.some((call) => call.method === 'attach' && call.target?.tabId === 7))
check(
  'debugger detaches after page actions',
  debuggerCalls.filter((call) => call.method === 'detach').length >= pageCases.length,
)

// dialog policy
dialogCommands.length = 0
nextPageValue = { ok: true, tag: 'button', label: 'OK' }
const clickResult = await sandbox.handleRequest({ method: 'tab.click', params: { ref: 1, owner: 's1' }, id: 'click-dialog' })
check('confirm dialog defaults to dismiss', dialogCommands.at(-1)?.accept === false)
check('click carries dialog info back to the provider', clickResult?.dialogs?.[0]?.type === 'confirm')

dialogCommands.length = 0
await sandbox.handleRequest({
  method: 'tab.click',
  params: { ref: 1, owner: 's1', dialog: { accept: true } },
  id: 'click-accept',
})
check('dialog accept:true is honored', dialogCommands.at(-1)?.accept === true)

// delta snapshot + post-action snapshot
nextPageValue = { query: 'a.*b', matches: [], truncated: false }
const regexFind = await sandbox.handleRequest({
  method: 'tab.find',
  params: { query: 'a.*b', regex: true, owner: 's1' },
  id: 'find-regex',
})
check('tab.find regex flag reaches the page helper', regexFind?.query === 'a.*b')

nextPageValue = { mode: 'delta', controls: [{ ref: 1, tag: 'button', label: 'Greet', new: true }], changedCount: 1, sameCount: 7, removedRefs: [] }
const delta = await sandbox.handleRequest({ method: 'tab.snapshot', params: { mode: 'delta', owner: 's1' }, id: 'snapshot-delta' })
check('tab.snapshot delta returns changed controls', delta?.mode === 'delta' && delta?.changedCount === 1)

nextPageValue = { ok: true, tag: 'button', label: 'Greet' }
const clickWithSnapshot = await sandbox.handleRequest({ method: 'tab.click', params: { ref: 1, snapshot: true, owner: 's1' }, id: 'click-with-snapshot' })
check('click can attach a post-action snapshot', clickWithSnapshot?.page?.mode === 'delta' || clickWithSnapshot?.page != null)

// selector fallback, element screenshot, tabs focus
nextPageValue = { ok: true, tag: 'button', label: 'BySelector' }
const clickSelector = await sandbox.handleRequest({
  method: 'tab.click',
  params: { selector: '#greet', owner: 's1' },
  id: 'click-selector',
})
check('tab.click accepts a selector instead of a ref', clickSelector?.ok === true)

nextPageValue = { x: 10, y: 20, width: 100, height: 30 }
const refShot = await sandbox.handleRequest({
  method: 'tab.screenshot',
  params: { owner: 's1', ref: 1 },
  id: 'shot-ref',
})
check('tab.screenshot with ref returns base64 data', typeof refShot?.dataBase64 === 'string')

const focus = await sandbox.handleRequest({ method: 'tab.tabs', params: { op: 'focus', tabId: 7, owner: 's1' }, id: 'tabs-focus' })
check('tab.tabs op=focus activates the tab', focus?.focused === true && tabs.get(7)?.active === true)

// readable group label reaches tabGroups.update on new tab
const labelled = await sandbox.handleRequest({
  method: 'tab.tabs',
  params: { op: 'new', url: 'https://example.com/', owner: 's9', ownerLabel: 'demo-project' },
  id: 'tabs-label',
})
check('new tab uses a readable group label', labelled?.tabId != null && tabGroupUpdates.some((update) => update.title === 'DSH · demo-project'))

// frameRef dispatch: snapshot builds the registry, click resolves it
await sandbox.handleRequest({ method: 'tab.snapshot', params: { owner: 's1' }, id: 'snapshot-frames' })
nextPageValue = { ok: true, tag: 'button', label: 'Child button' }
const frameClick = await sandbox.handleRequest({
  method: 'tab.click',
  params: { frameRef: 'fa1b2c3d4:1', owner: 's1' },
  id: 'click-frame-ref',
})
check('tab.click accepts a frameRef handle', frameClick?.ok === true && frameClick?.frameRef === 'fa1b2c3d4:1')
check('frameRef action uses an isolated world', debuggerCalls.some((call) => call.method === 'Page.createIsolatedWorld'))

let staleFrameError = null
try {
  await sandbox.handleRequest({
    method: 'tab.click',
    params: { frameRef: 'fdeadbeef:1', owner: 's1' },
    id: 'click-stale-frame',
  })
} catch (error) {
  staleFrameError = String(error?.message || error)
}
check('unknown frameRef reports FRAME_STALE', /FRAME_STALE|stale/i.test(staleFrameError || ''))

// drag + emulate dispatch
nextPageValue = { ok: true, from: 1, to: 2 }
const dragged = await sandbox.handleRequest({ method: 'tab.drag', params: { fromRef: 1, toRef: 2, owner: 's1' }, id: 'drag' })
check('tab.drag dispatches', dragged?.ok === true)

const emulated = await sandbox.handleRequest({ method: 'tab.emulate', params: { width: 375, height: 800, owner: 's1' }, id: 'emulate' })
check('tab.emulate applies device metrics', emulated?.applied === true && emulated?.width === 375)

const emulatedReset = await sandbox.handleRequest({ method: 'tab.emulate', params: { reset: true, owner: 's1' }, id: 'emulate-reset' })
check('tab.emulate reset clears the override', emulatedReset?.applied === false)

// popup focus-tab message activates the session tab
const focusResponse = await new Promise((resolve) => {
  for (const listener of runtimeMessageListeners) {
    if (listener({ type: 'dsh-focus-tab' }, {}, resolve) === true) break
  }
})
check('dsh-focus-tab activates the session tab', focusResponse?.ok === true && focusResponse?.tabId === 7)

// reconnect after the host exits: the worker must issue a NEW connectNative.
// Regression: ensurePort used to leave `connecting` non-null forever, so every
// later attempt returned a stale resolved promise without reconnecting.
check('worker connects once at startup', connectNativeCalls === 1)
for (const listener of nativePortListeners.disconnect) listener()
await new Promise((resolve) => setTimeout(resolve, 10))
await sandbox.ensurePort()
check('disconnect allows a new connectNative attempt', connectNativeCalls === 2, String(connectNativeCalls))
await sandbox.ensurePort()
check('while connected, ensurePort does not reconnect', connectNativeCalls === 2, String(connectNativeCalls))

// wait until=change polls the delta snapshot
nextPageValue = { mode: 'delta', changedCount: 1, sameCount: 0, removedRefs: [], controls: [] }
const waitedChange = await sandbox.handleRequest({
  method: 'tab.wait',
  params: { until: 'change', owner: 's1' },
  id: 'wait-change',
})
check('tab.wait change resolves when controls change', waitedChange?.loadState === 'complete')

// disk version mismatch triggers an automatic extension reload (800ms debounce)
for (const listener of nativePortListeners.message) {
  listener({ event: 'ext.state', params: { version: '9.9.9' } })
}
await new Promise((resolve) => setTimeout(resolve, 950))
check('disk version mismatch requests an extension reload', runtimeReloads >= 1, String(runtimeReloads))

// unsupported method
let unsupported = null
try {
  await sandbox.handleRequest({ method: 'tab.nope', params: {}, id: 'nope' })
} catch (error) {
  unsupported = error?.code
}
// D2: pick dispatch (page-side state machine is exercised live)
nextPageValue = { started: true, alreadyActive: false }
const pickStarted = await sandbox.handleRequest({ method: 'tab.pick_start', params: { owner: 's1' }, id: 'pick-start' })
check('tab.pick_start dispatches', pickStarted?.started === true)

nextPageValue = { available: true, active: false, done: true, canceled: false, result: { ref: 7, selector: '#x', tag: 'button', text: 'X' } }
const pickStatusValue = await sandbox.handleRequest({ method: 'tab.pick_status', params: { owner: 's1' }, id: 'pick-status' })
check('tab.pick_status returns the pick result', pickStatusValue?.result?.ref === 7)
const pickCancelValue = await sandbox.handleRequest({ method: 'tab.pick_cancel', params: { owner: 's1' }, id: 'pick-cancel' })
check('tab.pick_cancel dispatches', Boolean(pickCancelValue))

// C1: tab.evaluate uses the debugger session and returns a serialized value
nextPageValue = 42
const evalResult = await sandbox.handleRequest({
  method: 'tab.evaluate',
  params: { expression: '40 + 2', owner: 's1' },
  id: 'evaluate-basic',
})
check('tab.evaluate dispatches and returns the value', evalResult?.ok === true && evalResult?.value === 42)

// D3: user switching away pauses mutations until chrome_resume
for (const listener of tabActivatedListeners) await listener({ tabId: 7, windowId: 1 })
for (const listener of tabActivatedListeners) await listener({ tabId: 8, windowId: 1 })
nextPageValue = { ok: true, tag: 'button', label: 'Paused click' }
let pausedClickError = null
try {
  await sandbox.handleRequest({ method: 'tab.click', params: { ref: 1, owner: 's1' }, id: 'paused-click' })
} catch (error) {
  pausedClickError = String(error?.code || error?.message || error)
}
check('user switch pauses mutating actions', /USER_SWITCHED/.test(pausedClickError || ''))
const resumed = await sandbox.handleRequest({ method: 'tab.resume', params: { owner: 's1' }, id: 'resume' })
check('tab.resume clears the pause', resumed?.ok === true)
const afterResume = await sandbox.handleRequest({ method: 'tab.click', params: { ref: 1, owner: 's1' }, id: 'click-after-resume' })
check('click works again after resume', afterResume?.ok === true)

// F1: screencast dispatch + frame counter (host writes frames to disk)
const castStart = await sandbox.handleRequest({ method: 'tab.screencast_start', params: { owner: 's1', quality: 50 }, id: 'cast-start' })
check('tab.screencast_start dispatches', castStart?.active === true)
for (const listener of eventListeners) {
  listener({ tabId: 7 }, 'Page.screencastFrame', { sessionId: 's1', data: 'AA==', metadata: { timestamp: 1 } })
}
const castStatus = await sandbox.handleRequest({ method: 'tab.screencast_status', params: { owner: 's1' }, id: 'cast-status' })
check('tab.screencast_status counts frames', castStatus?.active === true && castStatus?.frames === 1)
const castStop = await sandbox.handleRequest({ method: 'tab.screencast_stop', params: { owner: 's1' }, id: 'cast-stop' })
check('tab.screencast_stop dispatches', castStop?.active === false && castStop?.frames === 1)

// C2a: capture metadata, pin, redaction and freeze
const emitNetwork = (method, params) => {
  for (const listener of eventListeners) listener({ tabId: 7 }, method, params)
}
const captureStart = await sandbox.handleRequest({
  method: 'tab.capture_start',
  params: { owner: 's1', maxEntries: 2 },
  id: 'capture-start',
})
check('tab.capture_start returns a capture id', typeof captureStart?.captureId === 'string' && captureStart?.active === true)
check('capture start enables the Network domain', debuggerCalls.some((call) => call.method === 'Network.enable'))
const captureAttachAfterStart = debuggerCalls.filter((call) => call.method === 'attach').length

emitNetwork('Network.requestWillBeSent', {
  requestId: 'r1',
  request: {
    url: 'https://api.test/data?access_token=SECRET',
    method: 'POST',
    hasPostData: true,
    postData: JSON.stringify({ user: 'u1', token: 'T0K3N' }),
  },
  type: 'Fetch',
  timestamp: 100,
  documentURL: 'http://127.0.0.1:8765/api.html',
})
emitNetwork('Network.responseReceived', {
  requestId: 'r1',
  response: { status: 200, statusText: 'OK', mimeType: 'application/json' },
  type: 'Fetch',
  timestamp: 101,
})
emitNetwork('Network.loadingFinished', { requestId: 'r1', timestamp: 100.25 })
await new Promise((resolve) => setTimeout(resolve, 30))

const capturedRequests = await sandbox.handleRequest({
  method: 'tab.capture_requests',
  params: { owner: 's1', limit: 10 },
  id: 'capture-requests-1',
})
check('capture fetches response body while attached', debuggerCalls.some((call) => call.method === 'Network.getResponseBody'))
check(
  'capture records method/status and redacts secret query values',
  capturedRequests?.entries?.[0]?.method === 'POST' &&
    capturedRequests?.entries?.[0]?.status === 200 &&
    capturedRequests?.entries?.[0]?.url.includes('«redacted»') &&
    !capturedRequests?.entries?.[0]?.url.includes('SECRET'),
  JSON.stringify(capturedRequests?.entries?.[0]),
)
check(
  'capture bodies are redacted before returning',
  typeof capturedRequests?.entries?.[0]?.responseBody === 'string' &&
    capturedRequests.entries[0].responseBody.includes('«redacted»') &&
    !JSON.stringify(capturedRequests).includes('T0K3N') &&
    !JSON.stringify(capturedRequests).includes('NESTED'),
  JSON.stringify(capturedRequests?.entries?.[0]?.responseBody),
)
check(
  'capture request body is redacted',
  typeof capturedRequests?.entries?.[0]?.requestBody === 'string' &&
    capturedRequests.entries[0].requestBody.includes('«redacted»'),
  JSON.stringify(capturedRequests?.entries?.[0]?.requestBody),
)
check('capture never includes headers in entries', !JSON.stringify(capturedRequests).match(/cookie|authorization|set-cookie/i))

// capture pins the debugger session: a page action must reuse it, not attach again
await sandbox.handleRequest({ method: 'tab.snapshot', params: { owner: 's1' }, id: 'snapshot-during-capture' })
const attachDuringCapture = debuggerCalls.filter((call) => call.method === 'attach').length
check('capture pins the debugger session', attachDuringCapture === captureAttachAfterStart)

// overflow drops the oldest entries
emitNetwork('Network.requestWillBeSent', { requestId: 'r2', request: { url: 'https://api.test/two', method: 'GET' }, type: 'Fetch', timestamp: 102 })
emitNetwork('Network.requestWillBeSent', { requestId: 'r3', request: { url: 'https://api.test/three', method: 'GET' }, type: 'Fetch', timestamp: 103 })
emitNetwork('Network.requestWillBeSent', { requestId: 'r4', request: { url: 'https://api.test/four', method: 'GET' }, type: 'Fetch', timestamp: 104 })
const overflow = await sandbox.handleRequest({ method: 'tab.capture_requests', params: { owner: 's1' }, id: 'capture-requests-overflow' })
check('capture enforces maxEntries and counts drops', overflow?.total === 2 && overflow?.dropped >= 2, JSON.stringify({ total: overflow?.total, dropped: overflow?.dropped }))

const captureStop = await sandbox.handleRequest({ method: 'tab.capture_stop', params: { owner: 's1' }, id: 'capture-stop' })
check('tab.capture_stop freezes and disables Network', captureStop?.active === false && debuggerCalls.some((call) => call.method === 'Network.disable'))
emitNetwork('Network.requestWillBeSent', { requestId: 'r5', request: { url: 'https://api.test/after-stop', method: 'GET' }, type: 'Fetch', timestamp: 105 })
const frozen = await sandbox.handleRequest({ method: 'tab.capture_requests', params: { owner: 's1', captureId: captureStop.captureId }, id: 'capture-requests-frozen' })
check('capture buffer stays readable after stop and ignores new events', frozen?.total === 2 && frozen?.active === false)

// C2: capture edge branches (failed/cache/type filter/owner isolation/detach freeze)
const edgeStart = await sandbox.handleRequest({
  method: 'tab.capture_start',
  params: { owner: 's1', maxEntries: 10 },
  id: 'capture-edge-start',
})
check('new capture_start after stop becomes active', edgeStart?.active === true)
const edgeAgain = await sandbox.handleRequest({
  method: 'tab.capture_start',
  params: { owner: 's1', maxEntries: 10 },
  id: 'capture-edge-again',
})
check('second capture_start reports alreadyActive', edgeAgain?.alreadyActive === true)

emitNetwork('Network.requestWillBeSent', { requestId: 'e1', request: { url: 'https://api.test/fail', method: 'GET' }, type: 'XHR', timestamp: 200 })
emitNetwork('Network.loadingFailed', { requestId: 'e1', errorText: 'net::ERR_FAILED', canceled: false })
emitNetwork('Network.requestWillBeSent', { requestId: 'e2', request: { url: 'https://api.test/cache', method: 'GET' }, type: 'Fetch', timestamp: 201 })
emitNetwork('Network.requestServedFromCache', { requestId: 'e2' })
emitNetwork('Network.requestWillBeSent', { requestId: 'e3', request: { url: 'https://api.test/pixel.png', method: 'GET' }, type: 'Image', timestamp: 202 })

const edgeRequests = await sandbox.handleRequest({ method: 'tab.capture_requests', params: { owner: 's1' }, id: 'capture-edge-requests' })
const failedEntry = edgeRequests?.entries?.find((entry) => entry.id === 'e1')
const cachedEntry = edgeRequests?.entries?.find((entry) => entry.id === 'e2')
check('capture marks failed requests with errorText', failedEntry?.failed === true && failedEntry?.errorText === 'net::ERR_FAILED')
check('capture records fromCache without responseReceived', cachedEntry?.fromCache === true)
check('capture resourceTypes filter drops images', !edgeRequests?.entries?.some((entry) => entry.id === 'e3'))

let otherOwnerCode = null
try {
  await sandbox.handleRequest({
    method: 'tab.capture_requests',
    params: { owner: 's2', captureId: edgeStart.captureId },
    id: 'capture-other-owner',
  })
} catch (error) {
  otherOwnerCode = String(error?.code || error?.message || error)
}
check('capture buffers are owner-isolated', /CAPTURE_NOT_FOUND/.test(otherOwnerCode || ''))

// F4: URL userinfo + form body redaction
emitNetwork('Network.requestWillBeSent', {
  requestId: 'e4',
  request: { url: 'https://user:pass@api.test/secure?token=SECRET&q=1', method: 'GET' },
  type: 'Fetch',
  timestamp: 210,
})
emitNetwork('Network.responseReceived', { requestId: 'e4', response: { status: 200, mimeType: 'application/json' }, timestamp: 211 })
emitNetwork('Network.loadingFinished', { requestId: 'e4', timestamp: 210.5 })
emitNetwork('Network.requestWillBeSent', {
  requestId: 'e5',
  request: { url: 'https://api.test/form', method: 'POST', hasPostData: true, postData: 'token=T0K3N&user=u1' },
  type: 'XHR',
  timestamp: 220,
})
emitNetwork('Network.responseReceived', { requestId: 'e5', response: { status: 200, mimeType: 'application/json' }, timestamp: 221 })
emitNetwork('Network.loadingFinished', { requestId: 'e5', timestamp: 220.5 })
await new Promise((resolve) => setTimeout(resolve, 30))

const redactedRequests = await sandbox.handleRequest({ method: 'tab.capture_requests', params: { owner: 's1' }, id: 'capture-redacted' })
const userinfoEntry = redactedRequests?.entries?.find((entry) => entry.id === 'e4')
const formEntry = redactedRequests?.entries?.find((entry) => entry.id === 'e5')
check(
  'capture redacts URL userinfo and query secrets',
  typeof userinfoEntry?.url === 'string' &&
    userinfoEntry.url.includes('«redacted»') &&
    !userinfoEntry.url.includes('SECRET'),
  JSON.stringify(userinfoEntry?.url),
)
check(
  'capture redacts form-urlencoded secret fields',
  typeof formEntry?.requestBody === 'string' && formEntry.requestBody.includes('token="«redacted»"'),
  JSON.stringify(formEntry?.requestBody),
)

for (const listener of debuggerDetachListeners) listener({ tabId: 7 }, 'target_closed')
const detachedRequests = await sandbox.handleRequest({ method: 'tab.capture_requests', params: { owner: 's1' }, id: 'capture-detached' })
check(
  'debugger detach freezes the capture with a reason',
  detachedRequests?.active === false && detachedRequests?.entries?.length >= 2,
)

// C0: one debugger session per entry (attach/detach ref counting)
const sessionCounts = (from) => {
  const slice = debuggerCalls.slice(from)
  return {
    attach: slice.filter((call) => call.method === 'attach').length,
    detach: slice.filter((call) => call.method === 'detach').length,
  }
}

nextPageValue = { ok: true, tag: 'button', label: 'C0 click' }
let mark = debuggerCalls.length
await sandbox.handleRequest({ method: 'tab.click', params: { ref: 1, owner: 's1' }, id: 'c0-click' })
let counts = sessionCounts(mark)
check('click uses exactly one debugger attach/detach', counts.attach === 1 && counts.detach === 1, JSON.stringify(counts))

mark = debuggerCalls.length
await sandbox.handleRequest({ method: 'tab.snapshot', params: { owner: 's1' }, id: 'c0-snapshot' })
counts = sessionCounts(mark)
check('frame snapshot uses exactly one debugger attach/detach', counts.attach === 1 && counts.detach === 1, JSON.stringify(counts))

mark = debuggerCalls.length
await sandbox.handleRequest({ method: 'tab.frames', params: { owner: 's1' }, id: 'c0-frames' })
counts = sessionCounts(mark)
check('tab.frames uses exactly one debugger attach/detach', counts.attach === 1 && counts.detach === 1, JSON.stringify(counts))

mark = debuggerCalls.length
await sandbox.handleRequest({ method: 'tab.screenshot', params: { ref: 1, owner: 's1' }, id: 'c0-screenshot-ref' })
counts = sessionCounts(mark)
check('screenshot with ref uses exactly one debugger attach/detach', counts.attach === 1 && counts.detach === 1, JSON.stringify(counts))

// C0: after a debugger onDetach the next action re-attaches cleanly
for (const listener of debuggerDetachListeners) listener({ tabId: 7 }, 'cancelled_by_user')
mark = debuggerCalls.length
const afterDetach = await sandbox.handleRequest({ method: 'tab.frames', params: { owner: 's1' }, id: 'c0-reattach' })
counts = sessionCounts(mark)
check(
  'action re-attaches after debugger detach',
  afterDetach != null && counts.attach === 1 && counts.detach === 1,
  JSON.stringify(counts),
)

check('unknown method is rejected', unsupported === 'UNSUPPORTED')

console.log(failures === 0 ? '\nEXTENSION LOGIC TEST: PASS' : `\nEXTENSION LOGIC TEST: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
