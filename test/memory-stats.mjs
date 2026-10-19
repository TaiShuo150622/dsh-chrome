/**
 * M6 — chrome_memory_stats snapshot (no Chrome required).
 *
 * Pins the monitoring contract:
 *
 *   - `nodeMemory()` reports the five byte counters, defaulting malformed input
 *     to zero;
 *   - `HeadlessDriver.memoryStats()` counts every retained map/array and never
 *     exposes page content (only numbers, booleans and the chrome pid);
 *   - `BrowserContextManager.memoryStats()` sums driver counters and keeps the
 *     per-context detail, tolerating a driver without stats or one that throws;
 *   - `BridgeServer.memoryStats()` reports connected/pending/handlers;
 *   - `objectCounts()` keeps the full zero-valued shape without a manager or
 *     bridge;
 *   - the `chrome_memory_stats` tool is registered once, uses the injected
 *     reader, degrades safely when it throws, and stays backend-agnostic.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { BackendRouter, wrapToolsForBackend } from '../src/backend.js'
import { BridgeServer } from '../src/bridge.js'
import { DEFAULT_CONFIG } from '../src/config.js'
import { BrowserContextManager } from '../src/contexts.js'
import { HeadlessDriver } from '../src/headless.js'
import {
  DRIVER_COUNT_FIELDS,
  collectMemoryStats,
  emptyBridgeStats,
  emptyContextStats,
  nodeMemory,
  objectCounts,
} from '../src/memory-stats.js'
import { chromeTools } from '../src/tools.js'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-m6-memory-'))
const cleanup = () => {
  try {
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  } catch {}
}

function fakeDriver(stats, { connected = true } = {}) {
  return {
    connected,
    memoryStats() {
      if (stats instanceof Error) throw stats
      return stats
    },
  }
}

function fakeContext(contextId, driver, { owner = `owner-${contextId}`, preset = 'sandbox' } = {}) {
  return {
    contextId,
    owner,
    preset,
    isolation: 'sandbox',
    visible: false,
    profileId: `profile-${contextId}`,
    profileDir: path.join(home, 'profiles', contextId),
    ephemeral: true,
    createdAt: 1,
    lastUsedAt: 1,
    driver,
  }
}

try {
  // ------------------------------------------------------------- nodeMemory
  console.log('nodeMemory')
  assert.deepEqual(nodeMemory({ rss: 1000.6, heapUsed: 2, heapTotal: 3, external: 4, arrayBuffers: 5 }), {
    rss: 1001,
    heapUsed: 2,
    heapTotal: 3,
    external: 4,
    arrayBuffers: 5,
  })
  assert.deepEqual(nodeMemory({}), { rss: 0, heapUsed: 0, heapTotal: 0, external: 0, arrayBuffers: 0 })
  assert.deepEqual(nodeMemory(null), { rss: 0, heapUsed: 0, heapTotal: 0, external: 0, arrayBuffers: 0 })
  const liveNode = nodeMemory()
  for (const field of ['rss', 'heapUsed', 'heapTotal', 'external', 'arrayBuffers']) {
    assert.ok(Number.isFinite(liveNode[field]) && liveNode[field] >= 0, `${field} is a live byte counter`)
  }

  // ------------------------------------------------------ HeadlessDriver
  console.log('HeadlessDriver.memoryStats')
  const driver = new HeadlessDriver({ home, executable: process.execPath, visible: true })
  driver.chrome = { pid: 4242 }
  driver.owners.set('owner-a', { owner: 'owner-a', tabs: new Map(), pending: 0, activeTabId: null })
  driver.bySession.set('session-1', {})
  driver.consoleBuffers.set(1, [{ level: 'error', text: 'not exposed' }])
  driver.consoleBuffers.set(2, [])
  driver.captures.set('cap-1', { entries: [{}, {}], bodyBytes: 900 })
  driver.captures.set('cap-2', { entries: [{}, {}], bodyBytes: 125 })
  driver.downloads.push({}, {}, {})
  driver.downloadByGuid.set('guid-1', {})
  driver.downloadByGuid.set('guid-2', {})
  driver.tabs.set(1, { tabId: 1, shotStream: { active: true, waiters: [], stopTimer: null } })
  driver.tabs.set(2, { tabId: 2 })
  driver.idleTimer = setInterval(() => {}, 60_000)
  driver.idleTimer.unref?.()

  const driverStats = driver.memoryStats()
  assert.deepEqual(driverStats, {
    chromePid: 4242,
    tabs: 2,
    owners: 1,
    bySession: 1,
    consoleBuffers: 2,
    captures: 2,
    captureEntries: 4,
    captureBodyBytes: 1025,
    downloads: 3,
    downloadByGuid: 2,
    shotStreams: 1,
    idleTimer: true,
    visible: true,
  })
  for (const [key, value] of Object.entries(driverStats)) {
    assert.ok(
      value === null || typeof value === 'number' || typeof value === 'boolean',
      `${key} is a number, boolean or null (no page content)`,
    )
  }

  driver.stopIdleTimer()
  assert.equal(driver.memoryStats().idleTimer, false)
  driver.chrome = null
  driver.loginProcess = { pid: 999 }
  assert.equal(driver.memoryStats().chromePid, 999, 'a visible login window is still a chrome pid')
  driver.loginProcess = null
  driver.handleBrowserExit('test')
  assert.deepEqual(driver.memoryStats(), {
    chromePid: null,
    tabs: 0,
    owners: 0,
    bySession: 0,
    consoleBuffers: 0,
    captures: 0,
    captureEntries: 0,
    captureBodyBytes: 0,
    downloads: 0,
    downloadByGuid: 0,
    shotStreams: 0,
    idleTimer: false,
    visible: true,
  })

  // ------------------------------------------------ BrowserContextManager
  console.log('BrowserContextManager.memoryStats')
  const manager = new BrowserContextManager({
    config: { ...DEFAULT_CONFIG, browser: { ...DEFAULT_CONFIG.browser, maxContexts: 4 } },
    createDriver: () => {
      throw new Error('createDriver is not used by this test')
    },
    home,
  })
  manager.pending = 1
  const statsA = {
    chromePid: 111,
    tabs: 2,
    owners: 1,
    bySession: 2,
    consoleBuffers: 2,
    captures: 1,
    captureEntries: 4,
    captureBodyBytes: 1000,
    downloads: 3,
    downloadByGuid: 2,
    shotStreams: 1,
    idleTimer: true,
    visible: true,
  }
  const statsB = {
    chromePid: 222,
    tabs: 1,
    owners: 0,
    bySession: 1,
    consoleBuffers: 1,
    captures: 0,
    captureEntries: 0,
    captureBodyBytes: 0,
    downloads: 0,
    downloadByGuid: 0,
    shotStreams: 0,
    idleTimer: false,
    visible: false,
  }
  manager.contexts.set('ctx-a', fakeContext('ctx-a', fakeDriver(statsA)))
  manager.contexts.set('ctx-b', fakeContext('ctx-b', fakeDriver(statsB)))
  manager.contexts.set('ctx-c', fakeContext('ctx-c', { connected: false }))
  manager.contexts.set(
    'ctx-d',
    fakeContext('ctx-d', fakeDriver(new Error('driver failed to report memory'))),
  )

  const aggregate = manager.memoryStats()
  assert.equal(aggregate.contexts, 4)
  assert.equal(aggregate.pending, 1)
  assert.equal(aggregate.maxContexts, 4)
  assert.equal(aggregate.drivers.length, 4)
  assert.deepEqual(aggregate.drivers.find((entry) => entry.contextId === 'ctx-a')?.stats, statsA)
  assert.equal(aggregate.drivers.find((entry) => entry.contextId === 'ctx-c')?.stats, null)
  assert.equal(aggregate.drivers.find((entry) => entry.contextId === 'ctx-d')?.stats, null)
  assert.equal(aggregate.drivers.find((entry) => entry.contextId === 'ctx-c')?.connected, false)
  for (const field of DRIVER_COUNT_FIELDS) {
    assert.equal(typeof aggregate.totals[field], 'number', `${field} is aggregated as a number`)
  }
  const totals = aggregate.totals
  assert.equal(totals.tabs, 3)
  assert.equal(totals.owners, 1)
  assert.equal(totals.bySession, 3)
  assert.equal(totals.consoleBuffers, 3)
  assert.equal(totals.captures, 1)
  assert.equal(totals.captureEntries, 4)
  assert.equal(totals.captureBodyBytes, 1000)
  assert.equal(totals.downloads, 3)
  assert.equal(totals.downloadByGuid, 2)
  assert.equal(totals.shotStreams, 1)
  assert.equal(totals.idleTimers, 1)
  assert.equal(totals.visibleDrivers, 1)

  // A manager with no contexts still returns the complete zero shape.
  const emptyManager = new BrowserContextManager({
    config: { ...DEFAULT_CONFIG, browser: { ...DEFAULT_CONFIG.browser, maxContexts: 2 } },
    createDriver: () => {},
    home,
  })
  assert.deepEqual(emptyManager.memoryStats(), {
    ...emptyContextStats(),
    maxContexts: 2,
  })

  // ---------------------------------------------------------- BridgeServer
  console.log('BridgeServer.memoryStats')
  const bridge = new BridgeServer({ home })
  assert.deepEqual(bridge.memoryStats(), { connected: false, pending: 0, handlers: 0 })
  bridge.pending.set('1', {})
  bridge.pending.set('2', {})
  bridge.handlers.set('browser.status', () => {})
  assert.deepEqual(bridge.memoryStats(), { connected: false, pending: 2, handlers: 1 })
  bridge.socket = { destroyed: false }
  bridge.authed = true
  assert.deepEqual(bridge.memoryStats(), { connected: true, pending: 2, handlers: 1 })
  bridge.socket = null
  bridge.authed = false

  // ---------------------------------------------------------- objectCounts
  console.log('objectCounts')
  const fakeContexts = {
    memoryStats: () => ({ contexts: 2, pending: 1, maxContexts: 5, drivers: [], totals: { tabs: 3 } }),
  }
  const fakeBridge = { memoryStats: () => ({ connected: true, pending: 4, handlers: 2 }) }
  const counted = objectCounts({ contexts: fakeContexts, bridge: fakeBridge })
  assert.deepEqual(counted.contexts, fakeContexts.memoryStats())
  assert.deepEqual(counted.bridge, { connected: true, pending: 4, handlers: 2 })
  const emptyCounts = objectCounts()
  assert.deepEqual(emptyCounts.contexts, emptyContextStats())
  assert.deepEqual(emptyCounts.bridge, emptyBridgeStats())
  const brokenCounts = objectCounts({
    contexts: {
      memoryStats() {
        throw new Error('broken context manager')
      },
    },
    bridge: { memoryStats: () => null },
  })
  assert.deepEqual(brokenCounts.contexts, emptyContextStats())
  assert.deepEqual(brokenCounts.bridge, emptyBridgeStats())

  // ------------------------------------------------------ collectMemoryStats
  console.log('collectMemoryStats')
  const at = new Date('2026-10-19T12:00:00.000Z')
  const collected = collectMemoryStats({
    contexts: fakeContexts,
    bridge: fakeBridge,
    now: () => at,
    pid: 77,
  })
  assert.equal(collected.at, at.toISOString())
  assert.equal(collected.pid, 77)
  assert.ok(collected.node.rss > 0 && collected.node.heapTotal > 0)
  assert.deepEqual(collected.objects.bridge, { connected: true, pending: 4, handlers: 2 })
  assert.equal(collected.objects.contexts.contexts, 2)

  // ------------------------------------------------------ chrome_memory_stats
  console.log('chrome_memory_stats tool')
  const snapshot = {
    at: at.toISOString(),
    pid: 77,
    node: { rss: 10, heapUsed: 4, heapTotal: 8, external: 2, arrayBuffers: 1 },
    objects: {
      contexts: {
        contexts: 1,
        pending: 0,
        maxContexts: 4,
        drivers: [
          { contextId: 'ctx-a', owner: 'owner-a', preset: 'sandbox', visible: false, connected: true, stats: statsA },
        ],
        totals: {
          tabs: 2,
          owners: 1,
          bySession: 2,
          consoleBuffers: 2,
          captures: 1,
          captureEntries: 4,
          captureBodyBytes: 1000,
          downloads: 3,
          downloadByGuid: 2,
          shotStreams: 1,
          idleTimers: 1,
          visibleDrivers: 1,
        },
      },
      bridge: { connected: true, pending: 0, handlers: 0 },
    },
  }
  const tools = chromeTools({ bridge: {}, memoryStats: () => snapshot })
  assert.equal(tools.length, 46, '45 previous tools + chrome_memory_stats')
  const memoryTool = tools.find((tool) => tool.name === 'chrome_memory_stats')
  assert.ok(memoryTool, 'chrome_memory_stats is registered')
  assert.equal(memoryTool.mutating, undefined, 'the snapshot does not mutate the browser')
  assert.equal(tools.filter((tool) => tool.name === 'chrome_memory_stats').length, 1)
  const result = await memoryTool.execute({})
  assert.equal(result.ok, true)
  assert.equal(result.op, 'status')
  assert.equal(result.at, snapshot.at)
  assert.equal(result.pid, snapshot.pid)
  assert.deepEqual(result.node, snapshot.node)
  assert.deepEqual(result.objects, snapshot.objects)
  assert.deepEqual(result.monitor, { available: false, running: false })
  const rendered = memoryTool.output.render({}, result)[0].text
  assert.match(rendered, /Memory snapshot/)
  assert.match(rendered, /tabs 2/)
  assert.match(rendered, /bridge: CONNECTED/)
  assert.match(rendered, /monitor: unavailable/)

  // Without an injected reader the tool still reports this process and zero
  // object counts (no context manager / bridge wired in the test).
  const bareTool = chromeTools({ bridge: {} }).find((tool) => tool.name === 'chrome_memory_stats')
  const bare = await bareTool.execute({})
  assert.equal(bare.ok, true)
  assert.equal(bare.op, 'status')
  assert.ok(bare.node.rss > 0)
  assert.deepEqual(bare.objects.contexts, emptyContextStats())
  assert.deepEqual(bare.objects.bridge, emptyBridgeStats())

  // A failing reader degrades to a Node-only snapshot with the reason.
  const failingTool = chromeTools({
    bridge: {},
    memoryStats: () => {
      throw new Error('collector exploded')
    },
  }).find((tool) => tool.name === 'chrome_memory_stats')
  const failed = await failingTool.execute({})
  assert.equal(failed.ok, false)
  assert.equal(failed.op, 'status')
  assert.equal(failed.error, 'collector exploded')
  assert.ok(failed.node.rss > 0)
  assert.deepEqual(failed.objects.contexts, emptyContextStats())

  // The tool reports process-wide state, so the backend wrapper must not add a
  // misleading routing parameter (chrome_verify has the same contract).
  const router = new BackendRouter({ desktop: { connected: false, call: async () => ({}) } })
  const wrapped = wrapToolsForBackend(tools, router)
  assert.equal(wrapped.length, 46)
  const wrappedMemory = wrapped.find((tool) => tool.name === 'chrome_memory_stats')
  const wrappedStatus = wrapped.find((tool) => tool.name === 'chrome_status')
  assert.equal(wrappedMemory.parameters.properties.backend, undefined)
  assert.ok(wrappedStatus.parameters.properties.backend, 'ordinary tools still receive the backend parameter')

  // The schema test (test/tool-schemas.mjs) iterates every registered tool, so
  // pin the two fields the render depends on here as well.
  assert.equal(memoryTool.parameters.additionalProperties, false)
  assert.ok(memoryTool.output.schema?.properties?.node)
  assert.ok(memoryTool.output.schema?.properties?.objects)

  console.log('\nMEMORY STATS TEST: PASS')
} finally {
  cleanup()
}
