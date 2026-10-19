/**
 * Continuous provider memory sampling (M7).
 *
 * `MemoryMonitor` samples the same numbers-only snapshot `chrome_memory_stats`
 * reports, keeps at most `maxSamples` in an in-memory ring, optionally appends
 * one numeric JSON line per sample to
 * `~/.dsh/cache/dsh-chrome/memory.jsonl` (mode 0600, records older than two
 * days pruned) and raises alerts when a counter crosses a known bound.
 *
 * The monitor never starts on its own: the model or the user must call
 * `chrome_memory_stats {op:"start"}`. Samples contain only numbers/counts, so
 * the ring and the JSONL file cannot leak page content, URLs, console text or
 * credentials.
 */
import fs from 'node:fs'
import path from 'node:path'

export const MEMORY_RING_LIMIT = 600
export const MEMORY_DEFAULT_INTERVAL_MS = 5000
export const MEMORY_MIN_INTERVAL_MS = 250
export const MEMORY_MAX_INTERVAL_MS = 10 * 60 * 1000
export const MEMORY_JSONL_MAX_AGE_MS = 2 * 24 * 60 * 60 * 1000
export const MEMORY_JSONL_NAME = 'memory.jsonl'
// Alert bounds (M7). `rss_growth` is relative to the first sample after start.
export const MEMORY_RSS_GROWTH_RATIO = 1.2
export const MEMORY_CAPTURE_BODY_ALERT_BYTES = 8 * 1024 * 1024
export const MEMORY_BRIDGE_PENDING_ALERT = 64
const ALERT_LOG_LIMIT = 200
const PRUNE_INTERVAL_MS = 60 * 60 * 1000

function integer(value) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.round(number) : 0
}

function clampInterval(value) {
  if (!Number.isFinite(Number(value))) return MEMORY_DEFAULT_INTERVAL_MS
  return Math.max(MEMORY_MIN_INTERVAL_MS, Math.min(MEMORY_MAX_INTERVAL_MS, Math.round(Number(value))))
}

/** Default liveness probe for the "context closed but chrome pid alive" alert. */
export function defaultPidAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return error?.code === 'EPERM'
  }
}

/**
 * Flatten one `collectMemoryStats()` result into the numeric sample shape that
 * the ring stores and the JSONL file appends. Every leaf is a number, so no
 * page-derived string can enter the monitoring data.
 */
export function compactSample(snapshot, at = Date.now()) {
  const node = snapshot?.node || {}
  const contexts = snapshot?.objects?.contexts || {}
  const totals = contexts.totals || {}
  const bridge = snapshot?.objects?.bridge || {}
  const drivers = Array.isArray(contexts.drivers) ? contexts.drivers : []
  return {
    at: integer(at) || Date.now(),
    pid: integer(snapshot?.pid),
    rss: integer(node.rss),
    heapUsed: integer(node.heapUsed),
    heapTotal: integer(node.heapTotal),
    external: integer(node.external),
    arrayBuffers: integer(node.arrayBuffers),
    contexts: integer(contexts.contexts),
    pendingContexts: integer(contexts.pending),
    drivers: drivers.length,
    tabs: integer(totals.tabs),
    owners: integer(totals.owners),
    bySession: integer(totals.bySession),
    consoleBuffers: integer(totals.consoleBuffers),
    captures: integer(totals.captures),
    captureEntries: integer(totals.captureEntries),
    captureBodyBytes: integer(totals.captureBodyBytes),
    downloads: integer(totals.downloads),
    downloadByGuid: integer(totals.downloadByGuid),
    shotStreams: integer(totals.shotStreams),
    idleTimers: integer(totals.idleTimers),
    visibleDrivers: integer(totals.visibleDrivers),
    bridgeConnected: bridge.connected ? 1 : 0,
    bridgePending: integer(bridge.pending),
    bridgeHandlers: integer(bridge.handlers),
  }
}

/** Chrome pids reported by the current snapshot's driver details. */
export function snapshotChromePids(snapshot) {
  const drivers = snapshot?.objects?.contexts?.drivers
  if (!Array.isArray(drivers)) return []
  const pids = []
  for (const driver of drivers) {
    const pid = Number(driver?.stats?.chromePid)
    if (Number.isFinite(pid) && pid > 0) pids.push(Math.round(pid))
  }
  return pids
}

export class MemoryMonitor {
  constructor({
    sample,
    home = process.env.DSH_HOME || '',
    logger = null,
    now = () => Date.now(),
    setIntervalImpl = setInterval,
    clearIntervalImpl = clearInterval,
    fsImpl = fs,
    isPidAlive = defaultPidAlive,
    intervalMs = MEMORY_DEFAULT_INTERVAL_MS,
    maxSamples = MEMORY_RING_LIMIT,
    jsonl = process.env.DSH_MEMORY_JSONL !== '0',
    jsonlPath = null,
  } = {}) {
    if (typeof sample !== 'function') throw new TypeError('MemoryMonitor requires a sample function')
    this.sample = sample
    this.home = home
    this.logger = logger
    this.now = now
    this.setIntervalImpl = setIntervalImpl
    this.clearIntervalImpl = clearIntervalImpl
    this.fs = fsImpl
    this.isPidAlive = isPidAlive
    this.intervalMs = clampInterval(intervalMs)
    this.maxSamples = Math.max(1, Math.min(10_000, Number(maxSamples) || MEMORY_RING_LIMIT))
    this.jsonlEnabled = Boolean(jsonl)
    this.jsonlPath = jsonlPath || path.join(String(home || '.'), 'cache', 'dsh-chrome', MEMORY_JSONL_NAME)
    this.timer = null
    this.samples = []
    this.baseline = null
    this.latest = null
    this.alerts = new Map()
    this.alertLog = []
    this.knownPids = new Set()
    this.lastError = null
    this.lastSampleAt = null
    this.startedAt = null
    this.stoppedAt = null
    this.jsonlWrites = 0
    this.jsonlError = null
    this.lastPruneAt = null
  }

  get running() {
    return this.timer != null
  }

  /**
   * Start continuous sampling. Explicit by contract: no caller starts the
   * monitor implicitly. An already-running monitor keeps its interval unless
   * a new one is supplied.
   */
  start({ intervalMs = null } = {}) {
    if (intervalMs != null) this.intervalMs = clampInterval(intervalMs)
    this.#prepareJsonl()
    if (this.timer) {
      return { started: false, alreadyRunning: true, running: true, intervalMs: this.intervalMs }
    }
    this.startedAt = this.now()
    this.stoppedAt = null
    // A restart measures growth from its own first sample.
    this.baseline = null
    this.knownPids.clear()
    this.timer = this.setIntervalImpl(() => this.sampleOnce(), this.intervalMs)
    this.timer?.unref?.()
    this.sampleOnce()
    this.logger?.info?.('dsh-chrome memory monitor started (every %sms)', this.intervalMs)
    return {
      started: true,
      alreadyRunning: false,
      running: true,
      intervalMs: this.intervalMs,
      sampleCount: this.samples.length,
    }
  }

  stop() {
    this.stoppedAt = this.now()
    if (!this.timer) return { stopped: false, running: false, intervalMs: this.intervalMs }
    this.clearIntervalImpl(this.timer)
    this.timer = null
    this.logger?.info?.('dsh-chrome memory monitor stopped')
    return { stopped: true, running: false, intervalMs: this.intervalMs, sampleCount: this.samples.length }
  }

  /**
   * Take one sample now. A failing sampler records `lastError` and leaves the
   * previous ring intact; the timer keeps running so a transient failure does
   * not stop monitoring.
   */
  sampleOnce() {
    let snapshot = null
    try {
      snapshot = this.sample()
    } catch (error) {
      this.lastError = error?.message || String(error)
      return null
    }
    const sample = compactSample(snapshot, this.now())
    this.lastError = null
    this.lastSampleAt = sample.at
    this.samples.push(sample)
    if (this.samples.length > this.maxSamples) {
      this.samples.splice(0, this.samples.length - this.maxSamples)
    }
    if (!this.baseline) this.baseline = { ...sample }
    this.latest = sample
    this.#updateAlerts(sample, snapshotChromePids(snapshot))
    this.#pruneJsonlIfDue(sample.at)
    this.#appendJsonl(sample)
    return { ...sample }
  }

  status() {
    return {
      available: true,
      running: this.running,
      intervalMs: this.intervalMs,
      sampleCount: this.samples.length,
      ringLimit: this.maxSamples,
      startedAt: this.startedAt,
      stoppedAt: this.stoppedAt,
      lastSampleAt: this.lastSampleAt,
      baseline: this.baseline ? { ...this.baseline } : null,
      latest: this.latest ? { ...this.latest } : null,
      alerts: [...this.alerts.values()].map((alert) => ({ ...alert })),
      lastError: this.lastError,
      jsonl: this.#jsonlStatus(),
    }
  }

  /**
   * Recent ring + retained-memory computation. `rssDeltaBytes` etc. compare
   * the newest sample with the first sample after start; the object counters
   * describe what is retained right now.
   */
  dump() {
    return {
      running: this.running,
      intervalMs: this.intervalMs,
      count: this.samples.length,
      ringLimit: this.maxSamples,
      baseline: this.baseline ? { ...this.baseline } : null,
      latest: this.latest ? { ...this.latest } : null,
      samples: this.samples.map((sample) => ({ ...sample })),
      retained: this.retained(),
      alerts: [...this.alerts.values()].map((alert) => ({ ...alert })),
      alertLog: this.alertLog.map((entry) => ({ ...entry })),
      lastError: this.lastError,
      jsonl: this.#jsonlStatus(),
    }
  }

  retained() {
    if (!this.latest) return null
    const base = this.baseline || this.latest
    return {
      from: base.at,
      to: this.latest.at,
      seconds: Math.max(0, Math.round((this.latest.at - base.at) / 1000)),
      samples: this.samples.length,
      rssBytes: this.latest.rss,
      rssDeltaBytes: this.latest.rss - base.rss,
      heapUsedBytes: this.latest.heapUsed,
      heapUsedDeltaBytes: this.latest.heapUsed - base.heapUsed,
      arrayBuffersBytes: this.latest.arrayBuffers,
      arrayBuffersDeltaBytes: this.latest.arrayBuffers - base.arrayBuffers,
      captureBodyBytes: this.latest.captureBodyBytes,
      captureEntries: this.latest.captureEntries,
      tabs: this.latest.tabs,
      bySession: this.latest.bySession,
      bridgePending: this.latest.bridgePending,
    }
  }

  #updateAlerts(sample, pids) {
    const next = new Map()
    const add = (code, message, value = null) => {
      const existing = this.alerts.get(code)
      next.set(code, {
        code,
        message,
        value,
        since: existing?.since ?? sample.at,
        lastSeenAt: sample.at,
      })
    }
    if (this.baseline && this.baseline.rss > 0 && sample.rss > this.baseline.rss * MEMORY_RSS_GROWTH_RATIO) {
      add(
        'rss_growth',
        `rss ${sample.rss} > baseline ${this.baseline.rss} * ${MEMORY_RSS_GROWTH_RATIO}`,
        sample.rss,
      )
    }
    if (sample.captureBodyBytes > MEMORY_CAPTURE_BODY_ALERT_BYTES) {
      add(
        'capture_body_bytes',
        `captureBodyBytes ${sample.captureBodyBytes} > ${MEMORY_CAPTURE_BODY_ALERT_BYTES}`,
        sample.captureBodyBytes,
      )
    }
    if (sample.bridgePending > MEMORY_BRIDGE_PENDING_ALERT) {
      add(
        'bridge_pending',
        `bridge pending ${sample.bridgePending} > ${MEMORY_BRIDGE_PENDING_ALERT}`,
        sample.bridgePending,
      )
    }
    if (sample.tabs !== sample.bySession) {
      add('tabs_sessions_mismatch', `tabs ${sample.tabs} != bySession ${sample.bySession}`, sample.tabs)
    }
    const current = new Set(pids)
    for (const pid of this.knownPids) {
      if (current.has(pid)) continue
      if (this.isPidAlive(pid)) {
        add(`chrome_pid_alive:${pid}`, `context closed but chrome pid ${pid} is still alive`, pid)
      }
    }
    this.knownPids = current

    for (const [code, alert] of next) {
      if (!this.alerts.has(code)) {
        this.alertLog.push({ at: sample.at, code, state: 'raised', message: alert.message, value: alert.value })
      }
    }
    for (const [code, alert] of this.alerts) {
      if (!next.has(code)) {
        this.alertLog.push({ at: sample.at, code, state: 'cleared', message: alert.message, value: alert.value })
      }
    }
    if (this.alertLog.length > ALERT_LOG_LIMIT) {
      this.alertLog.splice(0, this.alertLog.length - ALERT_LOG_LIMIT)
    }
    this.alerts = next
  }

  #jsonlStatus() {
    return {
      enabled: this.jsonlEnabled,
      path: this.jsonlEnabled ? this.jsonlPath : null,
      maxAgeMs: MEMORY_JSONL_MAX_AGE_MS,
      writes: this.jsonlWrites,
      error: this.jsonlError,
    }
  }

  #prepareJsonl() {
    if (!this.jsonlEnabled || this.jsonlError) return
    const cutoff = this.now() - MEMORY_JSONL_MAX_AGE_MS
    try {
      this.fs.mkdirSync(path.dirname(this.jsonlPath), { recursive: true, mode: 0o700 })
      let text = ''
      try {
        text = this.fs.readFileSync(this.jsonlPath, 'utf8')
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }
      const kept = []
      for (const line of String(text || '').split('\n')) {
        if (!line.trim()) continue
        let record = null
        try {
          record = JSON.parse(line)
        } catch {
          continue // a torn line from a crash is dropped, not rewritten
        }
        if (Number.isFinite(record?.at) && record.at >= cutoff) kept.push(JSON.stringify(record))
      }
      this.fs.writeFileSync(this.jsonlPath, kept.length ? `${kept.join('\n')}\n` : '', { mode: 0o600 })
      try {
        this.fs.chmodSync(this.jsonlPath, 0o600)
      } catch {
        // mode is already 0600 on a freshly created file
      }
      this.lastPruneAt = this.now()
    } catch (error) {
      this.jsonlError = error?.message || String(error)
      this.logger?.warn?.('dsh-chrome memory JSONL unavailable: %s', this.jsonlError)
    }
  }

  #pruneJsonlIfDue(at) {
    if (!this.jsonlEnabled || this.jsonlError) return
    if (this.lastPruneAt != null && at - this.lastPruneAt < PRUNE_INTERVAL_MS) return
    this.#prepareJsonl()
  }

  #appendJsonl(sample) {
    if (!this.jsonlEnabled || this.jsonlError) return
    try {
      this.fs.appendFileSync(this.jsonlPath, `${JSON.stringify(sample)}\n`, { mode: 0o600 })
      this.jsonlWrites += 1
    } catch (error) {
      this.jsonlError = error?.message || String(error)
      this.logger?.warn?.('dsh-chrome memory JSONL write failed: %s', this.jsonlError)
    }
  }
}
