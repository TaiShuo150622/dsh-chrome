/**
 * Plugin/release update checker (opt-in).
 *
 * This is deliberately separate from the extension's dev auto-reload: it
 * checks the public GitHub release feed, records the result in
 * `~/.dsh/cache/dsh-chrome/update.json`, and — only when the user enables
 * `update.autoInstall` on a Windows host — replaces the native host exe with
 * the release asset after SHA-256 verification. The DSH plugin code itself is
 * updated through DSH's plugin manager, not by this module.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

const RELEASES_URL = 'https://api.github.com/repos'
const CHECK_TIMEOUT_MS = 15_000

export function parseVersion(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(String(value || '').trim())
  if (!match) return null
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

export function compareVersions(a, b) {
  const left = Array.isArray(a) ? a : parseVersion(a)
  const right = Array.isArray(b) ? b : parseVersion(b)
  if (!left || !right) return 0
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1
  }
  return 0
}

function cacheDir(home) {
  return path.join(home, 'cache', 'dsh-chrome')
}

function statePath(home) {
  return path.join(cacheDir(home), 'update.json')
}

function hostPath(home) {
  return path.join(cacheDir(home), 'host', 'dsh-chrome-host.exe')
}

async function fetchWithTimeout(fetchImpl, url, options = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS)
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

async function readSha(fetchImpl, release) {
  const asset = (release.assets || []).find((item) => /\.sha256$/i.test(String(item.name || '')))
  if (!asset?.browser_download_url) return null
  const response = await fetchWithTimeout(fetchImpl, asset.browser_download_url, { headers: { 'user-agent': 'dsh-chrome-update' } })
  if (!response.ok) return null
  const body = await response.text()
  const match = /([a-f0-9]{64})/i.exec(body)
  return match ? match[1].toLowerCase() : null
}

function pickRelease(releases, channel) {
  const candidates = (Array.isArray(releases) ? releases : [])
    .filter((release) => release && !release.draft)
    .filter((release) => channel === 'preview' || !release.prerelease)
    .map((release) => ({ release, version: parseVersion(release.tag_name) }))
    .filter((item) => item.version)
    .sort((a, b) => compareVersions(b.version, a.version))
  return candidates[0] || null
}

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
    this.state = {
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
    }
    this.#restore()
  }

  #restore() {
    try {
      const saved = JSON.parse(fs.readFileSync(statePath(this.home), 'utf8'))
      if (saved && typeof saved === 'object') this.state = { ...this.state, ...saved, current: this.currentVersion }
    } catch {
      // no state yet
    }
    this.state.enabled = Boolean(this.config.enabled)
    this.state.autoInstall = Boolean(this.config.autoInstall)
  }

  #persist() {
    try {
      fs.mkdirSync(cacheDir(this.home), { recursive: true, mode: 0o700 })
      fs.writeFileSync(statePath(this.home), `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 })
    } catch (error) {
      this.logger?.warn?.('dsh-chrome: update state write failed: %s', error?.message || String(error))
    }
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
      const response = await fetchWithTimeout(this.fetchImpl, `${RELEASES_URL}/${repo}/releases?per_page=20`, { headers })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const releases = await response.json()
      const picked = pickRelease(releases, this.state.channel)
      this.state.error = null
      this.state.checkedAt = new Date(this.now()).toISOString()
      if (!picked) {
        this.state.latest = null
        this.state.available = false
        this.state.releaseUrl = null
        this.#persist()
        return this.status()
      }
      const available = compareVersions(picked.version, parseVersion(this.currentVersion) || [0, 0, 0]) > 0
      this.state.latest = picked.version.join('.')
      this.state.available = available
      this.state.releaseUrl = picked.release.html_url || null
      if (available && this.config.autoInstall === true) {
        this.state.autoInstallResult = await this.#installHost(picked.release)
      }
      this.#persist()
      if (available) this.logger?.info?.('dsh-chrome: update available: %s -> %s', this.currentVersion, this.state.latest)
      return this.status()
    } catch (error) {
      this.state.error = String(error?.message || error)
      this.state.checkedAt = new Date(this.now()).toISOString()
      this.#persist()
      this.logger?.warn?.('dsh-chrome: update check failed: %s', this.state.error)
      return this.status()
    }
  }

  async #installHost(release) {
    if (this.platform !== 'win32') return { installed: false, reason: 'host-auto-install is Windows-only' }
    const asset = (release.assets || []).find((item) => String(item.name || '') === 'dsh-chrome-host-win32-x64.exe')
    if (!asset?.browser_download_url) return { installed: false, reason: 'host asset not found' }
    try {
      const expected = await readSha(this.fetchImpl, release)
      if (!expected) return { installed: false, reason: 'sha256 asset not found' }
      const response = await fetchWithTimeout(this.fetchImpl, asset.browser_download_url, { headers: { 'user-agent': 'dsh-chrome-update' } })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const data = Buffer.from(await response.arrayBuffer())
      const actual = crypto.createHash('sha256').update(data).digest('hex')
      if (actual !== expected) return { installed: false, reason: 'sha256 mismatch' }
      const target = hostPath(this.home)
      await fsp.mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
      const tmp = `${target}.new-${process.pid}`
      await fsp.writeFile(tmp, data, { mode: 0o755 })
      await fsp.rename(tmp, target)
      return { installed: true, path: target, version: parseVersion(release.tag_name)?.join('.') || null }
    } catch (error) {
      return { installed: false, reason: String(error?.message || error) }
    }
  }
}

export function createUpdateChecker(options) {
  return new UpdateChecker(options)
}
