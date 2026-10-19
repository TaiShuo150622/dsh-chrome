/**
 * Provider-side bridge: a UNIX socket server that the Chrome native host
 * connects to. The native host relays JSON frames from the extension.
 *
 * Wire format: one JSON object per line. The first line from the host is
 * {"type":"hello","token":...,"protocol":1}; the provider either answers
 * {"type":"hello-ok","protocol":1} or closes with a stable
 * `PROTOCOL_VERSION_MISMATCH` hello-error frame (never a silent downgrade).
 */
import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

export const PROTOCOL_VERSION = 1
/**
 * Protocol versions this provider can speak. Negotiation is exact-match: the
 * provider never falls back to an older protocol because a newer host might
 * send frames this provider would misinterpret. Bump both the constant and
 * this list only together with `HOST_PROTOCOL` in host/host.mjs.
 */
export const SUPPORTED_PROTOCOL_VERSIONS = Object.freeze([1])
/** Stable error code required by docs/CONTRACTS.md §1/§6. Never rename it. */
export const PROTOCOL_VERSION_MISMATCH = 'PROTOCOL_VERSION_MISMATCH'
const HELLO_TIMEOUT_MS = 5000
const DEFAULT_TIMEOUT_MS = 30000

function isSupportedProtocol(value) {
  return Number.isInteger(value) && SUPPORTED_PROTOCOL_VERSIONS.includes(value)
}

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

/**
 * Windows has no UNIX-domain sockets: Node's `listen()` only accepts a named
 * pipe (`\\.\pipe\<name>`). The host reads `bridge.json` and connects to
 * whatever path is recorded there, so the provider can choose per platform.
 * Include the PID so a stale pipe from a crashed provider cannot collide.
 */
export function bridgeSocketPath({ home, platform = process.platform, pid = process.pid } = {}) {
  if (platform === 'win32') {
    const hash = createHash('sha256').update(String(home).toLowerCase()).digest('hex').slice(0, 16)
    return `\\\\.\\pipe\\dsh-chrome-${hash}-${pid}`
  }
  return path.join(String(home), 'cache', 'dsh-chrome', 'bridge.sock')
}

export class BridgeServer {
  constructor({ home, platform = process.platform, pid = process.pid } = {}) {
    this.home = home
    this.platform = platform
    this.pid = pid
    // Use the target platform's separator rules even when a test fakes
    // `platform: 'win32'` on macOS/Linux (the real process still uses the
    // host `path`, but discovery/dir strings must look Windows-native).
    const pathImpl = platform === 'win32' ? path.win32 : path.posix
    this.dir = pathImpl.join(String(home), 'cache', 'dsh-chrome')
    this.socketPath = bridgeSocketPath({ home, platform, pid })
    this.lastError = null
    this.lastProtocolError = null
    this.discoveryPath = pathImpl.join(this.dir, 'bridge.json')
    this.token = randomBytes(32).toString('hex')
    this.server = null
    this.socket = null
    this.authed = false
    this.buffer = ''
    this.pending = new Map()
    this.handlers = new Map()
    this.nextId = 0
    this.hostVersion = null
    this.hostProtocol = null
    this.extensionVersion = null
    this.startedAt = Date.now()
    this.pingTimer = null
  }

  get connected() {
    return Boolean(this.socket && !this.socket.destroyed && this.authed)
  }

  /**
   * M6: bridge retention counters for `chrome_memory_stats`. Counts only; the
   * pending-call table and the extension->provider handler table are the two
   * maps whose size can grow with tool usage.
   */
  memoryStats() {
    return { connected: this.connected, pending: this.pending.size, handlers: this.handlers.size }
  }

  async start() {
    try {
      return await this.#start()
    } catch (error) {
      // Record the failure for chrome_status. Without this, a failed listen
      // looks identical to "extension never connected".
      this.lastError = error
      throw error
    }
  }

  async #start() {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    if (this.platform !== 'win32') {
      try {
        fs.unlinkSync(this.socketPath)
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
    }
    const server = net.createServer((socket) => this.#accept(socket))
    this.server = server
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(this.socketPath, () => {
          server.off('error', reject)
          resolve()
        })
      })
      if (this.platform !== 'win32') fs.chmodSync(this.socketPath, 0o600)
      // `mode` only applies when the file is created, so an existing stale
      // bridge.json (e.g. 0644 from an older build) must be chmod'ed
      // explicitly: it carries the connection token.
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
      if (this.platform !== 'win32') fs.chmodSync(this.discoveryPath, 0o600)
      this.lastError = null
    } catch (error) {
      // Roll back a half-started listener: a failed discovery write must not
      // leave a bound socket (or a stale socket file) behind.
      this.lastError = error
      await new Promise((resolve) => {
        try {
          server.close(() => resolve())
        } catch {
          resolve()
        }
      })
      if (this.server === server) this.server = null
      if (this.platform !== 'win32') {
        try {
          fs.unlinkSync(this.socketPath)
        } catch {
          // never created, or already gone
        }
      }
      throw error
    }
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
        if (!isSupportedProtocol(message.protocol)) {
          // Fail closed with a stable, machine-readable code: an old/new host
          // must not silently speak a protocol the provider does not
          // implement. `socket.end` flushes the frame before FIN so the host
          // can log the real reason instead of a generic close.
          const received = message.protocol === undefined ? null : message.protocol
          const error = new BridgeError(
            PROTOCOL_VERSION_MISMATCH,
            `unsupported bridge protocol ${JSON.stringify(received)}; provider speaks ${PROTOCOL_VERSION}`,
          )
          this.lastProtocolError = {
            code: error.code,
            message: error.message,
            received,
            expected: PROTOCOL_VERSION,
          }
          clearTimeout(helloTimer)
          try {
            socket.end(
              `${JSON.stringify({
                type: 'hello-error',
                code: PROTOCOL_VERSION_MISMATCH,
                message: error.message,
                expected: PROTOCOL_VERSION,
                received,
              })}\n`,
            )
          } catch {
            socket.destroy()
          }
          return
        }
        this.authed = true
        clearTimeout(helloTimer)
        this.lastProtocolError = null
        if (typeof message.hostVersion === 'string') this.hostVersion = message.hostVersion
        this.hostProtocol = message.protocol
        socket.write(
          `${JSON.stringify({
            type: 'hello-ok',
            protocol: PROTOCOL_VERSION,
            hostProtocol: message.protocol,
          })}\n`,
        )
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
        if (typeof message.method === 'string') {
          // Extension -> provider request. The native host forwards it here;
          // answer on the same id without touching the pending-call table.
          const handler = this.handlers.get(message.method)
          if (!handler) {
            socket.write(`${JSON.stringify({ id: message.id, error: { code: 'UNSUPPORTED', message: `no sidecar handler for ${message.method}` } })}\n`)
            continue
          }
          Promise.resolve()
            .then(() => handler(message.params || {}, { method: message.method }))
            .then((result) => {
              if (!socket.destroyed) socket.write(`${JSON.stringify({ id: message.id, result })}\n`)
            })
            .catch((error) => {
              if (!socket.destroyed) {
                socket.write(`${JSON.stringify({ id: message.id, error: { code: error?.code || 'INTERNAL', message: String(error?.message || error) } })}\n`)
              }
            })
          continue
        }
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

  /** Register a provider-side handler for an extension -> provider request. */
  registerHandler(method, handler) {
    if (typeof method !== 'string' || !method) throw new BridgeError('INVALID_ARGUMENT', 'method is required')
    if (typeof handler !== 'function') throw new BridgeError('INVALID_ARGUMENT', 'handler must be a function')
    this.handlers.set(method, handler)
    return () => {
      if (this.handlers.get(method) === handler) this.handlers.delete(method)
    }
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
    const files = this.platform === 'win32' ? [this.discoveryPath] : [this.discoveryPath, this.socketPath]
    for (const file of files) {
      try {
        fs.unlinkSync(file)
      } catch {
        // absent is fine
      }
    }
  }
}
