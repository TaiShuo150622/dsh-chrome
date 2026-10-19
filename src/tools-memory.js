/**
 * chrome_memory_stats (M6 snapshot + M7 continuous monitor control).
 *
 * The tool reports Node heap counters plus retention counts from the browser
 * context manager and the bridge. `op:"start"` begins explicit continuous
 * sampling, `op:"stop"` ends it, `op:"dump"` returns the recent ring and the
 * retained-memory computation, and the default `op:"status"` returns a fresh
 * snapshot plus the monitor state. It never reads page text, console entries,
 * URLs, capture bodies or credentials, so the payload is safe to hand to the
 * model and to append to the local JSONL file.
 */
import { collectMemoryStats, emptyBridgeStats, emptyContextStats, nodeMemory } from './memory-stats.js'

function size(value) {
  const number = Number(value)
  const bytes = Number.isFinite(number) && number > 0 ? number : 0
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${bytes}B`
}

function signedSize(value) {
  const number = Number(value)
  const bytes = Number.isFinite(number) ? number : 0
  return `${bytes >= 0 ? '+' : '-'}${size(Math.abs(bytes))}`
}

function snapshotValue(snapshot) {
  const value = snapshot && typeof snapshot === 'object' ? snapshot : {}
  return {
    at: typeof value.at === 'string' ? value.at : new Date().toISOString(),
    pid: Number.isFinite(value.pid) ? value.pid : null,
    node: value.node && typeof value.node === 'object' ? value.node : nodeMemory(),
    objects: {
      contexts: value.objects?.contexts && typeof value.objects.contexts === 'object'
        ? value.objects.contexts
        : emptyContextStats(),
      bridge: value.objects?.bridge && typeof value.objects.bridge === 'object'
        ? value.objects.bridge
        : emptyBridgeStats(),
    },
    ...(typeof value.error === 'string' && value.error ? { error: value.error } : {}),
  }
}

function snapshotLines(value) {
  const node = value.node || {}
  const contexts = value.objects?.contexts || {}
  const totals = contexts.totals || {}
  const bridge = value.objects?.bridge || {}
  const lines = [
    `Memory snapshot at ${value.at || 'unknown'} (provider pid ${value.pid ?? '?'})`,
    `node: rss ${size(node.rss)}  heapUsed ${size(node.heapUsed)} / ${size(node.heapTotal)}  external ${size(node.external)}  arrayBuffers ${size(node.arrayBuffers)}`,
    `contexts: ${contexts.contexts ?? 0}/${contexts.maxContexts ?? '?'} (pending ${contexts.pending ?? 0})  drivers ${Array.isArray(contexts.drivers) ? contexts.drivers.length : 0}`,
    `retained: tabs ${totals.tabs ?? 0}  owners ${totals.owners ?? 0}  sessions ${totals.bySession ?? 0}  console buffers ${totals.consoleBuffers ?? 0}  captures ${totals.captures ?? 0} (entries ${totals.captureEntries ?? 0}, bodies ${size(totals.captureBodyBytes)})`,
    `downloads ${totals.downloads ?? 0} (${totals.downloadByGuid ?? 0} indexed)  shot streams ${totals.shotStreams ?? 0}  idle timers ${totals.idleTimers ?? 0}  visible drivers ${totals.visibleDrivers ?? 0}`,
    `bridge: ${bridge.connected ? 'CONNECTED' : 'DISCONNECTED'}  pending ${bridge.pending ?? 0}  handlers ${bridge.handlers ?? 0}`,
  ]
  for (const driver of Array.isArray(contexts.drivers) ? contexts.drivers : []) {
    const stats = driver?.stats || {}
    lines.push(
      `driver ${String(driver?.contextId ?? '?').slice(0, 8)}: chrome pid ${stats.chromePid ?? '?'}  tabs ${stats.tabs ?? 0}  captures ${stats.captures ?? 0}  shot streams ${stats.shotStreams ?? 0}  ${driver?.connected ? 'connected' : 'disconnected'}`,
    )
  }
  if (value.error) lines.push('', `WARNING: ${value.error}`)
  return lines
}

function jsonlLine(jsonl) {
  if (!jsonl || !jsonl.enabled) return 'jsonl: disabled'
  return `jsonl: ${jsonl.path} (${jsonl.writes ?? 0} writes, max age ${Math.round((jsonl.maxAgeMs || 0) / 3_600_000)}h)${jsonl.error ? ` — ERROR: ${jsonl.error}` : ''}`
}

function alertLines(alerts) {
  if (!Array.isArray(alerts) || alerts.length === 0) return []
  return [
    `alerts (${alerts.length}):`,
    ...alerts.map((alert) => `  - ${alert.code}: ${alert.message}`),
  ]
}

function monitorLines(monitor) {
  if (!monitor || monitor.available !== true) return ['monitor: unavailable (no MemoryMonitor wired)']
  const lines = [
    `monitor: ${monitor.running ? 'RUNNING' : 'stopped'} every ${monitor.intervalMs ?? '?'}ms  ring ${monitor.sampleCount ?? 0}/${monitor.ringLimit ?? '?'}  baseline rss ${size(monitor.baseline?.rss)}`,
    jsonlLine(monitor.jsonl),
    ...alertLines(monitor.alerts),
  ]
  if (monitor.lastError) lines.push(`monitor last error: ${monitor.lastError}`)
  return lines
}

function monitorStatus(memoryMonitor) {
  if (!memoryMonitor || typeof memoryMonitor.status !== 'function') {
    return { available: false, running: false }
  }
  try {
    return { available: true, ...memoryMonitor.status() }
  } catch (error) {
    return { available: true, running: false, error: error?.message || String(error) }
  }
}

export function createMemoryTools({ memoryStats = null, memoryMonitor = null, outputSchema, renderText }) {
  const readSnapshot = () => (typeof memoryStats === 'function' ? memoryStats() : collectMemoryStats({}))

  const memory = {
    name: 'chrome_memory_stats',
    description:
      'Report a provider memory snapshot: Node rss/heapUsed/heapTotal/external/arrayBuffers in bytes, plus retained-object counts for browser contexts, drivers, captures, console buffers, downloads, screenshot streams and the bridge. op:"start" begins explicit continuous sampling every intervalMs (default 5000ms, in-memory ring of 600, numeric JSONL at ~/.dsh/cache/dsh-chrome/memory.jsonl); op:"stop" ends sampling; op:"dump" returns the recent ring, retained-memory deltas and alerts; the default op:"status" returns a fresh snapshot plus monitor state. Numbers only — never page content, URLs, console text or credentials — so repeated calls can be compared to locate a leak.',
    parameters: {
      type: 'object',
      properties: {
        op: {
          type: 'string',
          enum: ['start', 'stop', 'status', 'dump'],
          description: 'start/stop continuous sampling, dump the recent ring, or take a status snapshot (default).',
        },
        intervalMs: {
          type: 'number',
          description: 'start: sampling interval in milliseconds (250–600000; default 5000).',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: outputSchema({
        ok: { type: 'boolean' },
        op: { type: 'string' },
        at: { type: 'string' },
        pid: {},
        node: { type: 'object', additionalProperties: true },
        objects: { type: 'object', additionalProperties: true },
        monitor: { type: 'object', additionalProperties: true },
        started: { type: 'boolean' },
        stopped: { type: 'boolean' },
        alreadyRunning: { type: 'boolean' },
        running: { type: 'boolean' },
        intervalMs: { type: 'number' },
        sampleCount: { type: 'number' },
        ringLimit: { type: 'number' },
        count: { type: 'number' },
        baseline: { type: 'object', additionalProperties: true },
        latest: { type: 'object', additionalProperties: true },
        samples: { type: 'array', items: { type: 'object', additionalProperties: true } },
        retained: { type: 'object', additionalProperties: true },
        alerts: { type: 'array', items: { type: 'object', additionalProperties: true } },
        alertLog: { type: 'array', items: { type: 'object', additionalProperties: true } },
        error: { type: 'string' },
      }),
      render: (_args, value) => {
        const op = value.op || 'status'
        if (op === 'start') {
          if (value.ok === false) return renderText(`chrome_memory_stats start failed: ${value.error || 'unknown error'}`)
          return renderText(
            [
              value.started
                ? `Memory monitor started: every ${value.intervalMs}ms (${value.sampleCount ?? 0} sample(s) in the ring)`
                : `Memory monitor already running: every ${value.intervalMs}ms`,
              jsonlLine(value.monitor?.jsonl),
              ...alertLines(value.monitor?.alerts),
            ].join('\n'),
          )
        }
        if (op === 'stop') {
          if (value.ok === false) return renderText(`chrome_memory_stats stop failed: ${value.error || 'unknown error'}`)
          return renderText(
            value.stopped
              ? `Memory monitor stopped after ${value.sampleCount ?? 0} sample(s); the ring stays readable with op:"dump".`
              : 'Memory monitor was not running.',
          )
        }
        if (op === 'dump') {
          if (value.ok === false) return renderText(`chrome_memory_stats dump failed: ${value.error || 'unknown error'}`)
          const retained = value.retained || {}
          const lines = [
            `Memory monitor dump: ${value.count ?? 0} sample(s) (ring ${value.ringLimit ?? '?'})  ${value.running ? 'RUNNING' : 'stopped'}  every ${value.intervalMs ?? '?'}ms`,
            `window: ${retained.seconds ?? 0}s  rss ${size(retained.rssBytes)} (${signedSize(retained.rssDeltaBytes)})  heapUsed ${size(retained.heapUsedBytes)} (${signedSize(retained.heapUsedDeltaBytes)})  arrayBuffers ${size(retained.arrayBuffersBytes)} (${signedSize(retained.arrayBuffersDeltaBytes)})`,
            `retained now: capture bodies ${size(retained.captureBodyBytes)} (${retained.captureEntries ?? 0} entries)  tabs ${retained.tabs ?? 0}  sessions ${retained.bySession ?? 0}  bridge pending ${retained.bridgePending ?? 0}`,
            jsonlLine(value.jsonl),
            ...alertLines(value.alerts),
          ]
          if (value.lastError) lines.push(`last error: ${value.lastError}`)
          return renderText(lines.join('\n'))
        }
        return renderText([...snapshotLines(value), ...monitorLines(value.monitor)].join('\n'))
      },
    },
    async execute(args) {
      const op = typeof args?.op === 'string' && args.op ? args.op : 'status'
      try {
        if (op === 'status') {
          try {
            return { ok: true, op, ...snapshotValue(readSnapshot()), monitor: monitorStatus(memoryMonitor) }
          } catch (error) {
            // A broken collector must still return the Node counters the
            // process can always read, plus the reason the snapshot failed.
            return {
              ok: false,
              op,
              ...snapshotValue({ ...collectMemoryStats({}), error: error?.message || String(error) }),
              monitor: monitorStatus(memoryMonitor),
            }
          }
        }
        if (op === 'start' || op === 'stop' || op === 'dump') {
          if (!memoryMonitor || typeof memoryMonitor[op] !== 'function') {
            return { ok: false, op, error: 'MONITOR_UNAVAILABLE' }
          }
          if (op === 'start') {
            const result = memoryMonitor.start({ intervalMs: args?.intervalMs })
            return { ok: true, op, ...result, monitor: monitorStatus(memoryMonitor) }
          }
          if (op === 'stop') {
            const result = memoryMonitor.stop()
            return { ok: true, op, ...result, monitor: monitorStatus(memoryMonitor) }
          }
          return { ok: true, op, ...memoryMonitor.dump() }
        }
        return { ok: false, op, error: 'INVALID_ARGUMENT' }
      } catch (error) {
        // Diagnostics must never fail the tool path.
        return { ok: false, op, error: error?.message || String(error) }
      }
    },
  }

  return { memory }
}
