/**
 * Plugin/release update checker (opt-in).
 *
 * This is deliberately separate from the extension's dev auto-reload: it
 * checks the public GitHub release feed, records the result in
 * `~/.dsh/cache/dsh-chrome/update.json`, and — only when the user enables
 * `update.autoInstall` on a Windows host — replaces the native host exe with
 * the release asset after SHA-256 verification. The DSH plugin code itself is
 * updated through DSH's plugin manager, not by this module.
 *
 * Q29: release parsing/version comparison live in update-release.js, the state
 * file paths and persistence in update-state.js, and the Windows host install in
 * update-host.js. UpdateChecker only orchestrates the check/install lifecycle.
 */
import { compareVersions, fetchWithTimeout, parseVersion, pickRelease, releasesUrl } from './update-release.js'
import { installUpdate } from './update-host.js'
import { loadState, saveState } from './update-state.js'

export { parseVersion, compareVersions } from './update-release.js'

export class UpdateChecker {
  constructor({ home, currentVersion, config, fetchImpl = globalThis.fetch, logger = null, platform = process.platform, now = Date.now } = {}) {
    this.home = home
    this.currentVersion = String(currentVersion || '0.0.0')
    this.config = config || {}
    this.fetchImpl = fetchImpl
    this.logger = logger
    this.platform = platform
    this.now = now
    this.timer = null
    this.running = null
    this.state = loadState(
      this.home,
      {
        enabled: Boolean(this.config.enabled),
        autoInstall: Boolean(this.config.autoInstall),
        channel: this.config.channel || 'stable',
        current: this.currentVersion,
        latest: null,
        available: false,
        checkedAt: null,
        error: null,
        autoInstallResult: null,
        releaseUrl: null,
      },
      this.currentVersion,
    )
    this.state.enabled = Boolean(this.config.enabled)
    this.state.autoInstall = Boolean(this.config.autoInstall)
  }

  status() {
    return { ...this.state, running: Boolean(this.running) }
  }

  start() {
    if (!this.state.enabled || this.timer || this.running) return
    const intervalMs = Math.max(1, Number(this.config.checkIntervalHours) || 24) * 3600_000
    const initial = setTimeout(() => { this.check().catch(() => {}) }, 3_000)
    initial.unref?.()
    this.timer = setInterval(() => { this.check().catch(() => {}) }, intervalMs)
    this.timer.unref?.()
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  async check() {
    if (!this.state.enabled) return this.status()
    if (this.running) return this.running
    this.running = this.#checkOnce().finally(() => { this.running = null })
    return this.running
  }

  async #checkOnce() {
    const repo = this.config.repository || 'TaiShuo150622/dsh-chrome'
    const headers = { accept: 'application/vnd.github+json', 'user-agent': 'dsh-chrome-update' }
    try {
      const response = await fetchWithTimeout(this.fetchImpl, releasesUrl(repo), { headers })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const releases = await response.json()
      const picked = pickRelease(releases, this.state.channel)
      this.state.error = null
      this.state.checkedAt = new Date(this.now()).toISOString()
      if (!picked) {
        this.state.latest = null
        this.state.available = false
        this.state.releaseUrl = null
        saveState(this.home, this.state, this.logger)
        return this.status()
      }
      const available = compareVersions(picked.version, parseVersion(this.currentVersion) || [0, 0, 0]) > 0
      this.state.latest = picked.version.join('.')
      this.state.available = available
      this.state.releaseUrl = picked.release.html_url || null
      if (available && this.config.autoInstall === true) {
        this.state.autoInstallResult = await installUpdate({
          home: this.home,
          platform: this.platform,
          fetchImpl: this.fetchImpl,
          release: picked.release,
        })
      }
      saveState(this.home, this.state, this.logger)
      if (available) this.logger?.info?.('dsh-chrome: update available: %s -> %s', this.currentVersion, this.state.latest)
      return this.status()
    } catch (error) {
      this.state.error = String(error?.message || error)
      this.state.checkedAt = new Date(this.now()).toISOString()
      saveState(this.home, this.state, this.logger)
      this.logger?.warn?.('dsh-chrome: update check failed: %s', this.state.error)
      return this.status()
    }
  }
}

export function createUpdateChecker(options) {
  return new UpdateChecker(options)
}
