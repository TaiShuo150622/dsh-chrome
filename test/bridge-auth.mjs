/**
 * Bridge authentication test — no Chrome required.
 *
 * Verifies the host/provider handshake fails closed: a wrong token, or a
 * request before `hello`, destroys the connection; only the discovery token
 * gets `hello-ok`.
 */
import net from 'node:net'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { BridgeServer } from '../src/bridge.js'

const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'dshrc-auth-'))
const bridge = new BridgeServer({ home })

let failures = 0
function check(name, condition, detail = '') {
  if (condition) console.log(`PASS ${name}${detail ? ` — ${detail}` : ''}`)
  else {
    failures += 1
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function handshake(payload, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const socket = net.connect(bridge.socketPath)
    const messages = []
    let closed = false
    let buffer = ''
    const timer = setTimeout(() => {
      socket.destroy()
      resolve({ messages, closed })
    }, timeoutMs)
    socket.setEncoding('utf8')
    socket.on('connect', () => socket.write(`${JSON.stringify(payload)}\n`))
    socket.on('data', (chunk) => {
      buffer += chunk
      let index = buffer.indexOf('\n')
      while (index >= 0) {
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        index = buffer.indexOf('\n')
        try {
          messages.push(JSON.parse(line))
        } catch {
          // ignore malformed provider frames
        }
      }
    })
    socket.on('close', () => {
      closed = true
      clearTimeout(timer)
      resolve({ messages, closed })
    })
    socket.on('error', () => {})
  })
}

await bridge.start()

const bad = await handshake({ type: 'hello', token: 'wrong-token', protocol: 1 })
check('wrong token is rejected', bad.closed && !bad.messages.some((message) => message.type === 'hello-ok'))

const early = await handshake({ id: 1, method: 'browser.status', params: {} })
check('request before hello is rejected', early.closed && !early.messages.some((message) => message.type === 'hello-ok'))

const good = await handshake({ type: 'hello', token: bridge.token, hostVersion: 'test', protocol: 1 })
check('valid token gets hello-ok', good.messages.some((message) => message.type === 'hello-ok'))

await bridge.stop()
await fsp.rm(home, { recursive: true, force: true })

console.log(failures === 0 ? '\nBRIDGE AUTH TEST: PASS' : `\nBRIDGE AUTH TEST: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
