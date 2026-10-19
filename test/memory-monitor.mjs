/**
 * M7 — continuous memory sampling, numeric JSONL and alerts (no Chrome, no
 * real timers, no real filesystem).
 *
 * Pins the contract:
 *
 *   - `compactSample()` flattens a snapshot to numbers only (no page content);
 *   - start is explicit, samples once immediately, then follows the injected
 *     timer; stop clears it and keeps the ring readable;
 *   - the in-memory ring is bounded by `maxSamples`;
 *   - the JSONL file is mode 0600, holds one numeric record per sample, and
 *     records older than two days (or corrupt lines) are pruned on start;
 *   - every M7 alert raises and clears: rss growth, capture bodies, bridge
 *     pending, tabs != bySession, and a closed context whose chrome pid is
 *     still alive;
 *   - the tool exposes start/stop/dump/status without breaking the snapshot
 *     shape, and reports MONITOR_UNAVAILABLE without a monitor.
 */
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'

import {
  MEMORY_BRIDGE_PENDING_ALERT,
  MEMORY_CAPTURE_BODY_ALERT_BYTES,
  MEMORY_DEFAULT_INTERVAL_MS,
  MEMORY_JSONL_MAX_AGE_MS,
  MEMORY_RING_LIMIT,
  MEMORY_RSS_GROWTH_RATIO,
  MemoryMonitor,
  compactSample,
  snapshotChromePids,
} from '../src/memory-monitor.js'
import { chromeTools } from '../src/tools.js'

const HOME = path.join(os.tmpdir(), 'dsh-memory-monitor-home')
const JSONL_PATH = path.join(HOME, 'cache', 'dsh-chrome', 'memory.jsonl')

function fakeTimers() {
  const intervals = []
  return {
    intervals,
    setIntervalImpl(fn, ms) {
      const timer = {
        fn,
        ms,
        cleared: false,
        unref() {
          this.unrefed = true
        },
      }
      intervals.push(timer)
      return timer
    },
    clearIntervalImpl(timer) {
      timer.cleared = true
    },
    fire() {
      for (const timer of intervals) if (!timer.cleared) timer.fn()
    },
  }
}

function fakeFs() {
  const files = new Map()
  return {
    files,
    mkdirSync() {},
    readFileSync(file) {
      if (!files.has(file)) {
        const error = new Error(`ENOENT: ${file}`)
        error.code = 'ENOENT'
        throw error
      }
      return files.get(file).content
    },
    writeFileSync(file, content, options = {}) {
      files.set(file, { content: String(content), mode: options.mode ?? null })
    },
    appendFileSync(file, content, options = {}) {
      const existing = files.get(file)
      if (existing) existing.content += String(content)
      else files.set(file, { content: String(content), mode: options.mode ?? null })
    },
    chmodSync(file, mode) {
      const existing = files.get(file)
      if (existing) existing.mode = mode
    },
  }
}

function snapshot({
  rss = 1000,
  heapUsed = 500,
  arrayBuffers = 10,
  captureBodyBytes = 0,
  bridgePending = 0,
  tabs = 0,
  bySession = 0,
  pids = [],
} = {}) {
  return {
    at: new Date(1_000_000).toISOString(),
    pid: 42,
    node: { rss, heapUsed, heapTotal: rss * 2, external: 20, arrayBuffers },
    objects: {
      contexts: {
        contexts: pids.length,
        pending: 0,
        maxContexts: 4,
        drivers: pids.map((pid, index) => ({
          contextId: `ctx-${index}`,
          owner: `owner-${index}`,
          preset: 'sandbox',
          visible: false,
          connected: true,
          stats: { chromePid: pid, tabs: 1 },
        })),
        totals: {
          tabs,
          owners: pids.length,
          bySession,
          consoleBuffers: 0,
          captures: 0,
          captureEntries: 0,
          captureBodyBytes,
          downloads: 0,
          downloadByGuid: 0,
          shotStreams: 0,
          idleTimers: 0,
          visibleDrivers: 0,
        },
      },
      bridge: { connected: true, pending: bridgePending, handlers: 0 },
    },
  }
}

function makeMonitor(overrides = {}) {
  const timers = fakeTimers()
  const fsImpl = fakeFs()
  let clock = 1_000_000
  let sequence = 0
  const defaultSample = () =>
    snapshot({
      rss: 1000 + sequence * 100,
      captureBodyBytes: 0,
      bridgePending: 0,
      tabs: 1,
      bySession: 1,
      pids: [100 + sequence],
    })
  const monitor = new MemoryMonitor({
    sample: overrides.sample || (() => (sequence += 1, defaultSample())),
    home: HOME,
    jsonl: true,
    fsImpl,
    setIntervalImpl: timers.setIntervalImpl,
    clearIntervalImpl: timers.clearIntervalImpl,
    now: () => (clock += 1000),
    ...overrides.options,
  })
  return { monitor, timers, fsImpl, bumpClock: () => (clock += 1000) }
}

console.log('compactSample')
{
  const sample = compactSample(snapshot({ rss: 1234, arrayBuffers: 9, captureBodyBytes: 99, tabs: 2, bySession: 2, pids: [11, 22] }), 1234)
  assert.equal(sample.at, 1234)
  assert.equal(sample.rss, 1234)
  assert.equal(sample.arrayBuffers, 9)
  assert.equal(sample.captureBodyBytes, 99)
  assert.equal(sample.tabs, 2)
  assert.equal(sample.drivers, 2)
  assert.equal(sample.bridgeConnected, 1)
  for (const [key, value] of Object.entries(sample)) {
    assert.equal(typeof value, 'number', `${key} is a number (monitoring data has no page content)`)
  }
  assert.deepEqual(snapshotChromePids(snapshot({ pids: [11, 22] })), [11, 22])
  assert.deepEqual(snapshotChromePids({}), [])
  assert.equal(MEMORY_RING_LIMIT, 600)
  assert.equal(MEMORY_JSONL_MAX_AGE_MS, 2 * 24 * 60 * 60 * 1000)
  assert.equal(MEMORY_DEFAULT_INTERVAL_MS, 5000)
}

console.log('start/stop + ring + JSONL')
{
  const { monitor, timers, fsImpl } = makeMonitor()
  const started = monitor.start()
  assert.equal(started.started, true)
  assert.equal(started.running, true)
  assert.equal(started.intervalMs, MEMORY_DEFAULT_INTERVAL_MS)
  assert.equal(started.sampleCount, 1, 'start takes one immediate sample')
  assert.equal(timers.intervals.length, 1)
  assert.equal(timers.intervals[0].ms, MEMORY_DEFAULT_INTERVAL_MS)
  assert.equal(timers.intervals[0].unrefed, true)

  const file = fsImpl.files.get(JSONL_PATH)
  assert.ok(file, 'JSONL file is created under the provider cache')
  assert.equal(file.mode, 0o600, 'JSONL file is mode 0600')
  assert.equal(file.content.trim().split('\n').length, 1)
  for (const value of Object.values(JSON.parse(file.content.trim()))) {
    assert.equal(typeof value, 'number', 'every JSONL value is a number')
  }

  timers.fire()
  assert.equal(monitor.samples.length, 2)
  assert.equal(monitor.status().sampleCount, 2)
  assert.equal(JSON.parse(fsImpl.files.get(JSONL_PATH).content.trim().split('\n').at(-1)).at, monitor.latest.at)

  const dumped = monitor.dump()
  assert.equal(dumped.count, 2)
  assert.equal(dumped.running, true)
  assert.deepEqual(dumped.samples, monitor.samples)
  assert.ok(dumped.retained.rssDeltaBytes >= 0)
  assert.equal(dumped.retained.tabs, 1)
  assert.equal(dumped.retained.bySession, 1)
  assert.equal(dumped.retained.captureBodyBytes, 0)

  const stopped = monitor.stop()
  assert.equal(stopped.stopped, true)
  assert.equal(monitor.running, false)
  timers.fire()
  assert.equal(monitor.samples.length, 2, 'no sampling after stop')
  assert.equal(monitor.dump().count, 2, 'the ring stays readable after stop')
}

console.log('start is idempotent and the ring is bounded')
{
  const { monitor, timers } = makeMonitor({ options: { maxSamples: 3 } })
  monitor.start()
  const again = monitor.start()
  assert.equal(again.alreadyRunning, true)
  assert.equal(again.started, false)
  for (let index = 0; index < 5; index += 1) timers.fire()
  assert.equal(monitor.samples.length, 3, 'the ring keeps at most maxSamples')
  assert.equal(monitor.status().ringLimit, 3)
  monitor.stop()
}

console.log('alerts: rss growth raises and clears')
{
  const values = [snapshot({ rss: 1000 }), snapshot({ rss: 1300 }), snapshot({ rss: 1100 })]
  let index = 0
  const { monitor, timers } = makeMonitor({ sample: () => values[Math.min(index++, values.length - 1)] })
  monitor.start()
  timers.fire()
  assert.ok(monitor.status().alerts.some((alert) => alert.code === 'rss_growth'), 'rss above baseline * 1.2 alerts')
  assert.equal(monitor.status().alerts.find((alert) => alert.code === 'rss_growth').value, 1300)
  timers.fire()
  assert.equal(monitor.status().alerts.some((alert) => alert.code === 'rss_growth'), false, 'the alert clears')
  const log = monitor.dump().alertLog
  assert.ok(log.some((entry) => entry.code === 'rss_growth' && entry.state === 'raised'))
  assert.ok(log.some((entry) => entry.code === 'rss_growth' && entry.state === 'cleared'))
  assert.ok(monitor.baseline.rss <= 1000)
  assert.equal(MEMORY_RSS_GROWTH_RATIO, 1.2)
  monitor.stop()
}

console.log('alerts: capture bodies, bridge pending, tabs/sessions, closed pid')
{
  const values = [
    snapshot({
      captureBodyBytes: MEMORY_CAPTURE_BODY_ALERT_BYTES + 1,
      bridgePending: MEMORY_BRIDGE_PENDING_ALERT + 1,
      tabs: 2,
      bySession: 1,
      pids: [4242],
    }),
    snapshot({ tabs: 1, bySession: 1, pids: [] }),
  ]
  let index = 0
  const { monitor, timers } = makeMonitor({
    sample: () => values[Math.min(index++, values.length - 1)],
    options: { isPidAlive: (pid) => pid === 4242 },
  })
  monitor.start()
  const first = new Set(monitor.status().alerts.map((alert) => alert.code))
  assert.ok(first.has('capture_body_bytes'))
  assert.ok(first.has('bridge_pending'))
  assert.ok(first.has('tabs_sessions_mismatch'))
  assert.equal(first.has('chrome_pid_alive:4242'), false, 'a live pid is only an alert after its context disappears')
  timers.fire()
  const codes = new Set(monitor.status().alerts.map((alert) => alert.code))
  assert.equal(codes.has('chrome_pid_alive:4242'), true, 'a closed context whose chrome pid is alive alerts')
  assert.equal(codes.has('capture_body_bytes'), false, 'a recovered counter clears its alert')
  assert.equal(codes.has('bridge_pending'), false)
  assert.equal(codes.has('tabs_sessions_mismatch'), false)
  assert.equal(monitor.status().alerts.find((alert) => alert.code === 'chrome_pid_alive:4242').value, 4242)
  assert.equal(MEMORY_CAPTURE_BODY_ALERT_BYTES, 8 * 1024 * 1024)
  assert.equal(MEMORY_BRIDGE_PENDING_ALERT, 64)
  assert.equal(monitor.status().alerts.length, 1)
  monitor.stop()
}

console.log('sampling failure keeps the monitor alive')
{
  let fail = true
  const { monitor, timers } = makeMonitor({
    sample: () => {
      if (fail) throw new Error('sampler down')
      return snapshot({ tabs: 1, bySession: 1 })
    },
  })
  monitor.start()
  assert.equal(monitor.samples.length, 0)
  assert.equal(monitor.status().running, true)
  assert.equal(monitor.status().lastError, 'sampler down')
  fail = false
  timers.fire()
  assert.equal(monitor.samples.length, 1)
  assert.equal(monitor.status().lastError, null)
  monitor.stop()
}

console.log('JSONL prunes records older than two days and drops torn lines')
{
  const { monitor, fsImpl } = makeMonitor()
  const now = 2_000_000_000_000
  const oldStamp = now - MEMORY_JSONL_MAX_AGE_MS - 1000
  fsImpl.files.set(JSONL_PATH, {
    mode: 0o644,
    content:
      `${JSON.stringify({ at: oldStamp, rss: 1 })}\n` +
      `${JSON.stringify({ at: now - 1000, rss: 2 })}\n` +
      '{"at": torn\n' +
      `${JSON.stringify({ at: now, rss: 3 })}\n`,
  })
  const timers = fakeTimers()
  let clock = now
  const timed = new MemoryMonitor({
    sample: () => snapshot({ tabs: 1, bySession: 1 }),
    home: HOME,
    jsonl: true,
    fsImpl,
    setIntervalImpl: timers.setIntervalImpl,
    clearIntervalImpl: timers.clearIntervalImpl,
    now: () => clock,
  })
  timed.start()
  const lines = fsImpl.files.get(JSONL_PATH).content.trim().split('\n').map((line) => JSON.parse(line))
  assert.equal(lines.length, 3, 'two retained records + the new sample')
  assert.equal(lines.some((line) => line.at === oldStamp), false, 'the old record is pruned')
  assert.equal(lines.some((line) => line.rss === 2), true)
  assert.equal(lines.some((line) => line.rss === 3), true)
  assert.equal(fsImpl.files.get(JSONL_PATH).mode, 0o600, 'an existing JSONL file is re-chmodded to 0600')
  timed.stop()
}

console.log('chrome_memory_stats monitor ops')
{
  const { monitor, timers } = makeMonitor({ options: { intervalMs: 5000 } })
  const tool = chromeTools({
    bridge: {},
    memoryStats: () => snapshot({ tabs: 1, bySession: 1 }),
    memoryMonitor: monitor,
  }).find((definition) => definition.name === 'chrome_memory_stats')

  const status = await tool.execute({})
  assert.equal(status.ok, true)
  assert.equal(status.op, 'status')
  assert.equal(status.monitor.available, true)
  assert.equal(status.monitor.running, false)
  assert.match(tool.output.render({}, status)[0].text, /monitor: stopped/)

  const started = await tool.execute({ op: 'start', intervalMs: 1234 })
  assert.equal(started.ok, true)
  assert.equal(started.started, true)
  assert.equal(started.intervalMs, 1234)
  assert.equal(started.monitor.running, true)
  assert.match(tool.output.render({ op: 'start' }, started)[0].text, /Memory monitor started: every 1234ms/)

  timers.fire()
  const dumped = await tool.execute({ op: 'dump' })
  assert.equal(dumped.ok, true)
  assert.equal(dumped.op, 'dump')
  assert.equal(dumped.count, 2)
  assert.equal(dumped.samples.length, 2)
  assert.ok(dumped.retained && typeof dumped.retained.rssDeltaBytes === 'number')
  assert.equal(dumped.jsonl.enabled, true)
  assert.match(tool.output.render({ op: 'dump' }, dumped)[0].text, /Memory monitor dump: 2 sample/)
  assert.match(tool.output.render({ op: 'dump' }, dumped)[0].text, /retained now:/)

  const stopped = await tool.execute({ op: 'stop' })
  assert.equal(stopped.ok, true)
  assert.equal(stopped.stopped, true)
  assert.equal(stopped.monitor.running, false)

  const invalid = await tool.execute({ op: 'nonsense' })
  assert.equal(invalid.ok, false)
  assert.equal(invalid.error, 'INVALID_ARGUMENT')

  const noMonitor = chromeTools({ bridge: {}, memoryStats: () => snapshot() }).find(
    (definition) => definition.name === 'chrome_memory_stats',
  )
  const unavailable = await noMonitor.execute({ op: 'start' })
  assert.equal(unavailable.ok, false)
  assert.equal(unavailable.error, 'MONITOR_UNAVAILABLE')
  assert.match(noMonitor.output.render({ op: 'start' }, unavailable)[0].text, /failed: MONITOR_UNAVAILABLE/)
  const unavailableDump = await noMonitor.execute({ op: 'dump' })
  assert.equal(unavailableDump.error, 'MONITOR_UNAVAILABLE')
}

console.log('MemoryMonitor rejects a missing sampler')
assert.throws(() => new MemoryMonitor({ home: HOME }), /sample function/)

console.log('\nMEMORY MONITOR TEST: PASS')
