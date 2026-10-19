/**
 * Best-effort Chrome process-tree RSS (M8).
 *
 * Chrome hosts the browser process plus one renderer per page and assorted
 * utility processes. `ps` reports RSS per process, so one table read plus a
 * parent/child walk gives the total RSS of the tree rooted at `chromePid`.
 *
 * The reader is intentionally synchronous and injectable: `chrome_memory_stats`
 * must stay a read-only, best-effort diagnostic, so any failure (missing `ps`,
 * timeout, gone pid) returns nulls instead of throwing or blocking the tool.
 * Windows has no `ps`; the queue allows reporting it as unsupported there.
 */
import { execFileSync } from 'node:child_process'

export const PS_TIMEOUT_MS = 1000
export const PS_MAX_BUFFER = 4 * 1024 * 1024

function defaultExec(file, args, options) {
  return execFileSync(file, args, options)
}

/** Parse `ps -axo pid=,ppid=,rss=` (RSS in KiB) into pid -> {ppid, rssKb}. */
export function parsePsTable(text) {
  const table = new Map()
  for (const line of String(text || '').split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)$/)
    if (!match) continue
    table.set(Number(match[1]), { ppid: Number(match[2]), rssKb: Number(match[3]) })
  }
  return table
}

/**
 * Sum RSS (bytes) and process count for `rootPid` and all descendants. Returns
 * null when the root pid is absent from the table; a cycle in a malformed table
 * cannot loop forever because every pid is visited once.
 */
export function processTreeFromTable(rootPid, table) {
  const root = Number(rootPid)
  if (!Number.isFinite(root) || !table?.has(root)) return null
  const children = new Map()
  for (const [pid, entry] of table) {
    if (!children.has(entry.ppid)) children.set(entry.ppid, [])
    children.get(entry.ppid).push(pid)
  }
  let rssKb = 0
  let processCount = 0
  const queue = [root]
  const seen = new Set()
  while (queue.length > 0) {
    const pid = queue.shift()
    if (seen.has(pid)) continue
    seen.add(pid)
    const entry = table.get(pid)
    if (!entry) continue
    rssKb += entry.rssKb
    processCount += 1
    for (const child of children.get(pid) || []) if (!seen.has(child)) queue.push(child)
  }
  return { rss: rssKb * 1024, processCount }
}

/**
 * Read the process tree rooted at `pid`.
 *
 * Returns `{ supported, rss, processCount }`; `rss`/`processCount` are null
 * whenever the value cannot be read (Windows, invalid/gone pid, `ps` failure).
 * `exec` is injectable so tests can pin a fake ps table without a real process.
 */
export function readProcessTree(
  pid,
  { platform = process.platform, exec = defaultExec, timeoutMs = PS_TIMEOUT_MS } = {},
) {
  const root = Number(pid)
  if (!Number.isFinite(root) || root <= 0) return { supported: true, rss: null, processCount: null }
  if (platform === 'win32') return { supported: false, rss: null, processCount: null }
  let output = null
  try {
    output = exec('ps', ['-axo', 'pid=,ppid=,rss='], {
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: PS_MAX_BUFFER,
    })
  } catch {
    return { supported: true, rss: null, processCount: null }
  }
  const tree = processTreeFromTable(root, parsePsTable(output))
  if (!tree) return { supported: true, rss: null, processCount: null }
  return { supported: true, rss: tree.rss, processCount: tree.processCount }
}
