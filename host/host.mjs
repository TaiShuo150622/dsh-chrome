#!/usr/bin/env node
/**
 * Chrome native messaging host for DSH Desktop Chrome.
 *
 * Chrome launches this process from the native messaging host manifest. It
 * relays JSON frames between the extension (stdio, 4-byte length prefix) and
 * the DSH provider (UNIX socket, JSON lines).
 *
 * The host stays alive when the provider goes away (DSH restart / plugin
 * reload): it keeps reading the discovery file and reconnects, so the extension
 * never has to re-establish its native port. Screenshot frames are materialized
 * to PNG files here so image bytes never travel over the provider socket.
 */
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'

/**
 * Host protocol version. Must stay equal to `PROTOCOL_VERSION` in
 * src/bridge.js; tests/platform/protocol.mjs parses both constants and fails
 * when they drift. There is no silent downgrade: an unsupported value is
 * logged and the host stops reconnecting to that provider generation.
 */
const HOST_PROTOCOL = 1
const MAX_FRAME_BYTES = 32 * 1024 * 1024
const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const cacheDir = path.join(home, 'cache', 'dsh-chrome')
const logPath = path.join(cacheDir, 'host.log')
const discoveryPath = path.join(cacheDir, 'bridge.json')
const updateStatePath = path.join(cacheDir, 'update-state.json')
const screencastDir = path.join(cacheDir, 'screencast')
const updateLogPath = path.join(cacheDir, 'update.log')

function positiveIntEnv(name, fallback) {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}

/**
 * `HOST_VERSION` is injected by the build (docs/CONTRACTS.md §6): the SEA
 * bootstrap sets `DSH_CHROME_HOST_VERSION` from package.json, and a source
 * checkout reads package.json directly. 0.0.1 used to be hardcoded here and
 * made chrome_status report a version that did not exist.
 */
function resolveHostVersion() {
  const injected = String(process.env.DSH_CHROME_HOST_VERSION || '').trim()
  if (injected) return injected
  try {
    const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    if (typeof pkg?.version === 'string' && pkg.version.trim()) return pkg.version.trim()
  } catch {
    // SEA / data: URL or a stripped checkout: no package.json to read.
  }
  return '0.0.0-unknown'
}

const HOST_VERSION = resolveHostVersion()
const MAX_PROTOCOL_MISMATCH_ATTEMPTS = positiveIntEnv('DSH_HOST_MAX_PROTOCOL_MISMATCHES', 3)
const RETRY_BASE_MS = positiveIntEnv('DSH_HOST_RETRY_BASE_MS', 500)
const RETRY_MAX_MS = positiveIntEnv('DSH_HOST_RETRY_MAX_MS', 5000)
const MISMATCH_POLL_MS = positiveIntEnv('DSH_HOST_MISMATCH_POLL_MS', RETRY_MAX_MS)

let socket = null
let authed = false
let socketBuffer = ''
let stdinEnded = false
let retryTimer = null
let retryDelay = RETRY_BASE_MS
// Protocol-mismatch retry policy: ordinary provider-not-running reconnects
// keep backing off forever (the host must outlive DSH restarts), but a
// *version* disagreement is different — retrying cannot fix it, so after
// MAX_PROTOCOL_MISMATCH_ATTEMPTS the host pauses until bridge.json changes
// (a new provider generation / DSH upgrade) instead of reconnecting forever.
let protocolMismatchCount = 0
let blockedDiscoveryToken = null
let mismatchPollTimer = null
// M5: the host is a relay, not a request store. Bound the in-flight request
// table so a peer that stops answering cannot grow the host without limit, and
// expire a single entry so an unanswered request does not stay forever. The
// provider has its own 30s call timeout; this one is deliberately longer so a
// normal slow call is not rejected twice. Tests can shorten it.
const MAX_PENDING = 64
const configuredPendingTimeoutMs = Number(process.env.DSH_HOST_PENDING_TIMEOUT_MS)
const PENDING_TIMEOUT_MS =
  Number.isFinite(configuredPendingTimeoutMs) && configuredPendingTimeoutMs > 0
    ? configuredPendingTimeoutMs
    : 60_000
const pending = new Map()

function log(line) {
  try {
    fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 })
    fs.appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`, { mode: 0o600 })
  } catch {
    // logging must never break the relay
  }
}

process.on('uncaughtException', (error) => {
  log(`uncaught exception: ${error?.stack || error?.message || error}`)
})
process.stdout.on('error', (error) => {
  // Chrome closed the native port; exit quietly instead of crashing the host.
  log(`stdout error: ${error.message}`)
  process.exit(0)
})

function fail(message) {
  log(`FATAL ${message}`)
  process.stderr.write(`dsh-chrome-host: ${message}\n`)
  process.exit(1)
}

function readDiscovery() {
  try {
    return JSON.parse(fs.readFileSync(discoveryPath, 'utf8'))
  } catch {
    return null
  }
}

// ------------------------------------------------------- extension auto-reload
// Developer convenience: when the provider wrote dev.json, watch the unpacked
// extension directory and tell the extension to reload itself. This is how a
// code change in extension/ reaches Chrome without a manual ⟳.
let watcher = null
let watchTimer = null
let lastReloadNoticeAt = 0

function sendNativeEvent(event, params) {
  if (!authed || !socket || socket.destroyed) return
  writeNative({ event, params })
}

function readExtensionManifest() {
  try {
    const dev = JSON.parse(fs.readFileSync(path.join(cacheDir, 'dev.json'), 'utf8'))
    if (!dev?.extensionDir) return null
    const manifestPath = path.join(dev.extensionDir, 'manifest.json')
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    return {
      version: String(manifest.version || ''),
      watching: Boolean(dev.watch),
      mtimeMs: fs.statSync(manifestPath).mtimeMs,
    }
  } catch {
    return null
  }
}

function readUpdateState() {
  try {
    return JSON.parse(fs.readFileSync(updateStatePath, 'utf8'))
  } catch {
    return {}
  }
}

function writeUpdateState(patch) {
  try {
    const state = { ...readUpdateState(), ...patch, lastCheckedAt: new Date().toISOString() }
    fs.writeFileSync(updateStatePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
    return state
  } catch (error) {
    log(`update-state write failed: ${error.message}`)
    return null
  }
}

function appendUpdateLog(line) {
  try {
    fs.appendFileSync(updateLogPath, `${new Date().toISOString()} ${line}\n`, { mode: 0o600 })
  } catch {
    // diagnostics only
  }
}

function sendExtensionState() {
  const state = readExtensionManifest()
  if (!state) return
  sendNativeEvent('ext.state', state)
  writeUpdateState({ diskVersion: state.version, watching: state.watching, manifestMtimeMs: state.mtimeMs })
  lastStateWriteAt = Date.now()
  log(`extension state sent: version ${state.version}, watching ${state.watching}`)
}

// Polling fallback: fs.watch can miss events (atomic saves / network mounts).
// Every 60s compare the manifest version+mtime and push a reload if they moved.
//
// A poll that finds nothing changed has nothing to say: rewriting
// update-state.json just to bump lastCheckedAt kept a disk write alive every
// minute for the whole life of the browser (measured: 1.85 writes/min while
// idle). Changes are still persisted immediately; the "watcher is alive"
// heartbeat runs at 10 min so the file cannot silently freeze if the poll dies.
let manifestPollTimer = null
let lastManifestSignature = null
const STATE_HEARTBEAT_MS = Number(process.env.DSH_UPDATE_STATE_HEARTBEAT_MS || 600000)
let lastStateWriteAt = 0

function startManifestPolling() {
  const intervalMs = Number(process.env.DSH_UPDATE_POLL_MS || 60000)
  if (manifestPollTimer || intervalMs <= 0) return
  manifestPollTimer = setInterval(() => {
    const state = readExtensionManifest()
    if (!state) return
    const signature = `${state.version}:${state.mtimeMs}`
    if (lastManifestSignature && signature !== lastManifestSignature) {
      appendUpdateLog(`manifest changed version=${state.version} mtime=${state.mtimeMs}`)
      lastReloadNoticeAt = 0
      lastReloadNoticeAt = Date.now()
      writeUpdateState({
        diskVersion: state.version,
        watching: state.watching,
        manifestMtimeMs: state.mtimeMs,
        lastChangeAt: new Date().toISOString(),
        lastReloadRequestedAt: new Date().toISOString(),
      })
      lastStateWriteAt = Date.now()
      log(`manifest changed on disk: ${state.version}; requesting extension reload`)
      sendNativeEvent('ext.changed', { file: 'manifest.json' })
    } else {
      lastManifestSignature = signature
      if (Date.now() - lastStateWriteAt < STATE_HEARTBEAT_MS) return
      writeUpdateState({ diskVersion: state.version, watching: state.watching, manifestMtimeMs: state.mtimeMs })
      lastStateWriteAt = Date.now()
    }
  }, intervalMs)
  manifestPollTimer.unref?.()
}

function startExtensionWatcher() {
  try {
    const dev = JSON.parse(fs.readFileSync(path.join(cacheDir, 'dev.json'), 'utf8'))
    if (!dev?.watch || typeof dev.extensionDir !== 'string') return
    if (!fs.existsSync(dev.extensionDir)) return
    watcher = fs.watch(dev.extensionDir, { recursive: true }, (_event, filename) => {
      const name = String(filename || '')
      if (!/\.(js|json|html|css|png|svg)$/.test(name)) return
      if (watchTimer) clearTimeout(watchTimer)
      watchTimer = setTimeout(() => {
        watchTimer = null
        // Cooldown: one reload per 3s. A batch of file writes (or a delete)
        // would otherwise trigger several reloads and kill the fresh host
        // before Chrome finishes loading the extension.
        if (Date.now() - lastReloadNoticeAt < 3000) return
        try {
          // Only reload when the manifest on disk is valid JSON (mid-write or
          // partially deleted files must not be pushed to Chrome).
          JSON.parse(fs.readFileSync(path.join(dev.extensionDir, 'manifest.json'), 'utf8'))
        } catch (error) {
          log(`extension change ignored (manifest not readable yet): ${error.message}`)
          return
        }
        lastReloadNoticeAt = Date.now()
        writeUpdateState({
          lastChangeAt: new Date().toISOString(),
          lastReloadRequestedAt: new Date().toISOString(),
          lastFile: name,
        })
        appendUpdateLog(`file changed: ${name}`)
        log(`extension change detected: ${name}`)
        sendNativeEvent('ext.changed', { file: name })
      }, 800)
    })
    watcher.on('error', (error) => log(`extension watcher error: ${error.message}`))
    log(`watching extension dir ${dev.extensionDir}`)
  } catch (error) {
    log(`extension watcher off: ${error.message}`)
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

// Viewer frame materialization is throttled like the headless driver
// (docs/HEADLESS.md §4.1.6): the live viewer polls every 300ms, so decode and
// atomic-write at most once per interval, with one trailing timer so the last
// frame of a burst still lands.
const SCREENCAST_WRITE_INTERVAL_MS = 100
let screencastPending = null
let screencastFlushTimer = null
let screencastLastWriteAt = 0
let screencastDirReady = false

function flushScreencastFrame() {
  const message = screencastPending
  screencastPending = null
  if (!message) return
  screencastLastWriteAt = Date.now()
  try {
    if (!screencastDirReady) {
      fs.mkdirSync(screencastDir, { recursive: true })
      screencastDirReady = true
    }
    const data = String(message?.data || '')
    const format = message.format === 'png' ? 'png' : 'jpg'
    const file = path.join(screencastDir, `latest.${format}`)
    const buffer = Buffer.from(data, 'base64')
    const tmp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, buffer, { mode: 0o600 })
    fs.renameSync(tmp, file)
    fs.writeFileSync(
      path.join(screencastDir, 'meta.json'),
      `${JSON.stringify({
        updatedAt: Date.now(),
        format,
        bytes: buffer.length,
        frames: message.frames ?? null,
        metadata: message.metadata ?? null,
        owner: message.owner ?? null,
      })}\n`,
      { mode: 0o600 },
    )
  } catch {
    // screencast frames are best effort
  }
}

function materializeScreencastFrame(message) {
  if (!String(message?.data || '')) return
  screencastPending = message
  const waited = Date.now() - screencastLastWriteAt
  if (waited >= SCREENCAST_WRITE_INTERVAL_MS) {
    flushScreencastFrame()
    return
  }
  if (screencastFlushTimer) return
  screencastFlushTimer = setTimeout(() => {
    screencastFlushTimer = null
    flushScreencastFrame()
  }, SCREENCAST_WRITE_INTERVAL_MS - waited)
  screencastFlushTimer.unref?.()
}

function handleNativeMessage(message) {
  if (message?.type === 'screencast-frame') {
    materializeScreencastFrame(message)
    return
  }
  if (!authed || !socket || socket.destroyed) {
    log('dropping native message: bridge not connected')
    return
  }
  let outgoing = message
  if (message?.id != null) {
    if (message.method == null) {
      // Reply from the extension to a provider-originated request: release
      // its capacity/slot and materialize a screenshot result as before.
      const entry = clearPending(message.id)
      if (entry) {
        if (message.error) {
          outgoing = { id: message.id, error: message.error }
        } else if (entry.method === 'tab.screenshot') {
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
    } else {
      // Request from the extension to the provider. Bound the in-flight table
      // before forwarding; over the cap the caller gets a normal error frame.
      const method = String(message.method)
      if (!trackPending(message.id, method, 'extension')) {
        rejectOverLimit(message.id, method, 'extension')
        return
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
  stdinEnded = true
  log('stdin ended')
  shutdown(0, 'stdin ended')
})
process.stdin.on('error', (error) => fail(`stdin error: ${error.message}`))

// --------------------------------------------------------------------- bridge
// M5 pending table: one entry per request crossing the host, bounded in count
// and lifetime. `origin` decides which side receives a rejection/timeout in the
// same wire shape that side already understands (id + error), so the protocol
// is unchanged.
function clearPending(id) {
  const key = String(id)
  const entry = pending.get(key)
  if (!entry) return null
  pending.delete(key)
  if (entry.timer) clearTimeout(entry.timer)
  return entry
}

function forgetPending() {
  for (const entry of pending.values()) {
    if (entry.timer) clearTimeout(entry.timer)
  }
  pending.clear()
}

function sendPendingError(origin, id, code, message) {
  if (origin === 'extension') {
    // The request came from the extension, so answer on the native channel.
    writeNative({ id, error: { code, message } })
    return
  }
  // The request came from the provider, so answer with one bridge JSON line.
  if (authed && socket && !socket.destroyed) {
    socket.write(`${JSON.stringify({ id, error: { code, message } })}\n`)
  }
}

function trackPending(id, method, origin) {
  if (pending.size >= MAX_PENDING) return false
  const key = String(id)
  const entry = { method, origin, timer: null }
  entry.timer = setTimeout(() => {
    if (pending.get(key) !== entry) return
    pending.delete(key)
    const message = `native host request ${method} timed out after ${PENDING_TIMEOUT_MS}ms`
    log(`pending ${origin} request ${method} (${key}) timed out`)
    sendPendingError(origin, id, 'TIMEOUT', message)
  }, PENDING_TIMEOUT_MS)
  entry.timer.unref?.()
  pending.set(key, entry)
  return true
}

function rejectOverLimit(id, method, origin) {
  const message = `native host has too many pending requests (max ${MAX_PENDING})`
  log(`rejecting ${origin} request ${method} (${id}): pending table full`)
  sendPendingError(origin, id, 'RESOURCE_LIMIT', message)
}

function clearMismatchPoll() {
  if (mismatchPollTimer) {
    clearTimeout(mismatchPollTimer)
    mismatchPollTimer = null
  }
}

/** Watch bridge.json only; a token change means a new provider generation. */
function scheduleMismatchPoll() {
  if (stdinEnded || blockedDiscoveryToken === null || mismatchPollTimer) return
  mismatchPollTimer = setTimeout(() => {
    mismatchPollTimer = null
    const discovery = readDiscovery()
    if (!discovery?.token || String(discovery.token) === blockedDiscoveryToken) {
      scheduleMismatchPoll()
      return
    }
    log('bridge.json changed after protocol mismatch; allowing a fresh negotiation')
    blockedDiscoveryToken = null
    protocolMismatchCount = 0
    retryDelay = RETRY_BASE_MS
    connectBridge()
  }, MISMATCH_POLL_MS)
  mismatchPollTimer.unref?.()
}

function scheduleReconnect(reason) {
  if (stdinEnded) return
  if (blockedDiscoveryToken !== null) {
    scheduleMismatchPoll()
    return
  }
  if (retryTimer) return
  const delay = retryDelay
  retryTimer = setTimeout(() => {
    retryTimer = null
    connectBridge()
  }, delay)
  retryDelay = Math.min(retryDelay * 2, RETRY_MAX_MS)
  log(`will reconnect in ${delay}ms (${reason})`)
}

function supportedProtocol(value) {
  return Number.isInteger(value) && value === HOST_PROTOCOL
}

function handleProtocolMismatch({ source, received, code = 'PROTOCOL_VERSION_MISMATCH', detail = '', discovery }) {
  protocolMismatchCount += 1
  const shown = received === undefined ? null : received
  log(
    `protocol mismatch (${source}): host=${HOST_PROTOCOL} provider=${JSON.stringify(shown)} ` +
      `${detail ? `${detail} ` : ''}[${code}] attempt ${protocolMismatchCount}/${MAX_PROTOCOL_MISMATCH_ATTEMPTS}`,
  )
  if (protocolMismatchCount >= MAX_PROTOCOL_MISMATCH_ATTEMPTS) {
    blockedDiscoveryToken = discovery?.token == null ? '' : String(discovery.token)
    clearMismatchPoll()
    log(
      'protocol negotiation failed repeatedly; reconnect paused until bridge.json changes. ' +
        'This path never spawns another host or Chrome process.',
    )
    scheduleMismatchPoll()
    return
  }
  scheduleReconnect('protocol mismatch')
}

function onSocketData(chunk, source) {
  if (source !== socket) return
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
        if (!supportedProtocol(message.protocol)) {
          handleProtocolMismatch({
            source: 'hello-ok',
            received: message.protocol,
            discovery: readDiscovery(),
          })
          source.destroy()
          continue
        }
        authed = true
        retryDelay = RETRY_BASE_MS
        protocolMismatchCount = 0
        blockedDiscoveryToken = null
        clearMismatchPoll()
        log(`bridge authenticated (protocol ${message.protocol})`)
        sendExtensionState()
      } else if (message?.type === 'hello-error') {
        handleProtocolMismatch({
          source: 'hello-error',
          received: message.received,
          code: typeof message.code === 'string' ? message.code : 'PROTOCOL_VERSION_MISMATCH',
          detail: typeof message.message === 'string' ? message.message : '',
          discovery: readDiscovery(),
        })
        source.destroy()
      } else {
        log('unexpected bridge greeting; reconnecting')
        source.destroy()
      }
      continue
    }
    if (message?.id != null) {
      if (typeof message.method === 'string') {
        // Request from the provider to the extension. Bounded like the
        // opposite direction; an over-cap caller gets a bridge-line error.
        const method = String(message.method)
        if (!trackPending(message.id, method, 'provider')) {
          rejectOverLimit(message.id, method, 'provider')
          continue
        }
      } else {
        // Reply from the provider to an extension-originated request.
        clearPending(message.id)
      }
      writeNative(message)
      continue
    }
    if (message?.event) writeNative({ event: message.event, params: message.params })
  }
}

function connectBridge() {
  if (stdinEnded) return
  const discovery = readDiscovery()
  if (!discovery?.socketPath || !discovery?.token) {
    scheduleReconnect('discovery file missing (is DSH running?)')
    return
  }
  if (blockedDiscoveryToken !== null && String(discovery.token) === blockedDiscoveryToken) {
    scheduleMismatchPoll()
    return
  }
  if (blockedDiscoveryToken !== null) {
    // A new provider generation wrote a new token: retry negotiation once,
    // even if the previous generation's protocol was incompatible.
    log('bridge token changed after protocol mismatch; retrying negotiation')
    blockedDiscoveryToken = null
    protocolMismatchCount = 0
  }
  if (discovery.protocol != null && !supportedProtocol(discovery.protocol)) {
    // Fail before connecting: the discovery file already declares the
    // provider's protocol, so there is nothing to negotiate.
    handleProtocolMismatch({
      source: 'discovery',
      received: discovery.protocol,
      detail: 'discovery file',
      discovery,
    })
    scheduleMismatchPoll()
    return
  }
  authed = false
  socketBuffer = ''
  forgetPending()
  const next = net.connect(discovery.socketPath)
  socket = next
  next.setEncoding('utf8')
  next.on('connect', () => {
    log(`connected to bridge ${discovery.socketPath}`)
    next.write(
      `${JSON.stringify({
        type: 'hello',
        token: discovery.token,
        hostVersion: HOST_VERSION,
        protocol: HOST_PROTOCOL,
      })}\n`,
    )
  })
  next.on('data', (chunk) => onSocketData(chunk, next))
  next.on('error', (error) => {
    log(`bridge socket error: ${error.message}`)
  })
  next.on('close', () => {
    const wasLive = authed
    authed = false
    if (socket === next) socket = null
    forgetPending()
    if (wasLive) log('bridge socket closed; waiting for DSH to come back')
    scheduleReconnect('socket closed')
  })
}

log(`host started pid=${process.pid} version=${HOST_VERSION} protocol=${HOST_PROTOCOL}`)
connectBridge()
startExtensionWatcher()
startManifestPolling()

function materializeScreenshot(result) {
  const dataBase64 = result?.dataBase64
  if (typeof dataBase64 !== 'string' || dataBase64.length === 0) return result
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

function shutdown(code, reason = 'shutdown') {
  log(reason)
  if (manifestPollTimer) {
    clearInterval(manifestPollTimer)
    manifestPollTimer = null
  }
  if (retryTimer) {
    clearTimeout(retryTimer)
    retryTimer = null
  }
  clearMismatchPoll()
  if (watchTimer) {
    clearTimeout(watchTimer)
    watchTimer = null
  }
  try {
    watcher?.close()
  } catch {
    // already closed
  }
  watcher = null
  if (screencastFlushTimer) {
    clearTimeout(screencastFlushTimer)
    screencastFlushTimer = null
  }
  screencastPending = null
  forgetPending()
  try {
    socket?.destroy()
  } catch {
    // already closed
  }
  process.exit(code)
}

process.on('SIGTERM', () => shutdown(0, 'SIGTERM'))
process.on('SIGINT', () => shutdown(0, 'SIGINT'))
