/**
 * M3 — launch rollback, capture summaries and screenshot/screencast bounds
 * (no real Chrome required).
 *
 * The assertions pin the contract:
 *
 *   - any failure after a headless child is spawned kills it, clears
 *     `chrome`/`cdp`/`startPromise`/`browserVersion` and removes its
 *     DevToolsActivePort, and a later attempt starts from a clean driver;
 *   - a child that exits during startup fails the launch without waiting for
 *     the 15s port deadline;
 *   - an existing context whose browser is gone is closed after a failed
 *     request, while an ordinary request error keeps it alive;
 *   - a dropped CDP connection (crashed Chrome) clears every map/timer and
 *     makes the driver terminal: later requests fail with CONTEXT_CRASHED;
 *   - a stopped capture stays readable, then is freed by TTL/count; reading a
 *     frozen capture releases its raw event index and request-body scratch;
 *   - one screenshot frame above the byte/pixel cap never becomes shot.last;
 *   - stopping a viewer screencast (or closing a tab) clears its timers.
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { DEFAULT_CONFIG } from '../src/config.js'
import { BrowserContextManager } from '../src/contexts.js'
import { HeadlessContextRouter } from '../src/headless-contexts.js'
import {
  CONSOLE_BUFFER_LIMIT,
  handleConsoleEvent,
  handleNetworkEvent,
  recordConsole,
} from '../src/headless-events.js'
import {
  CAPTURE_SUMMARY_LIMIT,
  CAPTURE_SUMMARY_TTL_MS,
  HeadlessDriver,
} from '../src/headless.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const makeHome = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `dsh-${name}-`))
const cleanupHome = (home) => {
  try {
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  } catch {}
}

assert.ok(CAPTURE_SUMMARY_LIMIT >= 1 && CAPTURE_SUMMARY_TTL_MS > 0, 'capture summary bounds are positive')

// ---------------------------------------------------------------- launch rollback
function fakeChild() {
  const child = new EventEmitter()
  child.stderr = new EventEmitter()
  child.killedWith = []
  child.kill = (signal = 'SIGTERM') => {
    child.killedWith.push(signal)
    child.emit('exit', null, signal)
    return true
  }
  return child
}

class FakeWebSocket {
  constructor(url) {
    this.url = url
    this.closed = false
    queueMicrotask(() => this.onopen?.())
  }

  send(payload) {
    const message = JSON.parse(payload)
    const result =
      message.method === 'Browser.getVersion'
        ? { product: 'Fake/1.0' }
        : message.method === 'Browser.setDownloadBehavior'
          ? {}
          : message.method === 'Target.createTarget'
            ? { targetId: 'fake-target' }
            : message.method === 'Target.attachToTarget'
              ? { sessionId: 'fake-session' }
              : {}
    queueMicrotask(() => {
      if (this.closed) return
      this.onmessage?.({ data: JSON.stringify({ id: message.id, result }) })
    })
  }

  close() {
    if (this.closed) return
    this.closed = true
    this.onclose?.()
  }
}

const originalWebSocket = globalThis.WebSocket
globalThis.WebSocket = FakeWebSocket
try {
  {
    const home = makeHome('m3-launch-fail')
    try {
      // A file where the download directory should be makes the post-connect
      // setup fail, i.e. a launch that already has a live child + CDP client.
      const blocker = path.join(home, 'blocker')
      fs.writeFileSync(blocker, 'not a directory')
      let spawns = 0
      const children = []
      const spawnImpl = (executable, args) => {
        spawns += 1
        const child = fakeChild()
        children.push(child)
        const profileArg = args.find((arg) => String(arg).startsWith('--user-data-dir='))
        const profileDir = profileArg.slice('--user-data-dir='.length)
        fs.mkdirSync(profileDir, { recursive: true })
        fs.writeFileSync(path.join(profileDir, 'DevToolsActivePort'), '9333\n/devtools/browser/fake\n')
        return child
      }
      const driver = new HeadlessDriver({
        home,
        executable: process.execPath,
        spawnImpl,
        downloadDir: path.join(blocker, 'downloads'),
      })
      await assert.rejects(driver.ensureStarted())
      assert.equal(spawns, 1, 'one child spawned')
      assert.deepEqual(children[0].killedWith, ['SIGTERM'], 'failed launch kills the child')
      assert.equal(driver.chrome, null, 'no orphan child handle')
      assert.equal(driver.cdp, null, 'no half-connected CDP client')
      assert.equal(driver.browserVersion, null)
      assert.equal(driver.startPromise, null, 'start promise cleared after failure')
      assert.equal(driver.idleTimer, null, 'no idle timer from a failed launch')
      assert.equal(
        fs.existsSync(path.join(driver.profileDir, 'DevToolsActivePort')),
        false,
        'port file from the failed child removed so the next attempt launches fresh',
      )

      // A clean driver state means the next call tries again (and fails for the
      // same configured reason) instead of returning a cached rejection.
      await assert.rejects(driver.ensureStarted())
      assert.equal(spawns, 2, 'second attempt spawns a fresh child')
      assert.deepEqual(children[1].killedWith, ['SIGTERM'])
      assert.equal(driver.chrome, null)
      assert.equal(driver.cdp, null)
    } finally {
      cleanupHome(home)
    }
  }

  {
    const home = makeHome('m3-launch-exit')
    try {
      const spawnImpl = () => {
        const child = fakeChild()
        setTimeout(() => child.emit('exit', 42), 30)
        return child
      }
      const driver = new HeadlessDriver({ home, executable: process.execPath, spawnImpl })
      const startedAt = Date.now()
      await assert.rejects(driver.ensureStarted(), (error) => error.code === 'HEADLESS_LAUNCH_FAILED')
      const elapsed = Date.now() - startedAt
      assert.ok(elapsed < 2000, `child exit fails fast (${elapsed}ms), not at the 15s deadline`)
      assert.equal(driver.chrome, null)
      assert.equal(driver.cdp, null)
      assert.equal(driver.idleTimer, null)
      assert.equal(driver.startPromise, null)
      assert.equal(driver.dead, false, 'a failed launch is retryable, not a crashed context')
      assert.equal(driver.deathReason, null)
    } finally {
      cleanupHome(home)
    }
  }

  {
    // A live browser whose CDP connection drops (Chrome crash): every piece of
    // per-browser state is released and the driver becomes terminal, so the
    // next request cannot reuse stale tab/session ids.
    const home = makeHome('m3-crash')
    try {
      let spawns = 0
      const child = fakeChild()
      const spawnImpl = (executable, args) => {
        spawns += 1
        const profileArg = args.find((arg) => String(arg).startsWith('--user-data-dir='))
        const profileDir = profileArg.slice('--user-data-dir='.length)
        fs.mkdirSync(profileDir, { recursive: true })
        fs.writeFileSync(path.join(profileDir, 'DevToolsActivePort'), '9333\n/devtools/browser/fake\n')
        return child
      }
      const driver = new HeadlessDriver({ home, executable: process.execPath, spawnImpl })
      await driver.ensureStarted()
      assert.equal(driver.connected, true)
      assert.equal(driver.browserVersion, 'Fake/1.0')

      const tab = await driver.attachTab(driver.ownerEntry('crash-owner'), 'about:blank')
      const started = await driver.dispatch('tab.capture_start', { owner: 'crash-owner', tabId: tab.tabId })
      const captureTimer = driver.captures.get(started.captureId).timer
      await driver.dispatch('tab.screencast_start', { owner: 'crash-owner', tabId: tab.tabId })
      const screencastTimer = tab.screencast.timer
      driver.onCdpEvent({ method: 'Browser.downloadWillBegin', params: { guid: 'g-crash', suggestedFilename: 'crash.txt' } })
      driver.startIdleTimer()
      assert.equal(driver.downloadByGuid.size, 1)

      // The websocket closing is what a killed/crashed Chrome produces.
      driver.cdp.ws.close()

      assert.equal(driver.dead, true, 'a dropped CDP connection marks the driver dead')
      assert.equal(driver.deathReason, 'connection-closed')
      assert.equal(driver.cdp, null)
      assert.equal(driver.chrome, null)
      assert.deepEqual(child.killedWith, ['SIGTERM'], 'a CDP-only crash kills a still-running child')
      assert.equal(driver.browserVersion, null)
      assert.equal(driver.tabs.size, 0)
      assert.equal(driver.bySession.size, 0)
      assert.equal(driver.owners.size, 0)
      assert.equal(driver.consoleBuffers.size, 0)
      assert.equal(driver.captures.size, 0)
      assert.equal(driver.captureByTab.size, 0)
      assert.equal(driver.downloads.length, 0)
      assert.equal(driver.downloadByGuid.size, 0)
      assert.equal(driver.idleTimer, null)
      assert.equal(tab.screencast, null, 'crash drops the screencast state')
      assert.equal(screencastTimer._destroyed, true, 'crash clears the screencast timer')
      assert.equal(captureTimer._destroyed, true, 'crash clears the capture timer')
      await assert.rejects(
        driver.ensureStarted(),
        (error) => error.code === 'CONTEXT_CRASHED',
        'later requests fail explicitly instead of relaunching under stale ids',
      )
      assert.equal(spawns, 1, 'a dead driver does not silently spawn another Chrome')
      await driver.close()
      assert.equal(driver.dead, false, 'an explicit close resets the terminal marker')
    } finally {
      cleanupHome(home)
    }
  }
} finally {
  if (originalWebSocket === undefined) delete globalThis.WebSocket
  else globalThis.WebSocket = originalWebSocket
}

// -------------------------------------- existing context fails -> closed
{
  const home = makeHome('m3-router')
  const config = {
    ...DEFAULT_CONFIG,
    browser: { ...DEFAULT_CONFIG.browser, preset: 'sandbox', maxContexts: 2, idleTimeoutMs: 60_000 },
  }
  let mode = 'ok'
  const drivers = []
  const manager = new BrowserContextManager({
    config,
    home,
    createDriver: async () => {
      const driver = {
        connected: true,
        async request() {
          if (mode === 'crash') {
            driver.connected = false
            throw Object.assign(new Error('headless launch failed'), { code: 'HEADLESS_LAUNCH_FAILED' })
          }
          if (mode === 'soft') throw Object.assign(new Error('missing ref'), { code: 'REF_STALE' })
          return { ok: true }
        },
        async close() {
          driver.closed = true
        },
      }
      drivers.push(driver)
      return driver
    },
  })
  const router = new HeadlessContextRouter({ manager })
  try {
    await router.request('tab.goto', { owner: 'owner-a' })
    assert.equal(manager.stats().active, 1)
    mode = 'crash'
    await assert.rejects(router.request('tab.snapshot', { owner: 'owner-a' }))
    assert.equal(manager.stats().active, 0, 'a context whose browser died is closed, not left running')
    assert.equal(drivers[0].closed, true, 'driver closed with the context')

    // Ordinary request errors keep a live context; only a disconnected driver
    // (failed restart / crashed browser) is closed.
    mode = 'ok'
    await router.request('tab.goto', { owner: 'owner-a' })
    assert.equal(manager.stats().active, 1)
    mode = 'soft'
    await assert.rejects(router.request('tab.snapshot', { owner: 'owner-a' }), (error) => error.code === 'REF_STALE')
    assert.equal(manager.stats().active, 1, 'a live context survives a normal request error')
  } finally {
    await router.close()
    cleanupHome(home)
  }
}

// ------------------------------------------------ capture summaries / read release
class FakeCdp {
  constructor() {
    this.calls = []
    this.nextTarget = 1
  }

  async send(method, params = {}, sessionId) {
    this.calls.push({ method, params, sessionId })
    switch (method) {
      case 'Target.createTarget':
        return { targetId: `target-${this.nextTarget++}` }
      case 'Target.attachToTarget':
        return { sessionId: `session-${params.targetId}` }
      case 'Network.getResponseBody':
        return { body: 'hello', base64Encoded: false }
      case 'Network.getRequestPostData':
        return { postData: 'user=u1&token=TOKEN' }
      default:
        return {}
    }
  }

  onMessage() {}
  close() {}
}

const makeCaptureDriver = (options = {}) => {
  const driver = new HeadlessDriver({ home: '/tmp/dsh-m3-capture-test', ...options })
  driver.cdp = new FakeCdp()
  return driver
}
const startCapture = async (driver, owner = 'owner-c') => {
  const tab = await driver.attachTab(driver.ownerEntry(owner), 'about:blank')
  const started = await driver.dispatch('tab.capture_start', { owner, tabId: tab.tabId })
  return { tab, started }
}
const emitRequest = (driver, tab, requestId = 'r1') => {
  driver.onCdpEvent({
    sessionId: tab.sessionId,
    method: 'Network.requestWillBeSent',
    params: {
      requestId,
      type: 'fetch',
      timestamp: 1,
      wallTime: 1,
      documentURL: 'https://example.test/',
      request: { method: 'POST', url: 'https://example.test/api', hasPostData: true, postData: 'token=SECRET' },
    },
  })
  return driver.captures.get(driver.captureByTab.get(tab.tabId)?.captureId)?.entries.at(-1)
}

{
  const driver = makeCaptureDriver({ captureSummaryTtlMs: 40 })
  try {
    const { tab, started } = await startCapture(driver)
    const entry = emitRequest(driver, tab)
    assert.equal(entry?._postDataRaw, 'token=SECRET', 'raw request body is kept while capturing')
    const stopped = await driver.dispatch('tab.capture_stop', { owner: 'owner-c', captureId: started.captureId })
    assert.equal(stopped.active, false)
    assert.equal(stopped.requests, 1)
    const capture = driver.captures.get(started.captureId)
    assert.ok(capture, 'stopped capture summary is retained')
    assert.equal(capture.byId.size, 0, 'raw event index released on stop')
    assert.equal('_postDataRaw' in capture.entries[0], false, 'raw request body released on stop')

    // Frozen captures stay readable (capture-parity contract) and a read also
    // releases the raw parts; it must not consume the entries.
    const firstRead = await driver.dispatch('tab.capture_requests', {
      owner: 'owner-c',
      captureId: started.captureId,
    })
    assert.equal(firstRead.total, 1)
    assert.equal(firstRead.entries.length, 1)
    const secondRead = await driver.dispatch('tab.capture_requests', {
      owner: 'owner-c',
      captureId: started.captureId,
    })
    assert.equal(secondRead.total, 1, 'a second read still sees the summary')
    assert.equal(secondRead.entries.length, 1)
    assert.equal(capture.entries.length, 1, 'entries stay until the summary expires')
    assert.equal(capture.byId.size, 0)
    assert.equal(capture.entries.some((item) => '_postDataRaw' in item), false)

    await sleep(120)
    assert.equal(driver.captures.has(started.captureId), false, 'TTL frees the stopped capture')
    assert.equal(driver.captureByTab.has(tab.tabId), false)
    assert.equal(capture.entries.length, 0, 'expiry also frees the entries')
    await assert.rejects(
      driver.dispatch('tab.capture_requests', { owner: 'owner-c', captureId: started.captureId }),
      (error) => error.code === 'CAPTURE_LOST',
    )
  } finally {
    cleanupHome('/tmp/dsh-m3-capture-test')
  }
}

{
  const driver = makeCaptureDriver({ captureSummaryLimit: 2 })
  try {
    const { tab } = await startCapture(driver)
    const ids = []
    for (let index = 0; index < 3; index += 1) {
      const started = await driver.dispatch('tab.capture_start', { owner: 'owner-c', tabId: tab.tabId })
      ids.push(started.captureId)
      await driver.dispatch('tab.capture_stop', { owner: 'owner-c', captureId: started.captureId })
    }
    assert.equal(driver.captures.size, 2, 'stopped summaries are bounded by count')
    assert.equal(driver.captures.has(ids[0]), false, 'oldest summary evicted')
    assert.equal(driver.captures.has(ids[1]), true)
    assert.equal(driver.captures.has(ids[2]), true)
    await assert.rejects(
      driver.dispatch('tab.capture_requests', { owner: 'owner-c', captureId: ids[0] }),
      (error) => error.code === 'CAPTURE_LOST',
    )
  } finally {
    cleanupHome('/tmp/dsh-m3-capture-test')
  }
}

// ------------------------------------------------------ screenshot frame caps
const fakePng = (width, height, padding = 0) => {
  const buffer = Buffer.alloc(24 + padding)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0)
  buffer.write('IHDR', 12, 'ascii')
  buffer.writeUInt32BE(width, 16)
  buffer.writeUInt32BE(height, 20)
  return buffer
}
const shotState = () => ({
  active: true,
  frames: 0,
  format: 'png',
  quality: 0,
  maxWidth: 100,
  maxHeight: 100,
  waivers: [],
  waiters: [],
  last: null,
  oversized: 0,
  invalidFrames: 0,
})

{
  const driver = new HeadlessDriver({ home: '/tmp/dsh-m3-shot-test', shotFrameMaxBytes: 40, shotFrameMaxPixels: 100 * 100 })
  const tab = { tabId: 1, shotStream: shotState() }
  const frame = (buffer, timestamp, width = 100, height = 100) =>
    driver.screenshot.handleFrame(tab, {
      data: buffer.toString('base64'),
      metadata: { timestamp, deviceWidth: width, deviceHeight: height },
    })

  frame(fakePng(100, 100), 1)
  assert.ok(tab.shotStream.last, 'a frame within both caps is cached')
  const first = tab.shotStream.last

  frame(fakePng(100, 100, 64), 2)
  assert.equal(tab.shotStream.last, first, 'an over-byte frame does not replace shot.last')
  assert.equal(tab.shotStream.oversized, 1)

  frame(fakePng(200, 100), 3)
  assert.equal(tab.shotStream.last, first, 'an over-pixel frame does not replace shot.last')
  assert.equal(tab.shotStream.oversized, 2)

  frame(Buffer.from('not a png'), 4)
  assert.equal(tab.shotStream.last, first, 'a frame without a parseable geometry is not cached')
  assert.equal(tab.shotStream.invalidFrames, 1)

  cleanupHome('/tmp/dsh-m3-shot-test')
}

// ---------------------------------------------- viewer screencast timer cleanup
{
  const driver = new HeadlessDriver({ home: '/tmp/dsh-m3-screencast-test' })
  driver.cdp = new FakeCdp()
  const tab = await driver.attachTab(driver.ownerEntry('owner-s'), 'about:blank')
  const started = await driver.dispatch('tab.screencast_start', { owner: 'owner-s', tabId: tab.tabId })
  assert.equal(started.active, true)
  const timer = tab.screencast.timer
  assert.ok(timer, 'screencast start timer armed')

  const stopped = await driver.dispatch('tab.screencast_stop', { owner: 'owner-s', tabId: tab.tabId })
  assert.equal(stopped.active, false)
  assert.equal(tab.screencast, null, 'stop clears screencast state')
  assert.equal(timer._destroyed, true, 'stop clears the 10-minute screencast timer')

  // A tab closed while a screencast runs also clears its timer.
  await driver.dispatch('tab.screencast_start', { owner: 'owner-s', tabId: tab.tabId })
  const closingTimer = tab.screencast.timer
  driver.cleanupTab(tab, { reason: 'test-close' })
  assert.equal(tab.screencast, null, 'tab cleanup drops the screencast state')
  assert.equal(closingTimer._destroyed, true, 'tab cleanup clears the screencast timer')

  // A failed Page.startScreencast must not leave the armed timer behind.
  const failing = new HeadlessDriver({ home: '/tmp/dsh-m3-screencast-test' })
  const failingCdp = new FakeCdp()
  failingCdp.fail = { 'Page.startScreencast': new Error('start failed') }
  const originalSend = failingCdp.send.bind(failingCdp)
  failingCdp.send = async (method, params, sessionId) => {
    if (failingCdp.fail[method]) throw failingCdp.fail[method]
    return originalSend(method, params, sessionId)
  }
  failing.cdp = failingCdp
  const failingTab = await failing.attachTab(failing.ownerEntry('owner-f'), 'about:blank')
  await assert.rejects(
    failing.dispatch('tab.screencast_start', { owner: 'owner-f', tabId: failingTab.tabId }),
    (error) => error.message === 'start failed',
  )
  assert.equal(failingTab.screencast, null, 'failed start clears screencast state')
  cleanupHome('/tmp/dsh-m3-screencast-test')
}

// --------------------------------------------- headless console buffer bounds
{
  const buffers = new Map()
  const tab = { tabId: 31 }
  for (let index = 0; index < 600; index += 1) {
    handleConsoleEvent(buffers, tab, 'Runtime.consoleAPICalled', {
      type: 'log',
      args: [{ value: `entry-${index}` }],
    })
  }
  assert.equal(CONSOLE_BUFFER_LIMIT, 500, 'the headless console buffer must match CONTRACTS.md (500)')
  assert.equal(buffers.get(31).length, 500, 'the console buffer is hard-capped at 500 entries')
  assert.equal(buffers.get(31)[0].text, 'entry-100', 'the newest 500 entries are kept')
  recordConsole(buffers, tab, { level: 'log', text: 'x'.repeat(5000) })
  assert.equal(buffers.get(31).at(-1).text.length, 2000, 'one console entry is truncated to 2000 chars')
  handleConsoleEvent(buffers, tab, 'Runtime.exceptionThrown', {
    exceptionDetails: { exception: { description: 'e'.repeat(5000) } },
  })
  assert.equal(buffers.get(31).at(-1).text.length, 2000, 'exceptions are truncated too')
}

// ------------------------------------------ headless capture body opt-in/leaks
{
  const tab = { tabId: 41, sessionId: 'session-41' }
  const makeCapture = (overrides = {}) => ({
    active: true,
    storeBodies: false,
    entries: [],
    byId: new Map(),
    maxEntries: 10,
    dropped: 0,
    bodyBytes: 0,
    bodiesDropped: 0,
    bodyTasks: 0,
    bodyTasksSet: new Set(),
    resourceTypes: ['fetch'],
    ...overrides,
  })
  const request = (id, extra = {}) =>
    handleNetworkEvent(tab, current, async () => {
      throw new Error('send must not be called when bodies are off')
    }, 'Network.requestWillBeSent', {
      requestId: id,
      type: 'Fetch',
      timestamp: 1,
      request: { method: 'POST', url: 'https://api.test/x', hasPostData: true, postData: 'token=SECRET', ...extra },
    })
  let current = makeCapture()
  request('n1')
  const entry = current.entries[0]
  assert.equal('_postDataRaw' in entry, false, 'storeBodies:false never keeps the raw request body')
  handleNetworkEvent(tab, current, async () => {
    throw new Error('send must not be called when bodies are off')
  }, 'Network.loadingFinished', { requestId: 'n1', timestamp: 1.2 })
  await sleep(10)
  assert.equal(entry.responseBody, undefined, 'storeBodies:false never materializes a response body')
  assert.equal(current.bodyTasks, 0, 'no body task was started')

  // A failed request must release the raw request body as well: it never
  // reaches loadingFinished, so nothing would consume/delete it.
  current = makeCapture({ storeBodies: true })
  request('n2')
  handleNetworkEvent(tab, current, async () => ({}), 'Network.loadingFailed', {
    requestId: 'n2',
    timestamp: 1.5,
    errorText: 'net::ERR_FAILED',
  })
  assert.equal('_postDataRaw' in current.entries[0], false, 'loadingFailed releases the raw request body')

  // A body fetch that throws must release its in-flight slot, not leak one of
  // the four budget tokens forever.
  current = makeCapture({ storeBodies: true })
  request('n3')
  handleNetworkEvent(tab, current, async () => {
    throw new Error('body evicted')
  }, 'Network.loadingFinished', { requestId: 'n3', timestamp: 2 })
  await sleep(10)
  assert.equal(current.bodyTasks, 0, 'a thrown body fetch releases the in-flight slot')
  assert.equal(current.entries[0].bodyUnavailable, 'evicted')
  assert.equal(current.bodyTasksSet.size, 0, 'body task handles are released')

  // A capture that stops while a body is in flight must not receive the body
  // after release, and must still account the task as done.
  current = makeCapture({ storeBodies: true })
  request('n4')
  let releaseBody
  const gate = new Promise((resolve) => {
    releaseBody = resolve
  })
  handleNetworkEvent(tab, current, async () => gate, 'Network.loadingFinished', { requestId: 'n4', timestamp: 2.5 })
  current.active = false
  releaseBody({ body: '{"token":"SECRET"}', base64Encoded: false })
  await sleep(10)
  assert.equal(current.entries[0].responseBody, undefined, 'a stopped capture never receives the body')
  assert.equal(current.bodyTasks, 0, 'the in-flight slot is released after stop')
}

// ------------------------------------ screenshot stream stop/drop reclamation
{
  const driver = new HeadlessDriver({ home: '/tmp/dsh-m3-shot-stream-test' })
  driver.cdp = { send: async () => ({}) }
  const tab = { tabId: 51 }
  const state = driver.shotStreamState(tab)
  state.active = true
  state.last = { buffer: Buffer.from('cached frame'), composedAt: 1 }
  const waiter = driver.screenshot.waitShotFrame(state, 2, 5000)
  const waiterTimer = state.waiters[0].timer
  await driver.screenshot.stopShotStream(tab)
  assert.equal(await waiter, null, 'stop resolves pending screenshot waiters with null')
  assert.equal(waiterTimer._destroyed, true, 'stop clears the waiter timer')
  assert.equal(state.waiters.length, 0, 'stop clears the waiter list')
  assert.equal(state.last, null, 'stop releases the cached frame')
  assert.equal(state.active, false)
  assert.equal(state.stopTimer, null)
  cleanupHome('/tmp/dsh-m3-shot-stream-test')
}

{
  const driver = new HeadlessDriver({ home: '/tmp/dsh-m3-shot-drop-test' })
  const tab = { tabId: 52 }
  const state = driver.shotStreamState(tab)
  state.active = true
  state.last = { buffer: Buffer.from('keep me'), composedAt: 1 }
  driver.touchShotStream(tab, state)
  const idleTimer = state.stopTimer
  assert.ok(idleTimer, 'the idle timer is armed')
  driver.screenshot.dropShotStream(tab, { keepLast: true })
  assert.equal(idleTimer._destroyed, true, 'drop clears the idle timer')
  assert.equal(state.stopTimer, null)
  assert.equal(state.active, false, 'drop marks the stream inactive')
  assert.deepEqual(state.last?.buffer, Buffer.from('keep me'), 'keepLast preserves the cached frame')
  driver.screenshot.dropShotStream(tab)
  assert.equal(state.last, null, 'a later drop releases the cached frame')
  cleanupHome('/tmp/dsh-m3-shot-drop-test')
}

// -------------------------------- screencast pending frame cap / drop release
{
  const driver = new HeadlessDriver({
    home: '/tmp/dsh-m3-screencast-frame-test',
    shotFrameMaxBytes: 64,
    shotFrameMaxPixels: 100 * 100,
  })
  const tab = {
    tabId: 61,
    screencast: {
      active: true,
      frames: 0,
      format: 'jpeg',
      pending: null,
      flushTimer: null,
      lastWriteAt: 0,
      dirReady: false,
      owner: 'owner-frame',
    },
  }
  driver.screenshot.handleFrame(tab, { data: 'A'.repeat(400), metadata: { timestamp: 1 } })
  assert.equal(tab.screencast.pending, null, 'an oversized screencast frame never becomes pending')
  assert.equal(tab.screencast.oversized, 1)
  tab.screencast.pending = { data: 'small' }
  const dropped = driver.screenshot.dropScreencast(tab)
  assert.equal(dropped?.pending, null, 'dropScreencast releases the pending frame bytes')
  assert.equal(dropped?.active, false)
  assert.equal(tab.screencast, null)
  cleanupHome('/tmp/dsh-m3-screencast-frame-test')
}

console.log('MEMORY LIFECYCLE TEST: PASS')
