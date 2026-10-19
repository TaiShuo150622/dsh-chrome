/**
 * Verification artifact storage.
 *
 * `chrome_verify` keeps evidence outside ephemeral context profiles so a run
 * stays reproducible after the context closes: one directory per run under a
 * global root, plus the JSON report and screenshot copied into it. Retention is
 * "keep the newest N runs" (mtime), matching the previous manager behavior.
 *
 * Contexts no longer own this layout; `index.js` constructs one store and
 * injects it into the verify tool.
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

const RUN_PREFIX = 'verify-'

export class ArtifactStore {
  constructor({ root, retentionRuns = 50 } = {}) {
    if (typeof root !== 'string' || !root) throw new TypeError('artifact root is required')
    this.root = root
    this.retentionRuns = retentionRuns
  }

  /** Create (and return) the per-run directory `verify-<runId>`. */
  async createArtifactRun(runId) {
    const dir = path.join(this.root, `${RUN_PREFIX}${runId}`)
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    return dir
  }

  /** Path of the JSON report for one run. */
  reportPath(runDir, runId) {
    return path.join(runDir, `${RUN_PREFIX}${runId}.json`)
  }

  /** Path of the copied screenshot for one run. */
  screenshotPath(runDir, runId) {
    return path.join(runDir, `screenshot-${runId}.png`)
  }

  /**
   * Copy a driver screenshot into the run directory. Throws when the source is
   * unreadable so the caller can fall back to the driver path.
   */
  async copyScreenshot(shot, runDir, runId) {
    const target = this.screenshotPath(runDir, runId)
    await fsp.copyFile(shot.path, target)
    return target
  }

  /**
   * Keep the newest `maxRuns` run directories. Best-effort: any filesystem
   * error leaves the remaining runs in place and returns what was removed.
   */
  pruneArtifacts(maxRuns = this.retentionRuns) {
    try {
      if (!fs.existsSync(this.root)) return []
      const runs = fs
        .readdirSync(this.root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name.startsWith(RUN_PREFIX))
        .map((entry) => {
          const full = path.join(this.root, entry.name)
          return { full, name: entry.name, mtime: fs.statSync(full).mtimeMs }
        })
        .sort((a, b) => b.mtime - a.mtime)
      const removed = runs.slice(Math.max(0, maxRuns))
      for (const run of removed) fs.rmSync(run.full, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
      return removed.map((run) => run.name)
    } catch {
      return []
    }
  }
}
