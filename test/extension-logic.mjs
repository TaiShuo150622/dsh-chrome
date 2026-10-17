/**
 * Extension logic test — runs extension/background.js inside a VM with a
 * mocked chrome.* API. No Chrome required.
 *
 * Covers the parts that previously only failed in real Chrome:
 *   - request dispatch (tool method -> extension handler)
 *   - owner -> tab resolution
 *   - CDP page actions and dialog interception defaults
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
const tabs = new Map([[7, { id: 7, url: 'https://example.com/', title: 'Example Domain', active: true, windowId: 1 }]])
const debuggerCalls = []
const dialogCommands = []
const eventListeners = new Set()
const pageActions = {}
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
        return {
          dshSessions: { s1: { tabIds: [7], groupId: 5, activeTabId: 7 } },
        }
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
      const tab = { id: ++nextTabId, url: url || 'about:blank', title: '', active: false, windowId: 1 }
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
    onUpdated: { addListener() {} },
  },
  tabGroups: {
    async update() {},
  },
  alarms: {
    create() {},
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
      return []
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
      if (method === 'Page.handleJavaScriptDialog') {
        dialogCommands.push(params)
        return {}
      }
      if (method === 'Runtime.evaluate') {
        // Simulate a confirm() dialog opening during the page action.
        for (const listener of eventListeners) {
          listener({ tabId: target.tabId }, 'Page.javascriptDialogOpening', {
            type: 'confirm',
            message: 'Delete this item?',
          })
        }
        const actionName = params.expression.includes('findInPage')
          ? 'find'
          : params.expression.includes('clickByRef')
            ? 'click'
            : 'other'
        const value = pageActions[actionName] ?? { ok: true, tag: 'button', label: 'OK' }
        return { result: { value } }
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

// 1) dispatch: tab.find -> find() -> CDP evaluate
pageActions.find = { query: 'Example', matches: [{ ref: 901, text: 'Example Domain', tag: 'h1', x: 10, y: 20 }], truncated: false }
const findResult = await sandbox.handleRequest({ method: 'tab.find', params: { query: 'Example', owner: 's1' }, id: 1 })
check('tab.find dispatches to the page helper', findResult?.matches?.[0]?.ref === 901)
check('find resolves the owner tab', debuggerCalls.some((call) => call.method === 'attach' && call.target?.tabId === 7))

// 2) dialog default: confirm is dismissed unless accept was requested
dialogCommands.length = 0
const clickResult = await sandbox.handleRequest({ method: 'tab.click', params: { ref: 1, owner: 's1' }, id: 2 })
check('click returns the page result', clickResult?.ok === true)
check('confirm dialog defaults to dismiss', dialogCommands.at(-1)?.accept === false)
check('click carries dialog info back to the provider', clickResult?.dialogs?.[0]?.type === 'confirm')
check('debugger detaches after the action', debuggerCalls.at(-1)?.method === 'detach')

// 3) explicit accept
dialogCommands.length = 0
await sandbox.handleRequest({ method: 'tab.click', params: { ref: 1, owner: 's1', dialog: { accept: true } }, id: 3 })
check('dialog accept:true is honored', dialogCommands.at(-1)?.accept === true)

// 4) unsupported method
let unsupported = null
try {
  await sandbox.handleRequest({ method: 'tab.nope', params: {}, id: 4 })
} catch (error) {
  unsupported = error?.code
}
check('unknown method is rejected', unsupported === 'UNSUPPORTED')

console.log(failures === 0 ? '\nEXTENSION LOGIC TEST: PASS' : `\nEXTENSION LOGIC TEST: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
