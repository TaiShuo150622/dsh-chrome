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

console.log('MEMORY LIFECYCLE TEST: PASS')
