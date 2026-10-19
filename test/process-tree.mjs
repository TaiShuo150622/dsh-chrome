/**
 * M8 — Chrome process-tree RSS (no real ps, no Chrome).
 *
 * Pins the contract:
 *
 *   - `ps -axo pid=,ppid=,rss=` parsing and the recursive parent/child walk,
 *     including cycle safety and KiB -> bytes conversion;
 *   - Windows reports unsupported without spawning anything, and a gone pid,
 *     invalid pid or failed `ps` returns nulls instead of throwing;
 *   - `HeadlessDriver.memoryStats()` adds best-effort `chromeRss`/`processCount`
 *     and still returns every M6 counter when the reader fails;
 *   - the context manager aggregates the Chrome-side totals, and
 *     `chrome_memory_stats` (and the monitor sample) expose them.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { DEFAULT_CONFIG } from '../src/config.js'
import { BrowserContextManager } from '../src/contexts.js'
import { HeadlessDriver } from '../src/headless.js'
import { collectMemoryStats } from '../src/memory-stats.js'
import { compactSample } from '../src/memory-monitor.js'
import { parsePsTable, processTreeFromTable, readProcessTree } from '../src/process-tree.js'
import { chromeTools } from '../src/tools.js'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-m8-process-tree-'))
const cleanup = () => {
  try {
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  } catch {}
}

const PS_OUTPUT = `
  100     1  1024
  101   100  2048
  102   101  3072
  200     1  5000
`

function fakeDriver(stats) {
  return { connected: true, memoryStats: () => stats }
}

function fakeContext(contextId, driver) {
  return {
    contextId,
    owner: `owner-${contextId}`,
    preset: 'sandbox',
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
  console.log('parsePsTable / processTreeFromTable')
  const table = parsePsTable(PS_OUTPUT)
  assert.equal(table.size, 4)
  assert.deepEqual(table.get(100), { ppid: 1, rssKb: 1024 })
  assert.deepEqual(table.get(102), { ppid: 101, rssKb: 3072 })
  assert.equal(parsePsTable('not a ps line\n').size, 0)

  const tree = processTreeFromTable(100, table)
  assert.deepEqual(tree, { rss: (1024 + 2048 + 3072) * 1024, processCount: 3 })
  assert.equal(processTreeFromTable(999, table), null, 'a gone pid has no tree')
  assert.equal(processTreeFromTable(0, table), null)
  assert.equal(processTreeFromTable('nonsense', table), null)

  const cycle = new Map([
    [1, { ppid: 2, rssKb: 10 }],
    [2, { ppid: 1, rssKb: 20 }],
  ])
  assert.deepEqual(processTreeFromTable(1, cycle), { rss: 30 * 1024, processCount: 2 }, 'a malformed cycle terminates')

  console.log('readProcessTree')
  const calls = []
  const exec = (file, args, options) => {
    calls.push({ file, args, options })
    return PS_OUTPUT
  }
  const read = readProcessTree(100, { platform: 'linux', exec })
  assert.deepEqual(read, { supported: true, rss: (1024 + 2048 + 3072) * 1024, processCount: 3 })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].file, 'ps')
  assert.deepEqual(calls[0].args, ['-axo', 'pid=,ppid=,rss='])
  assert.equal(calls[0].options.encoding, 'utf8')
  assert.ok(calls[0].options.timeout > 0)

  assert.deepEqual(readProcessTree(999, { platform: 'linux', exec }), {
    supported: true,
    rss: null,
    processCount: null,
  })
  assert.deepEqual(readProcessTree(0, { platform: 'linux', exec }), {
    supported: true,
    rss: null,
    processCount: null,
  })
  assert.deepEqual(readProcessTree(NaN, { platform: 'linux', exec }), {
    supported: true,
    rss: null,
    processCount: null,
  })
  assert.deepEqual(
    readProcessTree(100, {
      platform: 'linux',
      exec: () => {
        throw new Error('ps is missing')
      },
    }),
    { supported: true, rss: null, processCount: null },
    'a failed ps is best-effort, not an exception',
  )

  let windowsExecCalled = false
  assert.deepEqual(
    readProcessTree(100, {
      platform: 'win32',
      exec: () => {
        windowsExecCalled = true
        return PS_OUTPUT
      },
    }),
    { supported: false, rss: null, processCount: null },
  )
  assert.equal(windowsExecCalled, false, 'Windows never spawns ps')

  console.log('HeadlessDriver.memoryStats')
  const treeCalls = []
  const driver = new HeadlessDriver({
    home,
    executable: process.execPath,
    processTree: (pid) => {
      treeCalls.push(pid)
      return { rss: 8192, processCount: 5 }
    },
  })
  driver.chrome = { pid: 4242 }
  const stats = driver.memoryStats()
  assert.equal(stats.chromePid, 4242)
  assert.equal(stats.chromeRss, 8192)
  assert.equal(stats.processCount, 5)
  assert.equal(stats.tabs, 0, 'the M6 counters are still present')
  assert.ok(Array.isArray(treeCalls) && treeCalls[0] === 4242)
  driver.chrome = null
  treeCalls.length = 0
  assert.deepEqual(
    { chromePid: driver.memoryStats().chromePid, chromeRss: driver.memoryStats().chromeRss, processCount: driver.memoryStats().processCount },
    { chromePid: null, chromeRss: null, processCount: null },
  )
  assert.equal(treeCalls.length, 0, 'no chrome pid means no ps call')

  const failingDriver = new HeadlessDriver({
    home,
    executable: process.execPath,
    processTree: () => {
      throw new Error('ps exploded')
    },
  })
  failingDriver.chrome = { pid: 123 }
  const failedStats = failingDriver.memoryStats()
  assert.equal(failedStats.chromeRss, null)
  assert.equal(failedStats.processCount, null)
  assert.equal(failedStats.tabs, 0, 'a failed process read never breaks the snapshot')

  const nullDriver = new HeadlessDriver({
    home,
    executable: process.execPath,
    processTree: () => ({ rss: Infinity, processCount: undefined }),
  })
  nullDriver.chrome = { pid: 123 }
  assert.equal(nullDriver.memoryStats().chromeRss, null)
  assert.equal(nullDriver.memoryStats().processCount, null)

  const disabledDriver = new HeadlessDriver({ home, executable: process.execPath, processTree: null })
  disabledDriver.chrome = { pid: 123 }
  assert.equal(disabledDriver.memoryStats().chromeRss, null)

  console.log('BrowserContextManager aggregation')
  const manager = new BrowserContextManager({
    config: { ...DEFAULT_CONFIG, browser: { ...DEFAULT_CONFIG.browser, maxContexts: 4 } },
    createDriver: () => {
      throw new Error('createDriver is not used by this test')
    },
    home,
  })
  manager.contexts.set(
    'ctx-a',
    fakeContext('ctx-a', fakeDriver({ chromePid: 111, chromeRss: 8192, processCount: 5, tabs: 1, bySession: 1 })),
  )
  manager.contexts.set(
    'ctx-b',
    fakeContext('ctx-b', fakeDriver({ chromePid: 222, chromeRss: 1024, processCount: 1, tabs: 1, bySession: 1 })),
  )
  const aggregate = manager.memoryStats()
  assert.equal(aggregate.totals.chromeRss, 9216)
  assert.equal(aggregate.totals.processCount, 6)
  assert.equal(aggregate.drivers[0].stats.chromeRss, 8192)
  const emptyManager = new BrowserContextManager({
    config: { ...DEFAULT_CONFIG, browser: { ...DEFAULT_CONFIG.browser, maxContexts: 2 } },
    createDriver: () => {},
    home,
  })
  assert.equal(emptyManager.memoryStats().totals.chromeRss, null, 'no driver means unknown, not zero')
  assert.equal(emptyManager.memoryStats().totals.processCount, null)

  console.log('chrome_memory_stats returns the Chrome side')
  const tool = chromeTools({
    bridge: {},
    memoryStats: () => collectMemoryStats({ contexts: manager, bridge: null }),
  }).find((definition) => definition.name === 'chrome_memory_stats')
  const result = await tool.execute({})
  assert.equal(result.ok, true)
  assert.equal(result.objects.contexts.totals.chromeRss, 9216)
  assert.equal(result.objects.contexts.totals.processCount, 6)
  assert.equal(result.objects.contexts.drivers[0].stats.chromeRss, 8192)
  const rendered = tool.output.render({}, result)[0].text
  assert.match(rendered, /chrome processes: 6/)
  assert.match(rendered, /chrome pid 111/)
  assert.match(rendered, /rss 8\.0KB \(5 proc\)/)

  const sample = compactSample(result, 1_000)
  assert.equal(sample.chromeRss, 9216)
  assert.equal(sample.processCount, 6)
  for (const [key, value] of Object.entries(sample)) {
    assert.equal(typeof value, 'number', `${key} stays numeric in the monitor sample`)
  }

  console.log('\nPROCESS TREE TEST: PASS')
} finally {
  cleanup()
}
