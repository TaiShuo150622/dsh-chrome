/**
 * Windows native-host auto-install for the update checker (Q29): asset lookup,
 * SHA-256 verification and the write/rename into the cache host directory.
 * Verification and write behavior are unchanged.
 */
import crypto from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'

import { fetchWithTimeout, parseVersion, readSha } from './update-release.js'
import { hostPath } from './update-state.js'

async function installHost({ home, platform, fetchImpl, release }) {
  if (platform !== 'win32') return { installed: false, reason: 'host-auto-install is Windows-only' }
  const asset = (release.assets || []).find((item) => String(item.name || '') === 'dsh-chrome-host-win32-x64.exe')
  if (!asset?.browser_download_url) return { installed: false, reason: 'host asset not found' }
  try {
    const expected = await readSha(fetchImpl, release)
    if (!expected) return { installed: false, reason: 'sha256 asset not found' }
    const response = await fetchWithTimeout(fetchImpl, asset.browser_download_url, { headers: { 'user-agent': 'dsh-chrome-update' } })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const data = Buffer.from(await response.arrayBuffer())
    const actual = crypto.createHash('sha256').update(data).digest('hex')
    if (actual !== expected) return { installed: false, reason: 'sha256 mismatch' }
    const target = hostPath(home)
    await fsp.mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
    const tmp = `${target}.new-${process.pid}`
    await fsp.writeFile(tmp, data, { mode: 0o755 })
    await fsp.rename(tmp, target)
    return { installed: true, path: target, version: parseVersion(release.tag_name)?.join('.') || null }
  } catch (error) {
    return { installed: false, reason: String(error?.message || error) }
  }
}

export { installHost }
