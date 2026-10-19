#!/usr/bin/env node
/**
 * Install → connect → one tool call → exit-cleanup smoke test.
 *
 * Runs the real `ensureInstallAssets()` and the *installed launcher* (not
 * host/host.mjs directly), starts a real BridgeServer on a temp DSH_HOME, plays
 * the extension side over native-messaging frames, performs one provider →
 * extension request, then closes the native port and asserts:
 *
 *   - every install artifact exists, has the expected path/ownership and the
 *     manifest points at the installed launcher (absolute path);
 *   - the installed launcher actually starts the copied host and the host
 *     authenticates through bridge.json (POSIX socket on macOS/Linux);
 *   - discovery/socket are owner-only (0600), the launcher is executable;
 *   - one tool call round-trips through host ↔ provider;
 *   - stdin EOF makes the host exit 0; bridge.stop() removes bridge.sock and
 *     bridge.json, and no child process is left behind.
 *
 * Platform coverage (deliberate, see docs/PLATFORM-AUDIT.md):
 *   macOS  — runs here, real POSIX socket + shell launcher (no Chrome needed)
 *   Linux  — same POSIX path; CI/Linux real-machine Chrome still unverified
 *   Windows— SKIPPED here: named pipe + .exe launcher + HKCU registration need
 *            a real Windows machine (CI windows-latest gap)
 *
 * Run with: node tests/platform/smoke.mjs
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { BridgeServer, PROTOCOL_VERSION } from '../../src/bridge.js'
import { ensureInstallAssets } from '../../src/install.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))

if (process.platform === 'win32') {
  console.log('SKIP install/connect/tool-call smoke on Windows.')
  console.log('  Reason: named pipe (\\\\.\\pipe\\...), SEA dsh-chrome-host.exe and')
  console.log('  HKCU native-messaging registration need a real Windows machine.')
  console.log('  Coverage gap: windows-latest CI only builds/starts the exe; it does')
  console.log('  not run the extension ↔ host ↔ provider round-trip.')
  process.exit(0)
}

let failures = 0
function check(name, fn) {
  try {
    const detail = fn()
    console.log(`PASS ${name}${detail ? ` — ${detail}` : ''}`)
  } catch (error) {
    failures += 1
    console.log(`FAIL ${name} — ${error?.message || error}`)
  }
}
async function checkAsync(name, fn) {
  try {
    const detail = await fn()
    console.log(`PASS ${name}${detail ? ` — ${detail}` : ''}`)
  } catch (error) {
    failures += 1
    console.log(`FAIL ${name} — ${error?.message || error}`)
  }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function waitFor(predicate, timeoutMs, label) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true
    await sleep(20)
  }
  throw new Error(`timed out waiting for ${label}`)
}

function encodeNative(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  const header = Buffer.alloc(4)
  header.writeUInt32LE(body.length, 0)
  return Buffer.concat([header, body])
}

function frameReader(onMessage) {
  let buffer = Buffer.alloc(0)
  return (chunk) => {
    buffer = Buffer.concat([buffer, chunk])
    for (;;) {
      if (buffer.length < 4) return
      const length = buffer.readUInt32LE(0)
      if (buffer.length < 4 + length) return
      const body = buffer.subarray(4, 4 + length)
      buffer = buffer.subarray(4 + length)
      try {
        onMessage(JSON.parse(body.toString('utf8')))
      } catch {
        // malformed native frame: assertions below surface the miss
      }
    }
  }
}

// Keep the temp path short: a macOS UNIX socket path is limited to ~104 bytes.
const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'dshsmk-'))
let host = null
let bridge = null
let stderr = ''

try {
  // 1) install ------------------------------------------------------------
  const info = await ensureInstallAssets({ root, home, browser: 'chrome' })
  check('install selects the POSIX launcher for this platform', () => {
    assert.equal(info.platform, process.platform === 'darwin' ? 'mac' : 'linux')
    assert.equal(info.launcherKind, 'script')
    assert.equal(info.hostExePath, null)
    return info.launcherPath
  })
  check('native messaging manifest points at the installed launcher', () => {
    const manifest = JSON.parse(fs.readFileSync(info.nativeManifestPath, 'utf8'))
    assert.equal(manifest.name, 'com.deepseek.dsh.chrome')
    assert.equal(manifest.type, 'stdio')
    assert.equal(manifest.path, info.launcherPath)
    assert.ok(path.isAbsolute(manifest.path), `manifest path is not absolute: ${manifest.path}`)
    assert.ok(fs.existsSync(manifest.path), 'manifest path does not exist')
    assert.deepEqual(manifest.allowed_origins, [`chrome-extension://${info.extensionId}/`])
    return manifest.path
  })
  check('launcher is executable and carries the installed host version', () => {
    const mode = fs.statSync(info.launcherPath).mode & 0o777
    assert.ok(mode & 0o111, `launcher not executable: ${mode.toString(8)}`)
    const script = fs.readFileSync(info.launcherPath, 'utf8')
    assert.match(script, /^#!\/bin\/sh\n/)
    assert.ok(script.includes('host.mjs'))
    assert.ok(script.includes('DSH_CHROME_HOST_VERSION'), 'launcher does not pin the host version')
    assert.ok(script.includes(info.hostVersion), `launcher version ${info.hostVersion} missing`)
    return `${mode.toString(8)} / v${info.hostVersion}`
  })
  check('install writes the cache/dev assets under the temp DSH_HOME only', () => {
    assert.ok(info.launcherPath.startsWith(home), 'launcher escaped the temp home')
    assert.ok(info.instructionsPath.startsWith(home), 'INSTALL.md escaped the temp home')
    assert.ok(fs.existsSync(info.instructionsPath))
    const dev = JSON.parse(fs.readFileSync(path.join(info.cacheDir, 'dev.json'), 'utf8'))
    assert.equal(dev.extensionDir, info.extensionDir)
    const devMode = fs.statSync(path.join(info.cacheDir, 'dev.json')).mode & 0o777
    assert.equal(devMode, 0o600, `dev.json mode ${devMode.toString(8)}`)
    return 'sandboxed'
  })
  check('install reports executable candidates (headless discovery input)', () => {
    assert.ok(Array.isArray(info.executableCandidates) && info.executableCandidates.length > 0)
    assert.equal(info.nativeMessagingMode, 'directory')
    return info.executableCandidates[0]
  })

  // 2) bridge + installed launcher ---------------------------------------
  bridge = new BridgeServer({ home })
  await bridge.start()
  check('bridge discovery/socket are owner-only (0600)', () => {
    const discoveryPath = path.join(home, 'cache', 'dsh-chrome', 'bridge.json')
    const discovery = JSON.parse(fs.readFileSync(discoveryPath, 'utf8'))
    assert.equal(discovery.protocol, PROTOCOL_VERSION)
    assert.equal(discovery.socketPath, bridge.socketPath)
    const discoveryMode = fs.statSync(discoveryPath).mode & 0o777
    const socketMode = fs.statSync(bridge.socketPath).mode & 0o777
    assert.equal(discoveryMode, 0o600, `bridge.json mode ${discoveryMode.toString(8)}`)
    assert.equal(socketMode, 0o600, `socket mode ${socketMode.toString(8)}`)
    return 'bridge.json + bridge.sock = 0600'
  })

  host = spawn(info.launcherPath, [], {
    env: {
      ...process.env,
      DSH_HOME: home,
      DSH_UPDATE_POLL_MS: '600000',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  host.stderr.on('data', (chunk) => {
    stderr += chunk
  })
  host.stdout.on(
    'data',
    frameReader((message) => {
      if (message.id == null) return
      let result
      if (message.method === 'browser.status') {
        result = { extensionVersion: 'smoke-fake', connected: true }
      } else if (message.method === 'tab.goto') {
        result = {
          tabId: 7,
          url: message.params?.url ?? null,
          title: 'Smoke',
          loadState: 'complete',
        }
      }
      host.stdin.write(
        encodeNative(
          result
            ? { id: message.id, result }
            : { id: message.id, error: { code: 'UNSUPPORTED', message: 'smoke fake' } },
        ),
      )
    }),
  )

  await checkAsync('the installed launcher authenticates to the real bridge', async () => {
    await waitFor(() => bridge.connected, 8000, 'installed host authentication')
    assert.equal(bridge.hostVersion, packageJson.version, `host version ${bridge.hostVersion}`)
    assert.equal(bridge.hostProtocol, PROTOCOL_VERSION)
    return `host ${bridge.hostVersion} / protocol ${bridge.hostProtocol}`
  })

  // 3) one provider → extension tool call --------------------------------
  await checkAsync('one tool call round-trips through the installed host', async () => {
    const status = await bridge.call('browser.status', {}, 5000)
    assert.equal(status?.extensionVersion, 'smoke-fake')
    const goto = await bridge.call('tab.goto', { url: 'https://example.com/' }, 5000)
    assert.equal(goto?.tabId, 7)
    assert.equal(goto?.url, 'https://example.com/')
    return 'browser.status + tab.goto'
  })

  await checkAsync('host.log records startup, version and authentication', async () => {
    const logPath = path.join(home, 'cache', 'dsh-chrome', 'host.log')
    await waitFor(() => fs.existsSync(logPath), 3000, 'host.log')
    const log = fs.readFileSync(logPath, 'utf8')
    assert.match(log, /host started pid=\d+ version=\S+ protocol=1/)
    assert.ok(log.includes(`version=${packageJson.version}`), `installed log version: ${log.split('\n')[0]}`)
    assert.match(log, /bridge authenticated \(protocol 1\)/)
    return 'started + authenticated'
  })

  // 4) exit cleanup -------------------------------------------------------
  await checkAsync('stdin EOF exits the host with code 0', async () => {
    host.stdin.end()
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        host.kill('SIGTERM')
        resolve()
      }, 5000)
      host.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
    assert.equal(host.exitCode, 0, `exit ${host.exitCode}; stderr: ${stderr.slice(0, 500)}`)
    const log = fs.readFileSync(path.join(home, 'cache', 'dsh-chrome', 'host.log'), 'utf8')
    assert.match(log, /stdin ended/)
    return 'exit 0'
  })

  await checkAsync('bridge.stop removes discovery + socket and leaves no listener', async () => {
    const socketPath = bridge.socketPath
    const discoveryPath = path.join(home, 'cache', 'dsh-chrome', 'bridge.json')
    await bridge.stop()
    assert.equal(bridge.server, null)
    assert.equal(bridge.connected, false)
    assert.equal(fs.existsSync(socketPath), false, `stale socket: ${socketPath}`)
    assert.equal(fs.existsSync(discoveryPath), false, `stale bridge.json: ${discoveryPath}`)
    return 'both files removed'
  })
} finally {
  try {
    host?.kill('SIGTERM')
  } catch {
    // already exited
  }
  try {
    await bridge?.stop()
  } catch {
    // already stopped
  }
  await fsp.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {})
}

console.log(
  process.platform === 'darwin'
    ? 'Platform note: macOS ran the full install → host → tool-call → cleanup path.'
    : 'Platform note: Linux used the same POSIX path; real Chrome native messaging is still unverified here.',
)
console.log(failures === 0 ? '\nPLATFORM SMOKE TEST: PASS' : `\nPLATFORM SMOKE TEST: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
