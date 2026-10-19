/**
 * Platform-aware update install/staging.
 *
 * Windows: replace the native host exe in the cache after SHA-256 verification.
 * macOS/Linux: there is no single native binary to replace; stage the plugin
 * tarball and extension zip in `cache/dsh-chrome/downloads/update-<version>/`
 * so the next explicit install/restart can use them. Everything is opt-in via
 * `update.autoInstall` and never writes outside the DSH cache.
 */
import crypto from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'

import { fetchWithTimeout, parseVersion, readSha } from './update-release.js'
import { cacheDir, hostPath } from './update-state.js'

function findAsset(release, predicate) {
  return (release.assets || []).find((item) => item?.browser_download_url && predicate(String(item.name || '')))
}

async function download(fetchImpl, asset) {
  const response = await fetchWithTimeout(fetchImpl, asset.browser_download_url, { headers: { 'user-agent': 'dsh-chrome-update' } })
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${asset.name}`)
  return Buffer.from(await response.arrayBuffer())
}

async function stageAsset({ home, fetchImpl, release, asset, targetName, version }) {
  if (!asset) return null
  const expected = await readSha(fetchImpl, release, String(asset.name || ''))
  const data = await download(fetchImpl, asset)
  if (expected) {
    const actual = crypto.createHash('sha256').update(data).digest('hex')
    if (actual !== expected) throw new Error(`sha256 mismatch for ${asset.name}`)
  }
  const dir = path.join(cacheDir(home), 'downloads', `update-${version}`)
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 })
  const target = path.join(dir, targetName)
  await fsp.writeFile(target, data, { mode: 0o600 })
  return target
}

async function installHost({ home, fetchImpl, release }) {
  const hostAsset = findAsset(release, (name) => name === 'dsh-chrome-host-win32-x64.exe')
  if (!hostAsset) return { installed: false, staged: false, reason: 'host asset not found' }
  try {
    const expected = await readSha(fetchImpl, release, hostAsset.name)
    if (!expected) return { installed: false, staged: false, reason: 'sha256 asset not found' }
    const data = await download(fetchImpl, hostAsset)
    const actual = crypto.createHash('sha256').update(data).digest('hex')
    if (actual !== expected) return { installed: false, staged: false, reason: 'sha256 mismatch' }
    const target = hostPath(home)
    await fsp.mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
    const tmp = `${target}.new-${process.pid}`
    await fsp.writeFile(tmp, data, { mode: 0o755 })
    await fsp.rename(tmp, target)
    return { installed: true, staged: false, path: target, version: parseVersion(release.tag_name)?.join('.') || null }
  } catch (error) {
    return { installed: false, staged: false, reason: String(error?.message || error) }
  }
}

async function stagePackage({ home, platform, fetchImpl, release }) {
  const version = parseVersion(release.tag_name)?.join('.') || 'unknown'
  const packageAsset = findAsset(release, (name) => /^dsh-desktop-chrome-.*\.tgz$/i.test(name))
  const extensionAsset = findAsset(release, (name) => /^dsh-chrome-extension-.*\.zip$/i.test(name))
  try {
    const packagePath = await stageAsset({
      home,
      fetchImpl,
      release,
      asset: packageAsset,
      targetName: `dsh-desktop-chrome-${version}.tgz`,
      version,
    })
    const extensionPath = await stageAsset({
      home,
      fetchImpl,
      release,
      asset: extensionAsset,
      targetName: `dsh-chrome-extension-${version}.zip`,
      version,
    })
    return {
      installed: false,
      staged: Boolean(packagePath || extensionPath),
      platform,
      packagePath,
      extensionPath,
      version,
      note: 'staged in the DSH cache; install/restart explicitly (extension reload is manual)',
    }
  } catch (error) {
    return { installed: false, staged: false, platform, reason: String(error?.message || error) }
  }
}

export async function installUpdate({ home, platform, fetchImpl, release }) {
  if (platform === 'win32') return installHost({ home, fetchImpl, release })
  if (platform === 'darwin' || platform === 'linux') return stagePackage({ home, platform, fetchImpl, release })
  return { installed: false, staged: false, reason: `unsupported platform: ${platform}` }
}

export { installHost, stagePackage }
