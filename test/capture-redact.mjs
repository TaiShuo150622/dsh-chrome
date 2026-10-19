/**
 * capture-redact.mjs — desktop capture redaction sentinels (H1).
 *
 * The desktop extension's capture path is evaluated in a vm with a mocked
 * chrome.* surface (same approach as test/extension-logic.mjs), then fed
 * deterministic CDP Network events. Every sentinel below stands for a secret
 * that must never survive into the model-facing capture buffer:
 *
 *   - query keys: pwd / otp / cvv / auth (whole-key matching, `author` survives)
 *   - URL fragments: `#access_token=…`, `#password=…`
 *   - JSON keys and inline `key=value` inside JSON string values
 *   - form-urlencoded keys and plain-text `password=…`
 *   - headers supplied through ExtraInfo events are never captured
 *
 * The same rule set lives in src/headless-redact.js and is exercised on both
 * backends by test/capture-parity.mjs; this test keeps a deterministic
 * (Chrome-free) sentinel gate on the desktop path.
 *
 * Run: node test/capture-redact.mjs   (self-contained, no network)
 */
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

let checks = 0
let failures = 0
function check(name, condition, detail = '') {
  checks += 1
  if (condition) {
    console.log(`PASS ${name}${detail ? ` — ${detail}` : ''}`)
    return true
  }
  failures += 1
  console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  return false
}

function createExtensionHarness() {
  const source = fs.readFileSync(path.join(root, 'extension', 'background.js'), 'utf8')
  const tabs = new Map([
    [7, { id: 7, url: 'https://parity.test/', title: 'Parity', active: true, status: 'complete', windowId: 1 }],
  ])
  const debuggerCalls = []
  const eventListeners = new Set()
  const responseBodies = new Map()
  const requestBodies = new Map()
  const localStore = {
    dshSessions: { s1: { tabIds: [7], groupId: 5, activeTabId: 7, paused: false } },
  }
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
      id: 'capture-redact-extension',
      lastError: undefined,
      getManifest: () => ({ version: 'test-redact' }),
      connectNative: () => fakeNativePort,
      reload() {},
      onConnect: { addListener() {} },
      onInstalled: { addListener() {} },
      onStartup: { addListener() {} },
      onMessage: { addListener() {} },
    },
    storage: {
      session: {
        async get() {
          return {}
        },
        async set() {},
      },
      local: {
        async get(key) {
          if (key == null) return { ...localStore }
          return { [key]: localStore[key] }
        },
        async set(values) {
          Object.assign(localStore, values)
        },
      },
    },
    tabs: {
      onActivated: { addListener() {} },
      onUpdated: { addListener() {} },
      onRemoved: { addListener() {}, removeListener() {} },
      async get(tabId) {
        const tab = tabs.get(tabId)
        if (!tab) throw new Error(`no tab ${tabId}`)
        return tab
      },
      async query() {
        return [...tabs.values()]
      },
      async create({ url } = {}) {
        const tab = {
          id: 100 + tabs.size,
          url: url || 'about:blank',
          title: '',
          active: false,
          status: 'complete',
          windowId: 1,
        }
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
    },
    tabGroups: {
      async query() {
        return []
      },
      async update() {},
    },
    alarms: { create() {}, onAlarm: { addListener() {} } },
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
      async getTargets() {
        return []
      },
      async sendCommand(target, method, params = {}) {
        debuggerCalls.push({ method, target, params })
        if (method === 'Network.getResponseBody') {
          const hit = responseBodies.get(String(params?.requestId))
          if (!hit) throw new Error(`No resource with given identifier for ${params?.requestId}`)
          return hit
        }
        if (method === 'Network.getRequestPostData') {
          const hit = requestBodies.get(String(params?.requestId))
          if (!hit) throw new Error(`No post data for ${params?.requestId}`)
          return { postData: hit }
        }
        return {}
      },
      onEvent: {
        addListener(listener) {
          eventListeners.add(listener)
        },
        removeListener(listener) {
          eventListeners.delete(listener)
        },
      },
      onDetach: { addListener() {} },
    },
  }

  const sandbox = {
    chrome,
    console: { log() {}, info() {}, warn: console.warn, error: console.error, debug() {} },
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
    Map,
    Set,
    WeakMap,
    WeakSet,
    atob: (value) => Buffer.from(String(value), 'base64').toString('binary'),
    btoa: (value) => Buffer.from(String(value), 'binary').toString('base64'),
    TextDecoder,
    TextEncoder,
  }
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox, { filename: 'background.js' })

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  let sequence = 0
  const harness = {
    async request(method, params = {}) {
      sequence += 1
      return sandbox.handleRequest({ method, params: { owner: 's1', ...params }, id: `redact-${sequence}` })
    },
    emit(method, params) {
      for (const listener of eventListeners) listener({ tabId: 7 }, method, params)
    },
    setBodies(responses, posts) {
      responseBodies.clear()
      requestBodies.clear()
      for (const [requestId, body] of Object.entries(responses || {})) responseBodies.set(requestId, body)
      for (const [requestId, body] of Object.entries(posts || {})) requestBodies.set(requestId, body)
    },
    sleep,
  }
  return harness
}

const SENTINELS = [
  'SENTINEL_QUERY_PWD',
  'SENTINEL_QUERY_OTP',
  'SENTINEL_QUERY_CVV',
  'SENTINEL_QUERY_AUTH',
  'SENTINEL_FRAG_TOKEN',
  'SENTINEL_FRAG_INLINE',
  'SENTINEL_JSON_PWD',
  'SENTINEL_JSON_OTP',
  'SENTINEL_JSON_CVV',
  'SENTINEL_JSON_AUTH',
  'SENTINEL_JSON_INLINE',
  'SENTINEL_FORM_PASSWORD',
  'SENTINEL_FORM_OTP',
  'SENTINEL_PLAIN_PASSWORD',
  'SENTINEL_REQ_PWD',
  'SENTINEL_COOKIE',
  'SENTINEL_SET_COOKIE',
  'SENTINEL_AUTH_HEADER',
]

function request(id, opts = {}) {
  return [
    'Network.requestWillBeSent',
    {
      requestId: id,
      request: {
        url: opts.url ?? `https://api.test/${id}`,
        method: opts.method ?? 'GET',
        hasPostData: opts.hasPostData ?? Boolean(opts.postData),
        postData: opts.postData,
        headers: opts.headers,
      },
      type: opts.type ?? 'Fetch',
      timestamp: opts.timestamp ?? 100,
      wallTime: 1700000000.5,
      documentURL: opts.documentURL,
      frameId: 'F1',
    },
  ]
}

function response(id, opts = {}) {
  return [
    'Network.responseReceived',
    {
      requestId: id,
      response: {
        status: opts.status ?? 200,
        statusText: opts.statusText ?? 'OK',
        mimeType: opts.mimeType ?? 'text/plain',
        headers: opts.headers,
      },
      type: opts.type ?? 'Fetch',
      timestamp: opts.timestamp ?? 100.2,
    },
  ]
}

const finished = (id, timestamp = 100.25) => ['Network.loadingFinished', { requestId: id, timestamp }]

async function main() {
  const ext = createExtensionHarness()
  const started = await ext.request('tab.capture_start', { maxEntries: 50, storeBodies: true })
  check('capture starts with storeBodies=true', started?.active === true && started?.storeBodies === true, JSON.stringify(started))

  ext.setBodies(
    {
      j1: {
        body: JSON.stringify({
          user: 'u1',
          pwd: 'SENTINEL_JSON_PWD',
          otp: 'SENTINEL_JSON_OTP',
          cvv: 'SENTINEL_JSON_CVV',
          auth: 'SENTINEL_JSON_AUTH',
          author: 'alice',
          note: 'token=SENTINEL_JSON_INLINE',
        }),
        base64Encoded: false,
      },
      p1: { body: 'login password=SENTINEL_PLAIN_PASSWORD user=u1', base64Encoded: false },
    },
    {
      f1: 'password=SENTINEL_FORM_PASSWORD&otp=SENTINEL_FORM_OTP&user=u1',
      j2: JSON.stringify({ user: 'u1', pwd: 'SENTINEL_REQ_PWD' }),
    },
  )

  const events = [
    request('j1', {
      url: 'https://api.test/page?pwd=SENTINEL_QUERY_PWD&otp=SENTINEL_QUERY_OTP&cvv=SENTINEL_QUERY_CVV&auth=SENTINEL_QUERY_AUTH&q=keep#access_token=SENTINEL_FRAG_TOKEN&state=ok',
      documentURL: 'https://api.test/inbox#password=SENTINEL_FRAG_INLINE',
      type: 'XHR',
    }),
    response('j1', { mimeType: 'application/json' }),
    finished('j1'),
    request('f1', {
      url: 'https://api.test/login',
      method: 'POST',
      postData: 'password=SENTINEL_FORM_PASSWORD&otp=SENTINEL_FORM_OTP&user=u1',
      type: 'Fetch',
    }),
    response('f1', { mimeType: 'text/plain' }),
    finished('f1'),
    request('p1', { url: 'https://api.test/plain', type: 'XHR' }),
    response('p1', { mimeType: 'text/plain' }),
    finished('p1'),
    request('j2', {
      url: 'https://api.test/echo',
      method: 'POST',
      postData: JSON.stringify({ user: 'u1', pwd: 'SENTINEL_REQ_PWD' }),
      type: 'XHR',
    }),
    response('j2', { mimeType: 'application/json' }),
    finished('j2'),
    request('h1', { url: 'https://api.test/headers', type: 'Fetch' }),
    // ExtraInfo carries request/response headers. The capture path must ignore
    // them entirely (headers are never captured).
    [
      'Network.requestWillBeSentExtraInfo',
      {
        requestId: 'h1',
        headers: {
          Cookie: 'session=SENTINEL_COOKIE',
          Authorization: 'Bearer SENTINEL_AUTH_HEADER',
        },
      },
    ],
    response('h1', { mimeType: 'text/plain', headers: { 'set-cookie': 'sid=SENTINEL_SET_COOKIE' } }),
    [
      'Network.responseReceivedExtraInfo',
      { requestId: 'h1', headers: { 'set-cookie': 'sid=SENTINEL_SET_COOKIE' } },
    ],
    finished('h1'),
  ]
  for (const [method, params] of events) ext.emit(method, params)
  await ext.sleep(100)

  const result = await ext.request('tab.capture_requests', { limit: 50 })
  const serialized = JSON.stringify(result)

  check(
    'no sentinel survives into the capture buffer',
    !SENTINELS.some((sentinel) => serialized.includes(sentinel)),
    SENTINELS.filter((sentinel) => serialized.includes(sentinel)).join(',') || 'clean',
  )
  const entries = new Map((result?.entries || []).map((entry) => [entry.id, entry]))
  const j1 = entries.get('j1')
  const f1 = entries.get('f1')
  const p1 = entries.get('p1')
  const j2 = entries.get('j2')
  const h1 = entries.get('h1')

  check(
    'pwd/otp/cvv/auth query values are redacted, q survives',
    j1?.url ===
      'https://api.test/page?pwd=«redacted»&otp=«redacted»&cvv=«redacted»&auth=«redacted»&q=keep#access_token=«redacted»&state=ok',
    j1?.url,
  )
  check(
    'URL fragment secret is redacted',
    typeof j1?.documentURL === 'string' &&
      j1.documentURL.includes('#password=«redacted»') &&
      j1.documentURL.includes('/inbox'),
    j1?.documentURL,
  )
  check(
    'JSON keys and inline JSON string values are redacted, author survives',
    j1?.responseBody ===
      '{"user":"u1","pwd":"«redacted»","otp":"«redacted»","cvv":"«redacted»","auth":"«redacted»","author":"alice","note":"token=«redacted»"}',
    j1?.responseBody,
  )
  check(
    'form request body redacts password/otp',
    f1?.requestBody === 'password="«redacted»"&otp="«redacted»"&user=u1',
    f1?.requestBody,
  )
  check(
    'plain-text body redacts inline password=…',
    p1?.responseBody === 'login password=«redacted» user=u1',
    p1?.responseBody,
  )
  check(
    'request JSON fallback path redacts pwd',
    j2?.requestBody === '{"user":"u1","pwd":"«redacted»"}',
    j2?.requestBody,
  )
  check(
    'headers never reach the capture buffer',
    h1 != null &&
      !Object.keys(h1).some((key) => /cookie|authorization|headers/i.test(key)) &&
      !/SENTINEL_(COOKIE|SET_COOKIE|AUTH_HEADER)/.test(JSON.stringify(h1)),
    JSON.stringify(h1),
  )

  const stopped = await ext.request('tab.capture_stop', { captureId: started.captureId })
  check('capture stops', stopped?.active === false && stopped?.requests === 5, JSON.stringify({ active: stopped?.active, requests: stopped?.requests }))

  console.log(`\nCAPTURE REDACT: ${checks} checks, ${failures} failure(s)`)
  console.log(failures === 0 ? 'CAPTURE REDACT TEST: PASS' : `CAPTURE REDACT TEST: ${failures} FAILURE(S)`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error('CAPTURE REDACT TEST: ERROR', error)
  process.exit(1)
})
