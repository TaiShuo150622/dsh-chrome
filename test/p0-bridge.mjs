/**
 * P0 bridge protocol test — no Chrome required.
 *
 * Starts the real BridgeServer, spawns the real native host, and plays the
 * extension side over native messaging frames. Verifies:
 *   1. host connects and authenticates against the discovery file
 *   2. JSON round-trips through host and provider
 *   3. screenshot base64 is materialized to a PNG file by the host
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { BridgeServer } from '../src/bridge.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-chrome-p0-'))
const bridge = new BridgeServer({ home })

let failures = 0
function check(name, condition, detail = '') {
  if (condition) {
    console.log(`PASS ${name}${detail ? ` — ${detail}` : ''}`)
  } else {
    failures += 1
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function tinyPng() {
  // 1x1 red PNG
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  )
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

await bridge.start()
const host = spawn(process.execPath, [path.join(root, 'host', 'host.mjs')], {
  env: { ...process.env, DSH_HOME: home },
  stdio: ['pipe', 'pipe', 'inherit'],
})

const replies = []
host.stdout.on(
  'data',
  frameReader((message) => {
    replies.push(message)
    if (message.id == null) return
    const png = tinyPng()
    const table = {
      'browser.status': { extensionVersion: 'p0-fake', connected: true },
      'tab.goto': { tabId: 7, url: 'https://example.com/', title: 'Example Domain', loadState: 'complete' },
      'tab.snapshot': {
        title: 'Example Domain',
        url: 'https://example.com/',
        controls: [{ ref: 1, tag: 'a', kind: 'link', label: 'More information...' }],
        text: 'Example Domain body text',
        truncated: false,
      },
      'tab.screenshot': { dataBase64: png.toString('base64') },
    }
    const result = table[message.method]
    host.stdin.write(
      encodeNative(
        result
          ? { id: message.id, result }
          : { id: message.id, error: { code: 'UNSUPPORTED', message: 'p0 fake' } },
      ),
    )
  }),
)

await waitFor(() => bridge.connected, 5000, 'host authentication')
check('host authenticates through the discovery file', bridge.connected)

const status = await bridge.call('browser.status', {}, 5000)
check('browser.status round-trip', status?.extensionVersion === 'p0-fake', JSON.stringify(status))

const goto = await bridge.call('tab.goto', { url: 'https://example.com/' }, 5000)
check('tab.goto round-trip', goto?.tabId === 7 && goto?.title === 'Example Domain')

const snapshot = await bridge.call('tab.snapshot', { maxChars: 1000 }, 5000)
check('tab.snapshot round-trip', snapshot?.controls?.[0]?.ref === 1)

const shot = await bridge.call('tab.screenshot', {}, 5000)
check('screenshot materialized to a file', typeof shot?.path === 'string' && fs.existsSync(shot.path))
check('screenshot dimensions parsed', shot?.width === 1 && shot?.height === 1, `${shot?.width}x${shot?.height}`)
if (shot?.path) {
  const bytes = await fsp.readFile(shot.path)
  check('materialized PNG magic', bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
}

host.kill('SIGTERM')
await bridge.stop()
await fsp.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {})

console.log(failures === 0 ? '\nP0 BRIDGE TEST: PASS' : `\nP0 BRIDGE TEST: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

async function waitFor(predicate, timeoutMs, label) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`timed out waiting for ${label}`)
}
