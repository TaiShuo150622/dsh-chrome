import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

import { BridgeServer } from '../src/bridge.js'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-bridge-ingress-'))
const bridge = new BridgeServer({ home })
const lines = []
let socket = null
const waitFor = (predicate, timeoutMs = 3000) =>
  new Promise((resolve, reject) => {
    const started = Date.now()
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer)
        resolve()
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer)
        reject(new Error('timeout'))
      }
    }, 10)
  })

try {
  await bridge.start()
  const discovery = JSON.parse(fs.readFileSync(path.join(home, 'cache', 'dsh-chrome', 'bridge.json'), 'utf8'))
  socket = net.connect(discovery.socketPath)
  socket.setEncoding('utf8')
  let buffer = ''
  socket.on('data', (chunk) => {
    buffer += chunk
    let index = buffer.indexOf('\n')
    while (index >= 0) {
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      index = buffer.indexOf('\n')
      if (line.trim()) lines.push(JSON.parse(line))
    }
  })
  await new Promise((resolve) => socket.once('connect', resolve))
  socket.write(`${JSON.stringify({ type: 'hello', token: discovery.token, protocol: 1 })}\n`)
  await waitFor(() => lines.some((line) => line.type === 'hello-ok'))

  const dispose = bridge.registerHandler('sidecar.ping', async (params) => ({ ok: true, echo: params?.value ?? null }))
  socket.write(`${JSON.stringify({ id: 'req-1', method: 'sidecar.ping', params: { value: 7 } })}\n`)
  await waitFor(() => lines.some((line) => line.id === 'req-1'))
  const response = lines.find((line) => line.id === 'req-1')
  assert.deepEqual(response.result, { ok: true, echo: 7 })

  socket.write(`${JSON.stringify({ id: 'req-2', method: 'sidecar.unknown', params: {} })}\n`)
  await waitFor(() => lines.some((line) => line.id === 'req-2'))
  const unknown = lines.find((line) => line.id === 'req-2')
  assert.equal(unknown.error?.code, 'UNSUPPORTED')

  dispose()
  socket.write(`${JSON.stringify({ id: 'req-3', method: 'sidecar.ping', params: {} })}\n`)
  await waitFor(() => lines.some((line) => line.id === 'req-3'))
  assert.equal(lines.find((line) => line.id === 'req-3').error?.code, 'UNSUPPORTED')
  console.log('BRIDGE INGRESS TEST: PASS')
} finally {
  try { socket?.destroy() } catch {}
  await bridge.stop()
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}
