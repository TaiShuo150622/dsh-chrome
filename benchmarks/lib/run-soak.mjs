/**
 * Fixed memory soak for the headless browser backend.
 *
 * Workload (docs/LIFECYCLE.md "固定压测"):
 *
 *   repeat N rounds:
 *     1 context → 4 tabs; each tab goto + snapshot + screenshot
 *     10× capture start/stop, 10× screencast start/stop
 *     close every tab, close the context, wait for Chrome to exit, settle
 *
 * Every round records:
 *   - Node rss/heapUsed/heapTotal/external/arrayBuffers,
 *   - the Chrome process-tree rss and process count (best effort),
 *   - retained-object counts (tabs/bySession/owners/captures/
 *     captureBodyBytes/pending/downloadByGuid/...),
 *   - the round peak, the after-close baseline, and the retained delta.
 *
 * The harness is driver-agnostic: `createDriver` is injected, so tests run the
 * exact workload against a deterministic fake, and the CLI injects the real
 * `HeadlessDriver`. `BrowserContextManager`, the memory aggregation and the
 * invariants are the same objects in both modes.
 *
 * Failure policy: an action error or invariant violation is recorded on the
 * round, not thrown, so a run can complete and show *where* it leaked. The CLI
 * exits non-zero when `strict` is on (the default); tests use the report to
 * assert the positive controls.
 */
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'

import { BrowserContextManager } from '../../src/contexts.js'
import { DEFAULT_CONFIG } from '../../src/config.js'
import { BridgeServer } from '../../src/bridge.js'
import { CAPTURE_SUMMARY_LIMIT, HeadlessDriver, headlessChromeExecutable } from '../../src/headless.js'
import { collectMemoryStats } from '../../src/memory-stats.js'
import { readProcessTree } from '../../src/process-tree.js'
import { createFakeDriverFactory } from './fake-driver.mjs'
import {
  NODE_FIELDS,
  OBJECT_FIELDS,
  SCHEMA_VERSION,
  deltaNode,
  deltaObjects,
  summarize,
  writeReport,
} from './report.mjs'

export const SOAK_SCENARIO = 'fixed-1context-4tabs-capture10-screencast10'
export const SOAK_OWNER = 'soak'

export const SOAK_DEFAULTS = Object.freeze({
  rounds: 20,
  tabsPerRound: 4,
  captureCyclesPerRound: 10,
  screencastCyclesPerRound: 10,
  pageBytes: 8192,
  captureTraffic: 'reload',
  captureSettleMs: 100,
  screencastSettleMs: 120,
  settleMs: 500,
  // Chrome's shutdown tail is occasionally several seconds (observed 5.2s on
  // this machine) even though it always exited; a 5s cap produced false leak
  // failures. 15s still fails a genuinely stuck process.
  exitTimeoutMs: 15000,
  exitPollMs: 100,
  gc: true,
  strict: true,
})

const ACTION_KEYS = Object.freeze([
  'contextCreate',
  'contextClose',
  'tabNew',
  'goto',
  'snapshot',
  'screenshot',
  'captureStart',
  'captureStop',
  'captureReload',
  'screencastStart',
  'screencastStop',
  'tabClose',
])

const DRIVER_ZERO_FIELDS = Object.freeze([
  'tabs',
  'owners',
  'bySession',
  'consoleBuffers',
  'captures',
  'captureEntries',
  'captureBodyBytes',
  'downloads',
  'downloadByGuid',
  'shotStreams',
])

const CHECKED = Object.freeze([
  'tabs-bySession',
  'owners-present-while-tabs-open',
  'capture-summary-limit',
  'capture-body-budget',
  'capture-body-released-on-stop',
  'downloads-index',
  'bridge-pending-zero',
  'driver-zero-after-close',
  'chrome-pid-gone-after-close',
  'chrome-process-exited',
  'manager-zero-after-close',
  'actions-match-workload',
])

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function sleepMs(ms) {
  return Math.max(0, Number(ms) || 0)
}

function safeDriverStats(driver) {
  if (!driver || typeof driver.memoryStats !== 'function') return null
  try {
    return driver.memoryStats()
  } catch {
    return null
  }
}

function finiteOrNull(value) {
  return Number.isFinite(value) ? value : null
}

function flattenStats(stats) {
  const contexts = stats?.objects?.contexts || {}
  const totals = contexts.totals || {}
  const bridge = stats?.objects?.bridge || {}
  return {
    tabs: Number(totals.tabs) || 0,
    bySession: Number(totals.bySession) || 0,
    owners: Number(totals.owners) || 0,
    captures: Number(totals.captures) || 0,
    captureEntries: Number(totals.captureEntries) || 0,
    captureBodyBytes: Number(totals.captureBodyBytes) || 0,
    pending: Number(bridge.pending) || 0,
    downloads: Number(totals.downloads) || 0,
    downloadByGuid: Number(totals.downloadByGuid) || 0,
    shotStreams: Number(totals.shotStreams) || 0,
    consoleBuffers: Number(totals.consoleBuffers) || 0,
    contexts: Number(contexts.contexts) || 0,
    pendingContexts: Number(contexts.pending) || 0,
    idleTimers: Number(totals.idleTimers) || 0,
    visibleDrivers: Number(totals.visibleDrivers) || 0,
  }
}

function zeroObjects() {
  const objects = {}
  for (const field of OBJECT_FIELDS) objects[field] = 0
  return objects
}

function zeroNode() {
  const node = {}
  for (const field of NODE_FIELDS) node[field] = 0
  return node
}

function createPeak() {
  return { node: zeroNode(), objects: zeroObjects(), chromeRss: null, processCount: null }
}

function mergePeak(peak, snapshot) {
  for (const field of NODE_FIELDS) peak.node[field] = Math.max(peak.node[field], snapshot.node?.[field] ?? 0)
  for (const field of OBJECT_FIELDS) peak.objects[field] = Math.max(peak.objects[field], snapshot.objects?.[field] ?? 0)
  if (Number.isFinite(snapshot.chromeRss)) peak.chromeRss = Math.max(peak.chromeRss ?? 0, snapshot.chromeRss)
  if (Number.isFinite(snapshot.processCount)) peak.processCount = Math.max(peak.processCount ?? 0, snapshot.processCount)
}

function gcNow() {
  if (typeof global.gc !== 'function') return false
  global.gc()
  global.gc()
  return true
}

function scenarioConfig(options) {
  return {
    rounds: options.rounds,
    tabsPerRound: options.tabsPerRound,
    captureCyclesPerRound: options.captureCyclesPerRound,
    screencastCyclesPerRound: options.screencastCyclesPerRound,
    pageBytes: options.pageBytes,
    captureTraffic: options.captureTraffic,
    captureSettleMs: options.captureSettleMs,
    screencastSettleMs: options.screencastSettleMs,
    settleMs: options.settleMs,
    exitTimeoutMs: options.exitTimeoutMs,
    driver: options.driverKind,
  }
}

function scenarioId(config) {
  return createHash('sha256').update(JSON.stringify(config)).digest('hex').slice(0, 12)
}

function expectedActions(options) {
  return {
    contextCreate: 1,
    contextClose: 1,
    tabNew: options.tabsPerRound,
    goto: options.tabsPerRound,
    snapshot: options.tabsPerRound,
    screenshot: options.tabsPerRound,
    captureStart: options.captureCyclesPerRound,
    captureStop: options.captureCyclesPerRound,
    captureReload: options.captureTraffic === 'reload' ? options.captureCyclesPerRound : 0,
    screencastStart: options.screencastCyclesPerRound,
    screencastStop: options.screencastCyclesPerRound,
    tabClose: options.tabsPerRound,
  }
}

function zeroActions() {
  const actions = {}
  for (const key of ACTION_KEYS) actions[key] = 0
  return actions
}

function pageHtml(bytes) {
  const bodySize = Math.max(256, Math.floor(bytes))
  const fill = 'soak-page-fill '.repeat(Math.ceil(bodySize / 'soak-page-fill '.length)).slice(0, bodySize)
  return `<!doctype html><html><head><meta charset="utf-8"><title>DSH soak</title></head>
<body>
<h1>DSH soak page</h1>
<label>value <input id="v" value="soak"></label>
<button id="go">go</button>
<div id="out">ready</div>
<p>${fill}</p>
<script>
  console.log('soak-page-ready');
  fetch('/data.json?bytes=4096', { cache: 'no-store' }).catch(() => {});
</script>
</body></html>`
}

/** Local deterministic page server; no external network is used. */
async function startPageServer(pageBytes, sleep) {
  const html = pageHtml(pageBytes)
  const server = http.createServer((request, response) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1')
    if (url.pathname === '/data.json') {
      const bytes = Math.max(1, Math.min(64 * 1024, Number(url.searchParams.get('bytes')) || 4096))
      const body = JSON.stringify({ ok: true, blob: 'x'.repeat(bytes) })
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      response.end(body)
      return
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    response.end(html)
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address()
  return {
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    async close() {
      await new Promise((resolve) => server.close(resolve))
      await sleep(20)
    },
  }
}

function makeManagerConfig({ home, maxTabs }) {
  const config = structuredClone(DEFAULT_CONFIG)
  config.browser.maxContexts = 1
  config.browser.maxTabs = maxTabs
  // A soak round can be long; idle reaping would turn a measurement into a
  // half-closed context. Keep it at the allowed maximum.
  config.browser.idleTimeoutMs = 3_600_000
  config.browser.profilesDir = path.join(home, 'cache', 'dsh-chrome', 'profiles')
  return config
}

async function waitForChromeExit(chromePid, { probe, timeoutMs, pollMs, sleep, now }) {
  if (!Number.isFinite(chromePid)) return { exited: null, waitedMs: 0, last: null, note: 'no-pid' }
  const startedAt = now()
  let last = null
  while (true) {
    try {
      last = probe(chromePid)
    } catch {
      last = null
    }
    // readProcessTree returns rss:null when the pid is gone (or ps failed).
    if (!last || !Number.isFinite(last.rss)) {
      return { exited: true, waitedMs: Math.round(now() - startedAt), last }
    }
    if (now() - startedAt >= timeoutMs) {
      return { exited: false, waitedMs: Math.round(now() - startedAt), last }
    }
    await sleep(Math.max(10, pollMs))
  }
}

function violationRecorder() {
  const failures = []
  const byCode = new Map()
  const add = (code, message, detail = null) => {
    const existing = byCode.get(code)
    if (existing) {
      existing.occurrences += 1
      if (existing.detail == null && detail != null) existing.detail = detail
      return existing
    }
    const failure = { code, message, detail, occurrences: 1 }
    byCode.set(code, failure)
    failures.push(failure)
    return failure
  }
  return { failures, add }
}

function snapshotNow({ manager, bridge, driver, label, atMs, now }) {
  const stats = collectMemoryStats({ contexts: manager, bridge })
  const driverStats = driver ? safeDriverStats(driver) : null
  return {
    label,
    at: new Date(now()).toISOString(),
    atMs: Number.isFinite(atMs) ? Math.round(atMs) : null,
    node: stats.node,
    objects: flattenStats(stats),
    chromeRss: finiteOrNull(stats.objects.contexts.totals.chromeRss),
    processCount: finiteOrNull(stats.objects.contexts.totals.processCount),
    chromePid: driverStats?.chromePid ?? null,
  }
}


/**
 * Phase snapshots are diagnostic breadcrumbs, not a second full report: the
 * benchmark itself must not allocate megabytes of retained objects, or its own
 * heap would look like a provider leak. Keep the fields that explain a jump.
 */
function compactPhase(snapshot) {
  const objects = snapshot.objects || {}
  return {
    label: snapshot.label,
    atMs: snapshot.atMs,
    rss: snapshot.node?.rss ?? null,
    heapUsed: snapshot.node?.heapUsed ?? null,
    external: snapshot.node?.external ?? null,
    arrayBuffers: snapshot.node?.arrayBuffers ?? null,
    chromeRss: snapshot.chromeRss,
    processCount: snapshot.processCount,
    tabs: objects.tabs ?? null,
    bySession: objects.bySession ?? null,
    owners: objects.owners ?? null,
    captures: objects.captures ?? null,
    captureBodyBytes: objects.captureBodyBytes ?? null,
    pending: objects.pending ?? null,
    downloadByGuid: objects.downloadByGuid ?? null,
  }
}

function checkSnapshot(snapshot, addViolation) {
  const objects = snapshot.objects
  if (objects.tabs !== objects.bySession) {
    addViolation('tabs-session-mismatch', `tabs ${objects.tabs} != bySession ${objects.bySession} at ${snapshot.label}`, snapshot.objects)
  }
  if (objects.tabs > 0 && objects.owners === 0) {
    addViolation('owner-missing', `tabs ${objects.tabs} > 0 but owners is 0 at ${snapshot.label}`)
  }
  // The limit applies to stopped summaries; one active capture may sit on top
  // of it. The workload keeps exactly one active capture at a time.
  if (objects.captures > CAPTURE_SUMMARY_LIMIT + 1) {
    addViolation('capture-summaries-over-limit', `captures ${objects.captures} > limit ${CAPTURE_SUMMARY_LIMIT}+1 active at ${snapshot.label}`)
  }
  if (objects.captureBodyBytes > 8 * 1024 * 1024) {
    addViolation('capture-body-over-budget', `captureBodyBytes ${objects.captureBodyBytes} > 8MiB at ${snapshot.label}`)
  }
  if (objects.downloadByGuid !== objects.downloads) {
    addViolation('download-index-mismatch', `downloadByGuid ${objects.downloadByGuid} != downloads ${objects.downloads} at ${snapshot.label}`)
  }
  if (objects.pending !== 0) {
    addViolation('bridge-pending', `bridge pending ${objects.pending} != 0 at ${snapshot.label}`)
  }
}

function checkRoundInvariants({ driverAfterClose, endBaseline, close, peak, actions, expected, config, addViolation }) {
  // The driver is the owner of the retention maps; after `close()` every one of
  // them must be empty, even though the manager already dropped the context.
  for (const field of DRIVER_ZERO_FIELDS) {
    const value = Number(driverAfterClose?.[field]) || 0
    if (value !== 0) addViolation(`driver-${field}-after-close`, `driver retains ${field}=${value} after close`, { field, value })
  }
  if (driverAfterClose?.idleTimer) addViolation('driver-idle-timer-after-close', 'driver idle timer still armed after close')
  if (driverAfterClose?.chromePid != null) {
    addViolation('chrome-pid-after-close', `driver still reports chromePid ${driverAfterClose.chromePid} after close`)
  }
  if (endBaseline?.objects?.contexts !== 0) {
    addViolation('manager-contexts-after-close', `manager reports ${endBaseline.objects.contexts} contexts after close`)
  }
  if (endBaseline?.objects?.pendingContexts !== 0) {
    addViolation('manager-pending-after-close', `manager reports ${endBaseline.objects.pendingContexts} pending contexts after close`)
  }
  for (const field of ['tabs', 'bySession', 'owners', 'captures', 'captureEntries', 'captureBodyBytes', 'shotStreams', 'pending']) {
    if ((endBaseline?.objects?.[field] ?? 0) !== 0) {
      addViolation(`manager-${field}-after-close`, `manager retains ${field}=${endBaseline.objects[field]} after close`)
    }
  }
  if (close?.chromePid != null && close.exited === false) {
    addViolation('chrome-process-exited', `Chrome pid ${close.chromePid} still alive ${close.waitedMs}ms after close`, close.last)
  }
  // Workload completeness: a skipped action makes the whole run incomparable
  // and must not be hidden behind a clean memory baseline.
  for (const [name, count] of Object.entries(expected)) {
    if ((actions?.[name] || 0) !== count) {
      addViolation('actions-match-workload', `${name} ran ${actions?.[name] || 0} times, expected ${count}`, { name, actual: actions?.[name] || 0, expected: count })
    }
  }
  // Peak-shape checks.
  if ((peak?.objects?.tabs ?? 0) !== config.tabsPerRound) {
    addViolation('tabs-peak', `peak tabs ${peak?.objects?.tabs ?? 0} != ${config.tabsPerRound}`)
  }
  if ((peak?.objects?.tabs ?? 0) !== (peak?.objects?.bySession ?? 0)) {
    addViolation('tabs-session-peak-mismatch', `peak tabs ${peak?.objects?.tabs} != bySession ${peak?.objects?.bySession}`)
  }
  if (config.captureCyclesPerRound > 0 && (peak?.objects?.captures ?? 0) > CAPTURE_SUMMARY_LIMIT + 1) {
    addViolation('capture-summaries-peak-over-limit', `peak captures ${peak?.objects?.captures} > ${CAPTURE_SUMMARY_LIMIT}+1 active`)
  }
}

/**
 * Run one fixed workload. Returns `{ report, jsonPath, markdownPath, home }`;
 * the report is always returned even when the CLI will exit non-zero.
 */
export async function runSoak(options = {}) {
  const config = { ...SOAK_DEFAULTS, ...options }
  const rounds = Math.max(1, Math.floor(config.rounds))
  const tabsPerRound = Math.max(1, Math.floor(config.tabsPerRound))
  const captureCycles = Math.max(0, Math.floor(config.captureCyclesPerRound))
  const screencastCycles = Math.max(0, Math.floor(config.screencastCyclesPerRound))
  const driverKind = options.driverKind || (options.createDriver ? 'fake' : 'headless')
  config.rounds = rounds
  config.tabsPerRound = tabsPerRound
  config.captureCyclesPerRound = captureCycles
  config.screencastCyclesPerRound = screencastCycles
  config.driverKind = driverKind
  const now = options.now || (() => Date.now())
  const sleep = options.sleep || defaultSleep
  const log = options.log || (() => {})
  const strict = options.strict !== false
  const ownsHome = !options.home
  const home = options.home || fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-soak-'))
  const probeChrome = options.probeChrome || (driverKind === 'fake' ? () => null : readProcessTree)
  const executable = driverKind === 'headless' ? (() => {
    try { return headlessChromeExecutable() } catch { return null }
  })() : null

  fs.mkdirSync(home, { recursive: true })
  const effective = scenarioConfig({ ...config, driverKind })
  effective.rounds = rounds
  effective.tabsPerRound = tabsPerRound
  effective.captureCyclesPerRound = captureCycles
  effective.screencastCyclesPerRound = screencastCycles
  effective.gc = Boolean(config.gc)
  const scenario = {
    name: SOAK_SCENARIO,
    id: scenarioId(effective),
    driver: driverKind,
    rounds,
    tabsPerRound,
    captureCyclesPerRound: captureCycles,
    screencastCyclesPerRound: screencastCycles,
    pageBytes: config.pageBytes,
    captureTraffic: config.captureTraffic,
  }

  let server = null
  let createDriver = options.createDriver || null
  let fakeDrivers = null
  if (!createDriver) {
    if (driverKind === 'fake') {
      const factory = createFakeDriverFactory({
        owner: SOAK_OWNER,
        leakTabs: options.fakeLeak === 'tabs',
        leakCaptures: options.fakeLeak === 'captures',
      })
      createDriver = factory.createDriver
      fakeDrivers = factory.drivers
    } else {
      createDriver = async ({ profileDir, visible }) =>
        new HeadlessDriver({ home, profileDir, visible: Boolean(visible) })
    }
  }

  const manager = new BrowserContextManager({
    config: makeManagerConfig({ home, maxTabs: tabsPerRound }),
    createDriver,
    logger: null,
    home,
  })
  const bridge = new BridgeServer({ home })
  const startedAtMs = now()
  const startedAt = new Date(startedAtMs).toISOString()
  const loadAtStart = typeof os.loadavg === 'function' ? os.loadavg() : null
  const gcAvailable = typeof global.gc === 'function'
  const gcUsedBaseline = config.gc ? gcNow() : false
  if (gcUsedBaseline) await sleep(10)

  const baseline = snapshotNow({ manager, bridge, driver: null, label: 'baseline', atMs: 0, now })
  const roundReports = []
  let runPeak = createPeak()
  let previousEnd = baseline

  try {
    server = await startPageServer(config.pageBytes, sleep)
    const baseUrl = server.baseUrl
    log(`soak: ${scenario.id} driver=${driverKind} rounds=${rounds} tabs=${tabsPerRound} capture=${captureCycles} screencast=${screencastCycles}`)

    for (let roundNumber = 1; roundNumber <= rounds; roundNumber += 1) {
      const roundStartedAt = now()
      const roundIso = new Date(roundStartedAt).toISOString()
      const actions = zeroActions()
      const errors = []
      const phases = []
      const peak = createPeak()
      const { failures, add } = violationRecorder()
      let driver = null
      let context = null
      let contextClosed = false
      let chromePid = null
      let close = null
      let endBaseline = null
      let driverAfterClose = null
      let phase = 'start'

      const snapshot = (label, { gc = false } = {}) => {
        if (gc) gcNow()
        const snap = snapshotNow({
          manager,
          bridge,
          driver,
          label,
          atMs: now() - roundStartedAt,
          now,
        })
        mergePeak(peak, snap)
        checkSnapshot(snap, add)
        return snap
      }

      try {
        phase = 'context-create'
        context = await manager.create({ owner: SOAK_OWNER, preset: 'sandbox' })
        actions.contextCreate += 1
        driver = manager.driverFor(context.contextId)
        if (!driver) throw new Error(`context ${context.contextId} has no driver`)
        phases.push(compactPhase(snapshot('context-created')))

        phase = 'tabs'
        const tabIds = []
        for (let tabIndex = 0; tabIndex < tabsPerRound; tabIndex += 1) {
          const opened = await driver.request('tab.tabs', { op: 'new', url: 'about:blank', owner: SOAK_OWNER })
          actions.tabNew += 1
          tabIds.push(opened.tabId)
          const tabUrl = `${baseUrl}/tab/${tabIndex}?round=${roundNumber}`
          await driver.request('tab.goto', { owner: SOAK_OWNER, tabId: opened.tabId, url: tabUrl })
          actions.goto += 1
          await driver.request('tab.snapshot', { owner: SOAK_OWNER, tabId: opened.tabId, maxChars: 2000 })
          actions.snapshot += 1
          await driver.request('tab.screenshot', { owner: SOAK_OWNER, tabId: opened.tabId })
          actions.screenshot += 1
          snapshot(`tab-${tabIndex + 1}`)
        }
        phases.push(compactPhase(snapshot('tabs-open')))

        // Capture cycles run on the first tab. When captureTraffic is "reload",
        // each cycle reloads the page so the capture holds a real body and
        // captureBodyBytes has something to release on stop.
        const captureTabId = tabIds[0]
        for (let cycle = 0; cycle < captureCycles; cycle += 1) {
          phase = `capture-${cycle + 1}-start`
          const capture = await driver.request('tab.capture_start', {
            owner: SOAK_OWNER,
            tabId: captureTabId,
            maxEntries: 300,
            storeBodies: true,
          })
          actions.captureStart += 1
          if (config.captureTraffic === 'reload') {
            phase = `capture-${cycle + 1}-reload`
            await driver.request('tab.goto', {
              owner: SOAK_OWNER,
              tabId: captureTabId,
              url: `${baseUrl}/capture?round=${roundNumber}&cycle=${cycle + 1}`,
            })
            actions.captureReload += 1
            await sleep(sleepMs(config.captureSettleMs))
          }
          snapshot('capture-active')
          phase = `capture-${cycle + 1}-stop`
          await driver.request('tab.capture_stop', {
            owner: SOAK_OWNER,
            tabId: captureTabId,
            captureId: capture.captureId,
          })
          actions.captureStop += 1
          const stopped = snapshot('capture-stopped')
          if (stopped.objects.captureBodyBytes !== 0) {
            add('capture-body-released-on-stop', `capture ${capture.captureId} retained ${stopped.objects.captureBodyBytes} body bytes after stop`)
          }
        }
        phases.push(compactPhase(snapshot('captures-done')))

        for (let cycle = 0; cycle < screencastCycles; cycle += 1) {
          phase = `screencast-${cycle + 1}-start`
          await driver.request('tab.screencast_start', { owner: SOAK_OWNER, tabId: captureTabId })
          actions.screencastStart += 1
          await sleep(sleepMs(config.screencastSettleMs))
          snapshot('screencast-active')
          phase = `screencast-${cycle + 1}-stop`
          await driver.request('tab.screencast_stop', { owner: SOAK_OWNER, tabId: captureTabId })
          actions.screencastStop += 1
          snapshot('screencast-stopped')
        }
        phases.push(compactPhase(snapshot('screencasts-done')))

        phase = 'tabs-close'
        for (const tabId of [...tabIds].reverse()) {
          await driver.request('tab.tabs', { op: 'close', owner: SOAK_OWNER, tabId })
          actions.tabClose += 1
        }
        const tabsClosed = snapshot('tabs-closed')
        phases.push(compactPhase(tabsClosed))
        for (const field of ['tabs', 'bySession', 'owners', 'captureBodyBytes', 'shotStreams', 'consoleBuffers']) {
          if ((tabsClosed.objects[field] ?? 0) !== 0) {
            add(`tabs-closed-${field}`, `${field}=${tabsClosed.objects[field]} after closing every tab`)
          }
        }
        // Stopped capture summaries (entries included) survive tab close until
        // their TTL/count eviction; the bound, not zero, is the contract here.
        if ((tabsClosed.objects.captures ?? 0) > CAPTURE_SUMMARY_LIMIT) {
          add('tabs-closed-captures', `captures=${tabsClosed.objects.captures} after closing every tab (> ${CAPTURE_SUMMARY_LIMIT})`)
        }
        if ((tabsClosed.objects.captureEntries ?? 0) > CAPTURE_SUMMARY_LIMIT * 300) {
          add('tabs-closed-captureEntries', `captureEntries=${tabsClosed.objects.captureEntries} after closing every tab (> ${CAPTURE_SUMMARY_LIMIT * 300})`)
        }

        phase = 'context-close'
        const beforeClose = safeDriverStats(driver)
        chromePid = beforeClose?.chromePid ?? null
        const closed = await manager.close(context.contextId)
        contextClosed = true
        if (!closed) add('context-close-returned-false', `manager.close(${context.contextId}) returned false`)
        actions.contextClose += 1
        const exit = await waitForChromeExit(chromePid, {
          probe: probeChrome,
          timeoutMs: config.exitTimeoutMs,
          pollMs: config.exitPollMs,
          sleep,
          now,
        })
        await sleep(sleepMs(config.settleMs))
        if (config.gc) gcNow()
        phase = 'end-baseline'
        endBaseline = snapshotNow({
          manager,
          bridge,
          driver: null,
          label: 'end-baseline',
          atMs: now() - roundStartedAt,
          now,
        })
        driverAfterClose = safeDriverStats(driver)
        close = {
          chromePid,
          exited: exit.exited,
          waitedMs: exit.waitedMs,
          last: exit.last,
          note: exit.note || null,
          driverAfterClose,
        }
      } catch (error) {
        errors.push({ phase, code: error?.code || 'INTERNAL', message: error?.message || String(error) })
      } finally {
        // Cleanup is best-effort and idempotent; a failed round must not leak a
        // browser into the next round's baseline.
        if (!contextClosed && context) {
          try {
            const beforeClose = safeDriverStats(driver)
            chromePid = chromePid ?? beforeClose?.chromePid ?? null
            await manager.close(context.contextId)
            contextClosed = true
            actions.contextClose += 1
          } catch (cleanupError) {
            errors.push({ phase: 'cleanup-context', code: cleanupError?.code || 'INTERNAL', message: cleanupError?.message || String(cleanupError) })
          }
        }
        if (driver) {
          try { await driver.close() } catch {}
        }
      }

      // A failed round still gets an end baseline and a report entry, so the
      // failure is visible instead of aborting the whole soak.
      if (!endBaseline) {
        const beforeClose = safeDriverStats(driver)
        chromePid = chromePid ?? beforeClose?.chromePid ?? null
        const exit = await waitForChromeExit(chromePid, {
          probe: probeChrome,
          timeoutMs: config.exitTimeoutMs,
          pollMs: config.exitPollMs,
          sleep,
          now,
        })
        await sleep(sleepMs(config.settleMs))
        if (config.gc) gcNow()
        endBaseline = snapshotNow({
          manager,
          bridge,
          driver: null,
          label: 'end-baseline',
          atMs: now() - roundStartedAt,
          now,
        })
        driverAfterClose = safeDriverStats(driver)
        close = {
          chromePid,
          exited: exit.exited,
          waitedMs: exit.waitedMs,
          last: exit.last,
          note: exit.note || null,
          driverAfterClose,
        }
      }

      const expected = expectedActions(config)
      if (errors.length > 0) {
        add('round-error', errors.map((entry) => `${entry.phase}: ${entry.message}`).join('; '), errors)
      }
      checkRoundInvariants({
        driverAfterClose,
        endBaseline,
        close,
        peak,
        actions,
        expected,
        config: { ...config, tabsPerRound, captureCyclesPerRound: captureCycles },
        addViolation: add,
      })

      const retained = {
        node: deltaNode(endBaseline.node, baseline.node),
        objects: deltaObjects(endBaseline.objects, baseline.objects),
      }
      const retainedVsPrevious = {
        node: deltaNode(endBaseline.node, previousEnd.node),
        objects: deltaObjects(endBaseline.objects, previousEnd.objects),
      }
      const roundReport = {
        round: roundNumber,
        ok: errors.length === 0 && failures.length === 0,
        startedAt: roundIso,
        durationMs: Math.round(now() - roundStartedAt),
        contextId: context?.contextId ?? null,
        chromePid,
        browserVersion: driver?.browserVersion ?? null,
        peak,
        endBaseline,
        retained,
        retainedVsPrevious,
        phases,
        actions,
        errors,
        close,
        invariants: { checked: [...CHECKED], failures },
      }
      roundReports.push(roundReport)
      previousEnd = endBaseline
      mergePeak(runPeak, peak)
      log(
        `round ${roundNumber}/${rounds} ${roundReport.ok ? 'PASS' : `FAIL(${failures.length + (errors.length ? 1 : 0)})`} ` +
        `rssPeak=${(peak.node.rss / 1024 / 1024).toFixed(1)}MiB end=${(endBaseline.node.rss / 1024 / 1024).toFixed(1)}MiB ` +
        `chromePeak=${Number.isFinite(peak.chromeRss) ? `${(peak.chromeRss / 1024 / 1024).toFixed(1)}MiB` : '—'} ` +
        `dur=${(roundReport.durationMs / 1000).toFixed(1)}s`,
      )
    }
  } finally {
    try { await manager.closeAll() } catch {}
    if (server) {
      try { await server.close() } catch {}
    }
    const chromeStillAlive = roundReports.some((round) => round.close?.exited === false)
    if (ownsHome && !config.keepHome && !chromeStillAlive) {
      try { fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch {}
    } else if (chromeStillAlive) {
      log(`soak: keeping home ${home} because a Chrome process was still alive at the end`)
    }
  }

  const endedAtMs = now()
  const run = {
    startedAt,
    endedAt: new Date(endedAtMs).toISOString(),
    durationMs: Math.round(endedAtMs - startedAtMs),
    pid: process.pid,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    cpuCount: os.cpus().length,
    totalMemBytes: os.totalmem(),
    gcAvailable,
    gcUsed: Boolean(gcUsedBaseline),
    loadAtStart,
    loadAtEnd: typeof os.loadavg === 'function' ? os.loadavg() : null,
    executable,
    browserVersion: roundReports.find((round) => round.browserVersion)?.browserVersion ?? null,
    home,
  }
  const summary = summarize({
    baseline,
    rounds: roundReports,
    peak: runPeak,
    config: { ...effective, strict },
    startedAt,
    endedAt: run.endedAt,
    durationMs: run.durationMs,
  })
  const report = {
    schemaVersion: SCHEMA_VERSION,
    kind: 'dsh-chrome-soak',
    scenario,
    run,
    config: { ...effective, strict },
    baseline: { node: baseline.node, objects: baseline.objects, chromeRss: baseline.chromeRss, processCount: baseline.processCount, at: baseline.at },
    peak: runPeak,
    rounds: roundReports,
    summary,
    artifacts: { json: null, markdown: null },
  }
  let jsonPath = null
  let markdownPath = null
  if (options.outDir) {
    const written = writeReport(report, options.outDir)
    jsonPath = written.jsonPath
    markdownPath = written.markdownPath
  }
  const failed = report.summary.failedRounds > 0 || report.summary.invariantFailures.length > 0
  if (strict && failed) report.strictFailure = true
  return { report, jsonPath, markdownPath, home, fakeDrivers }
}
