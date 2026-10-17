#!/usr/bin/env node
/**
 * Chrome native messaging host for DSH Desktop Chrome.
 *
 * Chrome launches this process from the native messaging host manifest. It
 * reads the DSH provider discovery file, authenticates the UNIX socket
 * connection, and relays JSON frames:
 *
 *   Chrome extension  <-- 4-byte length + JSON -->  this host  <-- JSON lines -->  DSH provider
 *
 * Screenshot frames are materialized to PNG files here so large image bytes
 * never travel over the provider socket.
 */
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'

const HOST_VERSION = '0.0.1'
const PROTOCOL = 1
const MAX_FRAME_BYTES = 32 * 1024 * 1024
const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const cacheDir = path.join(home, 'cache', 'dsh-chrome')
const logPath = path.join(cacheDir, 'host.log')

function log(line) {
  try {
    fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 })
    fs.appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`, { mode: 0o600 })
  } catch {
    // logging must never break the relay
  }
}

function fail(message) {
  log(`FATAL ${message}`)
  process.stderr.write(`dsh-chrome-host: ${message}\n`)
  process.exit(1)
}

function readDiscovery() {
  try {
    return JSON.parse(fs.readFileSync(path.join(cacheDir, 'bridge.json'), 'utf8'))
  } catch {
    return null
  }
}

// ---------------------------------------------------------------- native frames
let stdinBuffer = Buffer.alloc(0)

function writeNative(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  const header = Buffer.alloc(4)
  header.writeUInt32LE(body.length, 0)
  process.stdout.write(Buffer.concat([header, body]))
}

function handleNativeMessage(message) {
  if (!authed || !socket || socket.destroyed) {
    log('dropping native message before bridge auth')
    return
  }
  let outgoing = message
  if (message?.id != null) {
    const method = pending.get(String(message.id))
    if (method && message.method == null) {
      // Response to a provider request: materialize screenshots before relaying.
      pending.delete(String(message.id))
      if (message.error) {
        outgoing = { id: message.id, error: message.error }
      } else if (method === 'tab.screenshot') {
        try {
          outgoing = { id: message.id, result: materializeScreenshot(message.result) }
        } catch (error) {
          outgoing = {
            id: message.id,
            error: { code: 'INTERNAL', message: `screenshot materialization failed: ${error.message}` },
          }
        }
      }
    }
  }
  socket.write(`${JSON.stringify(outgoing)}\n`)
}

process.stdin.on('data', (chunk) => {
  stdinBuffer = Buffer.concat([stdinBuffer, chunk])
  for (;;) {
    if (stdinBuffer.length < 4) return
    const length = stdinBuffer.readUInt32LE(0)
    if (length > MAX_FRAME_BYTES) fail(`native frame too large: ${length}`)
    if (stdinBuffer.length < 4 + length) return
    const body = stdinBuffer.subarray(4, 4 + length)
    stdinBuffer = stdinBuffer.subarray(4 + length)
    let message
    try {
      message = JSON.parse(body.toString('utf8'))
    } catch (error) {
      log(`bad native frame: ${error.message}`)
      continue
    }
    handleNativeMessage(message)
  }
})
process.stdin.on('end', () => {
  log('stdin ended')
  shutdown(0)
})
process.stdin.on('error', (error) => fail(`stdin error: ${error.message}`))

// --------------------------------------------------------------------- bridge
const discovery = readDiscovery()
if (!discovery?.socketPath || !discovery?.token) {
  fail('bridge discovery file missing; is DSH Desktop running with the dsh-chrome plugin?')
}

let authed = false
let socketBuffer = ''
const pending = new Map()
const socket = net.connect(discovery.socketPath)
socket.setEncoding('utf8')

socket.on('connect', () => {
  log(`connected to bridge ${discovery.socketPath}`)
  socket.write(
    `${JSON.stringify({ type: 'hello', token: discovery.token, hostVersion: HOST_VERSION, protocol: PROTOCOL })}\n`,
  )
})

socket.on('data', (chunk) => {
  socketBuffer += chunk
  let index = socketBuffer.indexOf('\n')
  while (index >= 0) {
    const line = socketBuffer.slice(0, index)
    socketBuffer = socketBuffer.slice(index + 1)
    index = socketBuffer.indexOf('\n')
    if (!line.trim()) continue
    let message
    try {
      message = JSON.parse(line)
    } catch (error) {
      log(`bad bridge frame: ${error.message}`)
      continue
    }
    if (!authed) {
      if (message?.type === 'hello-ok') {
        authed = true
        log(`bridge authenticated (protocol ${message.protocol})`)
      } else {
        fail('unexpected bridge greeting')
      }
      continue
    }
    if (message?.id != null) {
      if (typeof message.method === 'string') {
        // Provider request: remember the method for screenshot materialization.
        pending.set(String(message.id), message.method)
      }
      writeNative(message)
      continue
    }
    if (message?.event) {
      writeNative({ event: message.event, params: message.params })
    }
  }
})

socket.on('close', () => {
  log('bridge socket closed')
  shutdown(1)
})
socket.on('error', (error) => fail(`bridge socket error: ${error.message}`))

function materializeScreenshot(result) {
  const dataBase64 = result?.dataBase64
  if (typeof dataBase64 !== 'string' || dataBase64.length === 0) {
    return result
  }
  const bytes = Buffer.from(dataBase64, 'base64')
  const width = bytes.length >= 24 ? bytes.readUInt32BE(16) : 0
  const height = bytes.length >= 24 ? bytes.readUInt32BE(20) : 0
  const screenshotDir = path.join(cacheDir, 'screenshots')
  fs.mkdirSync(screenshotDir, { recursive: true, mode: 0o700 })
  const file = path.join(
    screenshotDir,
    `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(4).toString('hex')}.png`,
  )
  fs.writeFileSync(file, bytes, { mode: 0o600 })
  log(`screenshot saved ${file} (${bytes.length} bytes, ${width}x${height})`)
  return { path: file, mediaType: 'image/png', width, height, bytes: bytes.length }
}

function shutdown(code) {
  try {
    socket.destroy()
  } catch {
    // already closed
  }
  process.exit(code)
}

process.on('SIGTERM', () => shutdown(0))
process.on('SIGINT', () => shutdown(0))
