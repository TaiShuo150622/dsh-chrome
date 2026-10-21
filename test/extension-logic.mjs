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
  // The session fixture tab starts in the session group (id 5), like a tab
  // created through chrome_tabs on the real extension.
  [7, { id: 7, url: 'https://example.com/', title: 'Example Domain', active: true, status: 'complete', windowId: 1, groupId: 5 }],
])
// W2: CDP navigation history per tab. chrome.tabs.goBack/goForward counters
// prove the extension no longer uses those APIs.
const navigationHistories = new Map()
const goBackCalls = []
const goForwardCalls = []
const reloadCalls = []
function navigationHistoryFor(tabId) {
  let history = navigationHistories.get(tabId)
  if (!history) {
    const tab = tabs.get(tabId)
    history = {
      currentIndex: 0,
      entries: [{ id: 1, url: tab?.url || 'about:blank', title: tab?.title || '', transitionType: 'typed' }],
    }
    navigationHistories.set(tabId, history)
  }
  return history
}
const debuggerCalls = []
// Attached targets reported by chrome.debugger.getTargets(); the worker runs
// detachOrphanedTargets() on start and tests can seed a target left attached by
// a previous worker generation.
const orphanTargets = []
const dialogCommands = []
const eventListeners = new Set()
let nextPageValue = { ok: true, tag: 'button', label: 'OK' }
let nextTabId = 100
const downloadQueries = []

const runtimeMessageListeners = []
const debuggerDetachListeners = []
const alarmCreates = []
const alarmListeners = []
const storageSets = []
// diag persists to chrome.storage.local.dshDiag; the mock keeps that one key
// stateful so tests can assert which entries survive a burst of writes.
let diagRing = []
const tabRemovedListeners = []
const tabGroupUpdates = []
const tabActivatedListeners = []
const tabUpdates = []
// Windows the mocked tabs live in. `makeTabVisibleForScreencast` reads/writes
// focus + state here (screencast only emits frames for a visible tab).
const windows = new Map([[1, { id: 1, focused: true, state: 'normal' }]])
const windowUpdates = []
// W1: Page.bringToFront behavior and capture hangs are controllable per test.
// bringToFrontActivates defaults to true (real Chrome activates the tab);
// tests flip it to false/error to exercise the extension-side fallback.
let bringToFrontActivates = true
let bringToFrontError = false
let screenshotHangCount = 0
// Session tabs are grouped; a collapsed group is another reason Chrome does not
// render the tab (makeTabVisibleForScreencast expands it).
const tabGroups = new Map([[5, { id: 5, collapsed: true, title: 'DSH · demo-project', color: 'blue' }]])
let nextGroupId = 6
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
        if (key === 'dshDiag') return { dshDiag: [...diagRing] }
        return {}
      },
      async set(value) {
        storageSets.push(value)
        if (Array.isArray(value?.dshDiag)) diagRing = [...value.dshDiag]
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
    async query(queryInfo = {}) {
      let list = [...tabs.values()]
      // claimTab() picks the active tab; honour `active` so an unowned active
      // tab can be claimed without touching another session's tabs (R-12).
      if (queryInfo?.active === true) list = list.filter((tab) => tab.active)
      if (Number.isFinite(queryInfo?.windowId)) list = list.filter((tab) => tab.windowId === queryInfo.windowId)
      // syncTabsFromGroup() reconciles the tracked tab ids with the real group.
      if (Number.isFinite(queryInfo?.groupId)) list = list.filter((tab) => tab.groupId === queryInfo.groupId)
      return list
    },
    async create({ url }) {
      const tab = { id: ++nextTabId, url: url || 'about:blank', title: '', active: false, status: 'complete', windowId: 1 }
      tabs.set(tab.id, tab)
      return tab
    },
    async update(tabId, props) {
      const tab = tabs.get(tabId)
      if (!tab) throw new Error(`no tab ${tabId}`)
      tabUpdates.push({ tabId, ...props })
      // Real Chrome keeps one active tab per window: activating a tab clears
      // the previous one, which the screenshot restore/focus paths rely on.
      if (props?.active === true) {
        for (const other of tabs.values()) {
          if (other.id !== tabId && other.windowId === tab.windowId) other.active = false
        }
      }
      Object.assign(tab, props)
      return tab
    },
    async remove(tabId) {
      tabs.delete(tabId)
    },
    async group({ tabIds = [], groupId } = {}) {
      // One group per created set unless the caller joins an existing group;
      // this mirrors Chrome and keeps two owners from sharing group 5.
      const target = Number.isFinite(groupId) ? groupId : nextGroupId++
      for (const id of tabIds) {
        const tab = tabs.get(id)
        if (tab) tab.groupId = target
      }
      if (!tabGroups.has(target)) tabGroups.set(target, { id: target, collapsed: false, title: '', color: 'blue' })
      return target
    },
    async goBack(tabId) {
      goBackCalls.push(tabId)
    },
    async goForward(tabId) {
      goForwardCalls.push(tabId)
    },
    async reload(tabId) {
      reloadCalls.push(tabId)
    },
    onUpdated: { addListener() {}, removeListener() {} },
    onRemoved: {
      addListener(listener) {
        tabRemovedListeners.push(listener)
      },
      removeListener() {},
    },
  },
  tabGroups: {
    async get(groupId) {
      const group = tabGroups.get(groupId)
      if (!group) throw new Error(`no group ${groupId}`)
      return group
    },
    // Keep query() empty: reconcileGroups() runs on a 1.2s timer and must stay a
    // no-op here so the mocked session state is not rewritten mid-test.
    async query() {
      return []
    },
    async update(id, props) {
      tabGroupUpdates.push({ id, ...props })
      const group = tabGroups.get(id)
      if (group) Object.assign(group, props)
    },
  },
  windows: {
    async get(windowId) {
      const window = windows.get(windowId)
      if (!window) throw new Error(`no window ${windowId}`)
      return window
    },
    async update(windowId, props) {
      const window = windows.get(windowId)
      if (!window) throw new Error(`no window ${windowId}`)
      windowUpdates.push({ windowId, ...props })
      Object.assign(window, props)
      return window
    },
  },
  alarms: {
    create(name, info) {
      alarmCreates.push({ name, info })
    },
    // Real Chrome keeps one alarm per name; mirror that for browser.status.
    getAll() {
      const byName = new Map()
      for (const call of alarmCreates) {
        byName.set(call.name, {
          name: call.name,
          periodInMinutes: call.info?.periodInMinutes,
          scheduledTime: 0,
        })
      }
      return [...byName.values()]
    },
    onAlarm: {
      addListener(listener) {
        alarmListeners.push(listener)
      },
    },
  },
  offscreen: {
    async hasDocument() {
      return false
    },
    async createDocument() {},
  },
  downloads: {
    async search(query) {
      downloadQueries.push(query)
      // H4 fixture: one download per session (s1 -> tab 7, s2 -> tab 108),
      // one from an unrelated tab and one manual download with no tabId.
      return [
        { id: 1, filename: '/tmp/report.pdf', url: 'https://example.com/report.pdf', state: 'complete', tabId: 7, startTime: '2026-10-19T10:00:00.000Z' },
        { id: 2, filename: '/tmp/session-two.pdf', url: 'https://example.com/two.pdf', state: 'complete', tabId: 108, startTime: '2026-10-19T10:01:00.000Z' },
        { id: 3, filename: '/tmp/foreign.pdf', url: 'https://example.com/foreign.pdf', state: 'complete', tabId: 42, startTime: '2026-10-19T10:02:00.000Z' },
        { id: 4, filename: '/tmp/manual.pdf', url: 'https://example.com/manual.pdf', state: 'complete', startTime: '2026-10-19T10:03:00.000Z' },
      ]
    },
  },
  debugger: {
    async attach(target) {
      debuggerCalls.push({ method: 'attach', target })
    },
    async detach(target) {
      debuggerCalls.push({ method: 'detach', target })
    },
    async getTargets() {
      return orphanTargets
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
      if (method === 'Page.getNavigationHistory') {
        return navigationHistoryFor(target.tabId)
      }
      if (method === 'Page.navigateToHistoryEntry') {
        const history = navigationHistoryFor(target.tabId)
        const index = history.entries.findIndex((entry) => entry.id === params?.entryId)
        if (index < 0) throw new Error(`no history entry ${params?.entryId}`)
        history.currentIndex = index
        const entry = history.entries[index]
        const tab = tabs.get(target.tabId)
        if (tab) {
          tab.url = entry.url
          tab.title = entry.title || ''
          tab.status = 'complete'
        }
        return {}
      }
      if (method === 'Page.bringToFront') {
        debuggerCalls.push({ method: 'Page.bringToFrontCalled', target })
        if (bringToFrontError) throw new Error('Page.bringToFront failed')
        if (bringToFrontActivates) {
          const tab = tabs.get(target.tabId)
          if (tab) {
            for (const other of tabs.values()) {
              if (other.windowId === tab.windowId) other.active = false
            }
            tab.active = true
          }
        }
        return {}
      }
      if (method === 'Page.captureScreenshot') {
        // A capture that never answers models the Windows hang (frozen tab,
        // collapsed group): the extension-side timeout must fire, not the
        // provider's 60s call timeout.
        if (screenshotHangCount > 0) {
          screenshotHangCount -= 1
          debuggerCalls.push({ method: 'Page.captureScreenshotHang', target })
          return new Promise(() => {})
        }
        return { data: 'iVBORw0KGgo=' }
      }
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
check(
  'worker start creates exactly one periodic alarm (no duplicate watchdog)',
  new Set(alarmCreates.filter((call) => Number(call.info?.periodInMinutes) > 0).map((call) => call.name)).size === 1 &&
    !alarmCreates.some((call) => call.name === 'dsh-chrome-watchdog'),
  JSON.stringify(alarmCreates),
)

for (const listener of nativePortListeners.message) listener({ event: 'dsh.ping' })
check(
  'first native message resets the self-heal attempt counter',
  storageSets.some((value) => value?.dshSelfHeal?.count === 0),
)

// A healthy port makes the 1-minute wake-up a no-op. It must not persist a
// diag entry: the old code wrote a full 80-entry ring twice a minute, which was
// measured at 25.7 KB/min of LevelDB churn in the real browser and left the
// ring 80/80 full of these no-ops.
await new Promise((resolve) => setTimeout(resolve, 40))
const diagRingBeforeIdleAlarm = diagRing.length
const setsBeforeIdleAlarm = storageSets.length
for (const listener of alarmListeners) listener({ name: 'dsh-chrome-reconnect' })
await new Promise((resolve) => setTimeout(resolve, 40))
check(
  'alarm wake with a connected port writes nothing',
  storageSets.length === setsBeforeIdleAlarm && diagRing.length === diagRingBeforeIdleAlarm,
  `${storageSets.length - setsBeforeIdleAlarm} storage writes, ${diagRing.length} diag entries`,
)
check(
  'startup diag entries are persisted (worker-start / connect-start)',
  ['worker-start', 'connect-start'].every((event) => diagRing.some((entry) => entry.event === event)),
  JSON.stringify(diagRing.map((entry) => entry.event)),
)

// Serialized writes: two entries emitted in the same turn must both survive.
sandbox.diag('test-a')
sandbox.diag('test-b')
await new Promise((resolve) => setTimeout(resolve, 40))
check(
  'diag writes are serialized (same-tick entries both survive)',
  ['test-a', 'test-b'].every((event) => diagRing.some((entry) => entry.event === event)),
  JSON.stringify(diagRing.map((entry) => entry.event)),
)


const statusReply = await sandbox.handleRequest({ method: 'browser.status', params: {}, id: 'status' })
check(
  'browser.status exposes exactly the periodic reconnect alarm',
  Array.isArray(statusReply?.alarms) &&
    statusReply.alarms.length === 1 &&
    statusReply.alarms[0].name === 'dsh-chrome-reconnect' &&
    statusReply.alarms[0].periodInMinutes === 1,
  JSON.stringify(statusReply?.alarms),
)

const PAGE_ACTIONS = vm.runInContext('PAGE_ACTIONS', sandbox)
check(
  'PAGE_ACTIONS has the expected page actions',
  ['snapshot', 'click', 'type', 'press', 'scroll', 'find', 'hover', 'select', 'getText', 'console', 'network', 'overlay'].every(
    (name) => typeof PAGE_ACTIONS[name] === 'function',
  ),
)

// ------------------------------------------- H5 sensitive field page actions
// The page actions run inside Chrome in production; here they are called
// directly with a minimal fake DOM so the fail-closed decision (and that the
// value is never returned for a sensitive field) is unit-tested without Chrome.
class FakeInput {
  constructor(attrs = {}) {
    this.tagName = 'INPUT'
    this.attrs = attrs
    this._value = attrs.value || ''
    this.events = []
    this.focused = false
  }
  get value() {
    return this._value
  }
  set value(next) {
    this._value = String(next)
  }
  getAttribute(name) {
    return this.attrs[name] ?? null
  }
  focus() {
    this.focused = true
  }
  getBoundingClientRect() {
    return { left: 0, top: 0, width: 10, height: 10 }
  }
  dispatchEvent(event) {
    this.events.push(event.type)
    return true
  }
  get form() {
    return null
  }
}
class FakeTextArea extends FakeInput {
  constructor(attrs = {}) {
    super(attrs)
    this.tagName = 'TEXTAREA'
  }
}
class FakeKeyboardEvent {
  constructor(type, init = {}) {
    this.type = type
    this.key = init.key
  }
}
const bodyElement = {
  tagName: 'BODY',
  events: [],
  getBoundingClientRect() {
    return { left: 0, top: 0, width: 0, height: 0 }
  },
  dispatchEvent(event) {
    this.events.push(event.type)
    return true
  },
}
let pageElement = null
sandbox.HTMLInputElement = FakeInput
sandbox.HTMLTextAreaElement = FakeTextArea
sandbox.Event = class {
  constructor(type) {
    this.type = type
  }
}
sandbox.KeyboardEvent = FakeKeyboardEvent
sandbox.window = sandbox
sandbox.document = {
  body: bodyElement,
  querySelector: () => pageElement,
  activeElement: bodyElement,
}

const detectorCases = [
  [{ type: 'password' }, 'password'],
  [{ name: 'user_password' }, 'password'],
  [{ autocomplete: 'current-password' }, 'password'],
  [{ name: 'otp' }, 'otp'],
  [{ autocomplete: 'one-time-code' }, 'otp'],
  [{ placeholder: 'Verification code' }, 'otp'],
  [{ autocomplete: 'cc-number' }, 'payment'],
  [{ name: 'card_number' }, 'payment'],
  [{ name: 'cvv' }, 'payment'],
]
for (const [attrs, expected] of detectorCases) {
  const info = sandbox.sensitiveInputInfo(new FakeInput(attrs))
  check(
    `sensitive detector: ${JSON.stringify(attrs)} -> ${expected}`,
    info?.sensitive === expected,
    JSON.stringify(info),
  )
}
check('sensitive detector ignores a normal text field', sandbox.sensitiveInputInfo(new FakeInput({ type: 'text', name: 'name' })) === null)

const passwordField = new FakeInput({ type: 'password', name: 'password' })
pageElement = passwordField
sandbox.document.activeElement = passwordField
const refusedType = sandbox.typeIntoRef(1, 'DSH_SENTINEL_PASSWORD', false, false, '', false)
check(
  'type into a password field without approval is refused before any write',
  refusedType?.reason === 'SENSITIVE_FIELD' && passwordField.value === '' && passwordField.events.length === 0,
  JSON.stringify(refusedType),
)
check('the refusal does not leak typed text', JSON.stringify(refusedType).includes('DSH_SENTINEL_PASSWORD') === false)
const approvedType = sandbox.typeIntoRef(1, 'DSH_SENTINEL_PASSWORD', false, false, '', true)
check(
  'type into a password field after approval writes but returns no value',
  approvedType?.ok === true && approvedType.sensitive === 'password' && !Object.hasOwn(approvedType, 'value'),
  JSON.stringify(approvedType),
)
check('the approved result does not echo the secret', JSON.stringify(approvedType).includes('DSH_SENTINEL_PASSWORD') === false)

const otpField = new FakeInput({ name: 'otp' })
pageElement = otpField
const refusedOtp = sandbox.typeIntoRef(2, '123456', false, false, '', false)
check('type into an OTP field is refused without approval', refusedOtp?.reason === 'SENSITIVE_FIELD' && otpField.value === '')

const cardField = new FakeInput({ autocomplete: 'cc-number' })
pageElement = cardField
const refusedCard = sandbox.typeIntoRef(3, '4242424242424242', false, false, '', false)
check('type into a payment field is refused without approval', refusedCard?.reason === 'SENSITIVE_FIELD' && cardField.value === '')

const normalField = new FakeInput({ type: 'text', name: 'name' })
pageElement = normalField
const normalType = sandbox.typeIntoRef(4, 'hello', false, false, '', false)
check('a normal text field still returns its value', normalType?.ok === true && normalType.value === 'hello')

const eventsBeforePress = passwordField.events.length
const refusedPress = sandbox.pressKey('X', false)
check(
  'press on a focused password field without approval dispatches no key',
  refusedPress?.reason === 'SENSITIVE_FIELD' && passwordField.events.length === eventsBeforePress,
  JSON.stringify(refusedPress),
)
const approvedPress = sandbox.pressKey('X', true)
check(
  'press on a focused password field after approval dispatches keys',
  approvedPress?.ok === true &&
    approvedPress.sensitive === 'password' &&
    passwordField.events.length === eventsBeforePress + 3,
  JSON.stringify(approvedPress),
)
sandbox.document.activeElement = bodyElement
const bodyPress = sandbox.pressKey('X', false)
check('press outside a sensitive field needs no approval', bodyPress?.ok === true && !bodyPress.sensitive)

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

// R-05: file:// and other non-http(s) schemes never reach chrome.tabs.create /
// chrome.tabs.update, so they cannot become a local-file read primitive.
const tabsSizeBeforeScheme = tabs.size
let fileNewError = null
try {
  await sandbox.handleRequest({ method: 'tab.tabs', params: { op: 'new', url: 'file:///etc/hosts', owner: 's1' }, id: 'tabs-new-file' })
} catch (error) {
  fileNewError = error
}
check('tab.tabs new refuses file:// URLs', fileNewError?.code === 'PROTECTED_PAGE', String(fileNewError?.message || ''))
let fileGotoError = null
try {
  await sandbox.handleRequest({ method: 'tab.goto', params: { url: 'file:///etc/hosts', owner: 's1' }, id: 'goto-file' })
} catch (error) {
  fileGotoError = error
}
check('tab.goto refuses file:// URLs', fileGotoError?.code === 'PROTECTED_PAGE', String(fileGotoError?.message || ''))
check('a refused scheme creates no tab', tabs.size === tabsSizeBeforeScheme)

const history = await sandbox.handleRequest({ method: 'tab.history', params: { op: 'reload', owner: 's1' }, id: 'history' })
check('tab.history reload returns tab state', history?.tabId === 7)
check('tab.history reload keeps using chrome.tabs.reload', reloadCalls.at(-1) === 7, JSON.stringify(reloadCalls))

// W2: back/forward go through CDP Page.getNavigationHistory +
// Page.navigateToHistoryEntry. chrome.tabs.goBack/goForward stay untouched,
// out-of-range moves are NO_HISTORY_ENTRY, and three back/forward round trips
// land on the expected entry every time.
const goBackCallsBefore = goBackCalls.length
const goForwardCallsBefore = goForwardCalls.length
const tab7History = navigationHistoryFor(7)
tab7History.entries = [
  { id: 11, url: 'https://example.com/', title: 'Example Domain', transitionType: 'typed' },
  { id: 12, url: 'https://www.iana.org/', title: 'IANA', transitionType: 'link' },
]
tab7History.currentIndex = 1
tabs.get(7).url = tab7History.entries[1].url
tabs.get(7).title = tab7History.entries[1].title
const historyUrl = async (op, id, tabId) => {
  const value = await sandbox.handleRequest({
    method: 'tab.history',
    params: { op, owner: 's1', ...(tabId == null ? {} : { tabId }) },
    id,
  })
  return value?.url || ''
}
const roundTrips = []
for (let round = 0; round < 3; round += 1) {
  const backUrl = await historyUrl('back', `history-back-${round}`)
  const forwardUrl = await historyUrl('forward', `history-forward-${round}`)
  roundTrips.push({ backUrl, forwardUrl, index: tab7History.currentIndex })
}
check(
  'history back/forward use CDP entries for three round trips',
  roundTrips.every((trip) => trip.backUrl === 'https://example.com/' && trip.forwardUrl === 'https://www.iana.org/') &&
    tab7History.currentIndex === 1,
  JSON.stringify(roundTrips),
)
check(
  'history never calls chrome.tabs.goBack/goForward',
  goBackCalls.length === goBackCallsBefore && goForwardCalls.length === goForwardCallsBefore,
  JSON.stringify({ back: goBackCalls.length - goBackCallsBefore, forward: goForwardCalls.length - goForwardCallsBefore }),
)
await historyUrl('back', 'history-back-to-oldest')
let oldestBackError = null
try {
  await historyUrl('back', 'history-back-past-oldest')
} catch (error) {
  oldestBackError = error
}
check(
  'history back at the oldest entry is NO_HISTORY_ENTRY',
  oldestBackError?.code === 'NO_HISTORY_ENTRY',
  String(oldestBackError?.message || oldestBackError),
)
await historyUrl('forward', 'history-forward-to-newest')
let newestForwardError = null
try {
  await historyUrl('forward', 'history-forward-past-newest')
} catch (error) {
  newestForwardError = error
}
check(
  'history forward at the newest entry is NO_HISTORY_ENTRY',
  newestForwardError?.code === 'NO_HISTORY_ENTRY',
  String(newestForwardError?.message || newestForwardError),
)

// A brand-new tab has exactly one (about:blank) entry: both directions are
// explicit errors instead of chrome.tabs.goBack silently doing nothing.
const freshTab = await sandbox.handleRequest({
  method: 'tab.tabs',
  params: { op: 'new', url: 'about:blank', owner: 's1' },
  id: 'history-fresh-tab',
})
let freshBackError = null
try {
  await historyUrl('back', 'history-fresh-back', freshTab?.tabId)
} catch (error) {
  freshBackError = error
}
let freshForwardError = null
try {
  await historyUrl('forward', 'history-fresh-forward', freshTab?.tabId)
} catch (error) {
  freshForwardError = error
}
check(
  'a new tab has no back/forward history (NO_HISTORY_ENTRY)',
  freshBackError?.code === 'NO_HISTORY_ENTRY' && freshForwardError?.code === 'NO_HISTORY_ENTRY',
  JSON.stringify({ back: freshBackError?.code, forward: freshForwardError?.code, tab: freshTab?.tabId }),
)
await sandbox.handleRequest({ method: 'tab.tabs', params: { op: 'close', tabId: freshTab.tabId, owner: 's1' }, id: 'history-fresh-close' })
navigationHistories.delete(7)
tabs.get(7).url = 'https://example.com/'
tabs.get(7).title = 'Example Domain'

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

// R-12: a tab tracked by another session cannot be claimed.
let foreignClaimError = null
try {
  await sandbox.handleRequest({ method: 'tab.claim', params: { owner: 's2', tabId: 7 }, id: 'claim-foreign' })
} catch (error) {
  foreignClaimError = error
}
check('tab.claim rejects a tab owned by another session', foreignClaimError?.code === 'TAB_NOT_FOUND', String(foreignClaimError?.message || ''))

// An untracked user tab stays claimable, including via tabs op=claim.
tabs.set(108, { id: 108, url: 'https://foreign.example/', title: 'Foreign', active: true, status: 'complete', windowId: 1 })
tabs.get(7).active = false
const claim = await sandbox.handleRequest({ method: 'tab.claim', params: { owner: 's2' }, id: 'claim' })
check('tab.claim claims an unowned active tab', claim?.claimed === true && claim.tabId === 108)
tabs.get(7).active = true
tabs.get(108).active = false

tabs.set(109, { id: 109, url: 'https://foreign2.example/', title: 'Foreign 2', active: false, status: 'complete', windowId: 1 })
const foreignSite = await sandbox.handleRequest({
  method: 'browser.site',
  params: { owner: 's1', tabId: 109, allowForeign: true },
  id: 'site-foreign',
})
check(
  'browser.site resolves a not-yet-owned tab when allowForeign is set (claim guard)',
  foreignSite?.origin === 'https://foreign2.example' && foreignSite?.tabId === 109,
  JSON.stringify(foreignSite),
)
let foreignSiteDenied = null
try {
  await sandbox.handleRequest({ method: 'browser.site', params: { owner: 's1', tabId: 109 }, id: 'site-foreign-denied' })
} catch (error) {
  foreignSiteDenied = error
}
check('browser.site keeps the owned-tab check without allowForeign', foreignSiteDenied?.code === 'TAB_NOT_FOUND')

// claim without tabId targets the active (possibly foreign) tab.
tabs.get(7).active = false
tabs.get(109).active = true
const activeForeignSite = await sandbox.handleRequest({
  method: 'browser.site',
  params: { owner: 's1', allowForeign: true },
  id: 'site-foreign-active',
})
check(
  'browser.site resolves the active tab for claim when allowForeign is set',
  activeForeignSite?.origin === 'https://foreign2.example' && activeForeignSite?.tabId === 109,
  JSON.stringify(activeForeignSite),
)
tabs.get(109).active = false
tabs.get(7).active = true

const claimViaTabs = await sandbox.handleRequest({ method: 'tab.tabs', params: { op: 'claim', tabId: 109, owner: 's3' }, id: 'tabs-claim' })
check('tab.tabs op=claim routes to claim', claimViaTabs?.claimed === true && claimViaTabs.tabId === 109)

const downloads = await sandbox.handleRequest({
  method: 'browser.downloads',
  params: { limit: 5, owner: 's1' },
  id: 'downloads',
})
check(
  'browser.downloads only lists downloads from this session own tabs',
  downloads?.items?.length === 1 &&
    downloads.items[0].filename === '/tmp/report.pdf' &&
    downloads.items[0].tabId === 7 &&
    downloads?.scope === 'session',
  JSON.stringify(downloads),
)
const otherSessionDownloads = await sandbox.handleRequest({
  method: 'browser.downloads',
  params: { limit: 5, owner: 's2' },
  id: 'downloads-s2',
})
check(
  'browser.downloads isolates the second session (two-session test)',
  otherSessionDownloads?.items?.length === 1 &&
    otherSessionDownloads.items[0].filename === '/tmp/session-two.pdf' &&
    !otherSessionDownloads.items.some((item) => item.filename === '/tmp/report.pdf'),
  JSON.stringify(otherSessionDownloads),
)
const noSessionDownloads = await sandbox.handleRequest({
  method: 'browser.downloads',
  params: { limit: 5, owner: 's-unknown' },
  id: 'downloads-unknown',
})
check('browser.downloads fails closed for a session with no tabs', noSessionDownloads?.items?.length === 0)
const historyDownloads = await sandbox.handleRequest({
  method: 'browser.downloads',
  params: { limit: 10, owner: 's1', includeHistory: true },
  id: 'downloads-history',
})
check(
  'browser.downloads includeHistory returns the machine-wide list only when explicitly requested',
  historyDownloads?.items?.length === 4 && historyDownloads?.scope === 'history',
  JSON.stringify(historyDownloads),
)
check(
  'session-scoped download lookup never searches the machine-wide list without includeHistory',
  downloadQueries.at(-2)?.limit >= 5 && downloadQueries.at(-1)?.limit === 10,
  JSON.stringify(downloadQueries.slice(-2)),
)

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

// W1: screenshots from a tab that is not rendered by Chrome. A background tab
// inside a collapsed group used to hang Page.captureScreenshot on Windows;
// the extension now brings it to the front (CDP first), expands the group and
// restores whatever the user was looking at.
tabs.set(130, { id: 130, url: 'https://user.example/', title: 'User tab', active: true, status: 'complete', windowId: 1 })
tabs.get(7).active = false
tabs.get(7).groupId = 5
tabGroups.get(5).collapsed = true
windows.get(1).focused = false
let shotMark = debuggerCalls.length
const backgroundShot = await sandbox.handleRequest({ method: 'tab.screenshot', params: { owner: 's1' }, id: 'shot-collapsed-group' })
check(
  'screenshot succeeds for an inactive tab in a collapsed group',
  typeof backgroundShot?.dataBase64 === 'string',
  JSON.stringify(backgroundShot)?.slice(0, 120),
)
check(
  'screenshot asks CDP Page.bringToFront for a background tab',
  debuggerCalls.slice(shotMark).some((call) => call.method === 'Page.bringToFrontCalled' && call.target?.tabId === 7),
)
check(
  'screenshot expands the collapsed session group',
  tabGroups.get(5)?.collapsed === false,
  JSON.stringify(tabGroupUpdates.slice(-2)),
)
check(
  'screenshot restores the previously active tab',
  tabs.get(130)?.active === true && tabs.get(7)?.active === false,
  JSON.stringify({ user: tabs.get(130)?.active, session: tabs.get(7)?.active }),
)
check(
  'screenshot does not count the auto-activation as a user switch',
  vm.runInContext('expectedActivations', sandbox).has(7) && vm.runInContext('expectedActivations', sandbox).has(130),
)

// W1: Page.bringToFront can fail (or resolve without activating the tab). The
// extension-side repair (tabs.update + tabGroups + windows) must still make the
// screenshot work and restore the previous tab.
tabs.set(131, { id: 131, url: 'https://user2.example/', title: 'User tab 2', active: true, status: 'complete', windowId: 1 })
tabs.get(130).active = false
tabs.get(7).active = false
tabGroups.get(5).collapsed = false
bringToFrontActivates = false
bringToFrontError = true
const tabUpdatesBeforeFallback = tabUpdates.length
const fallbackShot = await sandbox.handleRequest({ method: 'tab.screenshot', params: { owner: 's1' }, id: 'shot-bring-to-front-failed' })
check('screenshot falls back to extension activation when Page.bringToFront fails', typeof fallbackShot?.dataBase64 === 'string')
check(
  'the fallback activates the session tab through the tabs API',
  tabUpdates.slice(tabUpdatesBeforeFallback).some((update) => update.tabId === 7 && update.active === true),
  JSON.stringify(tabUpdates.slice(tabUpdatesBeforeFallback)),
)
check('the fallback still restores the previously active tab', tabs.get(131)?.active === true)
bringToFrontActivates = true
bringToFrontError = false
tabs.delete(130)
tabs.delete(131)
tabs.get(7).active = true
tabGroups.get(5).collapsed = false
windows.get(1).focused = true
windows.get(1).state = 'normal'

// W3: focusing a second session tab updates activeTabId, tabs list `*`,
// subsequent snapshots and the window focus; onTabActivated follows a tab
// activation back without ever creating a new owner.
const dualTab = await sandbox.handleRequest({
  method: 'tab.tabs',
  params: { op: 'new', url: 'https://second.example/', owner: 's1' },
  id: 'w3-new-tab',
})
check(
  'second session tab is created in the session group',
  Number.isFinite(dualTab?.tabId) && tabs.get(dualTab.tabId)?.groupId === 5,
  JSON.stringify({ tabId: dualTab?.tabId, groupId: tabs.get(dualTab.tabId)?.groupId }),
)
windows.get(1).focused = false
const windowUpdatesBeforeW3 = windowUpdates.length
const focusSecond = await sandbox.handleRequest({
  method: 'tab.tabs',
  params: { op: 'focus', tabId: dualTab.tabId, owner: 's1' },
  id: 'w3-focus',
})
check(
  'focus returns the focused tab',
  focusSecond?.tabId === dualTab.tabId && focusSecond?.focused === true,
  JSON.stringify(focusSecond),
)
check(
  'focus activates the tab and deactivates the previous one',
  tabs.get(dualTab.tabId)?.active === true && tabs.get(7)?.active === false,
)
check(
  'focus focuses the window when it is not focused',
  windowUpdates.slice(windowUpdatesBeforeW3).some((update) => update.windowId === 1 && update.focused === true),
  JSON.stringify(windowUpdates.slice(windowUpdatesBeforeW3)),
)
const listAfterW3Focus = await sandbox.handleRequest({
  method: 'tab.tabs',
  params: { op: 'list', owner: 's1' },
  id: 'w3-list',
})
check(
  'tabs list marks the focused tab active',
  listAfterW3Focus?.tabs?.find((tab) => tab.tabId === dualTab.tabId)?.active === true &&
    listAfterW3Focus?.tabs?.find((tab) => tab.tabId === 7)?.active === false,
  JSON.stringify(listAfterW3Focus?.tabs),
)
let snapshotMark = debuggerCalls.length
nextPageValue = { ok: true, tag: 'button', label: 'W3 snapshot' }
await sandbox.handleRequest({ method: 'tab.snapshot', params: { owner: 's1' }, id: 'w3-snapshot' })
check(
  'snapshot after focus targets the new active tab',
  debuggerCalls.slice(snapshotMark).some((call) => call.method === 'attach' && call.target?.tabId === dualTab.tabId),
  JSON.stringify(debuggerCalls.slice(snapshotMark).filter((call) => call.method === 'attach')),
)

const sessionsBeforeW3 = await vm.runInContext('loadSessions()', sandbox)
const ownersBeforeW3 = Object.keys(sessionsBeforeW3).sort().join(',')
sessionsBeforeW3.s1.paused = true
sessionsBeforeW3.s1.pausedAt = Date.now()
sessionsBeforeW3.s1.pausedUrl = 'https://foreign.example/'
for (const listener of tabActivatedListeners) await listener({ tabId: 7, windowId: 1 })
const sessionsAfterW3 = await vm.runInContext('loadSessions()', sandbox)
check(
  'onTabActivated follows a session tab activation',
  sessionsAfterW3.s1?.activeTabId === 7,
  JSON.stringify({ activeTabId: sessionsAfterW3.s1?.activeTabId }),
)
check(
  'onTabActivated clears the USER_SWITCHED pause',
  sessionsAfterW3.s1?.paused === false && !sessionsAfterW3.s1?.pausedUrl,
  JSON.stringify({ paused: sessionsAfterW3.s1?.paused }),
)
for (const listener of tabActivatedListeners) await listener({ tabId: 42, windowId: 1 })
const sessionsAfterForeignW3 = await vm.runInContext('loadSessions()', sandbox)
check(
  'onTabActivated never creates a new owner',
  Object.keys(sessionsAfterForeignW3).sort().join(',') === ownersBeforeW3 &&
    sessionsAfterForeignW3.s1?.paused === true,
  JSON.stringify({ owners: Object.keys(sessionsAfterForeignW3), paused: sessionsAfterForeignW3.s1?.paused }),
)
await sandbox.handleRequest({ method: 'tab.resume', params: { owner: 's1' }, id: 'w3-resume' })
await sandbox.handleRequest({
  method: 'tab.tabs',
  params: { op: 'close', tabId: dualTab.tabId, owner: 's1' },
  id: 'w3-close',
})
tabs.get(7).active = true
for (const listener of tabActivatedListeners) await listener({ tabId: 7, windowId: 1 })

// readable group label reaches tabGroups.update on new tab
const labelled = await sandbox.handleRequest({
  method: 'tab.tabs',
  params: { op: 'new', url: 'https://example.com/', owner: 's9', ownerLabel: 'demo-project' },
  id: 'tabs-label',
})
check(
  'new tab uses an owner-disambiguated group label',
  labelled?.tabId != null && tabGroupUpdates.some((update) => /^DSH · demo-project · /.test(String(update.title))),
)
await sandbox.handleRequest({ method: 'tab.tabs', params: { op: 'new', url: 'https://example.com/', owner: 's10', ownerLabel: 'demo-project' }, id: 'tabs-label-2' })
const demoTitles = new Set(
  tabGroupUpdates.map((update) => String(update.title)).filter((title) => title.startsWith('DSH · demo-project')),
)
check('two sessions with the same cwd label get distinct group titles', demoTitles.size >= 2, JSON.stringify([...demoTitles]))

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
// F1b: the session tab sits in the background (the viewer is another window) —
// `start` must activate it, restore/focus the window, expand its collapsed tab
// group and clear a pending USER_SWITCHED pause, otherwise Chrome emits no
// frames (frames=0 / stale image).
tabs.get(7).active = false
tabs.get(7).groupId = 5
tabGroups.get(5).collapsed = true
windows.get(1).focused = false
windows.get(1).state = 'minimized'
// Simulate the user switching away: session tab 7 -> unrelated tab 9 pauses s1.
for (const listener of tabActivatedListeners) await listener({ tabId: 7, windowId: 1 })
for (const listener of tabActivatedListeners) await listener({ tabId: 9, windowId: 1 })
const castStatusBackground = await sandbox.handleRequest({
  method: 'tab.screencast_status',
  params: { owner: 's1' },
  id: 'cast-status-background',
})
check(
  'screencast status reports a background tab as not visible',
  castStatusBackground?.active === false &&
    castStatusBackground?.visible === false &&
    castStatusBackground?.tabActive === false &&
    castStatusBackground?.tabGroupCollapsed === true,
  JSON.stringify(castStatusBackground),
)

const tabUpdatesBeforeCast = tabUpdates.length
const windowUpdatesBeforeCast = windowUpdates.length
const tabGroupUpdatesBeforeCast = tabGroupUpdates.length
const castStart = await sandbox.handleRequest({ method: 'tab.screencast_start', params: { owner: 's1', quality: 50 }, id: 'cast-start' })
check('tab.screencast_start dispatches', castStart?.active === true)
check(
  'screencast start activates the background session tab',
  castStart?.activated === true &&
    tabUpdates.slice(tabUpdatesBeforeCast).some((update) => update.tabId === 7 && update.active === true) &&
    tabs.get(7)?.active === true,
)
check(
  'screencast start expands the collapsed session tab group',
  castStart?.expandedGroup === true &&
    tabGroupUpdates.slice(tabGroupUpdatesBeforeCast).some((update) => update.id === 5 && update.collapsed === false) &&
    tabGroups.get(5)?.collapsed === false,
  JSON.stringify(tabGroupUpdates.slice(tabGroupUpdatesBeforeCast)),
)
check(
  'screencast start restores and focuses a minimized window',
  castStart?.restoredWindow === true &&
    castStart?.focusedWindow === true &&
    windowUpdates.slice(windowUpdatesBeforeCast).some((update) => update.windowId === 1 && update.state === 'normal') &&
    windowUpdates.slice(windowUpdatesBeforeCast).some((update) => update.windowId === 1 && update.focused === true),
  JSON.stringify(windowUpdates.slice(windowUpdatesBeforeCast)),
)
check(
  'screencast start reports the tab as visible',
  castStart?.visible === true && castStart?.tabActive === true && windows.get(1)?.focused === true,
)
check('screencast start clears the USER_SWITCHED pause', castStart?.resumedFromPause === true)
check(
  'auto-activation tells the caller the tab was brought to the front',
  /visible tab/i.test(castStart?.hint || ''),
  castStart?.hint,
)
nextPageValue = { ok: true, tag: 'button', label: 'After cast activation' }
const clickAfterCast = await sandbox.handleRequest({ method: 'tab.click', params: { ref: 1, owner: 's1' }, id: 'click-after-cast' })
check('mutating actions work again after the screencast auto-resume', clickAfterCast?.ok === true)

const castStatusBeforeFrame = await sandbox.handleRequest({
  method: 'tab.screencast_status',
  params: { owner: 's1' },
  id: 'cast-status-before-frame',
})
check(
  'screencast status exposes visibility and frame time before the first frame',
  castStatusBeforeFrame?.active === true &&
    castStatusBeforeFrame?.visible === true &&
    castStatusBeforeFrame?.tabGroupCollapsed === false &&
    castStatusBeforeFrame?.frames === 0 &&
    castStatusBeforeFrame?.frameAt === null &&
    castStatusBeforeFrame?.frameAgeMs === null &&
    /waiting for the first frame/i.test(castStatusBeforeFrame?.hint || ''),
  JSON.stringify(castStatusBeforeFrame),
)
for (const listener of eventListeners) {
  listener({ tabId: 7 }, 'Page.screencastFrame', { sessionId: 's1', data: 'AA==', metadata: { timestamp: 1 } })
}
check(
  'screencast frame events carry the owning session (R-06)',
  fakeNativePort.posted.some((message) => message.type === 'screencast-frame' && message.owner === 's1'),
)
const castStatus = await sandbox.handleRequest({ method: 'tab.screencast_status', params: { owner: 's1' }, id: 'cast-status' })
check('tab.screencast_status counts frames', castStatus?.active === true && castStatus?.frames === 1)
check(
  'screencast status exposes the last-frame time',
  typeof castStatus?.frameAt === 'number' &&
    castStatus.frameAt > 0 &&
    typeof castStatus?.lastAt === 'string' &&
    typeof castStatus?.frameAgeMs === 'number' &&
    castStatus.visible === true,
  JSON.stringify({ frameAt: castStatus?.frameAt, frameAgeMs: castStatus?.frameAgeMs }),
)
const castStop = await sandbox.handleRequest({ method: 'tab.screencast_stop', params: { owner: 's1' }, id: 'cast-stop' })
check('tab.screencast_stop dispatches', castStop?.active === false && castStop?.frames === 1)

// C2a: capture metadata, pin, redaction and freeze
const emitNetwork = (method, params) => {
  for (const listener of eventListeners) listener({ tabId: 7 }, method, params)
}
const captureStart = await sandbox.handleRequest({
  method: 'tab.capture_start',
  params: { owner: 's1', maxEntries: 2, storeBodies: true },
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
  params: { owner: 's1', maxEntries: 10, storeBodies: true },
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

// W1: a Page.captureScreenshot that never answers must fail with a stable
// extension-side code, within the extension budget (not the provider's 60s
// timeout), and must not leave the tab attached or its refs stuck.
const liveDebuggerSessions = vm.runInContext('debuggerSessions', sandbox)
const shotLimits = vm.runInContext('SCREENSHOT_LIMITS', sandbox)
const savedShotLimits = { ...shotLimits }
shotLimits.commandMs = 40
shotLimits.budgetMs = 260
shotLimits.retryDelayMs = 1
screenshotHangCount = 2
let timeoutShotError = null
mark = debuggerCalls.length
const timeoutShotStarted = Date.now()
try {
  await sandbox.handleRequest({ method: 'tab.screenshot', params: { owner: 's1' }, id: 'shot-timeout' })
} catch (error) {
  timeoutShotError = error
}
const timeoutShotElapsed = Date.now() - timeoutShotStarted
counts = sessionCounts(mark)
check(
  'a hanging capture fails with SCREENSHOT_TIMEOUT inside the extension budget',
  timeoutShotError?.code === 'SCREENSHOT_TIMEOUT' && timeoutShotElapsed < 2000,
  `${timeoutShotError?.code || timeoutShotError?.message} after ${timeoutShotElapsed}ms`,
)
check(
  'a timed-out screenshot releases its debugger session and detaches both attempts',
  liveDebuggerSessions.size === 0 && counts.attach === 2 && counts.detach === 2,
  JSON.stringify({ sessions: liveDebuggerSessions.size, ...counts }),
)
screenshotHangCount = 0
mark = debuggerCalls.length
const recoveredShot = await sandbox.handleRequest({ method: 'tab.screenshot', params: { owner: 's1' }, id: 'shot-after-timeout' })
counts = sessionCounts(mark)
check(
  'the next screenshot re-attaches and succeeds after a timeout',
  typeof recoveredShot?.dataBase64 === 'string' && counts.attach === 1 && counts.detach === 1,
  JSON.stringify(counts),
)
screenshotHangCount = 1
mark = debuggerCalls.length
const retriedShot = await sandbox.handleRequest({ method: 'tab.screenshot', params: { owner: 's1' }, id: 'shot-retry-after-hang' })
counts = sessionCounts(mark)
check(
  'a hung first attempt is retried once and succeeds',
  typeof retriedShot?.dataBase64 === 'string' && counts.attach === 2 && counts.detach === 2,
  JSON.stringify(counts),
)
Object.assign(shotLimits, savedShotLimits)

// C3: capture reclamation. A stopped capture keeps a redacted summary for a
// bounded TTL/count, then releases entries/bodies/timers; bodies are opt-in.
const debuggerSessionsMap = vm.runInContext('debuggerSessions', sandbox)
const capturesMap = vm.runInContext('captures', sandbox)
const captureSummaryTtlMs = vm.runInContext('CAPTURE_SUMMARY_TTL_MS', sandbox)
const captureSummaryLimit = vm.runInContext('CAPTURE_SUMMARY_LIMIT', sandbox)
const networkBodyCalls = () => debuggerCalls.filter((call) => call.method === 'Network.getResponseBody').length

const bodyCallsBeforeDefault = networkBodyCalls()
const defaultCapture = await sandbox.handleRequest({
  method: 'tab.capture_start',
  params: { owner: 's1', maxEntries: 5 },
  id: 'capture-default-start',
})
check(
  'capture without storeBodies is metadata-only by default',
  defaultCapture?.storeBodies === false && defaultCapture?.active === true,
  JSON.stringify(defaultCapture),
)
emitNetwork('Network.requestWillBeSent', {
  requestId: 'd1',
  request: { url: 'https://api.test/default-body', method: 'POST', hasPostData: true, postData: 'token=SECRET' },
  type: 'XHR',
  timestamp: 300,
})
emitNetwork('Network.responseReceived', { requestId: 'd1', response: { status: 200, mimeType: 'application/json' }, timestamp: 301 })
emitNetwork('Network.loadingFinished', { requestId: 'd1', timestamp: 300.5 })
await new Promise((resolve) => setTimeout(resolve, 30))
const defaultRead = await sandbox.handleRequest({
  method: 'tab.capture_requests',
  params: { owner: 's1', captureId: defaultCapture.captureId, includeBodies: true },
  id: 'capture-default-read',
})
const defaultEntry = defaultRead?.entries?.find((entry) => entry.id === 'd1')
const defaultCaptureObject = capturesMap.get(defaultCapture.captureId)
check(
  'default capture stores no response/request body and never asks CDP for one',
  defaultEntry != null &&
    defaultEntry.responseBody === undefined &&
    defaultEntry.requestBody === undefined &&
    networkBodyCalls() === bodyCallsBeforeDefault &&
    defaultCaptureObject?.requests.get('d1')?.postDataRaw === undefined,
  JSON.stringify({ entry: defaultEntry, bodyCalls: networkBodyCalls() - bodyCallsBeforeDefault }),
)
const defaultStop = await sandbox.handleRequest({
  method: 'tab.capture_stop',
  params: { owner: 's1', captureId: defaultCapture.captureId },
  id: 'capture-default-stop',
})
check(
  'capture stop keeps entries readable and arms the summary TTL',
  defaultStop?.active === false &&
    defaultCaptureObject?.order.length === 1 &&
    Boolean(defaultCaptureObject?.expireTimer) &&
    defaultCaptureObject?.bodyTasks?.size === 0,
  JSON.stringify({ active: defaultStop?.active, entries: defaultCaptureObject?.order.length, ttl: Boolean(defaultCaptureObject?.expireTimer) }),
)
const frozenDefaultRead = await sandbox.handleRequest({
  method: 'tab.capture_requests',
  params: { owner: 's1', captureId: defaultCapture.captureId },
  id: 'capture-default-frozen-read',
})
check(
  'a second read of the frozen summary still works',
  frozenDefaultRead?.total === 1 && frozenDefaultRead?.entries?.[0]?.id === 'd1',
  JSON.stringify({ total: frozenDefaultRead?.total }),
)

// TTL: an expired stopped summary is dropped lazily and its entries freed.
defaultCaptureObject.stoppedAt = Date.now() - captureSummaryTtlMs - 1
let expiredCode = null
try {
  await sandbox.handleRequest({
    method: 'tab.capture_requests',
    params: { owner: 's1', captureId: defaultCapture.captureId },
    id: 'capture-expired-read',
  })
} catch (error) {
  expiredCode = error?.code || String(error?.message || error)
}
check(
  'an expired capture is CAPTURE_LOST and its entries are released',
  expiredCode === 'CAPTURE_LOST' &&
    !capturesMap.has(defaultCapture.captureId) &&
    defaultCaptureObject.order.length === 0 &&
    defaultCaptureObject.requests.size === 0 &&
    defaultCaptureObject.expireTimer === null,
  JSON.stringify({ code: expiredCode, size: defaultCaptureObject.order.length, requests: defaultCaptureObject.requests.size }),
)

// Count cap: start/stop 10 captures; only the newest CAPTURE_SUMMARY_LIMIT survive.
const recentCaptureIds = []
for (let index = 0; index < 10; index += 1) {
  const started = await sandbox.handleRequest({
    method: 'tab.capture_start',
    params: { owner: 's1', maxEntries: 1 },
    id: `capture-prune-${index}-start`,
  })
  await sandbox.handleRequest({
    method: 'tab.capture_stop',
    params: { owner: 's1', captureId: started.captureId },
    id: `capture-prune-${index}-stop`,
  })
  recentCaptureIds.push(started.captureId)
}
check(
  'stopped capture summaries are bounded by count',
  capturesMap.size <= captureSummaryLimit && capturesMap.has(recentCaptureIds.at(-1)) && !capturesMap.has(recentCaptureIds[0]),
  JSON.stringify({ size: capturesMap.size, limit: captureSummaryLimit }),
)

// A debugger detach (target closed / DevTools steals it) must clear the
// screencast auto-stop timer, not only the capture.
const detachCast = await sandbox.handleRequest({ method: 'tab.screencast_start', params: { owner: 's1' }, id: 'detach-cast-start' })
const detachCastTimer = debuggerSessionsMap.get(7)?.screencast?.timer
for (const listener of debuggerDetachListeners) listener({ tabId: 7 }, 'target_closed')
await new Promise((resolve) => setTimeout(resolve, 20))
check(
  'debugger detach clears the session and screencast timer',
  detachCast?.active === true &&
    detachCastTimer?._destroyed === true &&
    !debuggerSessionsMap.has(7),
  JSON.stringify({ active: detachCast?.active, timerDestroyed: detachCastTimer?._destroyed, sessions: debuggerSessionsMap.size }),
)

// Extension reload: prepareForReload detaches every debuggee and drops state.
const reloadCapture = await sandbox.handleRequest({
  method: 'tab.capture_start',
  params: { owner: 's1', maxEntries: 5 },
  id: 'reload-capture-start',
})
const reloadDetachMark = debuggerCalls.filter((call) => call.method === 'detach').length
await sandbox.prepareForReload()
await new Promise((resolve) => setTimeout(resolve, 20))
check(
  'prepareForReload detaches sessions and drops captures',
  reloadCapture?.active === true &&
    !debuggerSessionsMap.has(7) &&
    !capturesMap.has(reloadCapture.captureId) &&
    debuggerCalls.filter((call) => call.method === 'detach').length > reloadDetachMark,
  JSON.stringify({ sessions: debuggerSessionsMap.size, captures: capturesMap.size }),
)

// A target left attached by a previous worker generation is detached on the
// worker-start recovery path.
orphanTargets.push({ attached: true, tabId: 99, type: 'page' })
await sandbox.detachOrphanedTargets()
const orphanDetach = debuggerCalls.find((call) => call.method === 'detach' && call.target?.tabId === 99)
check('worker start detaches an orphaned debugger target', Boolean(orphanDetach), JSON.stringify(orphanDetach))
orphanTargets.length = 0

// Capture timeout: endCapture runs outside withDebugger, so it must release the
// debugger itself; otherwise a 10-minute auto-stop leaves Chrome attached.
const timeoutCapture = await sandbox.handleRequest({
  method: 'tab.capture_start',
  params: { owner: 's1', maxEntries: 5 },
  id: 'timeout-capture-start',
})
const timeoutCaptureObject = capturesMap.get(timeoutCapture.captureId)
const timeoutDetachMark = debuggerCalls.filter((call) => call.method === 'detach').length
sandbox.endCapture(timeoutCaptureObject, 'timeout')
await new Promise((resolve) => setTimeout(resolve, 20))
check(
  'capture timeout releases the debugger session',
  timeoutCapture?.active === true &&
    !debuggerSessionsMap.has(7) &&
    timeoutCaptureObject?.active === false &&
    timeoutCaptureObject?.endedReason === 'timeout' &&
    debuggerCalls.filter((call) => call.method === 'detach').length > timeoutDetachMark,
  JSON.stringify({ sessions: debuggerSessionsMap.size, reason: timeoutCaptureObject?.endedReason }),
)

// Screencast auto-stop: the 10-minute timer must clear state, stop CDP and drop
// the now-idle debugger session (the callback is invoked directly).
const autoCast = await sandbox.handleRequest({ method: 'tab.screencast_start', params: { owner: 's1' }, id: 'auto-cast-start' })
const autoCastTimer = debuggerSessionsMap.get(7)?.screencast?.timer
const autoStopMark = debuggerCalls.length
autoCastTimer?._onTimeout?.()
await new Promise((resolve) => setTimeout(resolve, 20))
check(
  'screencast auto-stop timer clears state, timer and debugger session',
  autoCast?.active === true &&
    autoCastTimer?._destroyed === true &&
    !debuggerSessionsMap.has(7) &&
    debuggerCalls.slice(autoStopMark).some((call) => call.method === 'Page.stopScreencast'),
  JSON.stringify({ timerDestroyed: autoCastTimer?._destroyed, sessions: debuggerSessionsMap.size }),
)

// Tab close: capture + screencast state and their timers are released.
const closeCapture = await sandbox.handleRequest({
  method: 'tab.capture_start',
  params: { owner: 's1', maxEntries: 5, storeBodies: true },
  id: 'tab-close-capture-start',
})
const closeCast = await sandbox.handleRequest({ method: 'tab.screencast_start', params: { owner: 's1' }, id: 'tab-close-cast-start' })
const closeSession = debuggerSessionsMap.get(7)
const closeCastTimer = closeSession?.screencast?.timer
const closeCaptureObject = capturesMap.get(closeCapture.captureId)
tabs.delete(7)
for (const listener of tabRemovedListeners) listener(7)
await new Promise((resolve) => setTimeout(resolve, 20))
check(
  'tab close releases capture, screencast and timers',
  closeCast?.active === true &&
    !debuggerSessionsMap.has(7) &&
    !capturesMap.has(closeCapture.captureId) &&
    closeCaptureObject?.order.length === 0 &&
    closeCastTimer?._destroyed === true,
  JSON.stringify({
    sessions: debuggerSessionsMap.size,
    captures: capturesMap.size,
    entries: closeCaptureObject?.order.length,
    timerDestroyed: closeCastTimer?._destroyed,
  }),
)

// Provider disconnect: the provider that owned the session is gone, so every
// debuggee must be detached and both tables cleared.
const providerTab = { id: 8, url: 'https://example.com/8', title: '8', active: true, status: 'complete', windowId: 1 }
tabs.set(8, providerTab)
const claimed = await sandbox.handleRequest({ method: 'tab.claim', params: { owner: 's1', tabId: 8 }, id: 'provider-claim' })
const providerCapture = await sandbox.handleRequest({
  method: 'tab.capture_start',
  params: { owner: 's1', tabId: 8, maxEntries: 5 },
  id: 'provider-capture-start',
})
const providerDetachMark = debuggerCalls.filter((call) => call.method === 'detach').length
for (const listener of nativePortListeners.disconnect) listener()
await new Promise((resolve) => setTimeout(resolve, 30))
check(
  'provider disconnect detaches every debuggee and clears capture state',
  claimed?.claimed === true &&
    providerCapture?.active === true &&
    debuggerSessionsMap.size === 0 &&
    capturesMap.size === 0 &&
    debuggerCalls.filter((call) => call.method === 'detach').length > providerDetachMark &&
    debuggerCalls.some((call) => call.method === 'detach' && call.target?.tabId === 8),
  JSON.stringify({ sessions: debuggerSessionsMap.size, captures: capturesMap.size }),
)

check('unknown method is rejected', unsupported === 'UNSUPPORTED')

// The periodic alarm is the only wake-up when no page/tab event arrives: with
// no port it must start a fresh connectNative. (The old duplicate watchdog
// alarm handled this too; the merged handler has to keep that guarantee.)
for (const listener of nativePortListeners.disconnect) listener()
await new Promise((resolve) => setTimeout(resolve, 10))
const connectsBeforeAlarm = connectNativeCalls
for (const listener of alarmListeners) listener({ name: 'dsh-chrome-reconnect' })
await new Promise((resolve) => setTimeout(resolve, 20))
check(
  'periodic alarm reconnects a dead port',
  connectNativeCalls === connectsBeforeAlarm + 1,
  `${connectsBeforeAlarm} -> ${connectNativeCalls}`,
)

console.log(failures === 0 ? '\nEXTENSION LOGIC TEST: PASS' : `\nEXTENSION LOGIC TEST: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
