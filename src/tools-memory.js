/**
 * chrome_memory_stats (M6): a provider-side memory snapshot.
 *
 * The tool reports Node heap counters plus retention counts from the browser
 * context manager and the bridge. It never reads page text, console entries,
 * URLs, capture bodies or credentials, so the payload is safe to hand to the
 * model and later to append to a local JSONL file. The provider injects the
 * composed reader so later monitoring layers (M7) can reuse the exact same
 * snapshot; without an injection the tool still reports this process's Node
 * counters and zero object counts.
 */
import { collectMemoryStats, emptyBridgeStats, emptyContextStats, nodeMemory } from './memory-stats.js'

function size(value) {
  const number = Number(value)
  const bytes = Number.isFinite(number) && number > 0 ? number : 0
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${bytes}B`
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

export function createMemoryTools({ memoryStats = null, outputSchema, renderText }) {
  const readSnapshot = () => (typeof memoryStats === 'function' ? memoryStats() : collectMemoryStats({}))

  const memory = {
    name: 'chrome_memory_stats',
    description:
      'Report a provider memory snapshot: Node rss/heapUsed/heapTotal/external/arrayBuffers in bytes, plus retained-object counts for browser contexts, drivers, captures, console buffers, downloads, screenshot streams and the bridge. Numbers only — never page content, URLs, console text or credentials — so repeated calls can be compared to locate a leak.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: outputSchema({
        at: { type: 'string' },
        pid: {},
        node: { type: 'object', additionalProperties: true },
        objects: { type: 'object', additionalProperties: true },
        error: { type: 'string' },
      }),
      render: (_args, value) => {
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
        return renderText(lines.join('\n'))
      },
    },
    async execute() {
      try {
        return snapshotValue(readSnapshot())
      } catch (error) {
        // Diagnostics must never fail the tool path: return the Node counters
        // the process can always read, plus the reason the richer snapshot was
        // unavailable.
        return snapshotValue({ ...collectMemoryStats({}), error: error?.message || String(error) })
      }
    },
  }

  return { memory }
}
