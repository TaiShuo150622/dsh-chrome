/**
 * capture-parity.mjs — cross-backend semantic parity for `chrome_capture_*`.
 *
 * Both backends implement the same three methods and are supposed to share one
 * semantic contract:
 *
 *   tab.capture_start   -> { captureId, active, ... }
 *   tab.capture_stop    -> freezes the buffer, Network domain disabled
 *   tab.capture_requests-> entries + total/dropped/bodiesDropped/truncated
 *
 * The contract covers:
 *   - CDP lifecycle: requestWillBeSent / responseReceived / loadingFinished /
 *     loadingFailed / requestServedFromCache
 *   - resourceTypes capture filter
 *   - maxEntries + dropped accounting
 *   - URL redaction (userinfo + secret query params)
 *   - JSON / form body redaction
 *   - body budget + truncation
 *   - freeze after stop (buffer stays readable, new events ignored)
 *   - owner isolation, unknown captureId, no-capture errors
 *
 * Harnesses:
 *   extension side — extension/background.js evaluated in a vm with a mocked
 *     chrome.* (same approach as test/extension-logic.mjs). CDP events are
 *     injected through the debugger.onEvent listener so the extension code
 *     path is the real one; no Chrome needed.
 *   headless side — real HeadlessDriver (src/headless.js) against real
 *     headless Chrome. Deterministic CDP events are fed through
 *     HeadlessDriver.onNetworkEvent (the real capture code path), and a live
 *     page in a temp HTTP server verifies the full pipeline including
 *     Network.getResponseBody.
 *
 * The test PASSES when every asserted parity check holds. Known, deliberate
 * divergences are reported in a printed table (and documented in
 * docs/CAPTURE-PARITY.md) instead of failing the run, so the test can be used
 * as a living parity audit while headless gaps are fixed.
 *
 * Run: node test/capture-parity.mjs   (self-contained, no network)
 */
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

import { HeadlessDriver, headlessSupported, headlessChromeExecutable } from '../src/headless.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// Mirrors CAPTURE_BODY_TOTAL_LIMIT in both implementations; seeded to force the
// budget-exceeded branch without transferring 8 MiB of body text.
const CAPTURE_BODY_TOTAL_LIMIT = 8 * 1024 * 1024

// ---------------------------------------------------------------- reporting
let checks = 0
let failures = 0
const divergences = []

function summarize(value) {
  if (value === undefined) return '—'
  if (typeof value === 'string') return value.length > 90 ? `${value.slice(0, 90)}…` : value
  try {
    const json = JSON.stringify(value)
    return json.length > 90 ? `${json.slice(0, 90)}…` : json
  } catch {
    return String(value)
  }
}

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

function recordDiff(area, extensionValue, headlessValue, status = 'DIVERGENT', note = '') {
  divergences.push({ area, extension: summarize(extensionValue), headless: summarize(headlessValue), status, note })
  console.log(
    `DIFF ${area} — extension=${summarize(extensionValue)} | headless=${summarize(headlessValue)}` +
      `${status === 'DIVERGENT' ? '' : ` [${status}]`}${note ? ` (${note})` : ''}`,
  )
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(probe, { timeoutMs = 8000, intervalMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    last = await probe()
    if (last) return last
    await sleep(intervalMs)
  }
  return last
}

const entriesById = (result) => new Map((result?.entries || []).map((entry) => [entry.id, entry]))

const pick = (entry, fields) => {
  const out = {}
  for (const field of fields) out[field] = entry?.[field] ?? null
  return out
}

// -------------------------------------------------------- shared CDP events
const CDP = {
  request(id, opts = {}) {
    const request = {
      url: opts.url ?? `https://api.test/${id}`,
      method: opts.method ?? 'GET',
      hasPostData: opts.hasPostData ?? Boolean(opts.postData),
      postData: opts.postData,
    }
    return [
      'Network.requestWillBeSent',
      {
        requestId: id,
        request,
        type: opts.type ?? 'Fetch',
        timestamp: opts.timestamp ?? 100,
        wallTime: opts.wallTime ?? 1700000000.5,
        documentURL: opts.documentURL,
        frameId: 'F1',
      },
    ]
  },
  response(id, opts = {}) {
    const response = {
      status: opts.status ?? 200,
      statusText: opts.statusText ?? 'OK',
      mimeType: opts.mimeType ?? 'text/plain',
      fromDiskCache: opts.fromDiskCache,
      fromMemoryCache: opts.fromMemoryCache,
      fromPrefetchCache: opts.fromPrefetchCache,
      fromServiceWorker: opts.fromServiceWorker,
      encodedDataLength: opts.encodedDataLength ?? 123,
    }
    return [
      'Network.responseReceived',
      { requestId: id, response, type: opts.type ?? 'Fetch', timestamp: opts.timestamp ?? 100.2 },
    ]
  },
  finished(id, timestamp = 100.25) {
    return ['Network.loadingFinished', { requestId: id, timestamp, encodedDataLength: 456 }]
  },
  failed(id, opts = {}) {
    return [
      'Network.loadingFailed',
      {
        requestId: id,
        errorText: opts.errorText ?? 'net::ERR_FAILED',
        canceled: opts.canceled ?? false,
        timestamp: opts.timestamp ?? 101,
      },
    ]
  },
  servedFromCache(id) {
    return ['Network.requestServedFromCache', { requestId: id }]
  },
}

// ================================================================= extension
// extension/background.js inside a vm with a mocked chrome.* surface. Only the
// APIs the worker touches at startup and for capture are mocked.
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
      id: 'capture-parity-extension',
      lastError: undefined,
      getManifest: () => ({ version: 'test-parity' }),
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

  const captures = () => vm.runInContext('captures', sandbox)
  let sequence = 0
  let activeCaptureId = null

  const harness = {
    label: 'extension',
    sandbox,
    debuggerCalls,
    captures,
    capture: (captureId) => captures().get(captureId),
    async request(method, params = {}) {
      sequence += 1
      return sandbox.handleRequest({ method, params: { owner: 's1', ...params }, id: `parity-${sequence}` })
    },
    async errorOf(method, params = {}) {
      try {
        await harness.request(method, params)
        return null
      } catch (error) {
        return { code: String(error?.code || ''), message: String(error?.message || error) }
      }
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
    async startCapture(params = {}) {
      const result = await harness.request('tab.capture_start', params)
      activeCaptureId = result.captureId
      return result
    },
    async stopCapture(params = {}) {
      const captureId = params.captureId ?? activeCaptureId
      const result = await harness.request('tab.capture_stop', { captureId })
      if (captureId === activeCaptureId) activeCaptureId = null
      return result
    },
    async stopActiveSilently() {
      if (!activeCaptureId) return
      try {
        await harness.request('tab.capture_stop', { captureId: activeCaptureId })
      } catch {
        // already gone
      }
      activeCaptureId = null
    },
  }
  return harness
}

// ================================================================== headless
// Real HeadlessDriver. Deterministic capture tests feed CDP events into
// onNetworkEvent; response bodies are served from a per-scenario map so the
// real materialize/redact code runs without a real network round-trip.
function createHeadlessHarness(driver, owner) {
  const bodyStore = new Map()
  const originalSend = driver.cdp.send.bind(driver.cdp)
  driver.cdp.send = async (method, params = {}, sessionId) => {
    if (method === 'Network.getResponseBody') {
      const hit = bodyStore.get(String(params?.requestId))
      if (hit) return hit
    }
    if (method === 'Network.getRequestPostData') {
      const hit = bodyStore.get(`post:${params?.requestId}`)
      if (hit) return { postData: hit }
    }
    return originalSend(method, params, sessionId)
  }

  let sequence = 0
  let activeCaptureId = null
  const harness = {
    label: 'headless',
    driver,
    owner,
    captures: driver.captures,
    capture: (captureId) => driver.captures.get(captureId),
    async request(method, params = {}) {
      sequence += 1
      return driver.request(method, { owner, ...params })
    },
    async errorOf(method, params = {}) {
      try {
        await harness.request(method, params)
        return null
      } catch (error) {
        return { code: String(error?.code || ''), message: String(error?.message || error) }
      }
    },
    emit(method, params) {
      // The tab exists as soon as the first capture_start runs.
      driver.onNetworkEvent(harness.tab, method, params)
    },
    setBodies(responses, posts) {
      bodyStore.clear()
      for (const [requestId, body] of Object.entries(responses || {})) bodyStore.set(requestId, body)
      for (const [requestId, body] of Object.entries(posts || {})) bodyStore.set(`post:${requestId}`, body)
    },
    async startCapture(params = {}) {
      const result = await harness.request('tab.capture_start', params)
      harness.tab = await driver.ensureTab(owner)
      activeCaptureId = result.captureId
      return result
    },
    async stopCapture(params = {}) {
      const captureId = params.captureId ?? activeCaptureId
      const result = await harness.request('tab.capture_stop', { captureId })
      if (captureId === activeCaptureId) activeCaptureId = null
      return result
    },
    async stopActiveSilently() {
      if (!activeCaptureId) return
      try {
        await harness.request('tab.capture_stop', { captureId: activeCaptureId })
      } catch {
        // already gone
      }
      activeCaptureId = null
    },
    restore() {
      driver.cdp.send = originalSend
    },
  }
  return harness
}

// Run the same capture scenario on both backends. Events are fed in the same
// order; bodies come from the same maps.
async function runSyntheticScenario(ext, head, scenario) {
  const { capture = {}, events = [], responseBodies = {}, requestBodies = {}, seedBodyBytes = null } = scenario
  // These scenarios assert body redaction/budget; the production default is
  // metadata-only (storeBodies:false, H1/M3). Opt in explicitly so the parity
  // contract is compared on the body path; the default is covered by
  // test/extension-logic.mjs.
  const captureParams = capture.storeBodies === undefined ? { ...capture, storeBodies: true } : capture
  await ext.stopActiveSilently()
  await head.stopActiveSilently()
  const extStart = await ext.startCapture(captureParams)
  const headStart = await head.startCapture(captureParams)
  ext.setBodies(responseBodies, requestBodies)
  head.setBodies(responseBodies, requestBodies)
  if (Number.isFinite(seedBodyBytes)) {
    ext.capture(extStart.captureId).bodyBytes = seedBodyBytes
    head.capture(headStart.captureId).bodyBytes = seedBodyBytes
  }
  for (const [method, params] of events) {
    ext.emit(method, params)
    head.emit(method, params)
  }
  await sleep(80)
  const extResult = await ext.request('tab.capture_requests', { captureId: extStart.captureId, limit: 200 })
  const headResult = await head.request('tab.capture_requests', { captureId: headStart.captureId, limit: 200 })
  return { name: scenario.name, extStart, headStart, extResult, headResult }
}

// ==================================================================== report
function printDivergenceTable() {
  console.log('\n=== DIVERGENCE TABLE (extension vs headless) ===')
  console.log('| # | 项目 | 扩展侧 | headless 侧 | 状态 |')
  console.log('|---|------|--------|-------------|------|')
  divergences.forEach((row, index) => {
    console.log(
      `| ${index + 1} | ${row.area} | ${String(row.extension).replace(/\|/g, '\\|')} | ${String(row.headless).replace(/\|/g, '\\|')} | ${row.status} |`,
    )
  })
  console.log(`\n${divergences.length} divergence(s) recorded (documented in docs/CAPTURE-PARITY.md; not fatal).`)
}

// ====================================================================== main
async function main() {
  const extension = createExtensionHarness()
  check('extension: background.js evaluates with mocked chrome', typeof extension.sandbox.handleRequest === 'function')

  if (!headlessSupported()) {
    console.log('CAPTURE PARITY TEST: SKIP (no Chrome/Chromium found; set DSH_HEADLESS_CHROME)')
    process.exit(0)
  }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-capture-parity-'))
  const driver = new HeadlessDriver({ home })
  const server = createLiveServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  let headless = null
  try {
    await driver.ensureStarted()
    console.log(`headless Chrome: ${driver.browserVersion || 'unknown'} (${headlessChromeExecutable()})`)
    headless = createHeadlessHarness(driver, 'parity')
    await runParityChecks(extension, headless)
    await runLiveHeadlessChecks(headless)
  } finally {
    headless?.restore()
    await driver.close().catch(() => {})
    server.close()
    await sleep(300)
    try {
      fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    } catch {
      // temp profile; leaking it on cleanup is harmless
    }
  }

  printDivergenceTable()
  console.log(
    `\nCAPTURE PARITY: ${checks} checks, ${failures} failure(s), ${divergences.length} documented divergence(s)`,
  )
  console.log(failures === 0 ? 'CAPTURE PARITY TEST: PASS' : `CAPTURE PARITY TEST: ${failures} FAILURE(S)`)
  process.exit(failures === 0 ? 0 : 1)
}

// ---------------------------------------------------------- parity checks
async function runParityChecks(ext, head) {
  // ------------------------------------------------------------------ S1
  // Lifecycle: request -> response -> finished, failure, cache, and the
  // start/stop response shape.
  console.log('\n--- capture lifecycle (synthetic CDP events, same on both) ---')
  const lifecycleStartExt = await ext.startCapture({ maxEntries: 50, storeBodies: true })
  const lifecycleStart = await head.startCapture({ maxEntries: 50, storeBodies: true })
  check(
    'capture_start returns a capture id and active=true on both',
    typeof lifecycleStartExt.captureId === 'string' &&
      lifecycleStartExt.active === true &&
      typeof lifecycleStart.captureId === 'string' &&
      lifecycleStart.active === true,
    `ext=${lifecycleStartExt.captureId} head=${lifecycleStart.captureId}`,
  )
  check(
    'capture_start maxEntries is echoed by both',
    lifecycleStartExt.maxEntries === 50 && lifecycleStart.maxEntries === 50,
    `ext=${lifecycleStartExt.maxEntries} head=${lifecycleStart.maxEntries}`,
  )
  recordDiff(
    'capture_start 响应字段',
    Object.keys(lifecycleStartExt).sort().join(','),
    Object.keys(lifecycleStart).sort().join(','),
    'DIVERGENT（待 Lead 修）',
    'headless 缺 startedAt / resourceTypes',
  )

  const againExt = await ext.startCapture({ maxEntries: 50 })
  const againHead = await head.startCapture({ maxEntries: 50 })
  check(
    'second capture_start reports alreadyActive on both',
    againExt.alreadyActive === true && againHead.alreadyActive === true,
    `ext=${JSON.stringify({ alreadyActive: againExt.alreadyActive, active: againExt.active })} head=${JSON.stringify({ alreadyActive: againHead.alreadyActive, active: againHead.active })}`,
  )
  recordDiff(
    'capture_start alreadyActive 响应字段',
    Object.keys(againExt).sort().join(','),
    Object.keys(againHead).sort().join(','),
    'DIVERGENT（待 Lead 修）',
    'headless 缺 startedAt / requests',
  )

  ext.setBodies(
    {
      l1: { body: 'hello parity', base64Encoded: false },
      l3: { body: '{"ok":true,"token":"CACHE_TOKEN"}', base64Encoded: false },
    },
    {},
  )
  head.setBodies(
    {
      l1: { body: 'hello parity', base64Encoded: false },
      l3: { body: '{"ok":true,"token":"CACHE_TOKEN"}', base64Encoded: false },
    },
    {},
  )
  const lifecycleEvents = [
    CDP.request('l1', { url: 'https://api.test/one', type: 'Fetch', documentURL: 'https://api.test/' }),
    CDP.response('l1', { type: 'Fetch' }),
    CDP.finished('l1'),
    CDP.request('l2', { url: 'https://api.test/fail', type: 'Fetch' }),
    CDP.failed('l2', { errorText: 'net::ERR_FAILED' }),
    CDP.request('l3', { url: 'https://api.test/cache', type: 'Fetch' }),
    CDP.servedFromCache('l3'),
    CDP.response('l3', { type: 'Fetch', mimeType: 'application/json', fromDiskCache: true }),
    CDP.finished('l3'),
    CDP.request('l4', { url: 'https://api.test/created', type: 'XHR' }),
    CDP.response('l4', { type: 'XHR', status: 201, statusText: 'Created', mimeType: 'application/json' }),
  ]
  for (const [method, params] of lifecycleEvents) {
    ext.emit(method, params)
    head.emit(method, params)
  }
  await sleep(80)
  const lifecycleExt = await ext.request('tab.capture_requests', {
    captureId: lifecycleStartExt.captureId,
    limit: 200,
  })
  const lifecycle = await head.request('tab.capture_requests', { captureId: lifecycleStart.captureId, limit: 200 })
  const extById = entriesById(lifecycleExt)
  const headById = entriesById(lifecycle)

  check(
    'both backends expose available=true and lost=false',
    lifecycleExt.available === true &&
      lifecycleExt.lost === false &&
      lifecycle.available === true &&
      lifecycle.lost === false,
    JSON.stringify({ ext: pick(lifecycleExt, ['available', 'lost']), head: pick(lifecycle, ['available', 'lost']) }),
  )
  for (const id of ['l1', 'l2', 'l3', 'l4']) {
    check(
      `both capture lifecycle request ${id}`,
      extById.has(id) && headById.has(id),
      `ext=${extById.has(id)} head=${headById.has(id)}`,
    )
  }
  const parityFields = ['id', 'method', 'url', 'resourceType', 'status', 'mimeType']
  const sharedEntryParity = ['l1', 'l2', 'l3', 'l4'].every((id) => {
    const a = pick(extById.get(id), parityFields)
    const b = pick(headById.get(id), parityFields)
    return JSON.stringify(a) === JSON.stringify(b)
  })
  check(
    'shared entry fields agree (id/method/url/resourceType/status/mimeType)',
    sharedEntryParity,
    JSON.stringify(
      ['l1', 'l2', 'l3', 'l4'].map((id) => ({
        id,
        ext: pick(extById.get(id), parityFields),
        head: pick(headById.get(id), parityFields),
      })),
    ).slice(0, 300),
  )
  check(
    'loadingFinished duration is the same monotonic delta on both',
    extById.get('l1')?.durationMs === 250 && headById.get('l1')?.durationMs === 250,
    `ext=${extById.get('l1')?.durationMs} head=${headById.get('l1')?.durationMs}`,
  )
  check(
    'loadingFailed sets failed=true / errorText on both',
    extById.get('l2')?.failed === true &&
      extById.get('l2')?.errorText === 'net::ERR_FAILED' &&
      headById.get('l2')?.failed === true &&
      headById.get('l2')?.errorText === 'net::ERR_FAILED',
    JSON.stringify({ ext: pick(extById.get('l2'), ['failed', 'errorText']), head: pick(headById.get('l2'), ['failed', 'errorText']) }),
  )
  check(
    'requestServedFromCache+fromDiskCache sets fromCache on both',
    extById.get('l3')?.fromCache === true && headById.get('l3')?.fromCache === true,
    `ext=${extById.get('l3')?.fromCache} head=${headById.get('l3')?.fromCache}`,
  )
  check(
    'response body is captured and equal on both',
    extById.get('l1')?.responseBody === 'hello parity' &&
      headById.get('l1')?.responseBody === 'hello parity' &&
      extById.get('l1')?.bodyTruncated === false &&
      headById.get('l1')?.bodyTruncated === false,
    JSON.stringify({ ext: pick(extById.get('l1'), ['responseBody', 'bodyTruncated']), head: pick(headById.get('l1'), ['responseBody', 'bodyTruncated']) }),
  )
  check(
    'response cache body is JSON-redacted on both',
    extById.get('l3')?.responseBody === '{"ok":true,"token":"«redacted»"}' &&
      headById.get('l3')?.responseBody === '{"ok":true,"token":"«redacted»"}',
    JSON.stringify({ ext: extById.get('l3')?.responseBody, head: headById.get('l3')?.responseBody }),
  )
  check(
    'no header-shaped fields leak in either buffer',
    !/cookie|authorization|set-cookie/i.test(JSON.stringify(lifecycleExt)) &&
      !/cookie|authorization|set-cookie/i.test(JSON.stringify(lifecycle)),
  )
  const extOnly = Object.keys(extById.get('l1') || {}).filter((key) => !(key in (headById.get('l1') || {})))
  const headOnly = Object.keys(headById.get('l1') || {}).filter((key) => !(key in (extById.get('l1') || {})))
  recordDiff(
    'entry 字段集合',
    `扩展独有: ${extOnly.sort().join(',') || '—'}`,
    `headless 独有: ${headOnly.sort().join(',') || '—'}`,
    'DIVERGENT（待 Lead 修）',
    'headless 缺 statusText/startTime/timestamp/wallTime/documentURL/finishedAt/responseAt/fromServiceWorker/encodedDataLength/canceled；用 startTimestamp 命名',
  )

  const extStop = await ext.stopCapture({ captureId: lifecycleStartExt.captureId })
  const headStop = await head.stopCapture({ captureId: lifecycleStart.captureId })
  check(
    'capture_stop reports active=false and the frozen request count on both',
    extStop.active === false &&
      extStop.requests === 4 &&
      headStop.active === false &&
      headStop.requests === 4,
    JSON.stringify({ ext: pick(extStop, ['active', 'requests', 'endedReason']), head: pick(headStop, ['active', 'requests', 'endedReason']) }),
  )
  check(
    'capture_stop records endedReason=stopped on both',
    extStop.endedReason === 'stopped' && headStop.endedReason === 'stopped',
    `ext=${extStop.endedReason} head=${headStop.endedReason}`,
  )
  recordDiff(
    'capture_stop 响应字段',
    Object.keys(extStop).sort().join(','),
    Object.keys(headStop).sort().join(','),
    'DIVERGENT（待 Lead 修）',
    'headless 缺 tabId / startedAt / endedAt / bodiesDropped',
  )

  // ------------------------------------------------------------------ S2
  // URL redaction: userinfo + secret query params. Synthetic events are the
  // same payloads the extension receives from Chrome.
  console.log('\n--- URL redaction ---')
  const urlScenario = await runSyntheticScenario(ext, head, {
    name: 'url-redaction',
    capture: { maxEntries: 50 },
    events: [
      CDP.request('u1', {
        url: 'https://api.test/secure?token=SECRET&q=1&api_key=K1',
        documentURL: 'https://api.test/page?access_token=DOC_SECRET',
      }),
      CDP.request('u2', { url: 'https://user:pass@api.test/secure?token=SECRET&q=1' }),
    ],
  })
  const urlExt = entriesById(urlScenario.extResult)
  const urlHead = entriesById(urlScenario.headResult)
  const urlOne = 'https://api.test/secure?token=«redacted»&q=1&api_key=«redacted»'
  const urlTwo = 'https://«redacted»:«redacted»@api.test/secure?token=«redacted»&q=1'
  check(
    'secret query values are redacted identically on both',
    urlExt.get('u1')?.url === urlOne && urlHead.get('u1')?.url === urlOne,
    JSON.stringify({ ext: urlExt.get('u1')?.url, head: urlHead.get('u1')?.url }),
  )
  check(
    'URL userinfo is redacted identically on both',
    urlExt.get('u2')?.url === urlTwo && urlHead.get('u2')?.url === urlTwo,
    JSON.stringify({ ext: urlExt.get('u2')?.url, head: urlHead.get('u2')?.url }),
  )
  check(
    'raw secrets never appear in either capture buffer',
    !JSON.stringify(urlScenario.extResult).includes('SECRET') &&
      !JSON.stringify(urlScenario.headResult).includes('SECRET') &&
      !JSON.stringify(urlScenario.extResult).includes('user:pass') &&
      !JSON.stringify(urlScenario.headResult).includes('user:pass'),
  )
  check(
    'extension redacts documentURL; headless may omit it (documented divergence, fix tolerated)',
    typeof urlExt.get('u1')?.documentURL === 'string' &&
      urlExt.get('u1').documentURL.includes('«redacted»') &&
      (urlHead.get('u1')?.documentURL === undefined ||
        (typeof urlHead.get('u1')?.documentURL === 'string' && urlHead.get('u1').documentURL.includes('«redacted»'))),
  )
  recordDiff(
    'documentURL 字段',
    '记录并脱敏（documentURL）',
    '不记录 documentURL',
    'DIVERGENT（待 Lead 修）',
    'headless 条目缺少发起页面 URL',
  )

  // ------------------------------------------------------------------ S3
  // Body redaction for JSON + form-urlencoded request/response bodies.
  console.log('\n--- body redaction (JSON / form) ---')
  const bodyScenario = await runSyntheticScenario(ext, head, {
    name: 'body-redaction',
    capture: { maxEntries: 50 },
    responseBodies: {
      j1: {
        body: '{"ok":true,"user":"u1","token":"RESP_TOKEN","nested":{"apiKey":"RESP_NESTED"}}',
        base64Encoded: false,
      },
      f1: { body: 'status=ok&token=RESP_FORM_TOKEN', base64Encoded: false },
    },
    requestBodies: {},
    events: [
      CDP.request('j1', {
        method: 'POST',
        postData: '{"user":"u1","token":"TOKEN_JSON","nested":{"apiKey":"TOKEN_NESTED"}}',
        timestamp: 200,
      }),
      CDP.response('j1', { mimeType: 'application/json', timestamp: 200.1 }),
      CDP.finished('j1', 200.25),
      CDP.request('f1', {
        method: 'POST',
        postData: 'token=TOKEN_FORM&user=u1',
        timestamp: 201,
      }),
      CDP.response('f1', { mimeType: 'application/x-www-form-urlencoded', timestamp: 201.1 }),
      CDP.finished('f1', 201.25),
    ],
  })
  const bodyExt = entriesById(bodyScenario.extResult)
  const bodyHead = entriesById(bodyScenario.headResult)
  const expectedJsonRequest = '{"user":"u1","token":"«redacted»","nested":{"apiKey":"«redacted»"}}'
  const expectedJsonResponse = '{"ok":true,"user":"u1","token":"«redacted»","nested":{"apiKey":"«redacted»"}}'
  check(
    'JSON request body is redacted identically on both',
    bodyExt.get('j1')?.requestBody === expectedJsonRequest && bodyHead.get('j1')?.requestBody === expectedJsonRequest,
    JSON.stringify({ ext: bodyExt.get('j1')?.requestBody, head: bodyHead.get('j1')?.requestBody }),
  )
  check(
    'JSON response body is redacted identically on both',
    bodyExt.get('j1')?.responseBody === expectedJsonResponse && bodyHead.get('j1')?.responseBody === expectedJsonResponse,
    JSON.stringify({ ext: bodyExt.get('j1')?.responseBody, head: bodyHead.get('j1')?.responseBody }),
  )
  check(
    'form request body is redacted identically on both',
    bodyExt.get('f1')?.requestBody === 'token="«redacted»"&user=u1' &&
      bodyHead.get('f1')?.requestBody === 'token="«redacted»"&user=u1',
    JSON.stringify({ ext: bodyExt.get('f1')?.requestBody, head: bodyHead.get('f1')?.requestBody }),
  )
  check(
    'form response body is redacted identically on both',
    bodyExt.get('f1')?.responseBody === 'status=ok&token="«redacted»"' &&
      bodyHead.get('f1')?.responseBody === 'status=ok&token="«redacted»"',
    JSON.stringify({ ext: bodyExt.get('f1')?.responseBody, head: bodyHead.get('f1')?.responseBody }),
  )
  check(
    'both mark redacted=true and no raw token survives',
    bodyExt.get('j1')?.redacted === true &&
      bodyHead.get('j1')?.redacted === true &&
      !JSON.stringify(bodyScenario.extResult).match(/TOKEN_JSON|RESP_TOKEN|TOKEN_NESTED|TOKEN_FORM|RESP_FORM_TOKEN/) &&
      !JSON.stringify(bodyScenario.headResult).match(/TOKEN_JSON|RESP_TOKEN|TOKEN_NESTED|TOKEN_FORM|RESP_FORM_TOKEN/),
  )

  // includeBodies:false is part of the same buffer; both must strip bodies.
  const extNoBodies = await ext.request('tab.capture_requests', {
    captureId: bodyScenario.extStart.captureId,
    includeBodies: false,
  })
  const headNoBodies = await head.request('tab.capture_requests', {
    captureId: bodyScenario.headStart.captureId,
    includeBodies: false,
  })
  const noBodiesExt = entriesById(extNoBodies)
  const noBodiesHead = entriesById(headNoBodies)
  check(
    'includeBodies=false strips request/response bodies on both',
    !('requestBody' in (noBodiesExt.get('j1') || {})) &&
      !('responseBody' in (noBodiesExt.get('j1') || {})) &&
      !('requestBody' in (noBodiesHead.get('j1') || {})) &&
      !('responseBody' in (noBodiesHead.get('j1') || {})),
    JSON.stringify({ ext: Object.keys(noBodiesExt.get('j1') || {}), head: Object.keys(noBodiesHead.get('j1') || {}) }),
  )

  // ------------------------------------------------------------------ S4
  // Body truncation: capture-time 4096-char cap (parity) and request-time
  // maxBodyChars (divergence).
  console.log('\n--- body truncation ---')
  const bigBody = 'A'.repeat(6000)
  const truncScenario = await runSyntheticScenario(ext, head, {
    name: 'body-truncation',
    capture: { maxEntries: 50 },
    responseBodies: { t1: { body: bigBody, base64Encoded: false } },
    events: [
      CDP.request('t1', { url: 'https://api.test/large', timestamp: 300 }),
      CDP.response('t1', { mimeType: 'text/plain', timestamp: 300.1 }),
      CDP.finished('t1', 300.25),
    ],
  })
  const truncRawExt = await ext.request('tab.capture_requests', {
    captureId: truncScenario.extStart.captureId,
    maxBodyChars: 65536,
  })
  const truncRawHead = await head.request('tab.capture_requests', {
    captureId: truncScenario.headStart.captureId,
    maxBodyChars: 65536,
  })
  const truncExt = entriesById(truncRawExt).get('t1')
  const truncHead = entriesById(truncRawHead).get('t1')
  check(
    'capture-time body truncation is identical on both',
    truncExt?.bodyTruncated === true &&
      truncHead?.bodyTruncated === true &&
      truncExt?.responseBody === truncHead?.responseBody &&
      typeof truncExt?.responseBody === 'string' &&
      truncExt.responseBody.endsWith('… <truncated>') &&
      truncExt.responseBody.startsWith('A'.repeat(64)),
    JSON.stringify({ ext: summarize(truncExt?.responseBody), head: summarize(truncHead?.responseBody) }),
  )
  const extShort = await ext.request('tab.capture_requests', {
    captureId: truncScenario.extStart.captureId,
    maxBodyChars: 64,
  })
  const headShort = await head.request('tab.capture_requests', {
    captureId: truncScenario.headStart.captureId,
    maxBodyChars: 64,
  })
  const shortExt = entriesById(extShort).get('t1')
  const shortHead = entriesById(headShort).get('t1')
  check(
    'maxBodyChars shortens the returned body on both',
    typeof shortExt?.responseBody === 'string' &&
      shortExt.responseBody.length > 64 &&
      shortExt.responseBody.endsWith('… <truncated>') &&
      typeof shortHead?.responseBody === 'string' &&
      (shortHead.responseBody.length === 64 ||
        (shortHead.responseBody.length > 64 && shortHead.responseBody.endsWith('… <truncated>'))),
    JSON.stringify({ ext: summarize(shortExt?.responseBody), head: summarize(shortHead?.responseBody) }),
  )
  recordDiff(
    'capture_requests maxBodyChars 截断语义',
    '短于上限时追加 "… <truncated>" 并置 copy.bodyTruncated=true',
    '直接 slice(0,maxBodyChars)，无标记、无 bodyTruncated',
    'DIVERGENT（待 Lead 修）',
    'headless 返回的 body 缺截断标记',
  )

  // ------------------------------------------------------------------ S5
  // Body total budget: exhausted budget must produce the same placeholder.
  console.log('\n--- body budget ---')
  const budgetScenario = await runSyntheticScenario(ext, head, {
    name: 'body-budget',
    capture: { maxEntries: 50 },
    seedBodyBytes: CAPTURE_BODY_TOTAL_LIMIT,
    responseBodies: { b1: { body: 'still here', base64Encoded: false } },
    events: [
      CDP.request('b1', { url: 'https://api.test/budget', timestamp: 400 }),
      CDP.response('b1', { mimeType: 'text/plain', timestamp: 400.1 }),
      CDP.finished('b1', 400.25),
    ],
  })
  const budgetExt = entriesById(budgetScenario.extResult).get('b1')
  const budgetHead = entriesById(budgetScenario.headResult).get('b1')
  check(
    'exhausted body budget yields the same placeholder and bodiesDropped=1 on both',
    budgetExt?.responseBody === '<body not captured: capture body budget exceeded>' &&
      budgetHead?.responseBody === '<body not captured: capture body budget exceeded>' &&
      budgetScenario.extResult.bodiesDropped === 1 &&
      budgetScenario.headResult.bodiesDropped === 1,
    JSON.stringify({
      ext: pick(budgetExt, ['responseBody']),
      head: pick(budgetHead, ['responseBody']),
      extDropped: budgetScenario.extResult.bodiesDropped,
      headDropped: budgetScenario.headResult.bodiesDropped,
    }),
  )

  // ------------------------------------------------------------------ S6
  // maxEntries overflow: both cap the buffer and count drops; eviction
  // direction differs.
  console.log('\n--- maxEntries / dropped ---')
  const capScenario = await runSyntheticScenario(ext, head, {
    capture: { maxEntries: 2 },
    events: [
      CDP.request('m1', { url: 'https://api.test/m1', timestamp: 500 }),
      CDP.request('m2', { url: 'https://api.test/m2', timestamp: 501 }),
      CDP.request('m3', { url: 'https://api.test/m3', timestamp: 502 }),
    ],
  })
  const capExtIds = (capScenario.extResult.entries || []).map((entry) => entry.id)
  const capHeadIds = (capScenario.headResult.entries || []).map((entry) => entry.id)
  check(
    'both enforce maxEntries=2 and count one drop',
    capExtIds.length === 2 &&
      capHeadIds.length === 2 &&
      capScenario.extResult.dropped === 1 &&
      capScenario.headResult.dropped === 1,
    JSON.stringify({ ext: capExtIds, head: capHeadIds }),
  )
  check('extension eviction keeps the newest entries', capExtIds.join(',') === 'm2,m3', capExtIds.join(','))
  check(
    'headless eviction matches the documented state (old: m1,m2; fixed: m2,m3)',
    ['m1,m2', 'm2,m3'].includes(capHeadIds.join(',')),
    capHeadIds.join(','),
  )
  recordDiff(
    'maxEntries 溢出淘汰方向',
    `保留最新（${capExtIds.join(',')}）`,
    `丢弃最新、保留最早（${capHeadIds.join(',')}）`,
    'DIVERGENT（待 Lead 修）',
    'headless 在页面加载高峰会持续丢弃新请求',
  )

  // ------------------------------------------------------------------ S7
  // capture_requests pagination / filter / resourceTypes filter semantics.
  console.log('\n--- capture_requests pagination / filters ---')
  const pageScenario = await runSyntheticScenario(ext, head, {
    capture: { maxEntries: 10 },
    events: [
      CDP.request('p1', { url: 'https://api.test/one', timestamp: 600 }),
      CDP.request('p2', { url: 'https://api.test/two', timestamp: 601 }),
      CDP.request('p3', { url: 'https://api.test/three', timestamp: 602 }),
    ],
  })
  const extPage = await ext.request('tab.capture_requests', { captureId: pageScenario.extStart.captureId, limit: 2 })
  const headPage = await head.request('tab.capture_requests', { captureId: pageScenario.headStart.captureId, limit: 2 })
  const extPageIds = (extPage.entries || []).map((entry) => entry.id)
  const headPageIds = (headPage.entries || []).map((entry) => entry.id)
  check(
    'limit=2 returns two entries and truncated=true on both',
    extPageIds.length === 2 && headPageIds.length === 2 && extPage.truncated === true && headPage.truncated === true,
    JSON.stringify({ ext: extPageIds, head: headPageIds }),
  )
  check('total counts all captured entries on both', extPage.total === 3 && headPage.total === 3, `ext=${extPage.total} head=${headPage.total}`)
  recordDiff(
    'capture_requests limit 取哪一端',
    `返回最新 ${extPageIds.join(',')}`,
    `返回最早 ${headPageIds.join(',')}`,
    'DIVERGENT（待 Lead 修）',
    '同一 limit 下两个后端返回不同时间段的条目',
  )

  const extFilter = await ext.request('tab.capture_requests', {
    captureId: pageScenario.extStart.captureId,
    limit: 2,
    filter: 'two',
  })
  const headFilter = await head.request('tab.capture_requests', {
    captureId: pageScenario.headStart.captureId,
    limit: 2,
    filter: 'two',
  })
  check(
    'filter=two returns the matching entry on both',
    (extFilter.entries || []).map((entry) => entry.id).join(',') === 'p2' &&
      (headFilter.entries || []).map((entry) => entry.id).join(',') === 'p2',
    JSON.stringify({ ext: (extFilter.entries || []).map((entry) => entry.id), head: (headFilter.entries || []).map((entry) => entry.id) }),
  )
  recordDiff(
    'capture_requests total/truncated 与 filter 的关系',
    `total=${extFilter.total} truncated=${extFilter.truncated}（按过滤后计数）`,
    `total=${headFilter.total} truncated=${headFilter.truncated}（按全部条目计数）`,
    'DIVERGENT（待 Lead 修）',
  )

  const extUpperTypes = await ext.request('tab.capture_requests', {
    captureId: pageScenario.extStart.captureId,
    resourceTypes: ['Fetch'],
  })
  const headUpperTypes = await head.request('tab.capture_requests', {
    captureId: pageScenario.headStart.captureId,
    resourceTypes: ['Fetch'],
  })
  check(
    'headless capture_requests resourceTypes filter normalizes case to lowercase',
    (headUpperTypes.entries || []).length === 3,
    JSON.stringify({ ext: (extUpperTypes.entries || []).length, head: (headUpperTypes.entries || []).length }),
  )
  check(
    'extension capture_requests resourceTypes filter is case-sensitive today (documented divergence, fix tolerated)',
    [0, 3].includes((extUpperTypes.entries || []).length),
    JSON.stringify((extUpperTypes.entries || []).map((entry) => entry.id)),
  )
  recordDiff(
    'capture_requests resourceTypes 过滤大小写',
    "区分大小写：['Fetch'] 匹配 0 条",
    "统一小写：['Fetch'] 匹配全部 fetch",
    'DIVERGENT（偏好 headless 语义）',
    '扩展侧调用方需传小写 type',
  )

  // ------------------------------------------------------------------ S8
  // Capture-time resourceTypes filter: extension filters, headless stores the
  // option but never applies it.
  console.log('\n--- capture-time resourceTypes filter ---')
  const typeScenario = await runSyntheticScenario(ext, head, {
    capture: { maxEntries: 50 },
    events: [
      CDP.request('if1', { type: 'Fetch', timestamp: 700 }),
      CDP.request('ii1', { type: 'Image', url: 'https://api.test/pixel.png', timestamp: 701 }),
      CDP.request('id1', { type: 'Document', url: 'https://api.test/doc', timestamp: 702 }),
      CDP.request('io1', { type: 'Other', url: 'https://api.test/font.woff2', timestamp: 703 }),
    ],
  })
  const typeExtIds = (typeScenario.extResult.entries || []).map((entry) => entry.id).sort().join(',')
  const typeHeadIds = (typeScenario.headResult.entries || []).map((entry) => entry.id).sort().join(',')
  check(
    'extension applies the default resourceTypes filter (xhr/fetch/document)',
    typeExtIds === 'id1,if1',
    `ext=${typeExtIds}`,
  )
  check(
    'headless capture-time filter matches the documented state (old: all types; fixed: default types)',
    ['id1,if1,ii1,io1', 'id1,if1'].includes(typeHeadIds),
    `head=${typeHeadIds}`,
  )
  check(
    'shared entries have the same lowercased resourceType on both',
    ['if1', 'id1'].every((id) => entriesById(typeScenario.extResult).get(id)?.resourceType === entriesById(typeScenario.headResult).get(id)?.resourceType),
    JSON.stringify(
      ['if1', 'id1'].map((id) => ({
        id,
        ext: entriesById(typeScenario.extResult).get(id)?.resourceType,
        head: entriesById(typeScenario.headResult).get(id)?.resourceType,
      })),
    ),
  )
  recordDiff(
    'capture 阶段 resourceTypes 过滤',
    '默认 xhr/fetch/document；可按参数过滤（image/other 不入缓冲）',
    '保存了 resourceTypes 选项但从不应用（image/other 也入缓冲）',
    'DIVERGENT（待 Lead 修）',
    'headless 与默认配置的缓冲内容不一致',
  )

  const imageOnly = await runSyntheticScenario(ext, head, {
    capture: { maxEntries: 50, resourceTypes: ['image'] },
    events: [
      CDP.request('xc1', { type: 'Fetch', timestamp: 710 }),
      CDP.request('xi1', { type: 'Image', url: 'https://api.test/pixel2.png', timestamp: 711 }),
    ],
  })
  check(
    'custom resourceTypes:[image] filters extension output to images',
    (imageOnly.extResult.entries || []).map((entry) => entry.id).join(',') === 'xi1',
    JSON.stringify((imageOnly.extResult.entries || []).map((entry) => entry.id)),
  )
  check(
    'headless custom resourceTypes matches the documented state (old: ignored; fixed: only xi1)',
    ['xc1,xi1', 'xi1'].includes((imageOnly.headResult.entries || []).map((entry) => entry.id).sort().join(',')),
    JSON.stringify((imageOnly.headResult.entries || []).map((entry) => entry.id)),
  )
  recordDiff(
    'capture_start resourceTypes 自定义值',
    '生效（本次只保留 image）',
    '不生效（fetch+image 都保留）',
    'DIVERGENT（待 Lead 修）',
  )
  check(
    'capture_start echoes resourceTypes on extension; headless may omit it (documented divergence, fix tolerated)',
    Array.isArray(lifecycleStartExt.resourceTypes) &&
      (lifecycleStart.resourceTypes === undefined ||
        JSON.stringify(lifecycleStart.resourceTypes) === JSON.stringify(lifecycleStartExt.resourceTypes)),
    JSON.stringify({ ext: lifecycleStartExt.resourceTypes, head: lifecycleStart.resourceTypes }),
  )

  // ------------------------------------------------------------------ S9
  // Cache-source mapping: fromDiskCache / fromMemoryCache / fromPrefetchCache /
  // fromServiceWorker and requestServedFromCache.
  console.log('\n--- cache source mapping ---')
  const cacheScenario = await runSyntheticScenario(ext, head, {
    capture: { maxEntries: 50 },
    events: [
      CDP.request('c1', { timestamp: 800 }),
      CDP.response('c1', { fromDiskCache: true, timestamp: 800.1 }),
      CDP.request('c2', { timestamp: 801 }),
      CDP.response('c2', { fromMemoryCache: true, timestamp: 801.1 }),
      CDP.request('c3', { timestamp: 802 }),
      CDP.response('c3', { fromPrefetchCache: true, timestamp: 802.1 }),
      CDP.request('c4', { timestamp: 803 }),
      CDP.servedFromCache('c4'),
      CDP.request('c5', { timestamp: 804 }),
      CDP.response('c5', { fromServiceWorker: true, timestamp: 804.1 }),
    ],
  })
  const cacheExt = entriesById(cacheScenario.extResult)
  const cacheHead = entriesById(cacheScenario.headResult)
  check(
    'fromDiskCache -> fromCache on both',
    cacheExt.get('c1')?.fromCache === true && cacheHead.get('c1')?.fromCache === true,
    `ext=${cacheExt.get('c1')?.fromCache} head=${cacheHead.get('c1')?.fromCache}`,
  )
  check(
    'requestServedFromCache -> fromCache on both',
    cacheExt.get('c4')?.fromCache === true && cacheHead.get('c4')?.fromCache === true,
    `ext=${cacheExt.get('c4')?.fromCache} head=${cacheHead.get('c4')?.fromCache}`,
  )
  check(
    'extension maps fromMemoryCache to fromCache=false (documented divergence)',
    cacheExt.get('c2')?.fromCache === false,
    `ext=${cacheExt.get('c2')?.fromCache}`,
  )
  check(
    'extension maps fromPrefetchCache to fromCache=true',
    cacheExt.get('c3')?.fromCache === true,
    `ext=${cacheExt.get('c3')?.fromCache}`,
  )
  check(
    'extension keeps fromServiceWorker as its own field instead of folding it into fromCache',
    cacheExt.get('c5')?.fromServiceWorker === true && cacheExt.get('c5')?.fromCache === false,
    JSON.stringify(pick(cacheExt.get('c5'), ['fromCache', 'fromServiceWorker'])),
  )
  recordDiff(
    '缓存来源映射（实际观测）',
    `c2(fromMemoryCache).fromCache=${cacheExt.get('c2')?.fromCache}, c3(fromPrefetchCache).fromCache=${cacheExt.get('c3')?.fromCache}, c5.fromServiceWorker=${cacheExt.get('c5')?.fromServiceWorker}`,
    `c2.fromCache=${cacheHead.get('c2')?.fromCache}, c3.fromCache=${cacheHead.get('c3')?.fromCache}, c5.fromServiceWorker=${cacheHead.get('c5')?.fromServiceWorker}, c5.fromCache=${cacheHead.get('c5')?.fromCache}`,
    'DIVERGENT（待 Lead 修）',
    'fromMemoryCache 与 fromPrefetchCache 双向不一致；fromServiceWorker 被折叠进 fromCache',
  )

  // ------------------------------------------------------------------ S10
  // Request-body retrieval fallback: extension calls
  // Network.getRequestPostData when requestWillBeSent has hasPostData but no
  // postData; headless only reads request.postData from the event.
  console.log('\n--- request body retrieval fallback ---')
  const fallbackScenario = await runSyntheticScenario(ext, head, {
    capture: { maxEntries: 50 },
    responseBodies: { fb1: { body: 'ok', base64Encoded: false } },
    requestBodies: { fb1: '{"user":"u1","token":"FALLBACK_TOKEN"}' },
    events: [
      CDP.request('fb1', { method: 'POST', hasPostData: true, timestamp: 900 }),
      CDP.response('fb1', { mimeType: 'text/plain', timestamp: 900.1 }),
      CDP.finished('fb1', 900.25),
    ],
  })
  const fbExt = entriesById(fallbackScenario.extResult).get('fb1')
  const fbHead = entriesById(fallbackScenario.headResult).get('fb1')
  check(
    'extension falls back to Network.getRequestPostData and redacts it',
    fbExt?.requestBody === '{"user":"u1","token":"«redacted»"}',
    JSON.stringify(fbExt?.requestBody),
  )
  check(
    'headless request-body fallback matches the documented state (old: missing; fixed: redacted JSON)',
    fbHead?.requestBody === undefined || fbHead?.requestBody === '{"user":"u1","token":"«redacted»"}',
    JSON.stringify(fbHead?.requestBody),
  )
  recordDiff(
    '请求体兜底路径',
    'requestWillBeSent 无 postData 时调用 Network.getRequestPostData',
    '只用 requestWillBeSent.request.postData；缺失时静默丢弃',
    'DIVERGENT（待 Lead 修）',
    '真实 Chrome 对部分 POST 会省略 postData',
  )

  // ------------------------------------------------------------------ S11
  // Freeze after stop + capture_start storeBodies:false semantics.
  console.log('\n--- stop freeze / storeBodies ---')
  const freezeScenario = await runSyntheticScenario(ext, head, {
    capture: { maxEntries: 50 },
    responseBodies: { z1: { body: '{"token":"FREEZE_TOKEN"}', base64Encoded: false } },
    events: [
      CDP.request('z1', { url: 'https://api.test/freeze', timestamp: 1000 }),
      CDP.response('z1', { mimeType: 'application/json', timestamp: 1000.1 }),
      CDP.finished('z1', 1000.25),
    ],
  })
  const extFrozenStop = await ext.stopCapture({ captureId: freezeScenario.extStart.captureId })
  const headFrozenStop = await head.stopCapture({ captureId: freezeScenario.headStart.captureId })
  check(
    'both report the frozen request count on stop',
    extFrozenStop.requests === 1 && headFrozenStop.requests === 1,
    `ext=${extFrozenStop.requests} head=${headFrozenStop.requests}`,
  )
  ext.setBodies({}, {})
  head.setBodies({}, {})
  ext.emit(...CDP.request('z2', { url: 'https://api.test/after-stop', timestamp: 1001 }))
  head.emit(...CDP.request('z2', { url: 'https://api.test/after-stop', timestamp: 1001 }))
  await sleep(80)
  const extFrozen = await ext.request('tab.capture_requests', { captureId: freezeScenario.extStart.captureId })
  const headFrozen = await head.request('tab.capture_requests', { captureId: freezeScenario.headStart.captureId })
  check(
    'buffer stays readable after stop and ignores new events on both',
    extFrozen.active === false &&
      headFrozen.active === false &&
      extFrozen.total === 1 &&
      headFrozen.total === 1 &&
      !entriesById(extFrozen).has('z2') &&
      !entriesById(headFrozen).has('z2'),
    JSON.stringify({ ext: pick(extFrozen, ['total', 'active']), head: pick(headFrozen, ['total', 'active']) }),
  )
  const extLatest = await ext.request('tab.capture_requests', {})
  const headLatest = await head.request('tab.capture_requests', {})
  check(
    'omitting captureId falls back to the latest capture on both',
    extLatest.captureId === freezeScenario.extStart.captureId &&
      headLatest.captureId === freezeScenario.headStart.captureId &&
      extLatest.active === false &&
      headLatest.active === false,
    JSON.stringify({ ext: pick(extLatest, ['captureId', 'active']), head: pick(headLatest, ['captureId', 'active']) }),
  )
  check(
    'frozen entry body is still readable on both',
    entriesById(extFrozen).get('z1')?.responseBody === '{"token":"«redacted»"}' &&
      entriesById(headFrozen).get('z1')?.responseBody === '{"token":"«redacted»"}',
    JSON.stringify({ ext: entriesById(extFrozen).get('z1')?.responseBody, head: entriesById(headFrozen).get('z1')?.responseBody }),
  )

  // storeBodies:false is honoured by the extension but ignored by headless.
  const storeScenario = await runSyntheticScenario(ext, head, {
    capture: { maxEntries: 50, storeBodies: false },
    responseBodies: { sb1: { body: 'text body', base64Encoded: false } },
    events: [
      CDP.request('sb1', { url: 'https://api.test/store-bodies', timestamp: 1100 }),
      CDP.response('sb1', { mimeType: 'text/plain', timestamp: 1100.1 }),
      CDP.finished('sb1', 1100.25),
    ],
  })
  check(
    'capture_start echoes storeBodies=false on extension; headless may echo true (documented divergence, fix tolerated)',
    storeScenario.extStart.storeBodies === false &&
      [false, true].includes(storeScenario.headStart.storeBodies),
    JSON.stringify({ ext: storeScenario.extStart.storeBodies, head: storeScenario.headStart.storeBodies }),
  )
  const sbExt = entriesById(storeScenario.extResult).get('sb1')
  const sbHead = entriesById(storeScenario.headResult).get('sb1')
  check(
    'extension honours storeBodies=false (no response body)',
    sbExt?.responseBody === undefined,
    JSON.stringify(sbExt?.responseBody),
  )
  check(
    'headless storeBodies=false handling matches the documented state (old: body captured; fixed: no body)',
    sbHead?.responseBody === 'text body' || sbHead?.responseBody === undefined,
    JSON.stringify(sbHead?.responseBody),
  )
  recordDiff(
    'capture_start storeBodies 参数',
    'storeBodies=false 生效（不抓 body）',
    '忽略该参数，始终抓 body',
    'DIVERGENT（待 Lead 修）',
  )

  // ------------------------------------------------------------------ S12
  // Errors / owner isolation / unknown captureId / no capture.
  console.log('\n--- errors, owner isolation, unknown captureId ---')
  // Use the newest stopped summary: stopped captures are bounded (TTL + count
  // limit 8) on both backends, so an older scenario's id may already be gone.
  const knownCaptureExt = storeScenario.extStart.captureId
  const knownCaptureHead = storeScenario.headStart.captureId
  const extOtherOwner = await ext.errorOf('tab.capture_requests', { owner: 's2', captureId: knownCaptureExt })
  const headOtherOwner = await head.errorOf('tab.capture_requests', { owner: 'other', captureId: knownCaptureHead })
  check(
    'capture buffers are owner-isolated with CAPTURE_NOT_FOUND on both',
    extOtherOwner?.code === 'CAPTURE_NOT_FOUND' && headOtherOwner?.code === 'CAPTURE_NOT_FOUND',
    JSON.stringify({ ext: extOtherOwner, head: headOtherOwner }),
  )
  const extBogus = await ext.errorOf('tab.capture_requests', { captureId: 'cap-does-not-exist' })
  const headBogus = await head.errorOf('tab.capture_requests', { captureId: 'hl-does-not-exist' })
  check(
    'unknown captureId is an error on both',
    extBogus !== null && headBogus !== null,
    JSON.stringify({ ext: extBogus, head: headBogus }),
  )
  check(
    'unknown captureId code is CAPTURE_LOST on extension (headless documents another code)',
    extBogus.code === 'CAPTURE_LOST' && ['CAPTURE_NOT_FOUND', 'CAPTURE_LOST'].includes(headBogus.code),
    JSON.stringify({ ext: extBogus.code, head: headBogus.code }),
  )
  recordDiff(
    'captureId 不存在时的错误码',
    'CAPTURE_LOST（worker 重启导致缓冲丢失）',
    'CAPTURE_NOT_FOUND（与 owner 不匹配同码）',
    'DIVERGENT（待 Lead 修）',
    '调用方无法区分"重启丢失"与"不属于我"',
  )
  const extStopBogus = await ext.errorOf('tab.capture_stop', { captureId: 'cap-does-not-exist' })
  const headStopBogus = await head.errorOf('tab.capture_stop', { captureId: 'hl-does-not-exist' })
  check(
    'capture_stop unknown captureId follows the same (tolerant) code contract',
    extStopBogus?.code === 'CAPTURE_LOST' &&
      ['CAPTURE_NOT_FOUND', 'CAPTURE_LOST'].includes(headStopBogus?.code),
    JSON.stringify({ ext: extStopBogus?.code, head: headStopBogus?.code }),
  )
  const extNoCapture = await ext.errorOf('tab.capture_requests', { owner: 'ghost-owner' })
  const headNoCapture = await head.errorOf('tab.capture_requests', { owner: 'ghost-owner' })
  check(
    'no capture at all reports NO_ACTIVE_CAPTURE on both',
    extNoCapture?.code === 'NO_ACTIVE_CAPTURE' && headNoCapture?.code === 'NO_ACTIVE_CAPTURE',
    JSON.stringify({ ext: extNoCapture, head: headNoCapture }),
  )

  await ext.stopActiveSilently()
  await head.stopActiveSilently()
  head.restore()
}

// ------------------------------------------------------- live headless pipeline
// Real Chrome + temp HTTP server: proves the headless capture pipeline receives
// real CDP events and materializes/redacts bodies beyond the synthetic path.
async function runLiveHeadlessChecks(head) {
  console.log('\n--- live headless pipeline (real Chrome + temp HTTP server) ---')
  const live = createHeadlessHarness(head.driver, 'live')
  const started = await live.startCapture({ maxEntries: 100 })
  const base = liveServerBase()
  const nav = await live.request('tab.goto', { url: `${base}/` })
  check('live: page navigates', nav.loadState === 'complete', `${nav.title} ${nav.url}`)

  const readLive = () =>
    live.request('tab.capture_requests', { captureId: started.captureId, limit: 100, maxBodyChars: 65536 })
  let captured = await waitFor(async () => {
    const result = await readLive()
    const entries = result.entries || []
    const urls = entries.map((entry) => entry.url)
    const find = (needle) => entries.find((entry) => entry.url.includes(needle))
    // Bodies are fetched asynchronously after loadingFinished: wait for them
    // instead of only waiting for the request list.
    const ready =
      urls.some((url) => url.endsWith('/')) &&
      urls.some((url) => url.includes('/api/large')) &&
      urls.some((url) => url.includes('/api/fail')) &&
      urls.some((url) => url.includes('/api/echo-form')) &&
      urls.some((url) => url.includes('/api/echo-json')) &&
      typeof entries.find((entry) => entry.resourceType === 'document')?.responseBody === 'string' &&
      typeof find('/api/data')?.responseBody === 'string' &&
      typeof find('/api/echo-json')?.requestBody === 'string' &&
      typeof find('/api/echo-form')?.requestBody === 'string' &&
      find('/api/large')?.bodyTruncated === true
    return ready ? result : null
  }, { timeoutMs: 25000 })
  if (!captured) {
    // One retry: under heavy parallel load the first navigation can race
    // Network.enable/body retrieval. Reload once and wait again before failing.
    await live.request('tab.goto', { url: `${base}/?retry=${Date.now()}` }).catch(() => {})
    captured = await waitFor(async () => {
      const result = await readLive()
      const entries = result.entries || []
      const urls = entries.map((entry) => entry.url)
      const find = (needle) => entries.find((entry) => entry.url.includes(needle))
      const ready =
        urls.some((url) => url.endsWith('/') || url.includes('/?retry=')) &&
        urls.some((url) => url.includes('/api/large')) &&
        urls.some((url) => url.includes('/api/fail')) &&
        urls.some((url) => url.includes('/api/echo-form')) &&
        urls.some((url) => url.includes('/api/echo-json')) &&
        typeof entries.find((entry) => entry.resourceType === 'document')?.responseBody === 'string' &&
        typeof find('/api/data')?.responseBody === 'string' &&
        typeof find('/api/echo-json')?.requestBody === 'string' &&
        typeof find('/api/echo-form')?.requestBody === 'string' &&
        find('/api/large')?.bodyTruncated === true
      return ready ? result : null
    }, { timeoutMs: 25000 })
  }
  if (!captured) {
    const debug = await readLive().catch(() => null)
    console.log(
      'LIVE DEBUG:',
      JSON.stringify(
        (debug?.entries || []).map((entry) => ({
          url: entry.url,
          type: entry.resourceType,
          status: entry.status,
          responseBody: typeof entry.responseBody === 'string' ? entry.responseBody.length : null,
          requestBody: typeof entry.requestBody === 'string' ? entry.requestBody.length : null,
          bodyTruncated: entry.bodyTruncated,
          bodyUnavailable: entry.bodyUnavailable,
        })),
        null,
        1,
      ),
    )
    check('live: capture receives the page requests', false, 'timed out waiting for captured entries')
    return
  }
  const byUrl = (needle) => (captured.entries || []).find((entry) => entry.url.includes(needle))

  const documentEntry = (captured.entries || []).find((entry) => entry.resourceType === 'document')
  check(
    'live: document request captured with its body',
    typeof documentEntry?.responseBody === 'string' && documentEntry.responseBody.includes('Capture Parity Live'),
    summarize(documentEntry?.responseBody),
  )
  const dataEntry = byUrl('/api/data')
  check(
    'live: secret query value redacted on a real request',
    typeof dataEntry?.url === 'string' &&
      dataEntry.url.includes('access_token=«redacted»') &&
      !dataEntry.url.includes('SECRET') &&
      dataEntry.status === 200,
    summarize(dataEntry?.url),
  )
  check(
    'live: JSON response body redacted on a real request',
    dataEntry?.responseBody === '{"ok":true,"user":"u1","token":"«redacted»"}' && dataEntry?.redacted === true,
    summarize(dataEntry?.responseBody),
  )
  const jsonEntry = byUrl('/api/echo-json')
  check(
    'live: JSON request body redacted on a real POST',
    jsonEntry?.requestBody === '{"user":"u1","token":"«redacted»","nested":{"apiKey":"«redacted»"}}',
    summarize(jsonEntry?.requestBody),
  )
  const formEntry = byUrl('/api/echo-form')
  check(
    'live: form request body redacted on a real POST',
    formEntry?.requestBody === 'token="«redacted»"&user=u1',
    summarize(formEntry?.requestBody),
  )
  const largeEntry = byUrl('/api/large')
  check(
    'live: oversized response body truncated with the marker',
    largeEntry?.bodyTruncated === true &&
      typeof largeEntry?.responseBody === 'string' &&
      largeEntry.responseBody.endsWith('… <truncated>'),
    JSON.stringify({ len: largeEntry?.responseBody?.length, truncated: largeEntry?.bodyTruncated }),
  )
  const failEntry = byUrl('/api/fail')
  check(
    'live: aborted request recorded as failed with errorText',
    failEntry?.failed === true && typeof failEntry?.errorText === 'string' && failEntry.errorText.length > 0,
    JSON.stringify(pick(failEntry, ['failed', 'errorText'])),
  )
  const imageEntry = byUrl('/pixel.png')
  check(
    'live: resourceTypes filter state agrees with the synthetic evidence (old: image captured; fixed: filtered)',
    imageEntry === undefined || imageEntry.resourceType === 'image',
    JSON.stringify(pick(imageEntry, ['resourceType', 'status'])),
  )
  recordDiff(
    'live 证据：默认 resourceTypes 下的 image/other',
    '默认过滤 image/other（合成层已验证）',
    `真实页面里捕获了 image（${summarize(imageEntry?.url)}）等非默认类型`,
    'DIVERGENT（待 Lead 修）',
  )
  check(
    'live: no raw tokens in the captured metadata/bodies (page source excluded)',
    !JSON.stringify((captured.entries || []).filter((entry) => entry.resourceType !== 'document')).match(
      /RESP_TOKEN|TOKEN_JSON|TOKEN_FORM|TOKEN_NESTED|SECRET/,
    ),
  )
  check(
    'live: no header-shaped fields in the live buffer',
    !/cookie|authorization|set-cookie/i.test(JSON.stringify(captured)),
  )

  const stop = await live.stopCapture({ captureId: started.captureId })
  check('live: stop reports active=false with the frozen count', stop.active === false && stop.requests === captured.total)
  await live.request('tab.goto', { url: `${base}/?after=stop` })
  await sleep(500)
  const frozen = await live.request('tab.capture_requests', { captureId: started.captureId, limit: 100 })
  check(
    'live: frozen buffer ignores post-stop navigation',
    frozen.active === false && frozen.total === captured.total,
    `before=${captured.total} after=${frozen.total}`,
  )
  live.restore()
}

// --------------------------------------------------------------- live server
let liveServer = null
let liveServerPort = null

function liveServerBase() {
  return `http://127.0.0.1:${liveServerPort}`
}

function createLiveServer() {
  const page = `<!doctype html><html><head><title>Capture Parity Live</title></head><body>
<h1>capture parity</h1>
<script>
  console.log('live-capture-page')
  fetch('/api/data?access_token=SECRET&q=1').catch(() => {})
  fetch('/api/echo-json', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user: 'u1', token: 'TOKEN_JSON', nested: { apiKey: 'TOKEN_NESTED' } }) }).catch(() => {})
  fetch('/api/echo-form', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'token=TOKEN_FORM&user=u1' }).catch(() => {})
  fetch('/api/large').catch(() => {})
  fetch('/api/fail').catch(() => {})
  new Image().src = '/pixel.png'
</script>
</body></html>`

  liveServer = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    if (url.pathname === '/api/data') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, user: 'u1', token: 'RESP_TOKEN' }))
      return
    }
    if (url.pathname === '/api/echo-json') {
      req.resume()
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.end('json-ok')
      })
      return
    }
    if (url.pathname === '/api/echo-form') {
      req.resume()
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/x-www-form-urlencoded' })
        res.end('status=ok&token=RESP_FORM_TOKEN')
      })
      return
    }
    if (url.pathname === '/api/large') {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('A'.repeat(6000))
      return
    }
    if (url.pathname === '/api/fail') {
      req.socket.destroy()
      return
    }
    if (url.pathname === '/pixel.png') {
      res.writeHead(200, { 'content-type': 'image/png' })
      res.end(
        Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
          'base64',
        ),
      )
      return
    }
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(page)
  })
  liveServer.on('listening', () => {
    liveServerPort = liveServer.address().port
  })
  return liveServer
}

await main()
