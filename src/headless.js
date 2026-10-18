/**
 * Background browser backend: launch a local headless Chromium with the DevTools
 * protocol and answer the same `tab.*` / `browser.*` requests the extension
 * answers. This is the H0 spike core (navigation/snapshot/click/type/screenshot/
 * evaluate/wait/tabs); unsupported methods fail with UNSUPPORTED_BACKEND.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

const CHROME_CANDIDATES = [
  process.env.DSH_HEADLESS_CHROME,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean)

const SUPPORTED = new Set([
  'browser.status',
  'browser.site',
  'tab.tabs',
  'tab.goto',
  'tab.snapshot',
  'tab.click',
  'tab.type',
  'tab.clickAt',
  'tab.hover',
  'tab.scroll',
  'tab.press',
  'tab.history',
  'tab.resume',
  'tab.frames',
  'tab.a11y',
  'tab.screenshot',
  'tab.pdf',
  'tab.evaluate',
  'tab.wait',
  'tab.html',
  'tab.text',
  'tab.get_text',
  'tab.find',
  'tab.select',
  'tab.drag',
  'tab.storage',
  'tab.emulate',
  'tab.selection',
  'tab.console',
  'tab.network',
  'tab.capture_start',
  'tab.capture_stop',
  'tab.capture_requests',
  'tab.screencast_start',
  'tab.screencast_stop',
  'tab.screencast_status',
  'tab.upload',
  'tab.resume',
  'browser.downloads',
  'tab.close_session',
  'tab.debug_diag',
])

const DEFAULT_IDLE_MINUTES = Number(process.env.DSH_HEADLESS_IDLE_MINUTES) || 5
const MAX_TABS = Number(process.env.DSH_HEADLESS_MAX_TABS) || 12

const CAPTURE_MAX_DURATION_MS = 10 * 60 * 1000
const CAPTURE_DEFAULT_MAX_ENTRIES = 300
const CAPTURE_HARD_MAX_ENTRIES = 1000

// Screenshot frame streaming (see docs/HEADLESS.md §4.1): while a tab is being
// screenshotted repeatedly, keep a short-lived PNG screencast running and serve
// `tab.screenshot` from the compositor's own frames. Chrome encodes a
// screencast PNG with the same encoder as Page.captureScreenshot (the bytes are
// identical for identical content), but the frame is produced off the request
// path, so a shot costs one compositor frame interval (~16ms) instead of a full
// capture (~44ms). A driver-side change marker plus the frame timestamp
// guarantee the returned frame includes the latest tab action; when that cannot
// be established the call falls back to a capture (first frame missing) or to
// the latest painted frame (visible page that produced no repaint), so
// screenshots never silently return a picture older than the last action.
const SHOT_STREAM_IDLE_MS = Math.max(250, Number(process.env.DSH_HEADLESS_SHOT_STREAM_IDLE_MS) || 2000)
const SHOT_STREAM_FRAME_TIMEOUT_MS = Math.max(20, Number(process.env.DSH_HEADLESS_SHOT_STREAM_FRAME_TIMEOUT_MS) || 40)
const SHOT_STREAM_FIRST_FRAME_TIMEOUT_MS = Math.max(50, Number(process.env.DSH_HEADLESS_FIRST_FRAME_TIMEOUT_MS) || 150)
const SHOT_STREAM_FAILURES_BEFORE_BACKOFF = 2
const SHOT_STREAM_BACKOFF_MS = 5000

// Every request that can change what the page renders bumps the owning tab's
// change marker. `tab.screenshot` only reuses a streamed frame (or waits for a
// new one) whose composition timestamp is at least this marker.
const SHOT_STREAM_METHODS = new Set([
  'tab.goto',
  'tab.click',
  'tab.clickAt',
  'tab.type',
  'tab.scroll',
  'tab.press',
  'tab.history',
  'tab.select',
  'tab.drag',
  'tab.hover',
  'tab.upload',
  'tab.evaluate',
  'tab.wait',
  'tab.storage',
  'tab.emulate',
])
const CAPTURE_BODY_TOTAL_LIMIT = 8 * 1024 * 1024
const CAPTURE_RESPONSE_BODY_CHARS = 4096
const CAPTURE_REQUEST_BODY_CHARS = 2048
const CAPTURE_TEXT_MIME = /^text\/|json|xml|javascript|x-www-form-urlencoded|graphql/i
const CAPTURE_SECRET_PARAM =
  /(pass(word|wd)?|secret|token|api[-_]?key|access[-_]?token|refresh[-_]?token|authorization|cookie|session[-_]?id|csrf|xsrf|signature|sig|credential|private[-_]?key)/i

function maskSecretsInText(text) {
  return String(text)
    .replace(/\b(Bearer\s+)[A-Za-z0-9._\-]{6,}/gi, '$1«redacted»')
    .replace(/\bsk-[A-Za-z0-9]{10,}\b/g, '«redacted»')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g, '«redacted»')
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, '«redacted»')
}

function redactUrl(rawUrl) {
  let url = String(rawUrl || '')
  try {
    const parsed = new URL(url)
    if (parsed.username) parsed.username = '«redacted»'
    if (parsed.password) parsed.password = '«redacted»'
    for (const name of [...parsed.searchParams.keys()]) {
      if (CAPTURE_SECRET_PARAM.test(name)) parsed.searchParams.set(name, '«redacted»')
    }
    url = parsed.toString().replace(/%C2%ABredacted%C2%BB/gi, '«redacted»')
  } catch {
    // keep non-URL strings
  }
  return url.length > 2048 ? `${url.slice(0, 2048)}…` : url
}

function redactJsonValue(value) {
  if (Array.isArray(value)) return value.map((item) => redactJsonValue(item))
  if (value && typeof value === 'object') {
    const out = {}
    for (const [key, item] of Object.entries(value)) {
      out[key] = CAPTURE_SECRET_PARAM.test(key) ? '«redacted»' : redactJsonValue(item)
    }
    return out
  }
  if (typeof value === 'string') return maskSecretsInText(value)
  return value
}

function redactBodyText(text, mimeType, maxChars) {
  let out = String(text ?? '')
  const trimmed = out.trim()
  const isJson = /json/i.test(String(mimeType || '')) || trimmed.startsWith('{') || trimmed.startsWith('[')
  if (isJson) {
    try {
      out = JSON.stringify(redactJsonValue(JSON.parse(trimmed)))
    } catch {
      out = maskSecretsInText(out)
    }
  } else if (/x-www-form-urlencoded/i.test(String(mimeType || ''))) {
    out = out
      .split('&')
      .map((pair) => {
        const [name, ...rest] = pair.split('=')
        if (CAPTURE_SECRET_PARAM.test(decodeURIComponent(name || ''))) return `${name}="«redacted»"`
        return `${name}${rest.length ? `=${rest.join('=')}` : ''}`
      })
      .join('&')
  } else {
    out = maskSecretsInText(out)
  }
  const truncated = out.length > maxChars
  return { text: truncated ? `${out.slice(0, maxChars)}… <truncated>` : out, truncated }
}

function materializeCaptureBody(capture, raw, mimeType, maxChars) {
  if (raw == null) return null
  let text
  if (!CAPTURE_TEXT_MIME.test(String(mimeType || ''))) {
    text = `<binary ${String(raw).length} chars>`
  } else {
    text = redactBodyText(raw, mimeType, maxChars).text
  }
  const bytes = text.length
  if (capture.bodyBytes + bytes > CAPTURE_BODY_TOTAL_LIMIT) {
    capture.bodiesDropped += 1
    return { text: '<body not captured: capture body budget exceeded>', truncated: false }
  }
  capture.bodyBytes += bytes
  return { text, truncated: text.length >= maxChars }
}

function error(code, message) {
  const err = new Error(message)
  err.code = code
  return err
}

function chromeExecutable() {
  for (const candidate of CHROME_CANDIDATES) {
    try {
      if (fs.existsSync(candidate)) return candidate
    } catch {
      // try next
    }
  }
  return null
}

// ---------------------------------------------------------------- CDP client
class Cdp {
  constructor(url) {
    this.url = url
    this.nextId = 0
    this.pending = new Map()
    this.listeners = new Set()
    this.ws = null
  }

  async connect() {
    if (typeof WebSocket !== 'function') throw error('UNSUPPORTED_BACKEND', 'this Node runtime has no WebSocket client')
    const ws = new WebSocket(this.url)
    this.ws = ws
    await new Promise((resolve, reject) => {
      ws.onopen = resolve
      ws.onerror = () => reject(error('HEADLESS_CDP_FAILED', 'cannot connect to headless Chrome CDP'))
    })
    ws.onmessage = (event) => {
      let message
      try {
        message = JSON.parse(event.data)
      } catch {
        return
      }
      if (message.id != null && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id)
        this.pending.delete(message.id)
        if (message.error) reject(error('HEADLESS_CDP_FAILED', message.error.message || 'CDP command failed'))
        else resolve(message.result ?? {})
        return
      }
      for (const listener of this.listeners) listener(message)
    }
    ws.onclose = () => {
      for (const { reject } of this.pending.values()) reject(error('HEADLESS_CDP_FAILED', 'headless Chrome connection closed'))
      this.pending.clear()
      this.listeners.clear()
      this.ws = null
    }
  }

  send(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      if (!this.ws) {
        reject(error('HEADLESS_CDP_FAILED', 'headless Chrome is not connected'))
        return
      }
      const id = ++this.nextId
      this.pending.set(id, { resolve, reject })
      try {
        this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
      } catch (sendError) {
        this.pending.delete(id)
        reject(error('HEADLESS_CDP_FAILED', sendError?.message || String(sendError)))
      }
    })
  }

  onMessage(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  close() {
    try {
      this.ws?.close()
    } catch {
      // already closed
    }
  }
}

// --------------------------------------------------------- page-side helpers
function snapshotPage(maxChars, boxes) {
  // One rect read per candidate: the same rect is reused for visibility and,
  // when requested, for the control's box coordinates.
  const visibleRect = (el) => {
    if (!el) return null
    const rect = el.getBoundingClientRect()
    if (rect.width <= 1 || rect.height <= 1) return null
    const style = getComputedStyle(el)
    if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') return null
    return rect
  }
  const labelOf = (el) => {
    const direct = el.getAttribute('aria-label') || el.getAttribute('title')
    if (direct) return direct.trim().slice(0, 120)
    if (el.tagName === 'INPUT') {
      const type = (el.getAttribute('type') || '').toLowerCase()
      if (type === 'submit' || type === 'button') return (el.value || el.getAttribute('value') || '').trim().slice(0, 120)
      if (el.getAttribute('placeholder')) return el.getAttribute('placeholder').trim().slice(0, 120)
    }
    const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim()
    return text.slice(0, 120)
  }
  const kindOf = (el) => {
    const tag = el.tagName.toLowerCase()
    if (tag === 'a') return 'link'
    if (tag === 'button') return 'button'
    if (tag === 'input') return (el.getAttribute('type') || 'text').toLowerCase()
    if (tag === 'select') return 'select'
    if (tag === 'textarea') return 'textarea'
    return el.getAttribute('role') || tag
  }
  const explicitRefs = new WeakMap()
  let nextRef = 1
  const all = Array.from(
    document.querySelectorAll(
      'a[href], button, input:not([type="hidden"]), select, textarea, summary, [role="button"], [role="link"], [role="textbox"], [role="checkbox"], [role="radio"], [role="tab"], [role="menuitem"], [role="combobox"], [contenteditable="true"], [contenteditable=""]',
    ),
  )
  const controls = []
  for (const el of all) {
    const rect = visibleRect(el)
    if (!rect) continue
    let ref = explicitRefs.get(el)
    if (!ref) {
      const existing = Number(el.getAttribute('data-dsh-ref'))
      ref = Number.isFinite(existing) && existing > 0 ? existing : nextRef++
      explicitRefs.set(el, ref)
      try {
        el.setAttribute('data-dsh-ref', String(ref))
      } catch {
        // non-HTML element
      }
    }
    if (ref >= nextRef) nextRef = ref + 1
    const tag = el.tagName.toLowerCase()
    const kind = kindOf(el)
    const rawValue = el.tagName === 'INPUT' && /password|card|secret/i.test(kind) ? '••••' : el.value
    const value = rawValue != null && rawValue !== '' ? String(rawValue).slice(0, 80) : undefined
    const control = { ref, tag, kind, label: labelOf(el), ...(value ? { value } : {}) }
    if (boxes) {
      control.box = [Math.round(rect.x), Math.round(rect.y), Math.round(rect.width), Math.round(rect.height)]
    }
    controls.push(control)
  }
  // body.innerText forces a layout: read it once and derive both text and the
  // truncation flag from the same string.
  const bodyText = document.body?.innerText || ''
  return {
    title: document.title || '',
    url: location.href,
    text: bodyText.slice(0, maxChars),
    truncated: bodyText.length > maxChars,
    controls,
    frameCount: 1,
    frames: [{ frameId: 'main', prefix: '', parentFrameId: null, url: location.href, title: document.title || '', controls: [] }],
  }
}

function clickPage(ref, selector, clickCount, button) {
  const el = selector
    ? document.querySelector(selector)
    : document.querySelector(`[data-dsh-ref="${Number(ref)}"]`)
  if (!el) return { ok: false, code: 'REF_NOT_FOUND', message: `no element for ${selector || `ref ${ref}`}` }
  el.scrollIntoView({ block: 'center', inline: 'center' })
  const rect = el.getBoundingClientRect()
  const options = {
    bubbles: true,
    cancelable: true,
    composed: true,
    view: window,
    clientX: rect.x + rect.width / 2,
    clientY: rect.y + rect.height / 2,
    button: button || 0,
    detail: clickCount || 1,
  }
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) {
    try {
      el.dispatchEvent(new PointerEvent(type, options))
    } catch {
      el.dispatchEvent(new MouseEvent(type, options))
    }
  }
  el.dispatchEvent(new MouseEvent('click', options))
  return {
    ok: true,
    tag: el.tagName.toLowerCase(),
    label: (el.getAttribute('aria-label') || el.innerText || el.value || '').replace(/\s+/g, ' ').trim().slice(0, 120),
    // Returned inline so the driver can refresh its tab cache without a second
    // Runtime.evaluate round trip after every click.
    url: location.href,
    title: document.title || '',
  }
}

function typePage(ref, selector, text, replace, submit) {
  const el = selector
    ? document.querySelector(selector)
    : document.querySelector(`[data-dsh-ref="${Number(ref)}"]`)
  if (!el) return { ok: false, code: 'REF_NOT_FOUND', message: `no element for ${selector || `ref ${ref}`}` }
  el.focus()
  const tag = el.tagName.toLowerCase()
  if (tag === 'input' || tag === 'textarea') {
    const proto = tag === 'input' ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
    const next = replace ? String(text) : `${el.value || ''}${text}`
    if (setter) setter.call(el, next)
    else el.value = next
    el.dispatchEvent(new Event('input', { bubbles: true, composed: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
  } else if (el.isContentEditable) {
    el.textContent = replace ? String(text) : `${el.textContent || ''}${text}`
    el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, data: String(text) }))
  } else {
    return { ok: false, code: 'NOT_EDITABLE', message: `element ${tag} is not an input` }
  }
  let submitted = false
  if (submit) {
    const form = el.closest?.('form')
    if (form) {
      if (typeof form.requestSubmit === 'function') form.requestSubmit()
      else form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      submitted = true
    } else if (tag === 'input') {
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }))
      submitted = true
    }
  }
  return { ok: true, value: String(el.value ?? el.textContent ?? '').slice(0, 200), submitted }
}

function currentSelection(maxChars) {
  const active = document.activeElement
  const tag = active?.tagName?.toLowerCase()
  if ((tag === 'input' || tag === 'textarea') && typeof active.selectionStart === 'number') {
    const text = String(active.value || '').slice(active.selectionStart, active.selectionEnd)
    if (text) return { found: true, text: text.slice(0, maxChars), source: 'input' }
  }
  const text = String(window.getSelection?.() || '')
  if (!text) return { found: false, message: 'NO_SELECTION' }
  return { found: true, text: text.slice(0, maxChars), source: 'document' }
}

function findPage(query, regex, maxResults) {
  const needle = String(query || '')
  if (!needle) return { query: needle, matches: [], truncated: false }
  let matcher
  if (regex) {
    try {
      const safe = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      matcher = new RegExp(safe, 'i')
    } catch {
      matcher = null
    }
  } else {
    matcher = new RegExp(String(needle).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
  }
  const cap = Number.isFinite(maxResults) ? Math.max(1, Math.min(50, maxResults)) : 20
  const matches = []
  let truncated = false
  const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT)
  let node
  while ((node = walker.nextNode())) {
    const text = (node.nodeValue || '').replace(/\s+/g, ' ').trim()
    if (!text || !matcher || !matcher.test(text)) continue
    const parent = node.parentElement
    if (!parent) continue
    const rect = parent.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) continue
    let ref = null
    let holder = parent
    for (let depth = 0; holder && depth < 6; depth += 1) {
      const value = Number(holder.getAttribute?.('data-dsh-ref'))
      if (Number.isFinite(value) && value > 0) {
        ref = value
        break
      }
      holder = holder.parentElement
    }
    matches.push({
      ...(ref ? { ref } : {}),
      tag: parent.tagName.toLowerCase(),
      text: text.slice(0, 200),
      x: Math.round(rect.x + rect.width / 2),
      y: Math.round(rect.y + rect.height / 2),
    })
    if (matches.length >= cap) {
      truncated = true
      break
    }
  }
  return { query: needle, matches, truncated }
}

function selectPage(ref, selector, value, checked) {
  const el = selector
    ? document.querySelector(selector)
    : document.querySelector(`[data-dsh-ref="${Number(ref)}"]`)
  if (!el) return { ok: false, code: 'REF_NOT_FOUND', message: `no element for ${selector || `ref ${ref}`}` }
  const tag = el.tagName.toLowerCase()
  if (tag === 'select') {
    if (value == null) return { ok: false, code: 'INVALID_ARGUMENT', message: 'value is required for select' }
    const option = Array.from(el.options).find(
      (candidate) => candidate.value === String(value) || (candidate.textContent || '').trim() === String(value),
    )
    if (!option) return { ok: false, code: 'INVALID_ARGUMENT', message: `option not found: ${value}` }
    el.value = option.value
    el.dispatchEvent(new Event('input', { bubbles: true, composed: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
    return { ok: true, tag, value: el.value }
  }
  if (tag === 'input' && ['checkbox', 'radio'].includes(String(el.type).toLowerCase())) {
    const next = typeof checked === 'boolean' ? checked : !el.checked
    el.checked = next
    el.dispatchEvent(new Event('input', { bubbles: true, composed: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
    return { ok: true, tag, value: next ? 'true' : 'false' }
  }
  return { ok: false, code: 'INVALID_ARGUMENT', message: `element <${tag}> is not a select/checkbox/radio` }
}

function dragPage(fromRef, toRef) {
  const from = document.querySelector(`[data-dsh-ref="${Number(fromRef)}"]`)
  const to = document.querySelector(`[data-dsh-ref="${Number(toRef)}"]`)
  if (!from || !to) return { ok: false, code: 'REF_NOT_FOUND', message: 'drag source or target not found' }
  const fromRect = from.getBoundingClientRect()
  const toRect = to.getBoundingClientRect()
  const start = { x: fromRect.x + fromRect.width / 2, y: fromRect.y + fromRect.height / 2 }
  const end = { x: toRect.x + toRect.width / 2, y: toRect.y + toRect.height / 2 }
  const dataTransfer = typeof DataTransfer === 'function' ? new DataTransfer() : null
  const fire = (target, type, x, y) => {
    const init = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, dataTransfer }
    try {
      target.dispatchEvent(new DragEvent(type, init))
    } catch {
      target.dispatchEvent(new MouseEvent(type.replace('drag', 'mouse'), init))
    }
  }
  fire(from, 'dragstart', start.x, start.y)
  fire(from, 'pointerdown', start.x, start.y)
  fire(to, 'dragenter', end.x, end.y)
  fire(to, 'dragover', end.x, end.y)
  fire(to, 'drop', end.x, end.y)
  fire(from, 'dragend', end.x, end.y)
  return { ok: true, from: Number(fromRef), to: Number(toRef) }
}

const PAGE_HELPERS = { snapshotPage, clickPage, typePage, currentSelection, findPage, selectPage, dragPage }

// Function.prototype.toString() is not free; serialize each page helper once.
const helperSources = new Map()

function pageCall(name, args) {
  let source = helperSources.get(name)
  if (!source) {
    source = PAGE_HELPERS[name].toString()
    helperSources.set(name, source)
  }
  return `(() => { const fn = ${source}; return fn(...${JSON.stringify(args)}); })()`
}

// ------------------------------------------------------------------ driver
export class HeadlessDriver {
  constructor({ home, logger, spawnImpl = spawn } = {}) {
    this.home = home
    this.logger = logger
    this.spawnImpl = spawnImpl
    this.chrome = null
    this.cdp = null
    this.browserVersion = null
    this.owners = new Map()
    this.tabs = new Map() // tabId -> tab (global; ids unique per owner group not guaranteed)
    this.nextTabId = 1
    this.startPromise = null
    this.screenshotDir = path.join(home || '.', 'cache', 'dsh-chrome', 'headless', 'screenshots')
    this.screenshotDirReady = false
    this.screenshotSeq = 0
    this.downloadDir = path.join(home || '.', 'cache', 'dsh-chrome', 'headless', 'downloads')
    this.bySession = new Map()
    this.consoleBuffers = new Map()
    this.screencastDir = path.join(home || '.', 'cache', 'dsh-chrome', 'screencast')
    this.downloads = []
    this.downloadByGuid = new Map()
    this.idleTimer = null
    this.lastActivity = Date.now()
    this.loginProcess = null
    this.loginProfile = path.join(home || '.', 'cache', 'dsh-chrome', 'headless', 'profile')
    this.captures = new Map()
    this.captureByTab = new Map()
    this.nextCaptureSeq = 1
  }

  get connected() {
    return Boolean(this.cdp)
  }

  async ensureStarted() {
    if (this.loginProcess) {
      throw error('HEADLESS_LOGIN_OPEN', 'an interactive login window is open; finish it before using the headless backend')
    }
    if (this.cdp) return this
    if (this.startPromise) return this.startPromise
    this.startPromise = (async () => {
      const executable = chromeExecutable()
      if (!executable) {
        throw error('UNSUPPORTED_BACKEND', 'no Chrome/Chromium executable found for the headless backend (set DSH_HEADLESS_CHROME)')
      }
      const profileDir = path.join(this.home || '.', 'cache', 'dsh-chrome', 'headless', 'profile')
      await fsp.mkdir(profileDir, { recursive: true })
      const activePortPath = path.join(profileDir, 'DevToolsActivePort')

      // Reuse a headless Chrome left over from a previous provider instance
      // (e.g. provider reload) instead of racing a second process on the same
      // profile. A stale DevToolsActivePort is removed before a fresh launch.
      try {
        const existing = fs.readFileSync(activePortPath, 'utf8').trim().split('\n')
        if (existing.length >= 2) {
          const existingCdp = new Cdp(`ws://127.0.0.1:${existing[0]}${existing[1]}`)
          const version = await existingCdp.connect().then(() => existingCdp.send('Browser.getVersion'))
          this.cdp = existingCdp
          this.chrome = null
          this.browserVersion = version?.product || null
          existingCdp.onMessage((message) => this.onCdpEvent(message))
          await existingCdp
            .send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: this.downloadDir, eventsEnabled: true })
            .catch(() => {})
          this.startIdleTimer()
          this.logger?.info?.('headless Chrome reused: %s', this.browserVersion || 'unknown')
          return this
        }
      } catch {
        try {
          fs.unlinkSync(activePortPath)
        } catch {
          // stale file already gone
        }
      }
      const child = spawn(
        executable,
        [
          '--headless=new',
          '--remote-debugging-port=0',
          `--user-data-dir=${profileDir}`,
          '--no-first-run',
          '--no-default-browser-check',
          '--disable-background-networking',
          '--disable-component-update',
          '--disable-sync',
          '--disable-extensions',
          '--mute-audio',
          '--window-size=1440,900',
          'about:blank',
        ],
        { stdio: ['ignore', 'ignore', 'pipe'] },
      )
      child.stderr?.on('data', (chunk) => this.logger?.debug?.('headless chrome: %s', String(chunk).trim().slice(0, 300)))
      this.chrome = child
      const deadline = Date.now() + 15000
      let lines = null
      while (Date.now() < deadline) {
        try {
          lines = fs.readFileSync(activePortPath, 'utf8').trim().split('\n')
          if (lines.length >= 2) break
        } catch {
          // not ready
        }
        await new Promise((resolve) => setTimeout(resolve, 150))
      }
      if (!lines || lines.length < 2) throw error('HEADLESS_LAUNCH_FAILED', 'headless Chrome did not expose DevToolsActivePort')
      const cdp = new Cdp(`ws://127.0.0.1:${lines[0]}${lines[1]}`)
      cdp.onMessage((message) => this.onCdpEvent(message))
      await cdp.connect()
      this.cdp = cdp
      const version = await cdp.send('Browser.getVersion').catch(() => null)
      this.browserVersion = version?.product || null
      this.chrome.on('exit', (code) => {
        this.logger?.warn?.('headless Chrome exited: %s', code)
        this.cdp = null
        this.chrome = null
      })
      await fsp.mkdir(this.downloadDir, { recursive: true })
      await cdp
        .send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: this.downloadDir, eventsEnabled: true })
        .catch((error) => this.logger?.warn?.('headless download behavior failed: %s', error?.message || String(error)))
      this.startIdleTimer()
      this.logger?.info?.('headless Chrome started: %s', this.browserVersion || 'unknown')
      return this
    })()
    try {
      return await this.startPromise
    } finally {
      this.startPromise = null
    }
  }

  startIdleTimer() {
    if (this.idleTimer) return
    this.idleTimer = setInterval(() => {
      if (!this.cdp) return
      if (this.tabs.size > 0) {
        this.lastActivity = Date.now()
        return
      }
      if (Date.now() - this.lastActivity < DEFAULT_IDLE_MINUTES * 60 * 1000) return
      this.logger?.info?.('headless Chrome idle for %s min; closing', DEFAULT_IDLE_MINUTES)
      this.close().catch(() => {})
    }, 30 * 1000)
    this.idleTimer.unref?.()
  }

  noteActivity() {
    this.lastActivity = Date.now()
  }

  onNetworkEvent(tab, method, params) {
    if (!tab) return
    const capture = this.captureByTab.get(tab.tabId)
    if (!capture || !capture.active) return
    const requestId = params.requestId
    if (method === 'Network.requestWillBeSent') {
      const resourceType = String(params.type || 'other').toLowerCase()
      if (!capture.resourceTypes.includes(resourceType)) return
      if (capture.entries.length >= capture.maxEntries) {
        // Keep the newest requests: drop the oldest entry, like the extension.
        const removed = capture.entries.shift()
        if (removed) capture.byId.delete(String(removed.id))
        capture.dropped += 1
      }
      const wallTime = Number(params.wallTime)
      const entry = {
        id: String(requestId),
        method: String(params.request?.method || 'GET'),
        url: redactUrl(params.request?.url),
        resourceType,
        timestamp: Number.isFinite(wallTime) ? Math.round(wallTime * 1000) : Date.now(),
        startTime: Date.now(),
        wallTime: Number.isFinite(wallTime) ? wallTime : null,
        startMono: params.timestamp ?? null,
        documentURL: params.documentURL ? redactUrl(params.documentURL) : null,
        hasPostData: Boolean(params.request?.hasPostData || params.request?.postData),
      }
      capture.byId.set(String(requestId), entry)
      capture.entries.push(entry)
      if (params.request?.postData) entry._postDataRaw = String(params.request.postData)
      return
    }
    const entry = capture.byId.get(String(requestId))
    if (!entry) return
    if (method === 'Network.responseReceived') {
      const response = params.response || {}
      entry.status = response.status
      entry.statusText = String(response.statusText || '')
      entry.mimeType = String(response.mimeType || '')
      entry.fromServiceWorker = Boolean(response.fromServiceWorker)
      if (Number.isFinite(response.encodedDataLength)) entry.encodedDataLength = response.encodedDataLength
      if (response.fromDiskCache || response.fromMemoryCache || response.fromPrefetchCache) entry.fromCache = true
      entry.responseAt = Date.now()
      return
    }
    if (method === 'Network.requestServedFromCache') {
      entry.fromCache = true
      return
    }
    if (method === 'Network.loadingFailed') {
      entry.failed = true
      entry.canceled = Boolean(params.canceled)
      entry.errorText = String(params.errorText || '')
      entry.durationMs = entry.startMono != null ? Math.round((params.timestamp - entry.startMono) * 1000) : null
      return
    }
    if (method === 'Network.loadingFinished') {
      entry.durationMs = entry.startMono != null ? Math.round((params.timestamp - entry.startMono) * 1000) : null
      entry.finishedAt = Date.now()
      if (Number.isFinite(params.encodedDataLength)) entry.encodedDataLength = params.encodedDataLength
      if (!capture.storeBodies) return
      if (!['xhr', 'fetch', 'document'].includes(entry.resourceType)) return
      if (capture.bodyTasks >= 4) {
        entry.bodyUnavailable = 'burst'
        return
      }
      capture.bodyTasks += 1
      const bodyTask = (async () => {
        try {
          const response = await this.cdp.send('Network.getResponseBody', { requestId: String(requestId) }, tab.sessionId)
          const raw = response?.base64Encoded
            ? Buffer.from(response.body || '', 'base64').toString('utf8')
            : String(response?.body ?? '')
          const materialized = materializeCaptureBody(capture, raw, entry.mimeType, CAPTURE_RESPONSE_BODY_CHARS)
          if (materialized) {
            entry.responseBody = materialized.text
            entry.bodyTruncated = materialized.truncated
            entry.redacted = true
          }
        } catch {
          entry.bodyUnavailable = 'evicted'
        }
        if (entry._postDataRaw == null && entry.hasPostData) {
          try {
            const request = await this.cdp.send('Network.getRequestPostData', { requestId: String(requestId) }, tab.sessionId)
            if (request?.postData) entry._postDataRaw = String(request.postData)
          } catch {
            // request body unavailable
          }
        }
        if (entry._postDataRaw != null) {
          const requestMime = /^{|^\[/.test(String(entry._postDataRaw).trim())
            ? 'application/json'
            : 'application/x-www-form-urlencoded'
          const materialized = materializeCaptureBody(capture, entry._postDataRaw, requestMime, CAPTURE_REQUEST_BODY_CHARS)
          if (materialized) {
            entry.requestBody = materialized.text
            entry.redacted = true
          }
          delete entry._postDataRaw
        }
        capture.bodyTasks -= 1
      })()
      capture.bodyTasksSet = capture.bodyTasksSet || new Set()
      capture.bodyTasksSet.add(bodyTask)
      bodyTask.finally(() => capture.bodyTasksSet.delete(bodyTask))
    }
  }

  recordConsole(tab, entry) {
    if (!tab) return
    const list = this.consoleBuffers.get(tab.tabId) || []
    list.push({ ...entry, time: Date.now() })
    while (list.length > 200) list.shift()
    this.consoleBuffers.set(tab.tabId, list)
  }

  onCdpEvent(message) {
    const sessionTab = message.sessionId ? this.bySession.get(message.sessionId) : null
    if (message.method === 'Runtime.consoleAPICalled') {
      const params = message.params || {}
      const text = (params.args || [])
        .map((arg) => (arg.value != null ? String(arg.value) : arg.description || arg.type || 'undefined'))
        .join(' ')
      this.recordConsole(sessionTab, { level: String(params.type || 'log'), text: text.slice(0, 2000) })
      return
    }
    if (message.method === 'Runtime.exceptionThrown') {
      const details = message.params?.exceptionDetails || {}
      const text = details.exception?.description || details.text || 'uncaught exception'
      this.recordConsole(sessionTab, { level: 'error', text: String(text).slice(0, 2000) })
      return
    }
    if (message.method === 'Page.screencastFrame') {
      const tab = sessionTab
      if (!tab) return
      // Ack immediately in both modes: an unacked frame pauses the stream.
      this.cdp
        .send('Page.screencastFrameAck', { sessionId: message.params?.sessionId }, tab.sessionId)
        .catch(() => {})
      const params = message.params || {}
      const state = tab.screencast
      if (state) {
        state.frames += 1
        state.lastAt = Date.now()
        try {
          const data = Buffer.from(String(params.data || ''), 'base64')
          fs.mkdirSync(this.screencastDir, { recursive: true })
          const file = path.join(this.screencastDir, `latest.${state.format === 'png' ? 'png' : 'jpg'}`)
          const tmp = `${file}.${process.pid}.tmp`
          fs.writeFileSync(tmp, data, { mode: 0o600 })
          fs.renameSync(tmp, file)
          fs.writeFileSync(
            path.join(this.screencastDir, 'meta.json'),
            `${JSON.stringify({
              updatedAt: Date.now(),
              format: state.format === 'png' ? 'png' : 'jpg',
              bytes: data.byteLength,
              frames: state.frames,
              metadata: params.metadata || null,
              backend: 'headless',
            })}\n`,
            { mode: 0o600 },
          )
        } catch {
          // best effort
        }
        return
      }
      // Screenshot frame cache: keep only the newest composited frame. Its
      // `metadata.timestamp` is a Unix-epoch timestamp (same clock as Date.now),
      // which is what lets `tab.screenshot` prove the frame is not older than
      // the last page-changing request.
      const shot = tab.shotStream
      if (shot?.active) {
        const composedAt = Number(params.metadata?.timestamp)
        const data = String(params.data || '')
        if (Number.isFinite(composedAt) && data) {
          shot.frames += 1
          shot.last = {
            buffer: Buffer.from(data, 'base64'),
            composedAt,
            width: Number(params.metadata?.deviceWidth) || 0,
            height: Number(params.metadata?.deviceHeight) || 0,
          }
          this.resolveShotWaiters(shot)
        }
      }
      return
    }
    if (String(message.method || '').startsWith('Network.')) {
      this.onNetworkEvent(sessionTab, message.method, message.params || {})
      return
    }
    if (message.method === 'Browser.downloadWillBegin') {
      const params = message.params || {}
      const record = {
        guid: params.guid,
        filename: params.suggestedFilename,
        url: params.url,
        state: 'inProgress',
        bytesReceived: 0,
        totalBytes: 0,
        startTime: new Date().toISOString(),
      }
      this.downloads.unshift(record)
      this.downloadByGuid.set(params.guid, record)
      while (this.downloads.length > 100) this.downloads.pop()
      return
    }
    if (message.method === 'Browser.downloadProgress') {
      const params = message.params || {}
      const record = this.downloadByGuid.get(params.guid)
      if (record) {
        record.state = params.state === 'completed' ? 'complete' : params.state === 'canceled' ? 'cancelled' : 'inProgress'
        record.bytesReceived = params.receivedBytes ?? record.bytesReceived
        record.totalBytes = params.totalBytes ?? record.totalBytes
      }
    }
  }

  ownerEntry(owner) {
    const key = String(owner || 'default')
    let entry = this.owners.get(key)
    if (!entry) {
      entry = { tabs: new Map(), activeTabId: null }
      this.owners.set(key, entry)
    }
    return entry
  }

  async attachTab(entry, url) {
    const created = await this.cdp.send('Target.createTarget', { url: url || 'about:blank' })
    const targetId = created.targetId
    const attached = await this.cdp.send('Target.attachToTarget', { targetId, flatten: true })
    const sessionId = attached.sessionId
    const tabId = this.nextTabId++
    if (this.tabs.size >= MAX_TABS) {
      throw error('RESOURCE_LIMIT', `headless tab limit reached (${MAX_TABS}); close a tab first`)
    }
    const tab = { tabId, targetId, sessionId, url: url || 'about:blank', title: '', renderChangeAt: 0, shotStream: null }
    this.bySession.set(sessionId, tab)
    this.consoleBuffers.set(tabId, [])
    this.tabs.set(tabId, tab)
    entry.tabs.set(tabId, tab)
    entry.activeTabId = tabId
    await this.cdp.send('Page.enable', {}, sessionId).catch(() => {})
    await this.cdp.send('Runtime.enable', {}, sessionId).catch(() => {})
    return tab
  }

  async ensureTab(owner, tabId) {
    const entry = this.ownerEntry(owner)
    if (Number.isFinite(tabId)) {
      const tab = entry.tabs.get(tabId)
      if (!tab) throw error('TAB_NOT_FOUND', `tab ${tabId} is not owned by this session`)
      entry.activeTabId = tabId
      return tab
    }
    if (entry.activeTabId != null) return entry.tabs.get(entry.activeTabId)
    return this.attachTab(entry, 'about:blank')
  }

  async evalOn(tab, expression, { awaitPromise = false } = {}) {
    const result = await this.cdp.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise,
    }, tab.sessionId)
    if (result.exceptionDetails) {
      const message = result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'page evaluation failed'
      throw error('INTERNAL', String(message))
    }
    return result.result?.value
  }

  async syncTabMeta(tab) {
    try {
      const meta = await this.evalOn(tab, '({ title: document.title, url: location.href })')
      if (meta) {
        tab.title = meta.title || ''
        tab.url = meta.url || tab.url
      }
    } catch {
      // tab may be navigating / closed
    }
    return tab
  }

  async ensureScreenshotDir() {
    if (this.screenshotDirReady) return
    await fsp.mkdir(this.screenshotDir, { recursive: true })
    this.screenshotDirReady = true
  }

  async writeCaptureFile(file, data) {
    await this.ensureScreenshotDir()
    try {
      await fsp.writeFile(file, data, { mode: 0o600 })
    } catch {
      // the cache directory may have been removed underneath us; recreate once
      await fsp.mkdir(this.screenshotDir, { recursive: true })
      await fsp.writeFile(file, data, { mode: 0o600 })
    }
  }

  // The headless window is fixed for the process lifetime, so innerWidth /
  // innerHeight only change through tab.emulate: cache them per tab instead of
  // paying a Runtime.evaluate on every screenshot.
  async viewportSize(tab) {
    if (!tab.viewport) {
      const meta = await this.evalOn(tab, '({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio })')
      tab.viewport = { w: meta?.w || 0, h: meta?.h || 0, dpr: meta?.dpr || 1 }
    }
    return tab.viewport
  }

  // Only the active headless target composites; background tabs report
  // visibilityState "hidden" and would never emit screencast frames.
  async pageVisible(tab) {
    try {
      return (await this.evalOn(tab, `document.visibilityState === 'visible'`)) === true
    } catch {
      return false
    }
  }

  // ---------------------------------------------------- screenshot frame stream
  tabForParams(params = {}) {
    const tabId = Number(params.tabId)
    if (Number.isFinite(tabId)) return this.tabs.get(tabId) || null
    if (params.owner == null) return null
    const entry = this.owners.get(String(params.owner || 'default'))
    if (entry?.activeTabId == null) return null
    return entry.tabs.get(entry.activeTabId) || null
  }

  shotStreamState(tab) {
    if (!tab.shotStream) {
      tab.shotStream = {
        active: false,
        frames: 0,
        served: 0,
        fallbacks: 0,
        timeouts: 0,
        repaintMisses: 0,
        failures: 0,
        disabledUntil: 0,
        maxWidth: 0,
        maxHeight: 0,
        startedAt: 0,
        last: null,
        waiters: [],
        stopTimer: null,
      }
    }
    return tab.shotStream
  }

  async ensureShotStream(tab) {
    // The live viewer owns Page.startScreencast while it runs; screenshots fall
    // back to Page.captureScreenshot rather than fighting over the stream.
    if (tab.screencast?.active) return null
    const state = this.shotStreamState(tab)
    const now = Date.now()
    if (state.disabledUntil > now) return null
    const viewport = await this.viewportSize(tab)
    const dpr = viewport.dpr || 1
    const maxWidth = Math.max(1, Math.round((viewport.w || 0) * dpr))
    const maxHeight = Math.max(1, Math.round((viewport.h || 0) * dpr))
    if (state.active) {
      if (state.maxWidth === maxWidth && state.maxHeight === maxHeight) return state
      await this.stopShotStream(tab)
    }
    // A hidden target (any non-active headless tab) is not composited, so its
    // screencast would never produce a frame. Keep the capture path there.
    if (!(await this.pageVisible(tab))) return null
    try {
      await this.cdp.send(
        'Page.startScreencast',
        { format: 'png', maxWidth, maxHeight, everyNthFrame: 1 },
        tab.sessionId,
      )
    } catch {
      state.failures += 1
      if (state.failures >= SHOT_STREAM_FAILURES_BEFORE_BACKOFF) state.disabledUntil = now + SHOT_STREAM_BACKOFF_MS
      return null
    }
    state.active = true
    state.frames = 0
    state.last = null
    state.maxWidth = maxWidth
    state.maxHeight = maxHeight
    state.startedAt = now
    state.failures = 0
    // Even if the first screenshot falls back (no frame in time), the stream
    // must not stay on forever.
    this.touchShotStream(tab, state)
    return state
  }

  async stopShotStream(tab, { keepLast = false } = {}) {
    const state = tab?.shotStream
    if (!state) return
    this.dropShotStream(tab, { keepLast })
    if (!state.active) return
    state.active = false
    try {
      await this.cdp?.send('Page.stopScreencast', {}, tab.sessionId)
    } catch {
      // tab already gone
    }
  }

  // Drop local stream state without talking to CDP (tab closing / browser
  // shutdown), resolving any in-flight screenshot waiters with null.
  dropShotStream(tab, { keepLast = false } = {}) {
    const state = tab?.shotStream
    if (!state) return
    if (state.stopTimer) {
      clearTimeout(state.stopTimer)
      state.stopTimer = null
    }
    for (const waiter of state.waiters.splice(0)) {
      clearTimeout(waiter.timer)
      waiter.resolve(null)
    }
    if (!keepLast) state.last = null
  }

  touchShotStream(tab, state) {
    if (state.stopTimer) clearTimeout(state.stopTimer)
    state.stopTimer = setTimeout(() => {
      state.stopTimer = null
      this.stopShotStream(tab).catch(() => {})
    }, SHOT_STREAM_IDLE_MS)
    state.stopTimer.unref?.()
  }

  resolveShotWaiters(state) {
    if (state.waiters.length === 0 || !state.last) return
    const frame = state.last
    const pending = []
    for (const waiter of state.waiters) {
      if (frame.composedAt >= waiter.changeAt) {
        clearTimeout(waiter.timer)
        waiter.resolve(frame)
      } else {
        pending.push(waiter)
      }
    }
    state.waiters = pending
  }

  waitShotFrame(state, changeAt, timeoutMs) {
    if (state.last && state.last.composedAt >= changeAt) return Promise.resolve(state.last)
    return new Promise((resolve) => {
      const waiter = { changeAt, timer: null, resolve: null }
      waiter.timer = setTimeout(() => {
        state.waiters = state.waiters.filter((item) => item !== waiter)
        resolve(null)
      }, timeoutMs)
      waiter.resolve = (frame) => resolve(frame)
      state.waiters.push(waiter)
    })
  }

  // Returns a PNG buffer for the current viewport, or null when no frame is
  // available at all (caller falls back to Page.captureScreenshot).
  //
  // Freshness rule: a cached frame is only reused when its composition
  // timestamp is at or after the last page-changing request. Otherwise wait for
  // the compositor's next frame. If that frame does not arrive within
  // SHOT_STREAM_FRAME_TIMEOUT_MS the change was not painted (yet), so the
  // latest painted frame is returned — that is still what the page looks like,
  // and a capture would force a repaint just to show the same pixels. The wait
  // is longer for the very first frame of a new stream (Chrome has to start the
  // capture pipeline), where there is no cached frame to fall back on.
  async screenshotFromStream(tab) {
    const state = await this.ensureShotStream(tab)
    if (!state) return null
    const changeAt = tab.renderChangeAt || 0
    let frame = state.last && state.last.composedAt >= changeAt ? state.last : null
    if (frame && Date.now() / 1000 - frame.composedAt > 1) {
      // A stale-but-fresh-enough frame from a tab that was backgrounded since
      // may hide page-internal changes (hidden tabs are not composited).
      if (!(await this.pageVisible(tab))) return null
    }
    if (!frame) {
      const hasCached = Boolean(state.last)
      frame = await this.waitShotFrame(
        state,
        changeAt,
        hasCached ? SHOT_STREAM_FRAME_TIMEOUT_MS : SHOT_STREAM_FIRST_FRAME_TIMEOUT_MS,
      )
      if (!frame && hasCached) {
        // No new frame within the repaint window. On a visible page that means
        // the change produced no painted output (e.g. a read-only evaluate), so
        // the latest painted frame is the honest screenshot. On a hidden tab
        // nothing is being composited at all — fall back to capture.
        if (!(await this.pageVisible(tab))) return null
        state.repaintMisses += 1
        frame = state.last
      }
    }
    if (!frame) {
      state.timeouts += 1
      state.fallbacks += 1
      if (state.timeouts >= SHOT_STREAM_FAILURES_BEFORE_BACKOFF) {
        await this.stopShotStream(tab)
        state.disabledUntil = Date.now() + SHOT_STREAM_BACKOFF_MS
      }
      return null
    }
    state.timeouts = 0
    state.served += 1
    this.touchShotStream(tab, state)
    return frame.buffer
  }

  async pageAction(tab, name, args, timeoutMs = 15000) {
    return this.evalOn(tab, pageCall(name, args))
  }

  async waitReady(tab, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      try {
        const state = await this.evalOn(tab, 'document.readyState')
        if (state === 'complete') return true
      } catch {
        // still navigating
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    return false
  }

  findCapture(owner, captureId) {
    if (captureId) {
      const capture = this.captures.get(String(captureId))
      if (!capture) throw error('CAPTURE_LOST', `capture ${captureId} is gone (was the extension worker restarted?)`)
      if (capture.owner !== owner) throw error('CAPTURE_NOT_FOUND', `no capture ${captureId} for this session`)
      return capture
    }
    let latest = null
    for (const capture of this.captures.values()) {
      if (capture.owner !== owner) continue
      if (!latest || capture.startedAt > latest.startedAt) latest = capture
    }
    if (!latest) throw error('NO_ACTIVE_CAPTURE', 'no capture for this session; call chrome_capture_start first')
    return latest
  }

  async request(method, params = {}) {
    const result = await this.dispatch(method, params)
    if (SHOT_STREAM_METHODS.has(method)) {
      const tab = this.tabForParams(params)
      if (tab) tab.renderChangeAt = Date.now() / 1000
    }
    return result
  }

  async dispatch(method, params = {}) {
    await this.ensureStarted()
    this.noteActivity()
    const owner = params.owner
    if (!SUPPORTED.has(method)) {
      throw error('UNSUPPORTED_BACKEND', `${method} is not implemented by the headless backend yet`)
    }
    switch (method) {
      case 'browser.status':
        return {
          connected: true,
          backend: 'headless',
          extensionVersion: null,
          hostVersion: null,
          protocol: 1,
          browserVersion: this.browserVersion,
          diskVersion: null,
          autoReload: false,
          groupCount: 0,
          groups: [],
        }
      case 'browser.site': {
        const tab = await this.ensureTab(owner)
        await this.syncTabMeta(tab)
        return { origin: new URL(tab.url).origin, url: tab.url, title: tab.title, tabId: tab.tabId }
      }
      case 'tab.tabs':
        return this.tabsRequest(owner, params)
      case 'tab.goto': {
        const tab = await this.ensureTab(owner, params.tabId)
        await this.cdp.send('Page.navigate', { url: params.url }, tab.sessionId)
        await this.waitReady(tab)
        await this.syncTabMeta(tab)
        return { tabId: tab.tabId, url: tab.url, title: tab.title, loadState: 'complete' }
      }
      case 'tab.get_text': {
        const tab = await this.ensureTab(owner, params.tabId)
        const selector = params.selector
          ? String(params.selector)
          : 'main, article, [role="main"], body'
        const raw = await this.evalOn(
          tab,
          `(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el ? (el.innerText || el.textContent || '') : null; })()`,
        )
        if (raw == null) return { found: false, text: '', truncated: false, frames: 1 }
        const maxChars = Math.min(Number(params.maxChars) || 20000, 200000)
        return { found: true, text: String(raw).slice(0, maxChars), truncated: String(raw).length > maxChars, frames: 1 }
      }
      case 'tab.find': {
        const tab = await this.ensureTab(owner, params.tabId)
        return this.pageAction(tab, 'findPage', [String(params.query || ''), Boolean(params.regex), params.maxResults])
      }
      case 'tab.select': {
        const tab = await this.ensureTab(owner, params.tabId)
        const result = await this.pageAction(tab, 'selectPage', [params.ref ?? null, params.selector ?? null, params.value ?? null, params.checked])
        if (!result?.ok) throw error(result?.code || 'REF_NOT_FOUND', result?.message || 'select failed')
        return { ok: true, tag: result.tag, value: result.value }
      }
      case 'tab.drag': {
        const tab = await this.ensureTab(owner, params.tabId)
        const result = await this.pageAction(tab, 'dragPage', [params.fromRef, params.toRef])
        if (!result?.ok) throw error(result?.code || 'REF_NOT_FOUND', result?.message || 'drag failed')
        return result
      }
      case 'tab.storage': {
        const tab = await this.ensureTab(owner, params.tabId)
        const scope = params.scope === 'session' ? 'sessionStorage' : 'localStorage'
        const op = String(params.op || 'get')
        const raw = await this.evalOn(tab, `(() => {
          const store = ${scope};
          const op = ${JSON.stringify(op)};
          const key = ${JSON.stringify(params.key ?? null)};
          const keys = ${JSON.stringify(Array.isArray(params.keys) ? params.keys : null)};
          const value = ${JSON.stringify(params.value ?? null)};
          const encode = (v) => { try { return JSON.stringify(v) } catch { return String(v) } };
          const decode = (v) => { try { return JSON.parse(v) } catch { return v } };
          if (op === 'set') { store.setItem(key == null ? 'null' : String(key), encode(value)); return { ok: true, set: 1 } }
          const want = keys && keys.length ? keys : key != null ? [String(key)] : Object.keys(store);
          const items = {};
          for (const name of want) { const item = store.getItem(name); if (item != null) items[name] = decode(item) }
          if (op === 'remove') { for (const name of want) store.removeItem(name); return { ok: true, removed: want.length } }
          if (op === 'clear') { store.clear(); return { ok: true, cleared: true } }
          return { ok: true, items }
        })()`)
        return { ...raw, scope }
      }
      case 'tab.emulate': {
        const tab = await this.ensureTab(owner, params.tabId)
        if (params.reset) {
          await this.cdp.send('Emulation.clearDeviceMetricsOverride', {}, tab.sessionId)
          tab.viewport = null
          // A running screenshot stream was sized for the old viewport.
          await this.stopShotStream(tab)
          return { applied: false, reloaded: false, viewport: { width: 0, height: 0, mobile: false } }
        }
        const width = Math.max(100, Number(params.width) || 1280)
        const height = Math.max(100, Number(params.height) || 800)
        const mobile = Boolean(params.mobile)
        await this.cdp.send(
          'Emulation.setDeviceMetricsOverride',
          { width, height, deviceScaleFactor: 1, mobile },
          tab.sessionId,
        )
        tab.viewport = mobile ? null : { w: width, h: height, dpr: 1 }
        await this.stopShotStream(tab)
        return { applied: true, reloaded: false, viewport: { width, height, mobile } }
      }
      case 'tab.snapshot': {
        const tab = await this.ensureTab(owner, params.tabId)
        // snapshotPage already reports title/url, so no extra syncTabMeta round trip.
        const value = await this.pageAction(tab, 'snapshotPage', [params.maxChars || 100000, Boolean(params.boxes)])
        if (value) {
          tab.title = value.title || ''
          if (value.url) tab.url = value.url
        }
        return { ...value, mode: 'full' }
      }
      case 'tab.click': {
        const tab = await this.ensureTab(owner, params.tabId)
        const result = await this.pageAction(tab, 'clickPage', [params.ref ?? null, params.selector ?? null, params.clickCount || 1, params.button === 'right' ? 2 : params.button === 'middle' ? 1 : 0])
        if (!result?.ok) throw error(result?.code || 'REF_NOT_FOUND', result?.message || 'click failed')
        if (result.url) tab.url = result.url
        if (result.title != null) tab.title = result.title
        return { ok: true, tag: result.tag, label: result.label, tabId: tab.tabId }
      }
      case 'tab.type': {
        const tab = await this.ensureTab(owner, params.tabId)
        const result = await this.pageAction(tab, 'typePage', [params.ref ?? null, params.selector ?? null, String(params.text ?? ''), Boolean(params.replace), Boolean(params.submit)])
        if (!result?.ok) throw error(result?.code || 'REF_NOT_FOUND', result?.message || 'type failed')
        return { ok: true, value: result.value, submitted: result.submitted, tabId: tab.tabId }
      }
      case 'tab.clickAt': {
        const tab = await this.ensureTab(owner, params.tabId)
        const x = Number(params.x)
        const y = Number(params.y)
        await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, tab.sessionId)
        await this.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: params.clickCount || 1 }, tab.sessionId)
        await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: params.clickCount || 1 }, tab.sessionId)
        return { ok: true, tabId: tab.tabId, x, y }
      }
      case 'tab.hover': {
        const tab = await this.ensureTab(owner, params.tabId)
        const result = await this.pageAction(tab, 'clickPage', [params.ref ?? null, params.selector ?? null, 1, 0])
        return result?.ok ? { ok: true, tag: result.tag, label: result.label, tabId: tab.tabId } : { ok: false, message: result?.message }
      }
      case 'tab.scroll': {
        const tab = await this.ensureTab(owner, params.tabId)
        const amount = Number(params.amount || 600)
        const direction = String(params.direction || 'down')
        // Scroll and read the resulting position in a single evaluate.
        const expression =
          direction === 'top' || direction === 'bottom'
            ? `(window.scrollTo(0, ${direction === 'top' ? 0 : 'document.body.scrollHeight'}), { x: window.scrollX, y: window.scrollY })`
            : `(window.scrollBy(0, ${direction === 'up' ? -amount : amount}), { x: window.scrollX, y: window.scrollY })`
        const pos = await this.evalOn(tab, expression)
        return { ok: true, tabId: tab.tabId, x: pos?.x ?? 0, y: pos?.y ?? 0 }
      }
      case 'tab.press': {
        const tab = await this.ensureTab(owner, params.tabId)
        const key = String(params.key || '')
        const keyCode = key === 'Enter' ? 13 : key === 'Tab' ? 9 : key === 'Escape' ? 27 : 0
        await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode: keyCode }, tab.sessionId)
        await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: keyCode }, tab.sessionId)
        return { ok: true, tabId: tab.tabId, key }
      }
      case 'tab.history': {
        const tab = await this.ensureTab(owner, params.tabId)
        if (params.op === 'back') await this.evalOn(tab, 'history.back()')
        else if (params.op === 'forward') await this.evalOn(tab, 'history.forward()')
        else await this.cdp.send('Page.reload', {}, tab.sessionId)
        await this.waitReady(tab)
        await this.syncTabMeta(tab)
        return { tabId: tab.tabId, url: tab.url, title: tab.title }
      }
      case 'tab.frames': {
        const tab = await this.ensureTab(owner, params.tabId)
        const tree = await this.cdp.send('Page.getFrameTree', {}, tab.sessionId)
        const frames = []
        const walk = (node, depth) => {
          frames.push({ frameId: node.frame.id, parentFrameId: node.frame.parentId || null, url: node.frame.url, title: node.frame.name || '' })
          for (const child of node.childFrames || []) walk(child, depth + 1)
        }
        if (tree?.frameTree) walk(tree.frameTree, 0)
        return { tabId: tab.tabId, frames, frameCount: frames.length, mainFrameId: frames[0]?.frameId }
      }
      case 'tab.a11y': {
        const tab = await this.ensureTab(owner, params.tabId)
        const tree = await this.cdp.send('Accessibility.getFullAXTree', { max_depth: params.limit || 200 }, tab.sessionId)
        const nodes = (tree?.nodes || []).map((node) => ({ role: node.role?.value, name: node.name?.value, value: node.value?.value }))
        return { tabId: tab.tabId, nodes, total: nodes.length }
      }
      case 'tab.screenshot': {
        const tab = await this.ensureTab(owner, params.tabId)
        const format = params.format === 'jpeg' ? 'jpeg' : 'png'
        // A plain viewport PNG (the common case) is served from the compositor's
        // own frames. Anything that needs a crop, JPEG encoding, the slow-PNG
        // opt-out, or a full-page capture keeps the exact
        // Page.captureScreenshot path.
        const needsCapture =
          Boolean(params.fullPage || params.clip || params.ref != null || params.frameRef || params.highlight) ||
          format === 'jpeg' ||
          params.optimizeForSpeed === false
        let data = needsCapture ? null : await this.screenshotFromStream(tab)
        if (!data) {
          const captureParams = { format, captureBeyondViewport: Boolean(params.fullPage) }
          if (format === 'jpeg') {
            captureParams.quality = Math.max(1, Math.min(100, Number(params.quality) || 70))
          } else if (params.optimizeForSpeed !== false) {
            // Fast PNG encoder: ~20% less screenshot CPU on content-heavy pages,
            // at the cost of a larger (still lossless) PNG. Opt out per call.
            captureParams.optimizeForSpeed = true
          }
          const shot = await this.cdp.send('Page.captureScreenshot', captureParams, tab.sessionId)
          data = Buffer.from(shot.data, 'base64')
        }
        this.screenshotSeq += 1
        const extension = format === 'jpeg' ? 'jpg' : 'png'
        const file = path.join(this.screenshotDir, `headless-${Date.now()}-${this.screenshotSeq}.${extension}`)
        await this.writeCaptureFile(file, data)
        const viewport = await this.viewportSize(tab)
        return {
          path: file,
          mediaType: format === 'jpeg' ? 'image/jpeg' : 'image/png',
          width: viewport.w,
          height: viewport.h,
          bytes: data.byteLength,
        }
      }
      case 'tab.pdf': {
        const tab = await this.ensureTab(owner, params.tabId)
        const pdf = await this.cdp.send('Page.printToPDF', { printBackground: true }, tab.sessionId)
        const data = Buffer.from(pdf.data, 'base64')
        this.screenshotSeq += 1
        const file = path.join(this.screenshotDir, `headless-${Date.now()}-${this.screenshotSeq}.pdf`)
        await this.writeCaptureFile(file, data)
        return { path: file, bytes: data.byteLength }
      }
      case 'tab.evaluate': {
        const tab = await this.ensureTab(owner, params.tabId)
        const value = await this.evalOn(tab, String(params.expression || 'undefined'), { awaitPromise: true })
        return { ok: true, value }
      }
      case 'tab.wait': {
        const tab = await this.ensureTab(owner, params.tabId)
        const deadline = Date.now() + Math.min(Number(params.timeoutMs) || 30000, 120000)
        while (Date.now() < deadline) {
          const state = await this.evalOn(tab, 'document.readyState').catch(() => null)
          let done = false
          if (params.until === 'load') done = state === 'complete'
          else if (params.until === 'text') done = await this.evalOn(tab, `(() => (document.body?.innerText || '').includes(${JSON.stringify(String(params.text || ''))}))()`).catch(() => false)
          else if (params.until === 'selector') done = await this.evalOn(tab, `Boolean(document.querySelector(${JSON.stringify(String(params.selector || ''))}))`).catch(() => false)
          else if (params.until === 'url') done = await this.evalOn(tab, `location.href.includes(${JSON.stringify(String(params.url || ''))})`).catch(() => false)
          if (done) {
            await this.syncTabMeta(tab)
            return { tabId: tab.tabId, url: tab.url, title: tab.title, loadState: state || 'unknown' }
          }
          await new Promise((resolve) => setTimeout(resolve, 150))
        }
        throw error('TIMEOUT', `wait timed out after ${params.timeoutMs || 30000}ms`)
      }
      case 'tab.html': {
        const tab = await this.ensureTab(owner, params.tabId)
        const html = await this.evalOn(tab, '(' + String(params.selector ? `document.querySelector(${JSON.stringify(params.selector)})` : 'document.documentElement') + ')?.outerHTML || ""')
        return { tabId: tab.tabId, html: String(html).slice(0, params.maxChars || 20000), truncated: String(html).length > (params.maxChars || 20000) }
      }
      case 'tab.text': {
        const tab = await this.ensureTab(owner, params.tabId)
        const text = await this.evalOn(tab, `(() => { const el = ${params.selector ? `document.querySelector(${JSON.stringify(params.selector)})` : 'document.body'}; return el ? (el.innerText || el.textContent || '') : ''; })()`)
        return { tabId: tab.tabId, text: String(text).slice(0, params.maxChars || 20000), truncated: String(text).length > (params.maxChars || 20000) }
      }
      case 'tab.selection': {
        const tab = await this.ensureTab(owner, params.tabId)
        const result = await this.pageAction(tab, 'currentSelection', [params.maxChars || 4000])
        return { ...result, tabId: tab.tabId }
      }
      case 'tab.console': {
        const tab = await this.ensureTab(owner, params.tabId)
        let entries = this.consoleBuffers.get(tab.tabId) || []
        if (params.level) entries = entries.filter((entry) => entry.level === params.level)
        if (params.filter) entries = entries.filter((entry) => String(entry.text || '').includes(String(params.filter)))
        const limit = Number(params.limit) > 0 ? Math.min(Number(params.limit), 120) : 50
        const sliced = entries.slice(-limit)
        if (params.clear) this.consoleBuffers.set(tab.tabId, [])
        return { available: true, entries: sliced }
      }
      case 'tab.network': {
        const tab = await this.ensureTab(owner, params.tabId)
        const raw = await this.evalOn(
          tab,
          `performance.getEntriesByType('resource').map((entry) => ({ url: entry.name, type: entry.initiatorType, durationMs: Math.round(entry.duration), transferSize: entry.transferSize || 0, status: entry.responseStatus || null }))`,
        )
        let entries = Array.isArray(raw) ? raw : []
        if (params.filter) entries = entries.filter((entry) => String(entry.url || '').includes(String(params.filter)))
        const limit = Number(params.limit) > 0 ? Math.min(Number(params.limit), 200) : 50
        return { available: true, entries: entries.slice(0, limit) }
      }
      case 'tab.upload': {
        const tab = await this.ensureTab(owner, params.tabId)
        const selector = params.selector
          ? `document.querySelector(${JSON.stringify(String(params.selector))})`
          : `document.querySelector('[data-dsh-ref="${Number(params.ref)}"]')`
        const handle = await this.cdp.send(
          'Runtime.evaluate',
          { expression: selector, returnByValue: false },
          tab.sessionId,
        )
        const objectId = handle?.result?.objectId
        if (!objectId) throw error('REF_NOT_FOUND', `no file input for ${params.selector || `ref ${params.ref}`}`)
        const files = Array.isArray(params.files) ? params.files.map(String) : []
        if (files.length === 0) throw error('INVALID_ARGUMENT', 'files must be a non-empty array')
        await this.cdp.send('DOM.setFileInputFiles', { files, objectId }, tab.sessionId)
        return { ok: true, ref: params.ref, selector: params.selector, files: files.length }
      }
      case 'tab.resume':
        return { ok: true, tabId: this.ownerEntry(owner).activeTabId ?? null }
      case 'browser.downloads': {
        const limit = Number(params.limit) > 0 ? Math.min(Number(params.limit), 100) : 20
        return {
          items: this.downloads.slice(0, limit).map((record) => ({
            ...record,
            path: path.join(this.downloadDir, record.filename || ''),
          })),
        }
      }
      case 'tab.capture_start': {
        const tab = await this.ensureTab(owner, params.tabId)
        if (this.captureByTab.get(tab.tabId)?.active) {
          const existing = this.captureByTab.get(tab.tabId)
          return {
            captureId: existing.captureId,
            tabId: tab.tabId,
            alreadyActive: true,
            requests: existing.entries.length,
            startedAt: new Date(existing.startedAt).toISOString(),
            resourceTypes: existing.resourceTypes,
          }
        }
        const resourceTypes = Array.isArray(params.resourceTypes) && params.resourceTypes.length > 0
          ? params.resourceTypes.map(String)
          : ['xhr', 'fetch', 'document']
        const maxEntries = Number.isFinite(params.maxEntries)
          ? Math.max(1, Math.min(CAPTURE_HARD_MAX_ENTRIES, params.maxEntries))
          : CAPTURE_DEFAULT_MAX_ENTRIES
        const capture = {
          captureId: `hl-${this.nextCaptureSeq++}`,
          owner,
          tabId: tab.tabId,
          active: true,
          startedAt: Date.now(),
          endedReason: null,
          entries: [],
          byId: new Map(),
          dropped: 0,
          maxEntries,
          storeBodies: params.storeBodies !== false,
          bodyBytes: 0,
          bodiesDropped: 0,
          bodyTasks: 0,
          resourceTypes,
        }
        capture.timer = setTimeout(() => {
          try {
            this.cdp?.send('Network.disable', {}, tab.sessionId)
          } catch {
            // ignore
          }
          if (capture.active) {
            capture.active = false
            capture.endedReason = 'max-duration'
          }
        }, CAPTURE_MAX_DURATION_MS)
        capture.timer.unref?.()
        this.captures.set(capture.captureId, capture)
        this.captureByTab.set(tab.tabId, capture)
        await this.cdp.send('Network.enable', {}, tab.sessionId)
        return {
          captureId: capture.captureId,
          active: true,
          tabId: tab.tabId,
          startedAt: new Date(capture.startedAt).toISOString(),
          resourceTypes,
          maxEntries,
          storeBodies: capture.storeBodies,
        }
      }
      case 'tab.capture_stop': {
        const capture = this.findCapture(owner, params.captureId)
        if (capture.active) {
          capture.active = false
          capture.endedReason = capture.endedReason || 'stopped'
          clearTimeout(capture.timer)
          try {
            await this.cdp.send('Network.disable', {}, this.tabs.get(capture.tabId)?.sessionId)
          } catch {
            // tab gone
          }
        }
        return {
          captureId: capture.captureId,
          active: false,
          tabId: capture.tabId,
          requests: capture.entries.length,
          dropped: capture.dropped,
          bodiesDropped: capture.bodiesDropped,
          startedAt: new Date(capture.startedAt).toISOString(),
          endedAt: new Date().toISOString(),
          endedReason: capture.endedReason,
          durationMs: Date.now() - capture.startedAt,
        }
      }
      case 'tab.capture_requests': {
        const capture = this.findCapture(owner, params.captureId)
        const limit = Number(params.limit) > 0 ? Math.min(Number(params.limit), 200) : 50
        let entries = capture.entries
        if (params.filter) {
          const needle = String(params.filter).toLowerCase()
          entries = entries.filter((entry) => `${entry.method} ${entry.url}`.toLowerCase().includes(needle))
        }
        if (Array.isArray(params.resourceTypes) && params.resourceTypes.length > 0) {
          const allowed = new Set(params.resourceTypes.map((type) => String(type).toLowerCase()))
          entries = entries.filter((entry) => allowed.has(entry.resourceType))
        }
        const includeBodies = params.includeBodies !== false
        const maxBodyChars = Number(params.maxBodyChars) > 0 ? Math.min(Number(params.maxBodyChars), 65536) : 4096
        const filtered = entries
        const selected = filtered.slice(-limit)
        const truncateBody = (text) => {
          const value = String(text || '')
          if (value.length <= maxBodyChars) return { text: value, truncated: false }
          return { text: `${value.slice(0, maxBodyChars)}… <truncated>`, truncated: true }
        }
        const rendered = selected.map((entry) => {
          const copy = { ...entry }
          delete copy._postDataRaw
          if (!includeBodies) {
            delete copy.requestBody
            delete copy.responseBody
          } else {
            if (copy.requestBody) {
              const result = truncateBody(copy.requestBody)
              copy.requestBody = result.text
              if (result.truncated) copy.bodyTruncated = true
            }
            if (copy.responseBody) {
              const result = truncateBody(copy.responseBody)
              copy.responseBody = result.text
              if (result.truncated) copy.bodyTruncated = true
            }
          }
          return copy
        })
        return {
          available: true,
          lost: false,
          active: capture.active,
          captureId: capture.captureId,
          tabId: capture.tabId,
          entries: rendered,
          total: filtered.length,
          truncated: filtered.length > limit,
          dropped: capture.dropped,
          bodiesDropped: capture.bodiesDropped,
        }
      }
      case 'tab.screencast_start': {
        const tab = await this.ensureTab(owner, params.tabId)
        if (tab.screencast?.active) {
          return { active: true, alreadyActive: true, tabId: tab.tabId, format: tab.screencast.format }
        }
        // The viewer takes over Page.startScreencast; stop the screenshot
        // stream first (screenshots then fall back to capture while it runs).
        await this.stopShotStream(tab)
        const format = params.format === 'png' ? 'png' : 'jpeg'
        const quality = Number.isFinite(params.quality) ? Math.max(1, Math.min(100, params.quality)) : 60
        const everyNthFrame = Number.isFinite(params.everyNthFrame)
          ? Math.max(1, Math.min(10, Math.trunc(params.everyNthFrame)))
          : 2
        tab.screencast = { active: true, format, frames: 0, startedAt: Date.now(), lastAt: null }
        tab.screencast.timer = setTimeout(() => {
          this.cdp?.send('Page.stopScreencast', {}, tab.sessionId).catch(() => {})
          tab.screencast = null
        }, 10 * 60 * 1000)
        tab.screencast.timer.unref?.()
        try {
          await this.cdp.send('Page.startScreencast', { format, quality, everyNthFrame, maxWidth: 1280, maxHeight: 800 }, tab.sessionId)
        } catch (error) {
          tab.screencast = null
          throw error
        }
        return { active: true, alreadyActive: false, tabId: tab.tabId, format, everyNthFrame }
      }
      case 'tab.screencast_stop': {
        const tab = await this.ensureTab(owner, params.tabId)
        const state = tab.screencast
        if (state?.timer) clearTimeout(state.timer)
        await this.cdp.send('Page.stopScreencast', {}, tab.sessionId).catch(() => {})
        tab.screencast = null
        return {
          active: false,
          tabId: tab.tabId,
          frames: state?.frames || 0,
          elapsedMs: state ? Date.now() - state.startedAt : 0,
        }
      }
      case 'tab.screencast_status': {
        const tab = await this.ensureTab(owner, params.tabId)
        const state = tab.screencast
        if (!state) return { active: false, tabId: tab.tabId, frames: 0 }
        return {
          active: true,
          tabId: tab.tabId,
          frames: state.frames,
          startedAt: new Date(state.startedAt).toISOString(),
          lastAt: state.lastAt ? new Date(state.lastAt).toISOString() : null,
          format: state.format,
        }
      }
      case 'tab.close_session': {
        const entry = this.ownerEntry(owner)
        let closed = 0
        for (const tab of [...entry.tabs.values()]) {
          this.dropShotStream(tab)
          try {
            await this.cdp.send('Target.closeTarget', { targetId: tab.targetId })
          } catch {
            // target already gone
          }
          entry.tabs.delete(tab.tabId)
          this.tabs.delete(tab.tabId)
          closed += 1
        }
        entry.activeTabId = null
        return { closed }
      }
      case 'tab.debug_diag':
        return {
          backend: 'headless',
          browserVersion: this.browserVersion,
          owners: [...this.owners.entries()].map(([key, entry]) => ({ owner: key, tabs: entry.tabs.size, activeTabId: entry.activeTabId })),
          tabs: [...this.tabs.values()].map((tab) => {
            const stream = tab.shotStream
            return {
              tabId: tab.tabId,
              screenshotStream: stream
                ? {
                    active: stream.active,
                    frames: stream.frames,
                    served: stream.served,
                    fallbacks: stream.fallbacks,
                    timeouts: stream.timeouts,
                    repaintMisses: stream.repaintMisses,
                    maxWidth: stream.maxWidth,
                    maxHeight: stream.maxHeight,
                    disabled: stream.disabledUntil > Date.now(),
                  }
                : null,
            }
          }),
        }
      default:
        throw error('UNSUPPORTED_BACKEND', `${method} is not implemented by the headless backend yet`)
    }
  }

  async tabsRequest(owner, params) {
    const entry = this.ownerEntry(owner)
    const op = String(params.op || 'list')
    if (op === 'list') {
      for (const tab of entry.tabs.values()) await this.syncTabMeta(tab)
      return {
        tabs: [...entry.tabs.values()].map((tab) => ({
          tabId: tab.tabId,
          title: tab.title,
          url: tab.url,
          active: tab.tabId === entry.activeTabId,
        })),
        groupId: null,
        activeTabId: entry.activeTabId,
      }
    }
    if (op === 'new') {
      const tab = await this.attachTab(entry, params.url || 'about:blank')
      if (params.url && params.url !== 'about:blank') await this.waitReady(tab)
      await this.syncTabMeta(tab)
      return { tabId: tab.tabId, url: tab.url, title: tab.title }
    }
    if (op === 'close') {
      const tab = entry.tabs.get(Number(params.tabId))
      if (!tab) throw error('TAB_NOT_FOUND', `tab ${params.tabId} is not owned by this session`)
      try {
        await this.cdp.send('Target.closeTarget', { targetId: tab.targetId })
      } catch {
        // already closed
      }
      entry.tabs.delete(tab.tabId)
      this.tabs.delete(tab.tabId)
      if (entry.activeTabId === tab.tabId) entry.activeTabId = [...entry.tabs.keys()][0] ?? null
      return { closed: tab.tabId, remaining: entry.tabs.size }
    }
    if (op === 'claim') {
      const tab = await this.ensureTab(owner, params.tabId)
      await this.syncTabMeta(tab)
      entry.activeTabId = tab.tabId
      return { claimed: true, tabId: tab.tabId, url: tab.url, title: tab.title }
    }
    if (op === 'focus') {
      const tab = await this.ensureTab(owner, params.tabId)
      entry.activeTabId = tab.tabId
      return { focused: true, tabId: tab.tabId, url: tab.url, title: tab.title }
    }
    throw error('INVALID_ARGUMENT', `unknown tabs op: ${op}`)
  }

  async loginStart({ url } = {}) {
    if (this.loginProcess) {
      return { running: true, alreadyRunning: true, pid: this.loginProcess.pid ?? null, profile: this.loginProfile }
    }
    if (this.tabs.size > 0) {
      throw error('HEADLESS_BUSY', 'close headless tabs (chrome_close_session {backend:"headless"}) before opening the login window')
    }
    if (this.chrome || this.cdp) await this.close()
    const executable = chromeExecutable()
    if (!executable) throw error('UNSUPPORTED_BACKEND', 'no Chrome/Chromium executable found (set DSH_HEADLESS_CHROME)')
    const target = url && /^https?:\/\//i.test(String(url)) ? String(url) : 'about:blank'
    await fsp.mkdir(this.loginProfile, { recursive: true })
    const child = this.spawnImpl(
      executable,
      [
        `--user-data-dir=${this.loginProfile}`,
        '--new-window',
        target,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-sync',
      ],
      { stdio: 'ignore' },
    )
    this.loginProcess = child
    child.once?.('exit', () => {
      if (this.loginProcess === child) this.loginProcess = null
    })
    this.logger?.info?.('headless login window opened (pid=%s)', child.pid)
    return { running: true, alreadyRunning: false, pid: child.pid ?? null, profile: this.loginProfile, url: target }
  }

  loginStatus() {
    return {
      running: Boolean(this.loginProcess),
      pid: this.loginProcess?.pid ?? null,
      profile: this.loginProfile,
    }
  }

  loginFinish() {
    const child = this.loginProcess
    if (!child) return { running: false, stopped: false, profile: this.loginProfile }
    try {
      child.kill('SIGTERM')
    } catch {
      // already gone
    }
    this.loginProcess = null
    this.logger?.info?.('headless login window closed')
    return { running: false, stopped: true, profile: this.loginProfile }
  }

  async close() {
    try {
      this.loginProcess?.kill?.('SIGTERM')
    } catch {
      // ignore
    }
    this.loginProcess = null
    for (const tab of this.tabs.values()) this.dropShotStream(tab)
    try {
      await this.cdp?.send('Browser.close')
    } catch {
      // browser already gone or does not support close
    }
    this.bySession.clear()
    this.tabs.clear()
    try {
      this.cdp?.close()
    } catch {
      // ignore
    }
    this.cdp = null
    try {
      this.chrome?.kill('SIGTERM')
    } catch {
      // ignore
    }
    this.chrome = null
  }
}

export function headlessSupported() {
  return Boolean(chromeExecutable())
}

export function headlessChromeExecutable() {
  return chromeExecutable()
}
