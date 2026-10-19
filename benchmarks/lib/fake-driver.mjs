/**
 * A deterministic, Chrome-free stand-in for `HeadlessDriver`, used by the soak
 * harness tests and by `benchmarks/soak.mjs --fake`.
 *
 * It implements only the methods the fixed soak workload calls, and it keeps
 * the same retention maps the real driver uses (`tabs`/`bySession`/`owners`/
 * `captures`). That matters: the harness exercises the real
 * `BrowserContextManager`, the real `collectMemoryStats()` aggregation and the
 * real capture-summary limit, so the fake proves the benchmark *logic* without
 * pretending to measure Chrome. A fake run is labelled `driver: "fake"` in the
 * report and is never comparable to a real run.
 *
 * Two knobs deliberately reproduce bugs the invariants must catch:
 *
 *   - `leakTabs: true` — `tabs op=close` leaves the tab registered;
 *   - `leakCaptures: true` — stopped captures are never pruned and their body
 *     bytes are not released.
 */
import { CAPTURE_SUMMARY_LIMIT } from '../../src/headless.js'

const MiB = 1024 * 1024

function captureLimit() {
  return CAPTURE_SUMMARY_LIMIT
}

export class FakeDriver {
  constructor({
    contextId = 'fake-context',
    owner = 'soak',
    pid = null,
    baseRssBytes = 120 * MiB,
    tabRssBytes = 8 * MiB,
    documentBytes = 4096,
    leakTabs = false,
    leakCaptures = false,
  } = {}) {
    this.contextId = contextId
    this.owner = String(owner || 'soak')
    this.pid = pid
    this.baseRssBytes = baseRssBytes
    this.tabRssBytes = tabRssBytes
    this.documentBytes = documentBytes
    this.leakTabs = leakTabs
    this.leakCaptures = leakCaptures
    this.connected = false
    this.closed = false
    this.tabs = new Map()
    this.bySession = new Map()
    this.owners = new Map()
    this.captures = new Map()
    this.captureByTab = new Map()
    this.consoleBuffers = new Map()
    this.downloads = []
    this.downloadByGuid = new Map()
    this.nextTabId = 1
    this.nextSessionId = 1
    this.nextCaptureId = 1
    this.counts = Object.create(null)
  }

  #count(method) {
    this.counts[method] = (this.counts[method] || 0) + 1
  }

  #entry(owner) {
    const key = String(owner || this.owner)
    let entry = this.owners.get(key)
    if (!entry) {
      entry = { owner: key, tabs: new Map(), activeTabId: null }
      this.owners.set(key, entry)
    }
    return entry
  }

  #tab(owner, tabId) {
    const tab = this.tabs.get(Number(tabId))
    if (!tab || tab.owner !== String(owner)) {
      throw Object.assign(new Error(`tab ${tabId} not in this fake session`), { code: 'TAB_NOT_FOUND' })
    }
    return tab
  }

  #pruneCaptures() {
    if (this.leakCaptures) return
    const stopped = [...this.captures.values()].filter((capture) => !capture.active)
    while (stopped.length > captureLimit()) {
      const oldest = stopped.shift()
      this.captures.delete(oldest.captureId)
      if (this.captureByTab.get(oldest.tabId) === oldest) this.captureByTab.delete(oldest.tabId)
    }
  }

  async request(method, params = {}) {
    this.#count(method)
    if (this.closed) throw Object.assign(new Error('fake driver is closed'), { code: 'NOT_CONNECTED' })
    this.connected = true
    const owner = String(params.owner || this.owner)
    switch (method) {
      case 'tab.tabs': {
        const entry = this.#entry(owner)
        const op = String(params.op || 'list')
        if (op === 'list') {
          return {
            tabs: [...entry.tabs.values()].map((tab) => ({
              tabId: tab.tabId,
              title: tab.title,
              url: tab.url,
              active: tab.tabId === entry.activeTabId,
            })),
            groupId: null,
            activeTabId: entry.activeTabId,
          }
        }
        if (op === 'new') {
          const tabId = this.nextTabId++
          const sessionId = `fake-session-${this.nextSessionId++}`
          const tab = {
            tabId,
            sessionId,
            owner,
            url: String(params.url || 'about:blank'),
            title: 'fake',
            closed: false,
          }
          this.tabs.set(tabId, tab)
          this.bySession.set(sessionId, tab)
          entry.tabs.set(tabId, tab)
          entry.activeTabId = tabId
          this.consoleBuffers.set(tabId, [])
          return { tabId, url: tab.url, title: tab.title }
        }
        if (op === 'close') {
          const tab = entry.tabs.get(Number(params.tabId))
          if (!tab) throw Object.assign(new Error(`tab ${params.tabId} not found`), { code: 'TAB_NOT_FOUND' })
          entry.tabs.delete(tab.tabId)
          if (entry.activeTabId === tab.tabId) entry.activeTabId = [...entry.tabs.keys()][0] ?? null
          if (!this.leakTabs) {
            this.tabs.delete(tab.tabId)
            this.bySession.delete(tab.sessionId)
            this.consoleBuffers.delete(tab.tabId)
            const capture = this.captureByTab.get(tab.tabId)
            if (capture) {
              this.captures.delete(capture.captureId)
              this.captureByTab.delete(tab.tabId)
            }
          }
          if (entry.tabs.size === 0) this.owners.delete(owner)
          return { closed: tab.tabId, remaining: entry.tabs.size }
        }
        throw Object.assign(new Error(`fake tab op ${op}`), { code: 'INVALID_ARGUMENT' })
      }
      case 'tab.goto': {
        const tab = this.#tab(owner, params.tabId)
        tab.url = String(params.url || 'about:blank')
        const capture = this.captureByTab.get(tab.tabId)
        if (capture?.active) {
          // A document load while capture is active retains materialized body
          // chars exactly like the real Network.getResponseBody path.
          const bytes = this.leakCaptures ? this.documentBytes * 4 : this.documentBytes
          capture.bodyBytes += bytes
          capture.entries.push({ url: tab.url, resourceType: 'document', bodyBytes: bytes })
        }
        return { tabId: tab.tabId, url: tab.url, title: tab.title, loadState: 'complete' }
      }
      case 'tab.snapshot':
        this.#tab(owner, params.tabId)
        return { title: 'fake', url: 'http://fake/', controls: [], text: 'x'.repeat(64) }
      case 'tab.screenshot':
        this.#tab(owner, params.tabId)
        return { bytes: 1024, format: 'png', width: 100, height: 100 }
      case 'tab.capture_start': {
        const tab = this.#tab(owner, params.tabId)
        const existing = this.captureByTab.get(tab.tabId)
        if (existing?.active) {
          return { captureId: existing.captureId, tabId: tab.tabId, alreadyActive: true, active: true }
        }
        const captureId = `fake-capture-${this.nextCaptureId++}`
        const capture = {
          captureId,
          tabId: tab.tabId,
          owner,
          active: true,
          startedAt: Date.now(),
          stoppedAt: null,
          endedReason: null,
          entries: [],
          bodyBytes: 0,
        }
        this.captures.set(captureId, capture)
        this.captureByTab.set(tab.tabId, capture)
        return { captureId, tabId: tab.tabId, active: true, alreadyActive: false }
      }
      case 'tab.capture_stop': {
        const capture = params.captureId
          ? this.captures.get(String(params.captureId))
          : this.captureByTab.get(Number(params.tabId))
        if (!capture) throw Object.assign(new Error('capture not found'), { code: 'CAPTURE_NOT_FOUND' })
        capture.active = false
        capture.stoppedAt = Date.now()
        capture.endedReason = 'stopped'
        if (!this.leakCaptures) {
          capture.entries.length = 0
          capture.bodyBytes = 0
        }
        this.#pruneCaptures()
        return { captureId: capture.captureId, tabId: capture.tabId, active: false, requests: capture.entries.length }
      }
      case 'tab.screencast_start': {
        const tab = this.#tab(owner, params.tabId)
        tab.screencast = { active: true, frames: 1 }
        return { active: true, alreadyActive: false, tabId: tab.tabId, format: 'jpeg' }
      }
      case 'tab.screencast_stop': {
        const tab = this.#tab(owner, params.tabId)
        const frames = tab.screencast?.frames ?? 0
        tab.screencast = null
        return { active: false, tabId: tab.tabId, frames, elapsedMs: 10 }
      }
      default:
        throw Object.assign(new Error(`fake driver does not implement ${method}`), { code: 'UNSUPPORTED_BACKEND' })
    }
  }

  memoryStats() {
    let captureEntries = 0
    let captureBodyBytes = 0
    for (const capture of this.captures.values()) {
      captureEntries += capture.entries.length
      captureBodyBytes += capture.bodyBytes
    }
    let shotStreams = 0
    for (const tab of this.tabs.values()) if (tab.screencast) shotStreams += 1
    return {
      chromePid: this.closed ? null : this.pid,
      chromeRss: this.closed ? null : this.baseRssBytes + this.tabs.size * this.tabRssBytes + captureBodyBytes,
      processCount: this.closed ? null : 5 + this.tabs.size,
      tabs: this.tabs.size,
      owners: this.owners.size,
      bySession: this.bySession.size,
      consoleBuffers: this.consoleBuffers.size,
      captures: this.captures.size,
      captureEntries,
      captureBodyBytes,
      downloads: this.downloads.length,
      downloadByGuid: this.downloadByGuid.size,
      shotStreams,
      idleTimer: false,
      visible: false,
    }
  }

  async close() {
    this.closed = true
    this.connected = false
    this.tabs.clear()
    this.bySession.clear()
    this.owners.clear()
    this.consoleBuffers.clear()
    this.captures.clear()
    this.captureByTab.clear()
    this.downloads.length = 0
    this.downloadByGuid.clear()
  }
}

/**
 * Factory in the shape `BrowserContextManager` expects. `drivers` keeps every
 * instance so a test can assert the exact requests and post-close state; the
 * driver's `contextId` is recorded from the manager's create payload.
 */
export function createFakeDriverFactory(options = {}) {
  let sequence = 0
  const drivers = []
  const createDriver = async ({ contextId, owner } = {}) => {
    sequence += 1
    const driver = new FakeDriver({
      ...options,
      contextId,
      owner: owner || options.owner || 'soak',
      pid: options.pid ?? 900_000 + sequence,
    })
    drivers.push(driver)
    return driver
  }
  return { createDriver, drivers }
}
