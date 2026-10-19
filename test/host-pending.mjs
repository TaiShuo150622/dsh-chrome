/**
 * M5 — native host pending table: max in-flight requests + per-request timeout
 * (no Chrome required).
 *
 * The host relays requests between the extension (native stdio) and the
 * provider (UNIX socket / named pipe). A peer that stops answering must not be
 * able to grow the host's `pending` map without limit, and a single unanswered
 * request must expire instead of living until disconnect. Rejections use the
 * existing `{id, error: {code, message}}` frame, so the wire protocol is
 * unchanged. The timeout is shortened here through
 * DSH_HOST_PENDING_TIMEOUT_MS.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

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
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`timed out waiting for ${label}`)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Start one fake provider socket + one real host process. The provider answers
 * the host hello, then sends one provider-originated request (id 9001) whose
 * reply proves authentication; the caller gets the rest.
 */
async function withHost({ timeoutMs }, fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-host-pending-'))
  const cacheDir = path.join(home, 'cache', 'dsh-chrome')
  fs.mkdirSync(cacheDir, { recursive: true })
  const socketPath = path.join(cacheDir, 'bridge.sock')
  const token = 'host-pending-test-token'
  fs.writeFileSync(path.join(cacheDir, 'bridge.json'), JSON.stringify({ socketPath, token }))

  const forwarded = []
  const connections = []
  let authedSocket = null
  const server = net.createServer((connection) => {
    connections.push(connection)
    let buffer = ''
    connection.setEncoding('utf8')
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
          authedSocket = connection
          connection.write(`${JSON.stringify({ type: 'hello-ok', protocol: 1 })}\n`)
          // Prove the host is authenticated before the caller sends anything:
          // this request must arrive on the native channel.
          connection.write(`${JSON.stringify({ id: 9001, method: 'browser.status', params: {} })}\n`)
          continue
        }
        forwarded.push(message)
      }
    })
  })
  await new Promise((resolve) => server.listen(socketPath, resolve))

  const host = spawn(process.execPath, [path.join(root, 'host', 'host.mjs')], {
    env: { ...process.env, DSH_HOME: home, DSH_HOST_PENDING_TIMEOUT_MS: String(timeoutMs) },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const native = []
  host.stdout.on('data', frameReader((message) => native.push(message)))
  let stderr = ''
  host.stderr.on('data', (chunk) => {
    stderr += String(chunk)
  })
  const exit = new Promise((resolve) => host.once('exit', (code, signal) => resolve({ code, signal })))

  try {
    await waitFor(
      () => native.some((message) => message?.id === 9001),
      8000,
      'host to forward the provider-originated handshake request',
    )
    host.stdin.write(encodeNative({ id: 9001, result: { ok: true } }))
    // Give the host a moment to release the handshake entry before the caller
    // fills the cap; otherwise the cap check starts one slot down.
    await sleep(100)
    await fn({ host, native, forwarded, send: (message) => host.stdin.write(encodeNative(message)) })
  } finally {
    host.kill('SIGTERM')
    const result = await Promise.race([exit, sleep(3000).then(() => null)])
    server.close()
    for (const connection of connections) connection.destroy()
    try {
      fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    } catch {
      // temp dir
    }
    if (!result) throw new Error('host did not exit after SIGTERM')
    assert.equal(result.code, 0, `host must exit cleanly on SIGTERM (stderr: ${stderr.slice(-400)})`)
  }
}

// ---------------------------------------------------------------- pending cap
await withHost({ timeoutMs: 10_000 }, async ({ host, native, forwarded, send }) => {
  const ids = Array.from({ length: 70 }, (_, index) => `cap-${index + 1}`)
  for (const id of ids) send({ id, method: 'browser.status', params: {} })

  await waitFor(
    () =>
      forwarded.filter(
        (message) => String(message?.id || '').startsWith('cap-') && typeof message.method === 'string',
      ).length >= 64,
    8000,
    '64 requests to be forwarded to the provider',
  )
  await waitFor(
    () => native.filter((message) => message?.error?.code === 'RESOURCE_LIMIT').length >= 6,
    8000,
    '6 over-limit rejections',
  )
  const forwardedCap = forwarded.filter(
    (message) => String(message?.id || '').startsWith('cap-') && typeof message.method === 'string',
  )
  const rejected = native.filter((message) => message?.error?.code === 'RESOURCE_LIMIT')
  assert.equal(forwardedCap.length, 64, 'exactly MAX_PENDING requests reach the provider')
  assert.equal(rejected.length, 6, 'the remaining requests are refused, not forwarded')
  assert.ok(rejected.every((message) => String(message.id).startsWith('cap-')))
  assert.ok(rejected.every((message) => /max 64/.test(message.error.message)))

  // A reply frees one slot: the next request is forwarded again.
  host.stdin.write(encodeNative({ id: 'cap-1', result: { ok: true } }))
  await sleep(100)
  send({ id: 'cap-71', method: 'browser.status', params: {} })
  await waitFor(
    () => forwarded.some((message) => message?.id === 'cap-71' && typeof message.method === 'string'),
    5000,
    'the freed slot to accept the next request',
  )
  assert.equal(
    forwarded.filter((message) => String(message?.id || '').startsWith('cap-') && typeof message.method === 'string').length,
    65,
    'reply/clear must release capacity',
  )
})

// ------------------------------------------------------------ pending timeout
await withHost({ timeoutMs: 200 }, async ({ host, native, forwarded, send }) => {
  send({ id: 'slow-1', method: 'browser.status', params: {} })
  await waitFor(
    () => forwarded.some((message) => message?.id === 'slow-1'),
    5000,
    'the slow request to reach the provider',
  )
  await waitFor(
    () => native.some((message) => message?.id === 'slow-1' && message?.error?.code === 'TIMEOUT'),
    5000,
    'the host timeout error frame',
  )
  const timeout = native.find((message) => message?.id === 'slow-1' && message?.error?.code === 'TIMEOUT')
  assert.match(timeout.error.message, /timed out after 200ms/)
  // The timed-out entry is gone: another request still fits.
  send({ id: 'slow-2', method: 'browser.status', params: {} })
  await waitFor(
    () => forwarded.some((message) => message?.id === 'slow-2'),
    5000,
    'a request after a timeout',
  )
})

console.log('HOST PENDING TEST: PASS')
