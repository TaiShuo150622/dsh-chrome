/**
 * Provider memory diagnostics (M6).
 *
 * A snapshot is numbers only: Node heap counters plus object counts from the
 * BrowserContextManager and the BridgeServer. It never reads page text, URLs,
 * console entries, capture bodies or credentials, so the result is safe to
 * return to the model and later to append to a local JSONL file.
 */

// Node's own counters, in bytes. `arrayBuffers` is the subset of `external`
// held by ArrayBuffer/Buffer instances, which is where screenshot frames,
// capture bodies and decoded PNG pixels live.
const BYTES_FIELDS = ['rss', 'heapUsed', 'heapTotal', 'external', 'arrayBuffers']

function bytes(value) {
  return Number.isFinite(value) && value >= 0 ? Math.round(value) : 0
}

function count(value) {
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0
}

/** Current Node memory counters in bytes (injectable for tests). */
export function nodeMemory(usage = process.memoryUsage()) {
  const result = {}
  for (const field of BYTES_FIELDS) result[field] = bytes(usage?.[field])
  return result
}

// Driver counters summed across browser contexts. Every field is a count, so a
// growth in one of them is a retained-object signal rather than noise.
export const DRIVER_COUNT_FIELDS = Object.freeze([
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

/** Zero-valued BrowserContextManager.memoryStats() payload. */
export function emptyContextStats() {
  const totals = {}
  for (const field of DRIVER_COUNT_FIELDS) totals[field] = 0
  // Booleans on one driver, counted: how many drivers keep an idle timer and
  // how many own a visible window.
  totals.idleTimers = 0
  totals.visibleDrivers = 0
  return { contexts: 0, pending: 0, maxContexts: null, drivers: [], totals }
}

/** Zero-valued BridgeServer.memoryStats() payload. */
export function emptyBridgeStats() {
  return { connected: false, pending: 0, handlers: 0 }
}

function readStats(owner) {
  if (!owner || typeof owner.memoryStats !== 'function') return null
  try {
    const stats = owner.memoryStats()
    return stats && typeof stats === 'object' ? stats : null
  } catch {
    return null
  }
}

/**
 * Object counts from the provider's two state owners:
 *
 *   - `contexts`: BrowserContextManager (per-driver detail + totals)
 *   - `bridge`: BridgeServer (connected/pending/handlers)
 *
 * Missing or failing owners keep the full zero-valued shape so callers and the
 * tool schema never have to special-case a fresh provider.
 */
export function objectCounts({ contexts = null, bridge = null } = {}) {
  const contextStats = readStats(contexts)
  const bridgeStats = readStats(bridge)
  return {
    contexts: contextStats || emptyContextStats(),
    bridge: bridgeStats
      ? {
          connected: Boolean(bridgeStats.connected),
          pending: count(bridgeStats.pending),
          handlers: count(bridgeStats.handlers),
        }
      : emptyBridgeStats(),
  }
}

/** One provider memory snapshot: Node counters + object counts. */
export function collectMemoryStats({ contexts = null, bridge = null, now = () => new Date(), pid = process.pid } = {}) {
  return {
    at: now().toISOString(),
    pid,
    node: nodeMemory(),
    objects: objectCounts({ contexts, bridge }),
  }
}
