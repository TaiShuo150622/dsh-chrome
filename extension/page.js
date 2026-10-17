// DSH Chrome page helper.
//
// Runs inside every http(s) page. It is both the keepalive port (keeps the
// service worker alive) and the in-page action channel: the service worker
// sends {id, action, args} and this script replies {id, result} or {id, error}.
// Using a content-script port avoids chrome.scripting.executeScript, which can
// hang on background/collapsed-group tabs in MV3.

let port = null

// Keepalive port only: keeps the service worker awake while pages are open.
function connectPagePort() {
  if (port) return port
  try {
    port = chrome.runtime.connect({ name: 'dsh-keepalive' })
  } catch {
    port = null
    return null
  }
  port.onDisconnect.addListener(() => {
    port = null
    setTimeout(connectPagePort, 1000)
  })
  return port
}

connectPagePort()

setInterval(() => {
  // A port message does NOT wake a terminated service worker, but
  // chrome.runtime.sendMessage does. This is what brings the SW back so it can
  // re-open the native port after Chrome evicted it.
  try {
    chrome.runtime.sendMessage({ type: 'dsh-page-tick' }, () => {
      void chrome.runtime.lastError
    })
  } catch {
    // extension context invalidated; reload of the page re-injects us
  }
  if (!port) {
    connectPagePort()
    return
  }
  try {
    port.postMessage({ type: 'keepalive' })
  } catch {
    port = null
    connectPagePort()
  }
}, 15000)

// Stateless action RPC: the service worker uses chrome.tabs.sendMessage, so a
// worker restart never invalidates the helper or the refs handed out by a
// snapshot (all refs live in this page's DOM).
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.target !== 'dsh-page') return false
  try {
    const handler = ACTIONS[message.action]
    if (!handler) throw pageError('UNSUPPORTED', `unknown page action: ${message.action}`)
    sendResponse({ result: handler(message.args || []) })
  } catch (error) {
    sendResponse({
      error: {
        code: typeof error?.code === 'string' ? error.code : 'INTERNAL',
        message: error?.message || String(error),
      },
    })
  }
  return false
})

function pageError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

const ACTIONS = {
  snapshot: (args) => pageSnapshot(args[0]),
  click: (args) => clickByRef(args[0]),
  type: (args) => typeIntoRef(args[0], args[1], args[2], args[3]),
  press: (args) => pressKey(args[0]),
  scroll: (args) => scrollPage(args[0], args[1]),
  hasText: (args) => (document.body ? document.body.innerText : '').includes(args[0]),
}

function clickByRef(ref) {
  const element = document.querySelector(`[data-dsh-ref="${ref}"]`)
  if (!element) return { ok: false, reason: 'REF_STALE', message: `ref ${ref} not found; take a new snapshot` }
  element.scrollIntoView({ block: 'center', inline: 'center' })
  const rect = element.getBoundingClientRect()
  const x = rect.left + rect.width / 2
  const y = rect.top + rect.height / 2
  const base = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, view: window }
  const pointer = { ...base, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0 }
  try { element.dispatchEvent(new PointerEvent('pointerdown', pointer)) } catch {}
  element.dispatchEvent(new MouseEvent('mousedown', base))
  try { element.dispatchEvent(new PointerEvent('pointerup', pointer)) } catch {}
  element.dispatchEvent(new MouseEvent('mouseup', base))
  element.dispatchEvent(new MouseEvent('click', base))
  return {
    ok: true,
    tag: element.tagName.toLowerCase(),
    label: (element.innerText || element.getAttribute('aria-label') || '').trim().slice(0, 80),
  }
}

function typeIntoRef(ref, text, replace, submit) {
  const element = document.querySelector(`[data-dsh-ref="${ref}"]`)
  if (!element) return { ok: false, reason: 'REF_STALE', message: `ref ${ref} not found; take a new snapshot` }
  element.focus()
  const tag = element.tagName.toLowerCase()
  if (tag !== 'input' && tag !== 'textarea') {
    return { ok: false, reason: 'UNSUPPORTED', message: `ref ${ref} is a ${tag}, not a text field` }
  }
  const proto = tag === 'textarea' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
  const next = `${replace ? '' : element.value || ''}${text}`
  if (setter) setter.call(element, next)
  else element.value = next
  element.dispatchEvent(new Event('input', { bubbles: true }))
  element.dispatchEvent(new Event('change', { bubbles: true }))
  let submitted = false
  if (submit) {
    const form = element.form
    try {
      if (form && typeof form.requestSubmit === 'function') {
        form.requestSubmit()
        submitted = true
      }
    } catch {
      submitted = false
    }
    if (!submitted) {
      for (const type of ['keydown', 'keypress', 'keyup']) {
        element.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }))
      }
    }
  }
  return { ok: true, value: element.value, submitted }
}

function pressKey(key) {
  const target = document.activeElement && document.activeElement !== document.body
    ? document.activeElement
    : document.body
  const options = { key, bubbles: true, cancelable: true, composed: true }
  target.dispatchEvent(new KeyboardEvent('keydown', options))
  target.dispatchEvent(new KeyboardEvent('keypress', options))
  target.dispatchEvent(new KeyboardEvent('keyup', options))
  return { ok: true, key, target: target.tagName.toLowerCase() }
}

function scrollPage(direction, amount) {
  const step = Number.isFinite(amount) ? amount : 600
  const maxY = Math.max(0, document.documentElement.scrollHeight - window.innerHeight)
  const deltas = { down: step, up: -step, top: -maxY, bottom: maxY }
  window.scrollBy({ top: deltas[direction] ?? step, left: 0, behavior: 'instant' })
  return {
    ok: true,
    y: window.scrollY,
    viewportHeight: window.innerHeight,
    documentHeight: document.documentElement.scrollHeight,
  }
}

function pageSnapshot(maxChars) {
  const limit = Number.isFinite(maxChars) ? maxChars : 100000
  const selectors = [
    'a[href]',
    'button',
    'input',
    'select',
    'textarea',
    '[role="button"]',
    '[role="link"]',
    '[role="checkbox"]',
    '[role="tab"]',
    '[onclick]',
  ]
  const seen = new Set()
  const elements = []
  for (const selector of selectors) {
    for (const element of document.querySelectorAll(selector)) {
      if (seen.has(element)) continue
      seen.add(element)
      elements.push(element)
    }
  }
  const isVisible = (element) => {
    const style = getComputedStyle(element)
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
      return false
    }
    if (element.closest('[hidden]')) return false
    const rect = element.getBoundingClientRect()
    return rect.width > 1 && rect.height > 1
  }
  const labelOf = (element) => {
    const aria = element.getAttribute('aria-label')
    if (aria && aria.trim()) return aria.trim().slice(0, 120)
    const text = (element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim()
    if (text) return text.slice(0, 120)
    return (
      element.getAttribute('placeholder') ||
      element.getAttribute('name') ||
      element.getAttribute('title') ||
      element.getAttribute('alt') ||
      ''
    ).slice(0, 120)
  }
  const kindOf = (element) => {
    const tag = element.tagName.toLowerCase()
    if (tag === 'input') return element.getAttribute('type') || 'text'
    if (tag === 'a') return 'link'
    return tag
  }
  const maskedValue = (element) => {
    const tag = element.tagName.toLowerCase()
    if (tag !== 'input' && tag !== 'textarea' && tag !== 'select') return undefined
    const type = (element.getAttribute('type') || '').toLowerCase()
    if (type === 'password' || type === 'hidden') return '••••'
    const autocomplete = (element.getAttribute('autocomplete') || '').toLowerCase()
    const name = (element.getAttribute('name') || '').toLowerCase()
    if (autocomplete.includes('cc-') || autocomplete.includes('password') || /card|otp|token|secret|cvv/.test(name)) {
      return '••••'
    }
    if (type === 'checkbox' || type === 'radio') return element.checked ? 'checked' : 'unchecked'
    const value = element.value
    if (value == null || value === '') return undefined
    return value.length > 80 ? value.slice(0, 80) : value
  }

  const controls = []
  for (const element of elements) {
    if (controls.length >= 400) break
    if (!isVisible(element)) continue
    const ref = controls.length + 1
    try {
      element.setAttribute('data-dsh-ref', String(ref))
    } catch {
      // read-only DOM: the ref still works for this snapshot
    }
    const control = {
      ref,
      tag: element.tagName.toLowerCase(),
      kind: kindOf(element),
      label: labelOf(element),
    }
    const value = maskedValue(element)
    if (value !== undefined) control.value = value
    if (control.tag === 'a') {
      const href = element.getAttribute('href')
      if (href) control.href = href
    }
    controls.push(control)
  }

  const bodyText = (document.body ? document.body.innerText : '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+\n/g, '\n')
    .trim()
  const truncated = bodyText.length > limit
  return {
    title: document.title || '',
    url: location.href,
    controls,
    text: truncated ? bodyText.slice(0, limit) : bodyText,
    truncated,
  }
}
