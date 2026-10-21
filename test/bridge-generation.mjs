/**
 * P5: bridge connection generations.
 *
 * The native host can overlap during an extension auto-reload (the old host
 * socket is still open while the new one authenticates). This test drives real
 * UNIX sockets against BridgeServer and proves:
 *   - a new host hello replaces the old host: the old socket is closed and
 *     every in-flight provider call fails fast (BRIDGE_RESTARTING), not after
 *     the 45s tool timeout;
 *   - frames from the old generation cannot resolve a pending call, and a
 *     stale id arriving on the new connection is discarded;
 *   - the extension's `dsh.restarting` event fails calls immediately during
 *     the reload window instead of hanging;
 *   - the next hello clears the restart window and requests flow again.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

import { BridgeServer } from '../src/bridge.js'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-bridge-gen-'))
const bridge = new BridgeServer({ home })
await bridge.start()
const discovery = JSON.parse(fs.readFileSync(bridge.discoveryPath, 'utf8'))

function connectHost() {
  const client = { socket: net.connect(bridge.socketPath), buffer: '', messages: [], closed: false }
  const waiters = []
  const notify = () => {
    for (const waiter of [...waiters]) {
      let matched = false
      try {
        matched = waiter.predicate()
      } catch {
        matched = false
      }
      if (!matched) continue
      waiters.splice(waiters.indexOf(waiter), 1)
      waiter.resolve()
    }
  }
  client.socket.setEncoding('utf8')
  client.socket.on('error', () => {})
  client.socket.on('data', (chunk) => {
    client.buffer += chunk
    for (;;) {
      const index = client.buffer.indexOf('\n')
      if (index < 0) break
      const line = client.buffer.slice(0, index)
      client.buffer = client.buffer.slice(index + 1)
      if (!line.trim()) continue
      try {
        client.messages.push(JSON.parse(line))
      } catch {
        // BridgeServer only writes JSON lines; ignore a malformed fixture line.
      }
    }
    notify()
  })
  client.socket.on('close', () => {
    client.closed = true
    notify()
  })
  client.waitFor = (predicate, timeoutMs = 3000, label = 'frame') =>
    new Promise((resolve, reject) => {
      if (predicate()) return resolve()
      const timer = setTimeout(() => {
        const index = waiters.indexOf(waiter)
        if (index >= 0) waiters.splice(index, 1)
        reject(new Error(`timed out waiting for ${label}; got ${JSON.stringify(client.messages)}`))
      }, timeoutMs)
      const waiter = {
        predicate,
        resolve: () => {
          clearTimeout(timer)
          resolve()
        },
      }
      waiters.push(waiter)
    })
  client.send = (message) => client.socket.write(`${JSON.stringify(message)}\n`)
  client.hello = async () => {
    client.send({ type: 'hello', token: discovery.token, protocol: 1, hostVersion: 'bridge-generation-test' })
    await client.waitFor(() => client.messages.some((m) => m?.type === 'hello-ok'), 3000, 'hello-ok')
    return client
  }
  client.request = async (method, params = {}) => {
    const before = client.messages.length
    const call = bridge.call(method, params, 5000)
    await client.waitFor(
      () => client.messages.slice(before).some((m) => m?.id != null && m?.method === method),
      3000,
      `${method} request`,
    )
    const message = client.messages.slice(before).find((m) => m?.id != null && m?.method === method)
    return { call, message, reply: (result) => client.send({ id: message.id, result }) }
  }
  return client
}

let failures = 0
function check(name, condition, detail = '') {
  if (condition) console.log(`PASS ${name}${detail ? ` — ${detail}` : ''}`)
  else {
    failures += 1
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

try {
  const first = connectHost()
  await first.hello()
  check('first host authenticates', bridge.connected)
  const firstServerSocket = bridge.socket

  const inFlight = bridge.call('tab.goto', { url: 'https://example.com/' }, 5000)
  const rejection = inFlight.then(
    (value) => ({ value }),
    (error) => ({ error }),
  )
  await first.waitFor(() => first.messages.some((m) => m?.method === 'tab.goto'), 3000, 'first tab.goto')
  const staleId = first.messages.find((m) => m?.method === 'tab.goto')?.id

  const second = connectHost()
  await second.hello()
  const settled = await Promise.race([
    rejection,
    new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), 1000)),
  ])
  check(
    'new host hello fails the old in-flight call fast with BRIDGE_RESTARTING',
    settled?.error?.code === 'BRIDGE_RESTARTING',
    JSON.stringify(settled?.error || settled),
  )
  await first.waitFor(() => first.closed, 3000, 'old socket close')
  check('new host hello closes the old socket', first.closed && bridge.connected)
  check(
    'only one active host remains',
    Boolean(bridge.socket) && bridge.socket !== firstServerSocket && !bridge.socket.destroyed,
  )

  // A response for the old generation's id arriving on the new connection must
  // be discarded (there is no pending entry for it any more).
  const pendingBefore = bridge.pending.size
  second.send({ id: staleId, result: { stale: true } })
  await new Promise((resolve) => setTimeout(resolve, 100))
  check('a stale response id is discarded', bridge.pending.size === pendingBefore)

  const live = await second.request('browser.status')
  live.reply({ extensionVersion: 'generation-2', connected: true })
  check('requests flow on the new host', (await live.call)?.extensionVersion === 'generation-2')

  // Reload window: the extension announces the reload before the socket goes
  // away. Every call must fail immediately with BRIDGE_RESTARTING instead of
  // waiting for the provider's 45s mutation timeout.
  const duringReload = await second.request('tab.snapshot')
  second.send({ event: 'dsh.restarting', params: { version: 'test' } })
  const reloadSettled = await Promise.race([
    duringReload.call.then(
      (value) => ({ value }),
      (error) => ({ error }),
    ),
    new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), 1000)),
  ])
  check(
    'dsh.restarting fails the in-flight call with BRIDGE_RESTARTING',
    reloadSettled?.error?.code === 'BRIDGE_RESTARTING',
    JSON.stringify(reloadSettled?.error || reloadSettled),
  )
  const startedAt = Date.now()
  let fastFail
  try {
    fastFail = { value: await bridge.call('browser.status', {}, 5000) }
  } catch (error) {
    fastFail = { error }
  }
  check(
    'a tool call during the reload window fails fast with BRIDGE_RESTARTING',
    fastFail?.error?.code === 'BRIDGE_RESTARTING' && Date.now() - startedAt < 1000,
    `${fastFail?.error?.code || JSON.stringify(fastFail)} in ${Date.now() - startedAt}ms`,
  )

  const third = connectHost()
  await third.hello()
  check('the next hello clears the reload window', bridge.connected)
  const afterReload = await third.request('browser.status')
  afterReload.reply({ extensionVersion: 'generation-3', connected: true })
  check('requests flow after the reload window', (await afterReload.call)?.extensionVersion === 'generation-3')

  await new Promise((resolve) => setTimeout(resolve, 50))
} finally {
  await bridge.stop()
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}

console.log(failures === 0 ? '\nBRIDGE GENERATION TEST: PASS' : `\nBRIDGE GENERATION TEST: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
