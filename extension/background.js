/**
 * DSH Desktop Chrome — MV3 service worker (P0).
 *
 * Executes the browser requests the provider sends: status, background-tab
 * navigation, text snapshots, actions and screenshots via the DevTools
 * protocol. The native messaging port itself is owned by the offscreen
 * document (offscreen.js) so it survives service-worker eviction.
 */
const VERSION = chrome.runtime.getManifest().version

let nativeStatus = { connected: false, lastError: null, lastPingAt: 0 }

function log(...args) {
  console.log('[DSH Chrome]', ...args)
}

function bridgeError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

// --------------------------------------------------------------- session state
// owner (DSH session id) -> { tabIds, groupId, activeTabId }
const SESSIONS_KEY = 'dshSessions'
let sessionsCache = null
let sessionsLoaded = false

async function loadSessions() {
  if (sessionsLoaded) return sessionsCache
  sessionsLoaded = true
  try {
    const stored = await chrome.storage.session.get(SESSIONS_KEY)
    sessionsCache =
      stored[SESSIONS_KEY] && typeof stored[SESSIONS_KEY] === 'object' ? stored[SESSIONS_KEY] : {}
  } catch {
    sessionsCache = {}
  }
  return sessionsCache
}

async function saveSessions() {
  try {
    await chrome.storage.session.set({ [SESSIONS_KEY]: sessionsCache || {} })
  } catch {
    // storage.session is best effort; in-memory state still works for this worker
  }
}

function ownerKey(owner) {
  return String(owner || 'default')
}

function ownerShort(owner) {
  return ownerKey(owner).slice(-6)
}

async function tabExists(tabId) {
  try {
    await chrome.tabs.get(tabId)
    return true
  } catch {
    return false
  }
}

async function getSessionEntry(owner) {
  const sessions = await loadSessions()
  const key = ownerKey(owner)
  let entry = sessions[key]
  if (!entry) {
    entry = { tabIds: [], groupId: null, activeTabId: null }
    sessions[key] = entry
  }
  if (!Array.isArray(entry.tabIds)) entry.tabIds = []
  const alive = []
  for (const id of entry.tabIds) {
    if (await tabExists(id)) alive.push(id)
  }
  entry.tabIds = alive
  if (entry.activeTabId != null && !alive.includes(entry.activeTabId)) {
    entry.activeTabId = alive.length ? alive[alive.length - 1] : null
  }
  if (entry.activeTabId == null && alive.length) entry.activeTabId = alive[alive.length - 1]
  if (!alive.length) entry.groupId = null
  return entry
}

async function attachGroup(owner, entry, tabIds) {
  try {
    if (entry.groupId != null) {
      try {
        await chrome.tabs.group({ tabIds, groupId: entry.groupId })
        return
      } catch {
        entry.groupId = null
      }
    }
    const groupId = await chrome.tabs.group({ tabIds })
    entry.groupId = groupId
    await chrome.tabGroups.update(groupId, {
      title: `DSH · ${ownerShort(owner)}`,
      color: 'blue',
      collapsed: true,
    })
  } catch (error) {
    log('tab group unavailable', error?.message || error)
  }
}

async function addTabToSession(owner, tab, { activate = true } = {}) {
  const entry = await getSessionEntry(owner)
  entry.tabIds.push(tab.id)
  if (activate) entry.activeTabId = tab.id
  await attachGroup(owner, entry, [tab.id])
  await saveSessions()
  return entry
}

async function requireTabId(owner) {
  const entry = await getSessionEntry(owner)
  if (entry.activeTabId == null) {
    throw bridgeError('NO_SESSION_TAB', 'No DSH session tab yet. Call chrome_goto with a URL first.')
  }
  return entry.activeTabId
}

async function resolveOwnedTabId(owner, tabId) {
  if (tabId == null) return requireTabId(owner)
  const entry = await getSessionEntry(owner)
  if (!entry.tabIds.includes(tabId)) {
    throw bridgeError('TAB_NOT_FOUND', `tab ${tabId} is not owned by this session`)
  }
  return tabId
}

async function firstActiveTabId() {
  const sessions = await loadSessions()
  for (const entry of Object.values(sessions)) {
    if (entry && entry.activeTabId != null) return entry.activeTabId
  }
  return null
}

async function closeSessionTabs(owner) {
  const sessions = await loadSessions()
  const key = ownerKey(owner)
  const entry = sessions[key]
  if (!entry) return { closed: 0 }
  let closed = 0
  for (const id of entry.tabIds) {
    try {
      await chrome.tabs.remove(id)
      closed += 1
    } catch {
      // already gone
    }
  }
  delete sessions[key]
  await saveSessions()
  return { closed }
}

// Development auto-reload: the native host watches extension/ and emits
// ext.changed; debounce so a burst of file writes reloads once.
let extensionReloadTimer = null
function scheduleExtensionReload() {
  if (extensionReloadTimer) clearTimeout(extensionReloadTimer)
  extensionReloadTimer = setTimeout(() => {
    extensionReloadTimer = null
    try {
      chrome.runtime.reload()
    } catch (error) {
      log('extension reload failed', error?.message || error)
    }
  }, 800)
}

// ------------------------------------------------- native messaging (offscreen)
// The offscreen document owns the native port; the worker only relays browser
// requests to it. This is what makes host death / worker eviction recoverable.

async function ensureOffscreen() {
  if (!chrome.offscreen?.createDocument) return false
  try {
    const existing = await chrome.offscreen.hasDocument?.()
    if (existing) return true
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['BLOBS'],
      justification: 'Own the DSH native messaging port so it survives worker eviction.',
    })
    return true
  } catch (error) {
    log('offscreen unavailable', error?.message || error)
    return false
  }
}

function sendOffscreen(message, timeoutMs = 2000) {
  return new Promise((resolve) => {
    let done = false
    const timer = setTimeout(() => {
      if (done) return
      done = true
      resolve(null)
    }, timeoutMs)
    try {
      chrome.runtime.sendMessage(message, (response) => {
        void chrome.runtime.lastError
        if (done) return
        done = true
        clearTimeout(timer)
        resolve(response ?? null)
      })
    } catch {
      if (!done) {
        done = true
        clearTimeout(timer)
        resolve(null)
      }
    }
  })
}

async function reconnectNative(force = false) {
  await ensureOffscreen()
  return sendOffscreen({ type: 'dsh-native-reconnect', force }, 3000)
}

async function nativeStatusReport() {
  const status = await sendOffscreen({ type: 'dsh-native-status' }, 1200)
  if (status) nativeStatus = { ...nativeStatus, ...status }
  return { ...nativeStatus }
}

// ------------------------------------------------------------------- requests
async function handleRequest(message) {
  const method = String(message.method || '')
  const params = message.params || {}
  const owner = params.owner ?? 'default'
  switch (method) {
    case 'browser.status':
      return { extensionVersion: VERSION, connected: true }
    case 'tab.goto':
      return gotoUrl(owner, String(params.url || ''))
    case 'tab.snapshot':
      return snapshot(owner, params)
    case 'tab.screenshot':
      return screenshot(owner, params.tabId)
    case 'tab.click':
      return click(owner, params)
    case 'tab.type':
      return typeText(owner, params)
    case 'tab.press':
      return press(owner, params)
    case 'tab.scroll':
      return scroll(owner, params)
    case 'tab.history':
      return history(owner, params)
    case 'tab.tabs':
      return tabs(owner, params)
    case 'tab.wait':
      return wait(owner, params)
    case 'tab.close_session':
      return closeSessionTabs(owner)
    default:
      throw bridgeError('UNSUPPORTED', `unknown method: ${method}`)
  }
}

async function gotoUrl(owner, url) {
  if (!/^https?:\/\//i.test(url)) {
    throw bridgeError('PROTECTED_PAGE', 'Only http(s) URLs are allowed.')
  }
  const entry = await getSessionEntry(owner)
  let tabId = entry.activeTabId
  if (tabId == null) {
    const tab = await chrome.tabs.create({ url, active: false, pinned: false })
    tabId = tab.id
    await addTabToSession(owner, tab)
  } else {
    await chrome.tabs.update(tabId, { url })
  }
  await waitForComplete(tabId, 45000)
  const updated = await chrome.tabs.get(tabId)
  return {
    tabId,
    url: updated.url || url,
    title: updated.title || '',
    loadState: updated.status || 'complete',
  }
}

// Page actions run through the DevTools protocol. Content-script messaging and
// chrome.scripting both proved unreliable for background/collapsed-group tabs
// (messages queued forever); CDP Runtime.evaluate stays responsive and is the
// same channel that already captures screenshots.
const PAGE_ACTIONS = {
  snapshot: pageSnapshot,
  click: clickByRef,
  type: typeIntoRef,
  press: pressKey,
  scroll: scrollPage,
  hasText,
}

// Virtual cursor: a small DSH-colored pointer injected into the page so the
// user can see where the agent is acting (Codex-style "own cursor"). It is a
// DOM overlay; screenshots taken right after an action include it.
const CURSOR_HELPER_SRC = `
(() => {
  if (window.__dshCursor) return
  const ID = '__dsh_cursor__'
  window.__dshCursor = (x, y, kind) => {
    try {
      let cursor = document.getElementById(ID)
      if (!cursor) {
        cursor = document.createElement('div')
        cursor.id = ID
        cursor.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none;opacity:0;transition:transform .22s cubic-bezier(.2,.8,.2,1),opacity .2s'
        const ring = document.createElement('div')
        ring.style.cssText = 'position:absolute;left:-14px;top:-14px;width:28px;height:28px;border-radius:50%;border:2px solid rgba(0,122,255,.55);opacity:0;transition:opacity .2s,transform .3s'
        const dot = document.createElement('div')
        dot.style.cssText = 'position:absolute;left:-7px;top:-7px;width:14px;height:14px;border-radius:50%;background:rgba(0,122,255,.95);border:2px solid #fff;box-shadow:0 1px 6px rgba(0,0,0,.35)'
        cursor.appendChild(ring)
        cursor.appendChild(dot)
        document.documentElement.appendChild(cursor)
      }
      cursor.style.transform = 'translate(' + x + 'px,' + y + 'px)'
      cursor.style.opacity = '1'
      if (kind === 'click' || kind === 'type' || kind === 'key') {
        const ring = cursor.firstChild
        ring.style.transition = 'none'
        ring.style.opacity = '1'
        ring.style.transform = 'scale(.6)'
        requestAnimationFrame(() => {
          ring.style.transition = 'opacity .35s,transform .35s'
          ring.style.opacity = '0'
          ring.style.transform = 'scale(2.4)'
        })
      }
      clearTimeout(cursor.__dshTimer)
      cursor.__dshTimer = setTimeout(() => { cursor.style.opacity = '0' }, 900)
    } catch {}
  }
})();
`

function withTimeout(promise, timeoutMs, code, message) {
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => setTimeout(() => reject(bridgeError(code, message)), timeoutMs)),
  ])
}

async function evalInTab(tabId, fn, args, timeoutMs) {
  const target = { tabId }
  let attached = false
  try {
    await chrome.debugger.attach(target, '1.3')
    attached = true
  } catch {
    // A previous detach may have raced; try to use the existing session.
  }
  try {
    const expression = `(() => { ${CURSOR_HELPER_SRC}
      return (${fn.toString()})(...${JSON.stringify(args)})
    })()`
    const response = await withTimeout(
      chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
      }),
      timeoutMs,
      'TIMEOUT',
      `page action timed out after ${timeoutMs}ms`,
    )
    if (response?.exceptionDetails) {
      const text = response.exceptionDetails.exception?.description || response.exceptionDetails.text || 'page action failed'
      throw bridgeError('INTERNAL', String(text))
    }
    return response?.result?.value
  } finally {
    if (attached) {
      try {
        await chrome.debugger.detach(target)
      } catch {
        // tab may have closed or detached already
      }
    }
  }
}

async function callInPage(tabId, action, args = [], timeoutMs = 15000) {
  const fn = PAGE_ACTIONS[action]
  if (!fn) throw bridgeError('UNSUPPORTED', `unknown page action: ${action}`)
  try {
    return await evalInTab(tabId, fn, args, timeoutMs)
  } catch (error) {
    if (error?.code !== 'TIMEOUT') throw error
    // First attach after a page load / worker wake can be slow; retry once.
    await new Promise((resolve) => setTimeout(resolve, 400))
    return evalInTab(tabId, fn, args, timeoutMs)
  }
}

async function snapshot(owner, params) {
  const tabId = await resolveOwnedTabId(owner, params.tabId)
  const limit = Number.isFinite(params.maxChars)
    ? Math.max(1000, Math.min(200000, params.maxChars))
    : 100000
  const value = await callInPage(tabId, 'snapshot', [limit])
  if (!value) throw bridgeError('INTERNAL', 'page snapshot returned no result')
  return value
}

async function screenshot(owner, tabIdArg) {
  const tabId = await resolveOwnedTabId(owner, tabIdArg)
  const target = { tabId }
  try {
    await chrome.debugger.attach(target, '1.3')
  } catch (error) {
    throw bridgeError('DEBUGGER_FAILED', `cannot attach debugger: ${error?.message || error}`)
  }
  try {
    const response = await chrome.debugger.sendCommand(target, 'Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false,
    })
    if (!response?.data) throw bridgeError('INTERNAL', 'empty screenshot data')
    return { dataBase64: response.data }
  } finally {
    try {
      await chrome.debugger.detach(target)
    } catch {
      // tab may have navigated or closed
    }
  }
}

async function click(owner, params) {
  const tabId = await resolveOwnedTabId(owner, params.tabId)
  const ref = Number(params.ref)
  if (!Number.isFinite(ref)) throw bridgeError('REF_STALE', 'ref must be a snapshot number')
  const result = await callInPage(tabId, 'click', [ref])
  if (!result?.ok) {
    throw bridgeError(result?.reason || 'REF_STALE', result?.message || `ref ${ref} is stale; take a new snapshot`)
  }
  return { ...result, tabId }
}

async function typeText(owner, params) {
  const tabId = await resolveOwnedTabId(owner, params.tabId)
  const ref = Number(params.ref)
  if (!Number.isFinite(ref)) throw bridgeError('REF_STALE', 'ref must be a snapshot number')
  const result = await callInPage(tabId, 'type', [
    ref,
    String(params.text ?? ''),
    Boolean(params.replace),
    Boolean(params.submit),
  ])
  if (!result?.ok) {
    throw bridgeError(result?.reason || 'REF_STALE', result?.message || `ref ${ref} is stale; take a new snapshot`)
  }
  return { ...result, tabId }
}

async function press(owner, params) {
  const tabId = await resolveOwnedTabId(owner, params.tabId)
  const key = String(params.key || '')
  if (!key) throw bridgeError('INTERNAL', 'key is required')
  const result = await callInPage(tabId, 'press', [key])
  return { ...result, tabId }
}

async function scroll(owner, params) {
  const tabId = await resolveOwnedTabId(owner, params.tabId)
  const direction = String(params.direction || 'down')
  const amount = Number.isFinite(params.amount) ? Number(params.amount) : 600
  const result = await callInPage(tabId, 'scroll', [direction, amount])
  return { ...result, tabId }
}

async function history(owner, params) {
  const tabId = await resolveOwnedTabId(owner, params.tabId)
  const op = String(params.op || 'reload')
  if (op === 'back') await chrome.tabs.goBack(tabId)
  else if (op === 'forward') await chrome.tabs.goForward(tabId)
  else if (op === 'reload') await chrome.tabs.reload(tabId)
  else throw bridgeError('UNSUPPORTED', `unknown history op: ${op}`)
  await waitForComplete(tabId, 45000).catch(() => {})
  const tab = await chrome.tabs.get(tabId)
  return { tabId, url: tab.url || '', title: tab.title || '', loadState: tab.status || 'complete' }
}

async function tabs(owner, params) {
  const op = String(params.op || 'list')
  const entry = await getSessionEntry(owner)
  if (op === 'list') {
    const list = []
    for (const id of entry.tabIds) {
      try {
        const tab = await chrome.tabs.get(id)
        list.push({
          tabId: id,
          title: tab.title || '',
          url: tab.url || '',
          active: id === entry.activeTabId,
        })
      } catch {
        // dropped between cleanup and listing
      }
    }
    return { tabs: list, groupId: entry.groupId }
  }
  if (op === 'new') {
    const url = params.url ? String(params.url) : 'about:blank'
    if (url !== 'about:blank' && !/^https?:\/\//i.test(url)) {
      throw bridgeError('PROTECTED_PAGE', 'Only http(s) URLs are allowed.')
    }
    const tab = await chrome.tabs.create({ url, active: false, pinned: false })
    await addTabToSession(owner, tab, { activate: false })
    if (url !== 'about:blank') await waitForComplete(tab.id, 45000).catch(() => {})
    const created = await chrome.tabs.get(tab.id)
    return { tabId: tab.id, url: created.url || url, title: created.title || '' }
  }
  if (op === 'close') {
    const tabId = await resolveOwnedTabId(owner, params.tabId)
    await chrome.tabs.remove(tabId)
    const after = await getSessionEntry(owner)
    await saveSessions()
    return { closed: tabId, remaining: after.tabIds.length }
  }
  throw bridgeError('UNSUPPORTED', `unknown tabs op: ${op}`)
}

async function wait(owner, params) {
  const tabId = await resolveOwnedTabId(owner, params.tabId)
  const until = String(params.until || 'load')
  const timeoutMs = Number.isFinite(params.timeoutMs)
    ? Math.max(500, Math.min(120000, Number(params.timeoutMs)))
    : 30000
  if (until === 'load') {
    await waitForComplete(tabId, timeoutMs)
  } else if (until === 'networkidle') {
    await waitForComplete(tabId, timeoutMs)
    await new Promise((resolve) => setTimeout(resolve, 800))
  } else if (until === 'text') {
    const text = String(params.text || '')
    if (!text) throw bridgeError('INTERNAL', 'text is required when until=text')
    const started = Date.now()
    let found = false
    while (Date.now() - started < timeoutMs) {
      found = Boolean(await callInPage(tabId, 'hasText', [text], 5000))
      if (found) break
      await new Promise((resolve) => setTimeout(resolve, 300))
    }
    if (!found) throw bridgeError('TIMEOUT', `text not found within ${timeoutMs}ms: ${text}`)
  } else {
    throw bridgeError('UNSUPPORTED', `unknown wait target: ${until}`)
  }
  const tab = await chrome.tabs.get(tabId)
  return { tabId, url: tab.url || '', title: tab.title || '', loadState: tab.status || 'complete' }
}

function waitForComplete(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    let done = false
    const listener = (updatedId, changeInfo) => {
      if (updatedId === tabId && changeInfo.status === 'complete') finish()
    }
    const timer = setTimeout(() => {
      cleanup()
      reject(bridgeError('TIMEOUT', `tab ${tabId} did not finish loading within ${timeoutMs}ms`))
    }, timeoutMs)
    function cleanup() {
      if (done) return false
      done = true
      clearTimeout(timer)
      chrome.tabs.onUpdated.removeListener(listener)
      return true
    }
    function finish() {
      if (cleanup()) resolve()
    }
    chrome.tabs.onUpdated.addListener(listener)
    chrome.tabs
      .get(tabId)
      .then((tab) => {
        if (tab.status === 'complete') finish()
      })
      .catch(() => {})
  })
}

// ------------------------------------------------------- injected page snapshot
/**
 * Runs inside the page. Must stay self-contained: Chrome serializes this
 * function and its arguments into the page's isolated world.
 */
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
      // read-only DOM is fine; the ref still works for this snapshot
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

// ------------------------------------------------------- injected page actions
/** Runs inside the page; self-contained. */
function clickByRef(ref) {
  const element = document.querySelector(`[data-dsh-ref="${ref}"]`)
  if (!element) return { ok: false, reason: 'REF_STALE', message: `ref ${ref} not found; take a new snapshot` }
  element.scrollIntoView({ block: 'center', inline: 'center' })
  const rect = element.getBoundingClientRect()
  const x = rect.left + rect.width / 2
  const y = rect.top + rect.height / 2
  const base = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, view: window }
  window.__dshCursor?.(x, y, 'click')
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

/** Runs inside the page; self-contained. */
function typeIntoRef(ref, text, replace, submit) {
  const element = document.querySelector(`[data-dsh-ref="${ref}"]`)
  if (!element) return { ok: false, reason: 'REF_STALE', message: `ref ${ref} not found; take a new snapshot` }
  element.focus()
  try {
    const rect = element.getBoundingClientRect()
    window.__dshCursor?.(rect.left + rect.width / 2, rect.top + rect.height / 2, 'type')
  } catch {}
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

/** Runs inside the page; self-contained. */
function pressKey(key) {
  const target = document.activeElement && document.activeElement !== document.body
    ? document.activeElement
    : document.body
  try {
    const rect = target.getBoundingClientRect()
    window.__dshCursor?.(rect.left + rect.width / 2, rect.top + rect.height / 2, 'key')
  } catch {}
  const options = { key, bubbles: true, cancelable: true, composed: true }
  target.dispatchEvent(new KeyboardEvent('keydown', options))
  target.dispatchEvent(new KeyboardEvent('keypress', options))
  target.dispatchEvent(new KeyboardEvent('keyup', options))
  return { ok: true, key, target: target.tagName.toLowerCase() }
}

/** Runs inside the page; self-contained. */
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

/** Runs inside the page; self-contained. */
function hasText(text) {
  return (document.body ? document.body.innerText : '').includes(text)
}

// --------------------------------------------------------------- worker wiring
function ensureReconnectAlarm() {
  try {
    chrome.alarms.create('dsh-chrome-reconnect', { periodInMinutes: 0.5 })
  } catch {
    // alarms unavailable; offscreen health check still reconnects
  }
}

function makeStatus(sessionTabId = null) {
  return {
    connected: Boolean(nativeStatus.connected),
    extensionVersion: VERSION,
    sessionTabId,
    lastError: nativeStatus.lastError || null,
  }
}

async function popupStatus() {
  await nativeStatusReport()
  return makeStatus(await firstActiveTabId())
}

function kickReconnect() {
  if (!nativeStatus.connected) reconnectNative().catch(() => {})
  return { ok: true }
}

chrome.runtime.onInstalled.addListener(() => {
  ensureReconnectAlarm()
  ensureOffscreen().then(() => reconnectNative()).catch(() => {})
})
chrome.runtime.onStartup.addListener(() => {
  ensureReconnectAlarm()
  ensureOffscreen().then(() => reconnectNative()).catch(() => {})
})
chrome.tabs.onUpdated.addListener(() => {
  kickReconnect()
})
chrome.runtime.onConnect.addListener((keepalivePort) => {
  if (keepalivePort.name !== 'dsh-keepalive') return
  keepalivePort.onMessage.addListener(() => {
    kickReconnect()
  })
})

// Every worker start (install/startup/event wake) ensures the offscreen owner
// exists and asks it to (re)connect the native port.
ensureOffscreen().then(() => reconnectNative()).catch(() => {})

chrome.alarms.onAlarm.addListener((alarm) => {
  if (!alarm.name.startsWith('dsh-chrome-reconnect')) return
  reconnectNative().catch(() => {})
})

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'dsh-native-request') {
    handleRequest(message.message)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) =>
        sendResponse({
          ok: false,
          error: {
            code: typeof error?.code === 'string' ? error.code : 'INTERNAL',
            message: error?.message || String(error),
          },
        }),
      )
    return true
  }
  if (message?.type === 'dsh-native-status-changed') {
    nativeStatus = { ...nativeStatus, ...(message.status || {}) }
    sendResponse({ ok: true })
    return false
  }
  if (message?.type === 'dsh-ext-changed') {
    log('extension files changed; reloading', message.file || '')
    scheduleExtensionReload()
    sendResponse({ ok: true })
    return false
  }
  if (message?.type === 'dsh-page-tick') {
    sendResponse(kickReconnect())
    return false
  }
  if (message?.type === 'dsh-status') {
    popupStatus().then(sendResponse, () => sendResponse(makeStatus()))
    return true
  }
  if (message?.type === 'dsh-connect') {
    reconnectNative(true)
      .then(() => new Promise((resolve) => setTimeout(resolve, 400)))
      .then(() => popupStatus())
      .then(sendResponse, () => sendResponse(makeStatus()))
    return true
  }
  return false
})

ensureReconnectAlarm()
