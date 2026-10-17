/**
 * Native host persistence test — no Chrome required.
 *
 * Verifies the P2-1 guarantee that the native host survives a provider
 * restart: the host must re-read the discovery file and reconnect to a *new*
 * BridgeServer instead of exiting.
 */
import { spawn } from 'node:child_process'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { BridgeServer } from '../src/bridge.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'dshrc-'))

let failures = 0
function check(name, condition, detail = '') {
  if (condition) console.log(`PASS ${name}${detail ? ` — ${detail}` : ''}`)
  else {
    failures += 1
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
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
      onMessage(JSON.parse(body.toString('utf8')))
    }
  }
}

async function waitFor(predicate, timeoutMs, label) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`timed out waiting for ${label}`)
}

let bridge = new BridgeServer({ home })
await bridge.start()

const host = spawn(process.execPath, [path.join(root, 'host', 'host.mjs')], {
  env: { ...process.env, DSH_HOME: home },
  stdio: ['pipe', 'pipe', 'inherit'],
})

host.stdout.on(
  'data',
  frameReader((message) => {
    if (message.id == null) return
    const result =
      message.method === 'browser.status'
        ? { extensionVersion: 'reconnect-fake', connected: true }
        : null
    host.stdin.write(
      encodeNative(
        result
          ? { id: message.id, result }
          : { id: message.id, error: { code: 'UNSUPPORTED', message: 'reconnect fake' } },
      ),
    )
  }),
)

await waitFor(() => bridge.connected, 5000, 'initial host authentication')
check('host connects to the first provider instance', bridge.connected)
const firstPid = bridge.discovery?.pid ?? null

// Simulate a provider restart: the first server goes away completely (socket
// and discovery file removed).
await bridge.stop()
check('first provider stopped', !bridge.connected)

bridge = new BridgeServer({ home })
await bridge.start()
await waitFor(() => bridge.connected, 15000, 'host reconnect to the new provider')
check('host reconnects to a new provider without a restart', bridge.connected)

const status = await bridge.call('browser.status', {}, 5000)
check('requests flow after reconnecting', status?.extensionVersion === 'reconnect-fake', JSON.stringify(status))

host.kill('SIGTERM')
await bridge.stop()
await fsp.rm(home, { recursive: true, force: true })
void firstPid

console.log(failures === 0 ? '\nHOST RECONNECT TEST: PASS' : `\nHOST RECONNECT TEST: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
