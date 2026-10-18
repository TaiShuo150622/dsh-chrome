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
  'tab.selection',
  'tab.close_session',
  'tab.debug_diag',
])

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
  const visible = (el) => {
    if (!el) return false
    const rect = el.getBoundingClientRect()
    if (rect.width <= 1 || rect.height <= 1) return false
    const style = getComputedStyle(el)
    return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0'
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
    if (!visible(el)) continue
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
      const rect = el.getBoundingClientRect()
      control.box = [Math.round(rect.x), Math.round(rect.y), Math.round(rect.width), Math.round(rect.height)]
    }
    controls.push(control)
  }
  const text = (document.body?.innerText || '').slice(0, maxChars)
  return {
    title: document.title || '',
    url: location.href,
    text,
    truncated: (document.body?.innerText || '').length > maxChars,
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

const PAGE_HELPERS = { snapshotPage, clickPage, typePage, currentSelection }

function pageCall(name, args) {
  return `(() => { const fn = ${PAGE_HELPERS[name].toString()}; return fn(...${JSON.stringify(args)}); })()`
}

// ------------------------------------------------------------------ driver
export class HeadlessDriver {
  constructor({ home, logger } = {}) {
    this.home = home
    this.logger = logger
    this.chrome = null
    this.cdp = null
    this.browserVersion = null
    this.owners = new Map()
    this.tabs = new Map() // tabId -> tab (global; ids unique per owner group not guaranteed)
    this.nextTabId = 1
    this.startPromise = null
    this.screenshotDir = path.join(home || '.', 'cache', 'dsh-chrome', 'headless', 'screenshots')
  }

  get connected() {
    return Boolean(this.cdp)
  }

  async ensureStarted() {
    if (this.cdp) return this
    if (this.startPromise) return this.startPromise
    this.startPromise = (async () => {
      const executable = chromeExecutable()
      if (!executable) {
        throw error('UNSUPPORTED_BACKEND', 'no Chrome/Chromium executable found for the headless backend (set DSH_HEADLESS_CHROME)')
      }
      const profileDir = path.join(this.home || '.', 'cache', 'dsh-chrome', 'headless', 'profile')
      await fsp.mkdir(profileDir, { recursive: true })
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
      const activePortPath = path.join(profileDir, 'DevToolsActivePort')
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
      this.logger?.info?.('headless Chrome started: %s', this.browserVersion || 'unknown')
      return this
    })()
    try {
      return await this.startPromise
    } finally {
      this.startPromise = null
    }
  }

  onCdpEvent(message) {
    if (message.method === 'Target.detachedFromTarget') {
      // tab removal handled lazily
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
    const tab = { tabId, targetId, sessionId, url: url || 'about:blank', title: '' }
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

  async request(method, params = {}) {
    await this.ensureStarted()
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
      case 'tab.snapshot': {
        const tab = await this.ensureTab(owner, params.tabId)
        await this.syncTabMeta(tab)
        const value = await this.pageAction(tab, 'snapshotPage', [params.maxChars || 100000, Boolean(params.boxes)])
        return { ...value, mode: params.mode === 'delta' ? 'full' : 'full' }
      }
      case 'tab.click': {
        const tab = await this.ensureTab(owner, params.tabId)
        const result = await this.pageAction(tab, 'clickPage', [params.ref ?? null, params.selector ?? null, params.clickCount || 1, params.button === 'right' ? 2 : params.button === 'middle' ? 1 : 0])
        if (!result?.ok) throw error(result?.code || 'REF_NOT_FOUND', result?.message || 'click failed')
        await this.syncTabMeta(tab)
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
        if (direction === 'top' || direction === 'bottom') {
          await this.evalOn(tab, `window.scrollTo(0, ${direction === 'top' ? 0 : 'document.body.scrollHeight'})`)
        } else {
          await this.evalOn(tab, `window.scrollBy(0, ${direction === 'up' ? -amount : amount})`)
        }
        const pos = await this.evalOn(tab, '({ x: window.scrollX, y: window.scrollY })')
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
        const shot = await this.cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: Boolean(params.fullPage) }, tab.sessionId)
        await fsp.mkdir(this.screenshotDir, { recursive: true })
        const file = path.join(this.screenshotDir, `headless-${Date.now()}.png`)
        const data = Buffer.from(shot.data, 'base64')
        await fsp.writeFile(file, data, { mode: 0o600 })
        const meta = await this.evalOn(tab, '({ w: innerWidth, h: innerHeight })')
        return { path: file, mediaType: 'image/png', width: meta?.w || 0, height: meta?.h || 0, bytes: data.byteLength }
      }
      case 'tab.pdf': {
        const tab = await this.ensureTab(owner, params.tabId)
        const pdf = await this.cdp.send('Page.printToPDF', { printBackground: true }, tab.sessionId)
        await fsp.mkdir(this.screenshotDir, { recursive: true })
        const file = path.join(this.screenshotDir, `headless-${Date.now()}.pdf`)
        const data = Buffer.from(pdf.data, 'base64')
        await fsp.writeFile(file, data, { mode: 0o600 })
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
      case 'tab.close_session': {
        const entry = this.ownerEntry(owner)
        let closed = 0
        for (const tab of [...entry.tabs.values()]) {
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

  async close() {
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
