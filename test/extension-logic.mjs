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

const fakeNativePort = {
  posted: [],
  onMessage: { addListener() {} },
  onDisconnect: { addListener() {} },
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
    connectNative: () => fakeNativePort,
    reload: () => {},
    onConnect: { addListener() {} },
    onInstalled: { addListener() {} },
    onStartup: { addListener() {} },
    onMessage: { addListener() {} },
  },
  storage: {
    session: {
      async get() {
        return { dshSessions: { s1: { tabIds: [7], groupId: 5, activeTabId: 7 } } }
      },
      async set() {},
    },
    local: {
      async get() {
        return {}
      },
      async set() {},
    },
  },
  tabs: {
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
  },
  tabGroups: { async update() {} },
  alarms: { create() {}, onAlarm: { addListener() {} } },
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
      if (method === 'Page.captureScreenshot') return { data: 'iVBORw0KGgo=' }
      if (method === 'Page.handleJavaScriptDialog') {
        dialogCommands.push(params)
        return {}
      }
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
}
vm.createContext(sandbox)
vm.runInContext(source, sandbox, { filename: 'background.js' })

check('background.js evaluates with mocked chrome', typeof sandbox.handleRequest === 'function')
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

const claim = await sandbox.handleRequest({ method: 'tab.claim', params: { owner: 's2' }, id: 'claim' })
check('tab.claim claims the active tab', claim?.claimed === true && tabs.get(claim.tabId) != null)

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

// unsupported method
let unsupported = null
try {
  await sandbox.handleRequest({ method: 'tab.nope', params: {}, id: 'nope' })
} catch (error) {
  unsupported = error?.code
}
check('unknown method is rejected', unsupported === 'UNSUPPORTED')

console.log(failures === 0 ? '\nEXTENSION LOGIC TEST: PASS' : `\nEXTENSION LOGIC TEST: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
