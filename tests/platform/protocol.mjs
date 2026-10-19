#!/usr/bin/env node
/**
 * Bridge/host protocol-version negotiation tests — no Chrome required.
 *
 * Covers the docs/CONTRACTS.md §1/§6 guarantees:
 *   1. provider side: hello must carry a supported `protocol`; a mismatch gets
 *      one `hello-error` frame with the stable `PROTOCOL_VERSION_MISMATCH`
 *      code and never a `hello-ok` (no silent downgrade);
 *   2. host side: hello-ok/discovery protocol mismatches are detected, the
 *      host logs the real reason, and retries stop after a bounded number of
 *      attempts instead of reconnecting forever;
 *   3. a new provider generation (new bridge.json token) re-enables exactly
 *      one fresh negotiation, so a DSH upgrade can recover without restarting
 *      Chrome;
 *   4. the SEA build injects the provider version (no hardcoded 0.0.1), and
 *      host/bridge protocol constants cannot drift silently;
 *   5. a failed BridgeServer.start() rolls back its listener/socket file.
 *
 * Run with: node tests/platform/protocol.mjs
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  BridgeServer,
  PROTOCOL_VERSION,
  PROTOCOL_VERSION_MISMATCH,
  SUPPORTED_PROTOCOL_VERSIONS,
} from '../../src/bridge.js'
import { makeSeaEntry, packageVersion } from '../../scripts/build-windows-host.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const hostPath = path.join(root, 'host', 'host.mjs')
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const isWindows = process.platform === 'win32'

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
        // malformed native frame: the test fails on its assertions instead
      }
    }
  }
}

/**
 * One raw JSON-line handshake. Resolves when the provider answers with
 * hello-ok/hello-error or when the connection closes/times out.
 */
function handshake(socketPath, payload, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const socket = net.connect(socketPath)
    const messages = []
    let buffer = ''
    let done = false
    let timer = null
    const finish = (closed) => {
      if (done) return
      done = true
      if (timer) clearTimeout(timer)
      try {
        socket.destroy()
      } catch {
        // already gone
      }
      resolve({ messages, closed })
    }
    timer = setTimeout(() => finish(false), timeoutMs)
    socket.setEncoding('utf8')
    socket.on('connect', () => socket.write(`${JSON.stringify(payload)}\n`))
    socket.on('data', (chunk) => {
      buffer += chunk
      let index = buffer.indexOf('\n')
      while (index >= 0) {
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        index = buffer.indexOf('\n')
        if (!line.trim()) continue
        let message
        try {
          message = JSON.parse(line)
        } catch {
          continue
        }
        messages.push(message)
        if (message?.type === 'hello-ok' || message?.type === 'hello-error') finish(false)
      }
    })
    socket.on('close', () => finish(true))
    socket.on('error', () => {})
  })
}

// ---------------------------------------------------------------------------
// 1) provider side negotiation
// ---------------------------------------------------------------------------

const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'dshpt-p-'))
const bridge = new BridgeServer({ home })
try {
  await bridge.start()
  const discoveryPath = path.join(home, 'cache', 'dsh-chrome', 'bridge.json')
  const discovery = JSON.parse(await fsp.readFile(discoveryPath, 'utf8'))

  check('discovery file advertises PROTOCOL_VERSION', () => {
    assert.equal(discovery.protocol, PROTOCOL_VERSION)
    return `protocol ${discovery.protocol}`
  })

  if (!isWindows) {
    check('discovery file and socket are owner-only (0600)', () => {
      const discoveryMode = fs.statSync(discoveryPath).mode & 0o777
      const socketMode = fs.statSync(bridge.socketPath).mode & 0o777
      assert.equal(discoveryMode, 0o600, `bridge.json mode ${discoveryMode.toString(8)}`)
      assert.equal(socketMode, 0o600, `socket mode ${socketMode.toString(8)}`)
      return 'bridge.json + bridge.sock = 0600'
    })
  }

  await checkAsync('hello with a supported protocol gets hello-ok', async () => {
    const result = await handshake(bridge.socketPath, {
      type: 'hello',
      token: bridge.token,
      hostVersion: 'protocol-test-host',
      protocol: PROTOCOL_VERSION,
    })
    const ok = result.messages.find((message) => message.type === 'hello-ok')
    assert.ok(ok, 'hello-ok missing')
    assert.equal(ok.protocol, PROTOCOL_VERSION)
    assert.equal(ok.hostProtocol, PROTOCOL_VERSION)
    assert.equal(bridge.hostVersion, 'protocol-test-host')
    assert.equal(bridge.hostProtocol, PROTOCOL_VERSION)
    return `protocol ${ok.protocol}`
  })

  await checkAsync('a newer protocol is rejected with PROTOCOL_VERSION_MISMATCH', async () => {
    const result = await handshake(bridge.socketPath, {
      type: 'hello',
      token: bridge.token,
      hostVersion: 'future-host',
      protocol: PROTOCOL_VERSION + 1,
    })
    assert.ok(!result.messages.some((message) => message.type === 'hello-ok'), 'must not send hello-ok')
    const error = result.messages.find((message) => message.type === 'hello-error')
    assert.ok(error, `hello-error missing: ${JSON.stringify(result.messages)}`)
    assert.equal(error.code, PROTOCOL_VERSION_MISMATCH)
    assert.equal(error.expected, PROTOCOL_VERSION)
    assert.equal(error.received, PROTOCOL_VERSION + 1)
    assert.equal(bridge.lastProtocolError?.code, PROTOCOL_VERSION_MISMATCH)
    return error.code
  })

  await checkAsync('hello without a protocol is rejected (no implicit version)', async () => {
    const result = await handshake(bridge.socketPath, {
      type: 'hello',
      token: bridge.token,
      hostVersion: 'legacy-host',
    })
    const error = result.messages.find((message) => message.type === 'hello-error')
    assert.ok(error, `hello-error missing: ${JSON.stringify(result.messages)}`)
    assert.equal(error.code, PROTOCOL_VERSION_MISMATCH)
    assert.equal(error.received, null)
    return 'received=null'
  })

  await checkAsync('a string protocol is not coerced into a number', async () => {
    const result = await handshake(bridge.socketPath, {
      type: 'hello',
      token: bridge.token,
      protocol: String(PROTOCOL_VERSION),
    })
    const error = result.messages.find((message) => message.type === 'hello-error')
    assert.ok(error, 'string protocol was accepted')
    assert.equal(error.code, PROTOCOL_VERSION_MISMATCH)
    return 'type-checked'
  })

  await checkAsync('a wrong token is still rejected without a version frame', async () => {
    const result = await handshake(bridge.socketPath, {
      type: 'hello',
      token: 'not-the-token',
      protocol: PROTOCOL_VERSION,
    })
    assert.ok(!result.messages.some((message) => message.type === 'hello-ok'))
    assert.ok(!result.messages.some((message) => message.type === 'hello-error'))
    return 'token gate first'
  })

  await checkAsync('the bridge still accepts a valid hello after mismatches', async () => {
    const result = await handshake(bridge.socketPath, {
      type: 'hello',
      token: bridge.token,
      protocol: PROTOCOL_VERSION,
    })
    assert.ok(result.messages.some((message) => message.type === 'hello-ok'))
    return 'recovered'
  })
} finally {
  await bridge.stop()
  await fsp.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {})
}

// ---------------------------------------------------------------------------
// 2) host side negotiation, bounded retry and recovery
// ---------------------------------------------------------------------------

if (isWindows) {
  console.log('SKIP host-side protocol test on Windows — run on macOS/Linux or a Windows CI machine (named pipe + host.exe still a real-machine gap)')
} else {
  const home2 = await fsp.mkdtemp(path.join(os.tmpdir(), 'dshpt-h-'))
  const cacheDir = path.join(home2, 'cache', 'dsh-chrome')
  fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 })
  const socketPath = path.join(cacheDir, 'bridge.sock')
  const connections = []
  const hellos = []
  const forwarded = []
  let allowAuth = false

  const server = net.createServer((connection) => {
    const generation = connections.length
    connections.push(connection)
    connection.setEncoding('utf8')
    let buffer = ''
    connection.on('data', (chunk) => {
      buffer += chunk
      for (;;) {
        const index = buffer.indexOf('\n')
        if (index < 0) return
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        if (!line.trim()) continue
        let message
        try {
          message = JSON.parse(line)
        } catch {
          continue
        }
        if (message?.type === 'hello') {
          hellos.push(message)
          if (allowAuth) {
            connection.write(`${JSON.stringify({ type: 'hello-ok', protocol: PROTOCOL_VERSION })}\n`)
          } else if (generation === 1) {
            // Exercise the explicit hello-error path as well as a bad hello-ok.
            connection.write(
              `${JSON.stringify({
                type: 'hello-error',
                code: PROTOCOL_VERSION_MISMATCH,
                message: 'fake provider speaks protocol 2',
                expected: 2,
                received: 2,
              })}\n`,
            )
          } else {
            connection.write(`${JSON.stringify({ type: 'hello-ok', protocol: 2 })}\n`)
          }
          continue
        }
        forwarded.push(message)
      }
    })
    connection.on('error', () => {})
  })
  await new Promise((resolve) => server.listen(socketPath, resolve))

  const writeDiscovery = async (token) => {
    const temp = path.join(cacheDir, `bridge.json.${process.pid}.tmp`)
    await fsp.writeFile(
      temp,
      JSON.stringify({ protocol: PROTOCOL_VERSION, socketPath, token, pid: process.pid, startedAt: Date.now() }),
      { mode: 0o600 },
    )
    await fsp.rename(temp, path.join(cacheDir, 'bridge.json'))
  }
  await writeDiscovery('generation-1')

  const host = spawn(process.execPath, [hostPath], {
    env: {
      ...process.env,
      DSH_HOME: home2,
      DSH_HOST_MAX_PROTOCOL_MISMATCHES: '3',
      DSH_HOST_RETRY_BASE_MS: '25',
      DSH_HOST_RETRY_MAX_MS: '50',
      DSH_HOST_MISMATCH_POLL_MS: '50',
      DSH_UPDATE_POLL_MS: '600000',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stderr = ''
  host.stderr.on('data', (chunk) => {
    stderr += chunk
  })
  const nativeFrames = []
  host.stdout.on(
    'data',
    frameReader((message) => {
      nativeFrames.push(message)
      if (message.id === 7) {
        host.stdin.write(
          encodeNative({ id: 7, result: { extensionVersion: 'protocol-fake', connected: true } }),
        )
      }
    }),
  )

  const logPath = path.join(cacheDir, 'host.log')
  const readLog = () => {
    try {
      return fs.readFileSync(logPath, 'utf8')
    } catch {
      return ''
    }
  }

  try {
    await checkAsync('host sends hello with protocol + injected provider version', async () => {
      await waitFor(() => hellos.length >= 1, 5000, 'first host hello')
      const hello = hellos[0]
      assert.equal(hello.type, 'hello')
      assert.equal(hello.protocol, PROTOCOL_VERSION)
      assert.equal(hello.hostVersion, packageVersion(root))
      assert.notEqual(hello.hostVersion, '0.0.1')
      return `${hello.hostVersion} / protocol ${hello.protocol}`
    })

    await checkAsync('host retries a version mismatch only a bounded number of times', async () => {
      await waitFor(() => connections.length >= 3, 5000, 'three mismatch attempts')
      const countAfterLimit = connections.length
      await sleep(350)
      assert.equal(
        connections.length,
        countAfterLimit,
        `host kept reconnecting (${countAfterLimit} -> ${connections.length}) after the cap`,
      )
      assert.ok(countAfterLimit <= 3, `too many attempts: ${countAfterLimit}`)
      return `${countAfterLimit} attempts, then paused`
    })

    await checkAsync('host log names the stable code and both versions', async () => {
      const log = readLog()
      assert.match(log, /protocol mismatch/)
      assert.match(log, /PROTOCOL_VERSION_MISMATCH/)
      assert.match(log, /host=1 provider=2/)
      assert.match(log, /reconnect paused until bridge\.json changes/)
      return 'log carries reason + code'
    })

    await checkAsync('a new provider generation (new token) gets one fresh negotiation', async () => {
      allowAuth = true
      await writeDiscovery('generation-2')
      await waitFor(() => connections.length >= 4, 5000, 'reconnect after token change')
      assert.equal(connections.length, 4, `expected exactly one new attempt, got ${connections.length}`)
      await waitFor(() => readLog().includes('bridge authenticated (protocol 1)'), 3000, 'host authentication')
      return 'gen-2 authenticated'
    })

    await checkAsync('the relay still carries a provider request after negotiation', async () => {
      connections.at(-1).write(`${JSON.stringify({ id: 7, method: 'browser.status', params: {} })}\n`)
      await waitFor(() => nativeFrames.some((frame) => frame.id === 7 && frame.method === 'browser.status'), 3000, 'native forward')
      await waitFor(() => forwarded.some((frame) => frame.id === 7 && frame.result?.extensionVersion === 'protocol-fake'), 3000, 'bridge reply')
      return 'round-trip ok'
    })
  } finally {
    host.kill('SIGTERM')
    await new Promise((resolve) => {
      if (host.exitCode !== null) return resolve()
      const timer = setTimeout(resolve, 3000)
      host.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
    await new Promise((resolve) => {
      try {
        server.close(() => resolve())
      } catch {
        resolve()
      }
    })
    await fsp.rm(home2, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {})
    check('host exits cleanly on SIGTERM', () => {
      assert.equal(host.exitCode, 0, `exit ${host.exitCode}; stderr: ${stderr.slice(0, 500)}`)
      return 'exit 0'
    })
  }
}

// ---------------------------------------------------------------------------
// 3) static contract checks + bridge start rollback
// ---------------------------------------------------------------------------

const bridgeSource = fs.readFileSync(path.join(root, 'src', 'bridge.js'), 'utf8')
const hostSource = fs.readFileSync(hostPath, 'utf8')

check('host and provider protocol constants cannot drift', () => {
  const provider = Number(/export const PROTOCOL_VERSION = (\d+)/.exec(bridgeSource)?.[1])
  const host = Number(/const HOST_PROTOCOL = (\d+)/.exec(hostSource)?.[1])
  assert.equal(Number.isInteger(provider), true, 'PROTOCOL_VERSION not found')
  assert.equal(host, provider, `host ${host} != provider ${provider}`)
  assert.ok(SUPPORTED_PROTOCOL_VERSIONS.includes(host), 'host protocol is not in SUPPORTED_PROTOCOL_VERSIONS')
  return `both ${host}`
})

check('host version is injected, not hardcoded 0.0.1', () => {
  assert.ok(!/HOST_VERSION\s*=\s*'0\.0\.1'/.test(hostSource), 'HOST_VERSION is still hardcoded 0.0.1')
  assert.match(hostSource, /DSH_CHROME_HOST_VERSION/)
  assert.match(hostSource, /resolveHostVersion/)
  return 'env/package.json'
})

check('SEA entry injects the provider version into the embedded host', () => {
  const entry = makeSeaEntry({ hostVersion: '9.9.9' })
  assert.match(entry, /process\.env\.DSH_CHROME_HOST_VERSION = "9\.9\.9"/)
  assert.ok(packageVersion(root) === packageJson.version, 'packageVersion disagrees with package.json')
  return `package ${packageJson.version}`
})

const rollbackHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'dshpt-r-'))
try {
  await checkAsync('a failed discovery write rolls back listener and socket', async () => {
    const cache = path.join(rollbackHome, 'cache', 'dsh-chrome')
    fs.mkdirSync(cache, { recursive: true })
    // A directory where bridge.json must be written makes writeFileSync fail
    // *after* listen() has already bound the socket.
    fs.mkdirSync(path.join(cache, 'bridge.json'), { recursive: true })
    const failing = new BridgeServer({ home: rollbackHome })
    await assert.rejects(() => failing.start())
    assert.equal(failing.server, null, 'server handle survived the failed start')
    assert.equal(fs.existsSync(failing.socketPath), false, 'socket file survived the failed start')
    assert.ok(failing.lastError instanceof Error)
    fs.rmdirSync(path.join(cache, 'bridge.json'))
    await failing.start()
    await failing.stop()
    return 'rolled back, then started cleanly'
  })
} finally {
  await fsp.rm(rollbackHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {})
}

console.log(failures === 0 ? '\nPLATFORM PROTOCOL TEST: PASS' : `\nPLATFORM PROTOCOL TEST: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
