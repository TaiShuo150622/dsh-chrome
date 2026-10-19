/**
 * Scheme A prototype: a per-context browser viewer served by the Host web
 * server. No DSH client plugin or bundle is required — the user opens a
 * loopback URL with a random token and gets a small polling screenshot viewer
 * with basic input forwarding.
 *
 * Routes (all loopback-only, all token-checked, no CDP surface):
 *   GET  /dsh-chrome/context/:id/view?token=...   inline HTML (no external assets)
 *   GET  /dsh-chrome/context/:id/frame?token=...  one driver screenshot (JPEG/PNG)
 *   POST /dsh-chrome/context/:id/input?token=...  JSON input -> driver tab.* call
 *
 * `getContext(contextId)` is injected by the caller and returns
 * `{ driver, owner? }` or null. The viewer always acts as the fixed driver
 * owner `viewer`, so its actions stay attributable to the viewer tab group.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const ROUTE_PREFIX = '/dsh-chrome/context'
const VIEWER_OWNER = 'viewer'
const MAX_BODY_BYTES = 64 * 1024
const MAX_TOKEN_LENGTH = 256
const MAX_CONTEXT_ID_LENGTH = 128
const CONTEXT_ID_PATTERN = /^[A-Za-z0-9._-]+$/
const TOKEN_PATTERN = /^[A-Za-z0-9._~-]+$/
const META_CACHE_MS = 750

class ViewerError extends Error {
  constructor(status, code, message, headers = null) {
    super(message)
    this.name = 'ViewerError'
    this.status = status
    this.code = code
    this.headers = headers
  }
}

function defaultHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

function tokenPath(home) {
  return path.join(home || defaultHome(), 'cache', 'dsh-chrome', 'context-viewer-token')
}

function normalizeToken(value) {
  if (typeof value !== 'string') return null
  const token = value.trim()
  if (token.length < 8 || token.length > MAX_TOKEN_LENGTH) return null
  return TOKEN_PATTERN.test(token) ? token : null
}

/**
 * Reuse the token written by an earlier registration, or create a new random
 * one. The file is the only persistence; nothing is stored in configuration.
 */
function readOrCreateToken(home) {
  const file = tokenPath(home)
  try {
    const existing = fs.readFileSync(file, 'utf8').trim()
    if (normalizeToken(existing)) return existing
  } catch {
    // create below
  }
  const token = crypto.randomBytes(24).toString('hex')
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    fs.writeFileSync(file, `${token}\n`, { mode: 0o600 })
    fs.chmodSync(file, 0o600)
  } catch {
    // token stays in memory even if the file cannot be written
  }
  return token
}

function readOrigin(webServer) {
  try {
    return typeof webServer.getOrigin === 'function' ? webServer.getOrigin() : null
  } catch {
    return null
  }
}

function isLoopback(req) {
  const address = req?.socket?.remoteAddress || ''
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

function parseUrl(reqUrl) {
  try {
    const parsed = new URL(String(reqUrl || '/'), 'http://127.0.0.1')
    return { pathname: parsed.pathname, token: parsed.searchParams.get('token') || '', searchParams: parsed.searchParams }
  } catch {
    return null
  }
}

function tokenMatches(supplied, expected) {
  const a = Buffer.from(String(supplied || ''))
  const b = Buffer.from(String(expected || ''))
  return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b)
}

function contextIdFromPath(rawId) {
  let decoded
  try {
    decoded = decodeURIComponent(rawId)
  } catch {
    return null
  }
  if (!decoded || decoded.length > MAX_CONTEXT_ID_LENGTH) return null
  return CONTEXT_ID_PATTERN.test(decoded) ? decoded : null
}

/** Resolve `/dsh-chrome/context/<id>/<action>` under the registered prefix. */
function parseRoute(pathname) {
  if (!pathname.startsWith(`${ROUTE_PREFIX}/`)) return null
  const rest = pathname.slice(ROUTE_PREFIX.length + 1)
  const slash = rest.indexOf('/')
  if (slash <= 0) return null
  const contextId = contextIdFromPath(rest.slice(0, slash))
  if (!contextId) return null
  const action = rest.slice(slash + 1)
  if (action !== 'view' && action !== 'frame' && action !== 'input') return null
  return { contextId, action }
}

function plain(res, status, body, headers = null) {
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...(headers || {}),
  })
  res.end(body)
}

function sendJson(res, status, value) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(JSON.stringify(value))
}

function methodNotAllowed(allowed) {
  return new ViewerError(405, 'METHOD_NOT_ALLOWED', `method not allowed; use ${allowed}`, { allow: allowed })
}

function badRequest(code, message) {
  return new ViewerError(400, code, message)
}

async function readJsonBody(req) {
  const chunks = []
  let size = 0
  try {
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += buffer.byteLength
      if (size > MAX_BODY_BYTES) throw new ViewerError(413, 'BODY_TOO_LARGE', `request body exceeds ${MAX_BODY_BYTES} bytes`)
      chunks.push(buffer)
    }
  } catch (error) {
    if (error instanceof ViewerError) throw error
    throw badRequest('READ_FAILED', `cannot read request body: ${error?.message || String(error)}`)
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim()
  if (!raw) throw badRequest('INVALID_JSON', 'request body must be a JSON object')
  let value
  try {
    value = JSON.parse(raw)
  } catch {
    throw badRequest('INVALID_JSON', 'request body is not valid JSON')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw badRequest('INVALID_JSON', 'request body must be a JSON object')
  return value
}

async function callDriver(driver, method, params = {}) {
  try {
    return await driver.request(method, { ...params, owner: VIEWER_OWNER })
  } catch (error) {
    const code = typeof error?.code === 'string' && error.code ? error.code : 'DRIVER_ERROR'
    const status = code === 'CONTEXT_NOT_FOUND' || code === 'TAB_NOT_FOUND' ? 404 : 500
    throw new ViewerError(status, code, error?.message || String(error))
  }
}

/** Resolve the injected context into a usable driver, mapping "not found" to 404. */
async function resolveContext(contextId, getContext) {
  let value
  try {
    value = await getContext(contextId)
  } catch (error) {
    if (error?.code === 'CONTEXT_NOT_FOUND') throw new ViewerError(404, 'CONTEXT_NOT_FOUND', `context ${contextId} was not found`)
    throw error
  }
  if (!value) throw new ViewerError(404, 'CONTEXT_NOT_FOUND', `context ${contextId} was not found`)
  const driver = value.driver || (typeof value.request === 'function' ? value : null)
  if (!driver || typeof driver.request !== 'function') {
    throw new ViewerError(503, 'CONTEXT_UNAVAILABLE', `context ${contextId} has no driver`)
  }
  return { context: value, driver }
}

function normalizeHttpUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null
  let parsed
  try {
    parsed = new URL(value.trim())
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  if (!parsed.hostname) return null
  return parsed.toString()
}

function screenshotFormat(searchParams) {
  const format = searchParams?.get('format') === 'png' ? 'png' : 'jpeg'
  const rawQuality = searchParams?.get('quality')
  const parsedQuality = rawQuality == null || rawQuality === '' ? Number.NaN : Number(rawQuality)
  const quality = Number.isFinite(parsedQuality) ? Math.max(1, Math.min(100, Math.round(parsedQuality))) : 70
  return { format, quality }
}

async function readScreenshotData(shot) {
  if (Buffer.isBuffer(shot)) return shot
  if (typeof shot?.path === 'string' && shot.path) {
    try {
      return await fsp.readFile(shot.path)
    } catch (error) {
      throw new ViewerError(500, 'SCREENSHOT_UNAVAILABLE', `cannot read screenshot ${shot.path}: ${error?.message || String(error)}`)
    }
  }
  if (Buffer.isBuffer(shot?.data)) return shot.data
  if (typeof shot?.data === 'string' && shot.data) return Buffer.from(shot.data, 'base64')
  throw new ViewerError(500, 'SCREENSHOT_UNAVAILABLE', 'driver returned no screenshot data or path')
}

function captureFrame(contextId, driver, params, state) {
  const key = `${contextId}:${params.format}:${params.quality}`
  const pending = state.inflight.get(key)
  if (pending) return pending
  const promise = callDriver(driver, 'tab.screenshot', params).finally(() => state.inflight.delete(key))
  state.inflight.set(key, promise)
  return promise
}

async function readTabMeta(contextId, driver, state) {
  const cached = state.metaCache.get(contextId)
  if (cached && Date.now() - cached.at < META_CACHE_MS) return cached.value
  const list = await callDriver(driver, 'tab.tabs', { op: 'list' })
  const tabs = Array.isArray(list?.tabs) ? list.tabs : []
  const active =
    list?.activeTabId != null
      ? tabs.find((tab) => tab.tabId === list.activeTabId)
      : tabs.find((tab) => tab.active === true)
  const value = active
    ? { tabId: active.tabId ?? null, url: String(active.url || ''), title: String(active.title || '') }
    : null
  state.metaCache.set(contextId, { at: Date.now(), value })
  return value
}

function encodedHeader(value, maxChars) {
  return encodeURIComponent(String(value || '').slice(0, maxChars))
}

async function serveView(res, contextId, { getContext, state }) {
  await resolveContext(contextId, getContext)
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-security-policy':
      "default-src 'none'; img-src blob: data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'none'; base-uri 'none'",
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
  })
  res.end(viewerHtml({ contextId, token: state.token }))
}

async function serveFrame(res, contextId, searchParams, { getContext, state, logger }) {
  const { driver } = await resolveContext(contextId, getContext)
  const { format, quality } = screenshotFormat(searchParams)
  let meta = null
  if (searchParams.get('meta') === '1') {
    try {
      meta = await readTabMeta(contextId, driver, state)
    } catch (error) {
      logger?.warn?.('dsh-chrome: context viewer metadata failed for %s: %s', contextId, error?.message || String(error))
    }
  }
  const shot = await captureFrame(contextId, driver, { format, quality }, state)
  const data = await readScreenshotData(shot)
  const headers = {
    'content-type': shot?.mediaType === 'image/png' || shot?.mediaType === 'image/jpeg' ? shot.mediaType : format === 'png' ? 'image/png' : 'image/jpeg',
    'cache-control': 'no-store, max-age=0',
    'content-length': data.byteLength,
    'x-content-type-options': 'nosniff',
  }
  if (Number.isFinite(Number(shot?.width)) && Number(shot.width) > 0) headers['x-dsh-view-width'] = String(Math.round(Number(shot.width)))
  if (Number.isFinite(Number(shot?.height)) && Number(shot.height) > 0) headers['x-dsh-view-height'] = String(Math.round(Number(shot.height)))
  if (meta?.url) headers['x-dsh-context-url'] = encodedHeader(meta.url, 2000)
  if (meta?.title) headers['x-dsh-context-title'] = encodedHeader(meta.title, 200)
  if (meta?.tabId != null) headers['x-dsh-context-tab'] = String(meta.tabId)
  res.writeHead(200, headers)
  res.end(data)
}

async function performInput(payload, driver) {
  const kind = typeof payload.kind === 'string' ? payload.kind : ''
  if (kind === 'click') {
    const x = Number(payload.x)
    const y = Number(payload.y)
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw badRequest('INVALID_CLICK', 'click needs finite x and y')
    const requested = Number(payload.clickCount)
    const clickCount = Number.isFinite(requested) ? Math.max(1, Math.min(3, Math.trunc(requested))) : 1
    const result = await callDriver(driver, 'tab.clickAt', { x, y, clickCount })
    return { x, y, clickCount, tabId: result?.tabId ?? null }
  }
  if (kind === 'type') {
    if (typeof payload.text !== 'string') throw badRequest('INVALID_TYPE', 'type needs a text string')
    if (payload.text.length === 0 && payload.replace !== true) throw badRequest('INVALID_TYPE', 'type text is empty; set replace=true to clear the field')
    const params = { text: payload.text }
    if (typeof payload.selector === 'string' && payload.selector) params.selector = payload.selector
    else if (Number.isFinite(Number(payload.ref))) params.ref = Number(payload.ref)
    else params.selector = ':focus'
    if (payload.replace != null) params.replace = Boolean(payload.replace)
    if (payload.submit != null) params.submit = Boolean(payload.submit)
    const result = await callDriver(driver, 'tab.type', params)
    return { value: result?.value ?? null, submitted: result?.submitted === true }
  }
  if (kind === 'key') {
    const key = typeof payload.key === 'string' ? payload.key : ''
    if (!key || key.length > 32 || /[\u0000-\u001f\u007f]/.test(key)) throw badRequest('INVALID_KEY', 'key needs a short printable string')
    await callDriver(driver, 'tab.press', { key })
    return { key }
  }
  if (kind === 'scroll') {
    const deltaY = Number(payload.deltaY)
    if (!Number.isFinite(deltaY) || deltaY === 0) throw badRequest('INVALID_SCROLL', 'scroll needs a non-zero finite deltaY')
    const amount = Math.max(1, Math.min(5000, Math.round(Math.abs(deltaY))))
    const direction = deltaY > 0 ? 'down' : 'up'
    const result = await callDriver(driver, 'tab.scroll', { direction, amount })
    return { direction, amount, x: result?.x ?? null, y: result?.y ?? null }
  }
  if (kind === 'navigate') {
    const url = normalizeHttpUrl(payload.url)
    if (!url) throw badRequest('INVALID_URL', 'navigate needs an http(s) url')
    const result = await callDriver(driver, 'tab.goto', { url })
    return { url: String(result?.url || url), title: result?.title ?? null, loadState: result?.loadState ?? null }
  }
  if (kind === 'history') {
    // Extension beyond the five documented input kinds: the viewer's
    // back/forward/reload buttons map to the driver's history operation.
    const op = typeof payload.op === 'string' ? payload.op : 'reload'
    if (op !== 'back' && op !== 'forward' && op !== 'reload') throw badRequest('INVALID_HISTORY', 'history op must be back, forward or reload')
    const result = await callDriver(driver, 'tab.history', { op })
    return { op, url: result?.url ?? null, title: result?.title ?? null }
  }
  throw badRequest('INVALID_KIND', 'kind must be one of click, type, key, scroll, navigate, history')
}

async function serveInput(req, res, contextId, { getContext, state }) {
  const { driver } = await resolveContext(contextId, getContext)
  const payload = await readJsonBody(req)
  const result = await performInput(payload, driver)
  state.metaCache.delete(contextId)
  sendJson(res, 200, { ok: true, kind: payload.kind, ...result })
}

async function dispatch(req, res, deps) {
  let asJson = false
  try {
    if (!isLoopback(req)) throw new ViewerError(403, 'LOOPBACK_ONLY', 'the context viewer only accepts loopback requests')
    const parsed = parseUrl(req?.url)
    if (!parsed) throw badRequest('BAD_URL', 'invalid request URL')
    if (!tokenMatches(parsed.token, deps.state.token)) {
      throw new ViewerError(403, 'INVALID_TOKEN', 'invalid or missing viewer token')
    }
    const route = parseRoute(parsed.pathname)
    if (!route) throw new ViewerError(404, 'NOT_FOUND', 'not found')
    if (route.action === 'view') {
      if (req.method !== 'GET') throw methodNotAllowed('GET')
      await serveView(res, route.contextId, deps)
      return
    }
    if (route.action === 'frame') {
      if (req.method !== 'GET') throw methodNotAllowed('GET')
      await serveFrame(res, route.contextId, parsed.searchParams, deps)
      return
    }
    if (req.method !== 'POST') throw methodNotAllowed('POST')
    asJson = true
    await serveInput(req, res, route.contextId, deps)
  } catch (error) {
    if (res.writableEnded) return
    const status = error instanceof ViewerError ? error.status : 500
    const code = error instanceof ViewerError ? error.code : 'INTERNAL'
    const message = error instanceof ViewerError ? error.message : `context viewer failed: ${error?.message || String(error)}`
    if (status >= 500) deps.logger?.warn?.('dsh-chrome: context viewer request failed (%s): %s', code, message)
    if (asJson) sendJson(res, status, { ok: false, error: { code, message } })
    else plain(res, status, message, error instanceof ViewerError ? error.headers : null)
  }
}

function viewerHtml({ contextId, token }) {
  const base = `${ROUTE_PREFIX}/${encodeURIComponent(contextId)}`
  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DSH · 隔离浏览器</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #0b0d10; color: #d7dae0; font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  header { display: flex; flex-wrap: wrap; gap: 10px; align-items: baseline; padding: 8px 10px; border-bottom: 1px solid #242a33; background: #11151b; }
  header b { color: #fff; font-size: 13px; }
  .hint { color: #7d8695; font-size: 12px; }
  .bar { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; padding: 8px 10px; border-bottom: 1px solid #1b212a; }
  .grow { flex: 1 1 280px; display: flex; gap: 6px; min-width: 0; }
  .grow input { flex: 1 1 auto; }
  button, input { font: inherit; color: #e7eaf0; background: #1a2029; border: 1px solid #303949; border-radius: 6px; padding: 4px 8px; }
  button { cursor: pointer; white-space: nowrap; }
  button:hover { background: #242d3a; }
  input { min-width: 0; }
  input:focus, button:focus-visible { outline: 1px solid #4c8dff; outline-offset: 1px; }
  .sep { width: 1px; height: 18px; background: #29313c; margin: 0 2px; }
  #stage { display: flex; justify-content: center; padding: 8px; background: #050608; min-height: 180px; }
  #frame { display: block; max-width: 100%; max-height: calc(100vh - 158px); background: #000; border: 1px solid #1d232c; border-radius: 4px; cursor: crosshair; }
  #status { padding: 6px 10px 12px; color: #8b94a3; font-size: 12px; white-space: pre-wrap; overflow-wrap: anywhere; }
</style>
</head>
<body>
<header>
  <b>DSH · 隔离浏览器</b>
  <span class="hint">方案 A 原型 · 截图轮询约 3 fps</span>
  <span class="hint" id="meta"></span>
  <span class="hint" id="conn">连接中…</span>
</header>
<div class="bar">
  <button id="back" title="后退">←</button>
  <button id="forward" title="前进">→</button>
  <button id="reload" title="刷新页面">⟳</button>
  <form id="navform" class="grow">
    <input id="url" placeholder="https://…" spellcheck="false" autocomplete="off" aria-label="页面地址">
    <button type="submit">打开</button>
  </form>
</div>
<div class="bar">
  <form id="typeform" class="grow">
    <input id="text" placeholder="输入文本（先点击页面里的输入框）" autocomplete="off" aria-label="要发送到页面的文本">
    <button type="submit">输入</button>
  </form>
  <span class="sep"></span>
  <button data-key="Enter">Enter</button>
  <button data-key="Tab">Tab</button>
  <button data-key="Escape">Esc</button>
  <button data-key="ArrowUp">↑</button>
  <button data-key="ArrowDown">↓</button>
  <button data-key="ArrowLeft">←</button>
  <button data-key="ArrowRight">→</button>
</div>
<div id="stage"><img id="frame" alt="隔离浏览器截图"></div>
<div id="status">点击截图发送鼠标点击；滚动滚轮发送滚动；页面里的输入框先用鼠标点一下再发文本。</div>
<script>
  'use strict'
  const base = ${JSON.stringify(base)}
  const token = ${JSON.stringify(token)}
  const framePath = base + '/frame?token=' + encodeURIComponent(token)
  const inputPath = base + '/input?token=' + encodeURIComponent(token)

  const frame = document.getElementById('frame')
  const urlInput = document.getElementById('url')
  const textInput = document.getElementById('text')
  const statusEl = document.getElementById('status')
  const connEl = document.getElementById('conn')
  const metaEl = document.getElementById('meta')

  let lastMetaAt = 0
  let failures = 0
  let pollBusy = false
  let cssWidth = 0
  let cssHeight = 0
  let scrollPending = 0
  let scrollTimer = null

  function decodeHeader(value) {
    if (!value) return ''
    try { return decodeURIComponent(value) } catch { return value }
  }

  function short(value) {
    const text = typeof value === 'string' ? value : JSON.stringify(value)
    return text.length > 240 ? text.slice(0, 240) + '…' : text
  }

  function setStatus(text) {
    statusEl.textContent = text
  }

  async function post(payload) {
    const response = await fetch(inputPath, {
      method: 'POST',
      cache: 'no-store',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    let body = null
    try { body = await response.json() } catch { body = null }
    if (!response.ok || !body || body.ok !== true) {
      const detail = body && body.error ? (body.error.code || 'ERROR') + ': ' + (body.error.message || '') : 'HTTP ' + response.status
      throw new Error(detail)
    }
    return body
  }

  async function act(payload, label) {
    try {
      const result = await post(payload)
      if ((payload.kind === 'navigate' || payload.kind === 'history') && result.url) urlInput.value = result.url
      if (payload.kind === 'navigate' || payload.kind === 'history') lastMetaAt = 0
      setStatus(label + ' ✓ ' + short(result))
      return result
    } catch (error) {
      setStatus(label + ' ✗ ' + (error && error.message ? error.message : String(error)))
      return null
    }
  }

  document.getElementById('navform').addEventListener('submit', (event) => {
    event.preventDefault()
    const url = urlInput.value.trim()
    if (url) void act({ kind: 'navigate', url }, '打开 ' + url)
  })

  document.getElementById('typeform').addEventListener('submit', (event) => {
    event.preventDefault()
    const text = textInput.value
    if (!text) return
    void act({ kind: 'type', text }, '输入文本').then((result) => {
      if (result) textInput.value = ''
    })
  })

  for (const button of document.querySelectorAll('button[data-key]')) {
    button.addEventListener('click', () => {
      void act({ kind: 'key', key: button.dataset.key }, '按键 ' + button.dataset.key)
    })
  }

  document.getElementById('back').addEventListener('click', () => { void act({ kind: 'history', op: 'back' }, '后退') })
  document.getElementById('forward').addEventListener('click', () => { void act({ kind: 'history', op: 'forward' }, '前进') })
  document.getElementById('reload').addEventListener('click', () => { void act({ kind: 'history', op: 'reload' }, '刷新页面') })

  frame.addEventListener('click', (event) => {
    const rect = frame.getBoundingClientRect()
    const width = cssWidth || frame.naturalWidth
    const height = cssHeight || frame.naturalHeight
    if (!width || !height || !rect.width || !rect.height) return
    const x = Math.round(((event.clientX - rect.left) / rect.width) * width)
    const y = Math.round(((event.clientY - rect.top) / rect.height) * height)
    void act({ kind: 'click', x, y }, '点击 (' + x + ', ' + y + ')')
  })

  frame.addEventListener('wheel', (event) => {
    event.preventDefault()
    scrollPending += event.deltaY
    if (scrollTimer) return
    scrollTimer = setTimeout(() => {
      scrollTimer = null
      const deltaY = scrollPending
      scrollPending = 0
      if (!deltaY) return
      void act({ kind: 'scroll', deltaY }, '滚动 ' + (deltaY > 0 ? '↓' : '↑'))
    }, 120)
  }, { passive: false })

  async function poll() {
    if (pollBusy || document.hidden) return
    pollBusy = true
    const wantMeta = Date.now() - lastMetaAt > 900
    try {
      const response = await fetch(framePath + '&t=' + Date.now() + (wantMeta ? '&meta=1' : ''), { cache: 'no-store' })
      if (!response.ok) throw new Error('HTTP ' + response.status)
      const width = Number(response.headers.get('x-dsh-view-width'))
      const height = Number(response.headers.get('x-dsh-view-height'))
      if (Number.isFinite(width) && width > 0) cssWidth = width
      if (Number.isFinite(height) && height > 0) cssHeight = height
      if (wantMeta) {
        lastMetaAt = Date.now()
        const pageUrl = decodeHeader(response.headers.get('x-dsh-context-url'))
        if (pageUrl && document.activeElement !== urlInput) urlInput.value = pageUrl
        const title = decodeHeader(response.headers.get('x-dsh-context-title'))
        metaEl.textContent = title ? '· ' + title : ''
      }
      const blob = await response.blob()
      const next = URL.createObjectURL(blob)
      const previous = frame.src
      await new Promise((resolve, reject) => {
        const onLoad = () => { cleanup(); resolve() }
        const onError = () => { cleanup(); reject(new Error('image decode failed')) }
        const cleanup = () => {
          frame.removeEventListener('load', onLoad)
          frame.removeEventListener('error', onError)
        }
        frame.addEventListener('load', onLoad)
        frame.addEventListener('error', onError)
        frame.src = next
      })
      if (previous.indexOf('blob:') === 0) URL.revokeObjectURL(previous)
      failures = 0
      connEl.textContent = '已连接 · ' + frame.naturalWidth + '×' + frame.naturalHeight + ' · ' + new Date().toLocaleTimeString()
    } catch (error) {
      failures += 1
      if (failures >= 2) connEl.textContent = '暂无画面：' + (error && error.message ? error.message : String(error))
    } finally {
      pollBusy = false
    }
  }

  setInterval(() => { void poll() }, 330)
  void poll()
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) void poll()
  })
</script>
</body></html>`
}

function disabledViewer() {
  return { enabled: false, token: null, urlFor: () => null, dispose: () => {} }
}

/**
 * Register the per-context viewer routes on the Host web server.
 *
 * @param {object} options
 * @param {{register: Function, getOrigin?: Function}} options.webServer Host web server service.
 * @param {(contextId: string) => ({driver: object, owner?: string} | null | Promise<...>)} options.getContext Context lookup.
 * @param {string} [options.token] Optional existing token (memory only); generated/persisted otherwise.
 * @param {{info?: Function, warn?: Function}} [options.logger]
 * @param {string} [options.home] DSH home for the token file (defaults to DSH_HOME or ~/.dsh).
 * @returns {{enabled: boolean, token: string|null, urlFor: (contextId: string) => string|null, dispose: () => void}}
 */
export function registerContextViewer({ webServer, getContext, token, logger = null, home = defaultHome() } = {}) {
  if (!webServer || typeof webServer.register !== 'function') {
    logger?.warn?.('dsh-chrome: context viewer disabled (Host webServer is unavailable)')
    return disabledViewer()
  }
  if (typeof getContext !== 'function') {
    logger?.warn?.('dsh-chrome: context viewer disabled (getContext is required)')
    return disabledViewer()
  }
  const callerToken = normalizeToken(token)
  let viewerToken = callerToken
  if (token != null && !viewerToken) logger?.warn?.('dsh-chrome: context viewer ignored an invalid token and generated a new one')
  if (!viewerToken) viewerToken = readOrCreateToken(home)

  const state = {
    token: viewerToken,
    origin: readOrigin(webServer),
    disposed: false,
    inflight: new Map(),
    metaCache: new Map(),
  }
  let disposeRoute
  try {
    disposeRoute = webServer.register({
      kind: 'prefix',
      path: ROUTE_PREFIX,
      handler: (req, res) => dispatch(req, res, { getContext, logger, state }),
    })
  } catch (error) {
    logger?.warn?.('dsh-chrome: context viewer registration failed: %s', error?.message || String(error))
    return disabledViewer()
  }

  logger?.info?.(
    'dsh-chrome: context viewer registered at %s (token file %s)',
    `${state.origin || '<origin unavailable>'}${ROUTE_PREFIX}/:id/view`,
    callerToken != null ? '<memory only>' : tokenPath(home),
  )

  return {
    enabled: true,
    token: viewerToken,
    urlFor(contextId) {
      if (state.disposed) return null
      const id = String(contextId ?? '')
      if (!id || id.length > MAX_CONTEXT_ID_LENGTH || !CONTEXT_ID_PATTERN.test(id)) return null
      const origin = state.origin || readOrigin(webServer)
      if (!origin) return null
      state.origin = origin
      return `${origin}${ROUTE_PREFIX}/${encodeURIComponent(id)}/view?token=${encodeURIComponent(viewerToken)}`
    },
    dispose() {
      if (state.disposed) return
      state.disposed = true
      state.inflight.clear()
      state.metaCache.clear()
      try {
        disposeRoute?.()
      } catch {
        // unloading continues
      }
    },
  }
}
