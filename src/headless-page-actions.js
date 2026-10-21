/**
 * Page-side helper scripts for the headless driver (Q17).
 *
 * Each helper is serialized with Function.prototype.toString() and evaluated in
 * the page by HeadlessDriver.pageAction, so every function must stay
 * self-contained: it may only use page globals, never module-scope bindings.
 */
// --------------------------------------------------------- page-side helpers
export function snapshotPage(maxChars, boxes) {
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
  // truncation flag from the same string. Hide the DSH overlay so annotations
  // and the virtual pointer do not leak into page text.
  const overlayRoot = document.getElementById('__dsh_overlay__')
  if (overlayRoot) overlayRoot.style.display = 'none'
  const bodyText = document.body?.innerText || ''
  if (overlayRoot) overlayRoot.style.display = ''
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

export function clickPage(ref, selector, clickCount, button) {
  const el = selector
    ? document.querySelector(selector)
    : document.querySelector(`[data-dsh-ref="${Number(ref)}"]`)
  if (!el) return { ok: false, code: 'REF_NOT_FOUND', message: `no element for ${selector || `ref ${ref}`}` }
  // `hazard` marks targets where this synthetic click can change what the page
  // renders through a UA default action the visual tracker cannot see (no DOM
  // mutation, no scroll/focus event): navigation, form submission, label
  // forwarding, checkbox/radio/select/file activation, media controls, popover
  // or command toggles. `null` means the driver may keep the previous change
  // marker when both snapshots agree (docs/HEADLESS.md §4.1.8).
  const hazard = (() => {
    try {
      if (el.closest?.('a[href], area[href]')) return 'navigation'
      if (el.closest?.('label')) return 'label-activation'
      if (el.closest?.('video, audio')) return 'media-control'
      if (el.closest?.('[popovertarget], [commandfor]')) return 'ua-toggle'
      // Any form control: checkbox/radio/select/file activation repaints without
      // a mutation, and typable controls can move a caret/selection.
      if (el.closest?.('input, select, textarea')) return 'form-control'
      const button = el.closest?.('button')
      if (button) {
        // A button's own default action is form submission; only a submitter
        // (implicit type=submit) associated with a form can navigate.
        const type = String(button.getAttribute('type') || 'submit').toLowerCase()
        if ((button.form || button.closest?.('form')) && type !== 'button' && type !== 'reset') return 'form-submit'
      }
    } catch {
      return 'unknown'
    }
    return null
  })()
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
    hazard,
  }
}

// Page-side detector for password/OTP/payment fields (H5). Self-contained
// because pageCall() serializes it into every page evaluation; it returns only
// tag/type/reason, never the value, label, name or id.
export function sensitiveInputInfo(element) {
  if (!element) return null
  const tag = String(element.tagName || '').toLowerCase()
  if (tag !== 'input' && tag !== 'textarea') return null
  const attr = (name) => String(element.getAttribute?.(name) || '').toLowerCase()
  const type = attr('type')
  const autocomplete = attr('autocomplete')
  const hay = `${attr('name')} ${attr('id')} ${attr('placeholder')} ${attr('aria-label')} ${autocomplete}`
  if (type === 'password' || autocomplete.includes('password')) {
    return { tag, type: type || 'text', sensitive: 'password' }
  }
  if (
    autocomplete.startsWith('cc-') ||
    /(^|[^a-z])(?:card|cc-?num|cc-?name|cc-?exp|cvv2?|cvc|payment|billing)([^a-z]|$)/.test(hay)
  ) {
    return { tag, type: type || 'text', sensitive: 'payment' }
  }
  if (/(^|[^a-z])(?:otp|totp|one[-_ ]?time|verification[-_ ]?code|auth(?:entication)?[-_ ]?code|mfa|2fa)([^a-z]|$)/.test(hay)) {
    return { tag, type: type || 'text', sensitive: 'otp' }
  }
  if (/(^|[^a-z])(?:pass(?:word|wd|phrase)?|pwd)([^a-z]|$)/.test(hay)) {
    return { tag, type: type || 'text', sensitive: 'password' }
  }
  return null
}

export function typePage(ref, selector, text, replace, submit, probe, sensitiveApproved) {
  const el = selector
    ? document.querySelector(selector)
    : document.querySelector(`[data-dsh-ref="${Number(ref)}"]`)
  if (!el) return { ok: false, code: 'REF_NOT_FOUND', message: `no element for ${selector || `ref ${ref}`}` }
  const tag = el.tagName.toLowerCase()
  // H5: fail closed before focus/value write. Without the provider's approval
  // flag the secret never reaches the page, and the refusal carries no value.
  const field = sensitiveInputInfo(el)
  if (field && sensitiveApproved !== true) {
    return {
      ok: false,
      code: 'SENSITIVE_FIELD',
      sensitive: field.sensitive,
      field: { tag: field.tag, type: field.type, sensitive: field.sensitive },
      message: `target is a sensitive ${field.sensitive} field; hard confirmation is required before typing`,
    }
  }
  // The pre-action tracker snapshot travels inside this same evaluate when the
  // caller asks for it (docs/HEADLESS.md §4.1.16): the type always has to make
  // one page round trip anyway, so the probe costs the page-side snapshot work
  // but not a second round trip — a type that really changes the value (the
  // common case, which the result then vetoes) pays ~0.1ms instead of ~0.5ms.
  // It is taken before the field is focused or written, exactly where the
  // separate snapshot used by the other actions sits.
  const probeBefore = probe === true && window.__dshVisual ? window.__dshVisual.snapshot() : null
  // What the type actually changed (docs/HEADLESS.md §4.1.16): the field's
  // value, which element holds focus, and the text caret inside the field. A
  // type that leaves all three exactly as they were cannot repaint the field,
  // which is the only thing the driver needs to skip the repaint window. The
  // synthetic `change` event is counted so the probe can tell its own event
  // apart from a control whose UA state another action flipped.
  const activeBefore = document.activeElement
  const valueBefore = String(el.value ?? el.textContent ?? '')
  const caretBefore = [el.selectionStart, el.selectionEnd]
  let changeEvents = 0
  el.focus()
  if (tag === 'input' || tag === 'textarea') {
    const proto = tag === 'input' ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
    const next = replace ? String(text) : `${el.value || ''}${text}`
    if (setter) setter.call(el, next)
    else el.value = next
    el.dispatchEvent(new Event('input', { bubbles: true, composed: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
    changeEvents = 1
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
  const valueAfter = String(el.value ?? el.textContent ?? '')
  const caretAfter = [el.selectionStart, el.selectionEnd]
  const changed =
    document.activeElement !== activeBefore ||
    valueAfter !== valueBefore ||
    caretAfter[0] !== caretBefore[0] ||
    caretAfter[1] !== caretBefore[1]
  if (field) return { ok: true, submitted, changed, changeEvents, probeBefore, sensitive: field.sensitive }
  return { ok: true, value: valueAfter.slice(0, 200), submitted, changed, changeEvents, probeBefore }
}

// H5: used before a keyboard press so the headless action can ask the provider
// for a hard confirmation when focus sits in a password/OTP/payment field.
export function activeFieldInfo() {
  const active = document.activeElement
  const field = sensitiveInputInfo(active)
  if (!field) return { ok: true, active: false, sensitive: null }
  return { ok: true, active: true, tag: field.tag, type: field.type, sensitive: field.sensitive }
}

export function currentSelection(maxChars) {
  const active = document.activeElement
  const tag = active?.tagName?.toLowerCase()
  // Mirror the desktop extension's readSelection(): a selection inside a
  // password/hidden/payment/OTP/secret field never returns text, whatever the
  // caller asked. Kept self-contained because this helper is serialized into
  // the page.
  const sensitive = (element) => {
    if (!element) return false
    const type = String(element.getAttribute('type') || '').toLowerCase()
    const autocomplete = String(element.getAttribute('autocomplete') || '').toLowerCase()
    const name = String(element.getAttribute('name') || '').toLowerCase()
    if (type === 'password' || type === 'hidden') return true
    if (autocomplete.includes('cc-') || autocomplete.includes('password')) return true
    return /pass(word)?|card|otp|token|secret|cvv|payment/.test(name)
  }
  if ((tag === 'input' || tag === 'textarea') && sensitive(active)) {
    return { found: false, reason: 'SENSITIVE_SELECTION', message: 'selection is inside a sensitive field' }
  }
  if ((tag === 'input' || tag === 'textarea') && typeof active.selectionStart === 'number') {
    const text = String(active.value || '').slice(active.selectionStart, active.selectionEnd)
    if (text) return { found: true, text: text.slice(0, maxChars), source: 'input' }
  }
  const text = String(window.getSelection?.() || '')
  if (!text) return { found: false, message: 'NO_SELECTION' }
  return { found: true, text: text.slice(0, maxChars), source: 'document' }
}

export function findPage(query, regex, maxResults) {
  const raw = String(query || '')
  // NBSP / repeated whitespace is common in rendered pages; normalize the
  // caller's query the same way the text node is normalized below, otherwise a
  // literal query with ordinary spaces misses the NBSP-separated words.
  const normalize = (value) => String(value ?? '').replace(/\s+/g, ' ').trim()
  const needle = normalize(raw)
  if (!needle) return { query: raw, matches: [], truncated: false }
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
    const text = normalize(node.nodeValue || '')
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
  return { query: raw, matches, truncated }
}

export function selectPage(ref, selector, value, checked, probe) {
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
    // Selects and checkboxes dispatch `change` (and `input`) whether or not the
    // state actually moved, so the caller cannot tell an idempotent re-select
    // from a real one by the result alone (docs/HEADLESS.md §4.1.17). Answer
    // "did the state change" from the values around the write; the optional
    // pre-action tracker snapshot rides in this same evaluate (the same form
    // `typePage` uses), so the paint-free case costs no extra round trip.
    const probeBefore = probe === true && window.__dshVisual ? window.__dshVisual.snapshot() : null
    const valueBefore = el.value
    el.value = option.value
    el.dispatchEvent(new Event('input', { bubbles: true, composed: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
    return { ok: true, tag, value: el.value, changed: el.value !== valueBefore, changeEvents: 1, probeBefore }
  }
  if (tag === 'input' && ['checkbox', 'radio'].includes(String(el.type).toLowerCase())) {
    const next = typeof checked === 'boolean' ? checked : !el.checked
    const probeBefore = probe === true && window.__dshVisual ? window.__dshVisual.snapshot() : null
    const checkedBefore = el.checked
    el.checked = next
    el.dispatchEvent(new Event('input', { bubbles: true, composed: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
    return { ok: true, tag, value: next ? 'true' : 'false', changed: el.checked !== checkedBefore, changeEvents: 1, probeBefore }
  }
  return { ok: false, code: 'INVALID_ARGUMENT', message: `element <${tag}> is not a select/checkbox/radio` }
}

export function dragPage(fromRef, toRef) {
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

export const PAGE_HELPERS = { snapshotPage, clickPage, typePage, currentSelection, findPage, selectPage, dragPage, activeFieldInfo }

// Function.prototype.toString() is not free; serialize each page helper once.
const helperSources = new Map()
let sensitiveHelperSource = null

export function pageCall(name, args) {
  let source = helperSources.get(name)
  if (!source) {
    source = PAGE_HELPERS[name].toString()
    helperSources.set(name, source)
  }
  // A serialized page helper cannot close over module scope, so the sensitive
  // field detector is embedded as a local binding under the name it calls.
  sensitiveHelperSource ||= `const sensitiveInputInfo = ${sensitiveInputInfo.toString()};`
  return `(() => { ${sensitiveHelperSource} const fn = ${source}; return fn(...${JSON.stringify(args)}); })()`
}

