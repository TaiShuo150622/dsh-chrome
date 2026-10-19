/**
 * Provider-side bridge: a UNIX socket server that the Chrome native host
 * connects to. The native host relays JSON frames from the extension.
 *
 * Wire format: one JSON object per line. The first line from the host is
 * {"type":"hello","token":...}; the provider answers {"type":"hello-ok"}.
 */
import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import { randomBytes, timingSafeEqual } from 'node:crypto'

export const PROTOCOL_VERSION = 1
const HELLO_TIMEOUT_MS = 5000
const DEFAULT_TIMEOUT_MS = 30000

export class BridgeError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'BridgeError'
    this.code = code
  }
}

function sameToken(left, right) {
  const a = Buffer.from(String(left))
  const b = Buffer.from(String(right))
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

export class BridgeServer {
  constructor({ home }) {
    this.home = home
    this.dir = path.join(home, 'cache', 'dsh-chrome')
    this.socketPath = path.join(this.dir, 'bridge.sock')
    this.discoveryPath = path.join(this.dir, 'bridge.json')
    this.token = randomBytes(32).toString('hex')
    this.server = null
    this.socket = null
    this.authed = false
    this.buffer = ''
    this.pending = new Map()
    this.nextId = 0
    this.hostVersion = null
    this.extensionVersion = null
    this.startedAt = Date.now()
    this.pingTimer = null
  }

  get connected() {
    return Boolean(this.socket && !this.socket.destroyed && this.authed)
  }

  async start() {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    try {
      fs.unlinkSync(this.socketPath)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    const server = net.createServer((socket) => this.#accept(socket))
    this.server = server
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(this.socketPath, () => {
        server.off('error', reject)
        resolve()
      })
    })
    fs.chmodSync(this.socketPath, 0o600)
    fs.writeFileSync(
      this.discoveryPath,
      JSON.stringify(
        {
          protocol: PROTOCOL_VERSION,
          socketPath: this.socketPath,
          token: this.token,
          pid: process.pid,
          startedAt: this.startedAt,
        },
        null,
        2,
      ),
      { mode: 0o600 },
    )
  }

  #accept(socket) {
    if (this.socket && this.socket !== socket) {
      try {
        this.socket.destroy()
      } catch {
        // the old host is already gone
      }
    }
    this.socket = socket
    this.authed = false
    this.buffer = ''
    socket.setEncoding('utf8')
    const helloTimer = setTimeout(() => socket.destroy(), HELLO_TIMEOUT_MS)
    socket.on('data', (chunk) => this.#onData(chunk, socket, helloTimer))
    socket.on('close', () => {
      clearTimeout(helloTimer)
      if (this.socket === socket) {
        this.socket = null
        this.authed = false
        if (this.pingTimer) {
          clearInterval(this.pingTimer)
          this.pingTimer = null
        }
        this.#failPending('NOT_CONNECTED', 'Chrome native host disconnected')
      }
    })
    socket.on('error', () => {})
  }

  #onData(chunk, socket, helloTimer) {
    this.buffer += chunk
    let index = this.buffer.indexOf('\n')
    while (index >= 0) {
      const line = this.buffer.slice(0, index)
      this.buffer = this.buffer.slice(index + 1)
      index = this.buffer.indexOf('\n')
      if (!line.trim()) continue
      let message
      try {
        message = JSON.parse(line)
      } catch {
        socket.destroy()
        return
      }
      if (!this.authed) {
        if (
          message?.type !== 'hello' ||
          typeof message.token !== 'string' ||
          !sameToken(message.token, this.token)
        ) {
          socket.destroy()
          return
        }
        this.authed = true
        clearTimeout(helloTimer)
        if (typeof message.hostVersion === 'string') this.hostVersion = message.hostVersion
        socket.write(`${JSON.stringify({ type: 'hello-ok', protocol: PROTOCOL_VERSION })}\n`)
        // Heartbeat: lets the extension notice a silently dead native port
        // (Chrome does not always deliver onDisconnect immediately).
        this.pingTimer = setInterval(() => {
          if (!this.socket || this.socket.destroyed) return
          try {
            this.socket.write(`${JSON.stringify({ event: 'dsh.ping', params: { at: Date.now() } })}\n`)
          } catch {
            // the close handler tears down the timer
          }
        }, 20000)
        continue
      }
      if (message?.id != null) {
        const key = String(message.id)
        const request = this.pending.get(key)
        if (!request) continue
        this.pending.delete(key)
        clearTimeout(request.timer)
        if (message.error) {
          request.reject(
            new BridgeError(
              typeof message.error.code === 'string' ? message.error.code : 'INTERNAL',
              typeof message.error.message === 'string' ? message.error.message : 'bridge call failed',
            ),
          )
        } else {
          request.resolve(message.result)
        }
      }
      // Event frames are reserved for P1; P0 ignores them.
    }
  }

  #failPending(code, message) {
    for (const [, request] of this.pending) {
      clearTimeout(request.timer)
      request.reject(new BridgeError(code, message))
    }
    this.pending.clear()
  }

  call(method, params = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
    if (!this.connected) {
      throw new BridgeError(
        'NOT_CONNECTED',
        'Chrome extension is not connected. Load the unpacked extension in chrome://extensions, restart Chrome, and retry.',
      )
    }
    const id = ++this.nextId
    const socket = this.socket
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(String(id))
        reject(new BridgeError('TIMEOUT', `bridge call ${method} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      this.pending.set(String(id), { resolve, reject, timer })
      try {
        socket.write(`${JSON.stringify({ id, method, params })}\n`)
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(String(id))
        reject(new BridgeError('NOT_CONNECTED', error?.message || 'bridge write failed'))
      }
    })
  }

  /** Send an unsolicited provider -> extension event frame (host relays it). */
  emit(event, params = {}) {
    if (!this.connected || !this.socket) return false
    try {
      this.socket.write(`${JSON.stringify({ event, params })}\n`)
      return true
    } catch {
      return false
    }
  }

  async stop() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer)
      this.pingTimer = null
    }
    this.#failPending('NOT_CONNECTED', 'bridge stopped')
    if (this.socket) {
      try {
        this.socket.destroy()
      } catch {
        // already closed
      }
      this.socket = null
    }
    if (this.server) {
      const server = this.server
      this.server = null
      await new Promise((resolve) => server.close(() => resolve()))
    }
    for (const file of [this.discoveryPath, this.socketPath]) {
      try {
        fs.unlinkSync(file)
      } catch {
        // absent is fine
      }
    }
  }
}
