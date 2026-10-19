import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { UpdateChecker, compareVersions, parseVersion } from '../src/update.js'

assert.deepEqual(parseVersion('v0.2.1'), [0, 2, 1])
assert.deepEqual(parseVersion('v0.2.1-win-preview.1'), [0, 2, 1])
assert.equal(compareVersions('0.2.10', '0.2.9'), 1)
assert.equal(compareVersions('0.2.1', '0.2.1'), 0)
assert.equal(compareVersions('bad', '0.2.1'), 0)

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-update-'))
const hostBytes = Buffer.from('fake-windows-host-binary')
const hostSha = crypto.createHash('sha256').update(hostBytes).digest('hex')
const calls = []
function makeFetch({ releases, host = hostBytes } = {}) {
  return async (url, options = {}) => {
    calls.push({ url, options })
    if (String(url).includes('/releases')) {
      return { ok: true, status: 200, async json() { return releases || [] }, async text() { return '' } }
    }
    if (String(url).endsWith('.sha256')) {
      return { ok: true, status: 200, async text() { return `${hostSha}  dsh-chrome-host-win32-x64.exe\n` } }
    }
    if (String(url).includes('host-win32-x64.exe')) {
      return { ok: true, status: 200, async arrayBuffer() { return host.buffer.slice(host.byteOffset, host.byteOffset + host.byteLength) } }
    }
    return { ok: false, status: 404, async text() { return 'not found' } }
  }
}
const stableRelease = {
  tag_name: 'v0.3.0',
  draft: false,
  prerelease: false,
  html_url: 'https://github.com/x/y/releases/tag/v0.3.0',
  assets: [
    { name: 'dsh-chrome-host-win32-x64.exe', browser_download_url: 'https://example.test/host-win32-x64.exe' },
    { name: 'dsh-chrome-host-win32-x64.exe.sha256', browser_download_url: 'https://example.test/host-win32-x64.exe.sha256' },
  ],
}
const previewRelease = { ...stableRelease, tag_name: 'v0.3.1-beta.1', prerelease: true, html_url: 'https://github.com/x/y/releases/tag/v0.3.1-beta.1' }

// disabled: no fetch at all
const disabled = new UpdateChecker({ home: root, currentVersion: '0.2.1', config: { enabled: false }, fetchImpl: async () => { throw new Error('should not fetch') } })
assert.equal((await disabled.check()).available, false)
assert.equal(calls.length, 0)

// stable channel ignores prerelease
let checker = new UpdateChecker({ home: root, currentVersion: '0.2.1', config: { enabled: true, channel: 'stable' }, fetchImpl: makeFetch({ releases: [previewRelease, stableRelease] }) })
let status = await checker.check()
assert.equal(status.latest, '0.3.0')
assert.equal(status.available, true)
assert.equal(status.channel, 'stable')
assert.ok(fs.existsSync(path.join(root, 'cache', 'dsh-chrome', 'update.json')))

// current version is up to date
checker = new UpdateChecker({ home: root, currentVersion: '0.3.0', config: { enabled: true }, fetchImpl: makeFetch({ releases: [stableRelease] }) })
status = await checker.check()
assert.equal(status.available, false)

// network/HTTP failure is recorded, not thrown
checker = new UpdateChecker({ home: root, currentVersion: '0.2.1', config: { enabled: true }, fetchImpl: async () => ({ ok: false, status: 503 }) })
status = await checker.check()
assert.match(status.error, /HTTP 503/)

// autoInstall on Windows verifies sha and writes the host binary
const installRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-update-install-'))
checker = new UpdateChecker({
  home: installRoot,
  currentVersion: '0.2.1',
  platform: 'win32',
  config: { enabled: true, autoInstall: true },
  fetchImpl: makeFetch({ releases: [stableRelease] }),
})
status = await checker.check()
assert.equal(status.autoInstallResult.installed, true)
assert.deepEqual(fs.readFileSync(path.join(installRoot, 'cache', 'dsh-chrome', 'host', 'dsh-chrome-host.exe')), hostBytes)
console.log('UPDATE TEST: PASS')

// macOS/Linux: stage plugin tgz + extension zip (no native host exe)
const stageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-update-stage-'))
const pkgBytes = Buffer.from('fake-plugin-tgz')
const extBytes = Buffer.from('fake-extension-zip')
const pkgSha = crypto.createHash('sha256').update(pkgBytes).digest('hex')
function makeStageFetch() {
  return async (url) => {
    if (String(url).includes('/releases')) {
      return {
        ok: true,
        status: 200,
        async json() {
          return [{
            tag_name: 'v0.4.0',
            draft: false,
            prerelease: false,
            html_url: 'https://example.test/v0.4.0',
            assets: [
              { name: 'dsh-desktop-chrome-0.4.0.tgz', browser_download_url: 'https://example.test/dsh-desktop-chrome-0.4.0.tgz' },
              { name: 'dsh-desktop-chrome-0.4.0.tgz.sha256', browser_download_url: 'https://example.test/dsh-desktop-chrome-0.4.0.tgz.sha256' },
              { name: 'dsh-chrome-extension-0.4.0.zip', browser_download_url: 'https://example.test/dsh-chrome-extension-0.4.0.zip' },
            ],
          }]
        },
      }
    }
    if (String(url).endsWith('.tgz.sha256')) return { ok: true, status: 200, async text() { return `${pkgSha}  dsh-desktop-chrome-0.4.0.tgz` } }
    if (String(url).endsWith('.tgz')) return { ok: true, status: 200, async arrayBuffer() { return pkgBytes } }
    if (String(url).endsWith('.zip')) return { ok: true, status: 200, async arrayBuffer() { return extBytes } }
    return { ok: false, status: 404 }
  }
}
const stageChecker = new UpdateChecker({
  home: stageRoot,
  currentVersion: '0.2.1',
  platform: 'darwin',
  config: { enabled: true, autoInstall: true },
  fetchImpl: makeStageFetch(),
})
const stageStatus = await stageChecker.check()
assert.equal(stageStatus.autoInstallResult.staged, true)
assert.equal(stageStatus.autoInstallResult.installed, false)
assert.ok(fs.existsSync(stageStatus.autoInstallResult.packagePath))
assert.ok(fs.existsSync(stageStatus.autoInstallResult.extensionPath))
assert.deepEqual(fs.readFileSync(stageStatus.autoInstallResult.packagePath), pkgBytes)
