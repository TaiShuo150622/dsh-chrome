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

import { buildLaunchArgs, parseDevToolsActivePort } from './headless-launch.js'
import { decodePngFrame, encodePngFrame, jpegFrameSize, pngFrameSize } from './headless-png.js'
import { handleConsoleEvent, handleNetworkEvent } from './headless-events.js'
import { pageCall } from './headless-page-actions.js'
import { createHeadlessLogin } from './headless-login.js'

let overlaySourceCache = null
function overlaySource() {
  if (overlaySourceCache != null) return overlaySourceCache
  try {
    overlaySourceCache = fs.readFileSync(new URL('../extension/overlay.js', import.meta.url), 'utf8')
  } catch {
    overlaySourceCache = ''
  }
  return overlaySourceCache
}

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
  'tab.overlay',
  'tab.screencast_start',
  'tab.screencast_stop',
  'tab.screencast_status',
  'tab.upload',
  'tab.resume',
  'browser.downloads',
  'tab.close_session',
  'tab.debug_diag',
])

// Extra Chrome switches appended after the defaults (space-separated). This is
// the launch-flag experiment hook used by docs/HEADLESS.md §4.1.3; defaults do
// not set it.
const EXTRA_CHROME_ARGS = String(process.env.DSH_HEADLESS_CHROME_ARGS || '')
  .split(/\s+/)
  .filter(Boolean)

const DEFAULT_IDLE_MINUTES = Number(process.env.DSH_HEADLESS_IDLE_MINUTES) || 5
const MAX_TABS = Number(process.env.DSH_HEADLESS_MAX_TABS) || 12

// waitReady polls document.readyState. Local/real navigations often finish in
// tens of milliseconds, so a 100ms poll handed most of the load time back as
// request latency. 25ms costs a few cheap evaluates and removes that. (The
// DevToolsActivePort poll stays at 150ms: §4.1.5 measured no gain from a tight
// poll because Chrome finishes the launch ~300-570ms after writing that file,
// so the poll wait is fully overlapped.)
const READY_POLL_MS = 25

const CAPTURE_MAX_DURATION_MS = 10 * 60 * 1000
const CAPTURE_DEFAULT_MAX_ENTRIES = 300
const CAPTURE_HARD_MAX_ENTRIES = 1000

// Screenshot frame streaming (see docs/HEADLESS.md §4.1.1): while a tab is
// being screenshotted repeatedly, keep a short-lived screencast running and
// serve `tab.screenshot` from the compositor's own frames. Chrome encodes a
// screencast PNG with the same encoder as Page.captureScreenshot (the bytes are
// identical for identical content), but the frame is produced off the request
// path, so a shot costs one compositor frame interval (~16ms) instead of a full
// capture (~44ms). JPEG requests use a JPEG screencast through the same cache:
// the frame is cheaper to encode, and capture would otherwise cost ~44ms.
// A driver-side change marker plus the frame timestamp guarantee the returned
// frame includes the latest tab action; when that cannot be established the
// call falls back to a capture (first frame missing) or to the latest painted
// frame (visible page that produced no repaint), so screenshots never silently
// return a picture older than the last action.
const SHOT_STREAM_ENABLED = process.env.DSH_HEADLESS_SHOT_STREAM !== '0'
const SHOT_STREAM_IDLE_MS = Math.max(250, Number(process.env.DSH_HEADLESS_SHOT_STREAM_IDLE_MS) || 2000)
const SHOT_STREAM_FRAME_TIMEOUT_MS = Math.max(20, Number(process.env.DSH_HEADLESS_SHOT_STREAM_FRAME_TIMEOUT_MS) || 40)
const SHOT_STREAM_FIRST_FRAME_TIMEOUT_MS = Math.max(50, Number(process.env.DSH_HEADLESS_FIRST_FRAME_TIMEOUT_MS) || 1000)
// Keep the frame stream (and its cached frame) alive only across idle windows
// in which the page produced no frame at all: a blinking caret or any animation
// repaints within the window, and encoding those frames while nobody is
// screenshotting both burns CPU and slows the next CDP round trip, so those
// pages keep the old stop-after-idle behaviour.
const SHOT_STREAM_KEEPALIVE = process.env.DSH_HEADLESS_SHOT_STREAM_KEEPALIVE !== '0'
const SHOT_STREAM_FAILURES_BEFORE_BACKOFF = 2
const SHOT_STREAM_BACKOFF_MS = 5000
// JPEG `clip`/`ref` shots are cropped by the page's own decoder/encoder inside
// an isolated world, because the driver has no JPEG codec (docs/HEADLESS.md
// §4.1.9). The frame bytes are stored on that world's `window`, so cropping an
// unchanged frame again pays no transfer. A frame above this size is left to
// Page.captureScreenshot: a 2MB+ JPEG is a 4K-class fully-detailed page, where
// the data-URL round trip stops paying for itself.
// `DSH_HEADLESS_JPEG_CROP=0` restores the capture path.
const SHOT_JPEG_CROP_ENABLED = process.env.DSH_HEADLESS_JPEG_CROP !== '0'
const SHOT_JPEG_CROP_MAX_FRAME_BYTES = 2 * 1024 * 1024
const SHOT_JPEG_CROP_WORLD = 'dsh-shot-crop'

// Page-side visual-change probe (docs/HEADLESS.md §4.1.7/§4.1.8/§4.1.12). The
// repaint window above is a blind wait for a composited frame, so an action that
// cannot have painted anything (a read-only evaluate, a scroll that does not
// move the viewport, a click on a plain element, a key press with no editable
// focus and no UA default action) still pays it in full. The driver
// installs this tracker in every document and snapshots it around such an
// action; only a clean verdict keeps the previous change marker, which turns
// the next screenshot into a frame cache hit instead of a ~40ms wait. Anything
// the tracker cannot see (canvas pixels, media surfaces, same-origin subframe
// documents, asynchronous effects) keeps the conservative wait, and
// `DSH_HEADLESS_VISUAL_PROBE=0` disables the shortcut.
const VISUAL_PROBE_ENABLED = process.env.DSH_HEADLESS_VISUAL_PROBE !== '0'
const VISUAL_TRACKER_SCRIPT = `(() => {
  if (window.__dshVisual) return true
  const state = { mutations: 0, scrolls: 0, focus: 0, changes: 0, toggles: 0, broken: false }
  const docId = Math.random().toString(36).slice(2)
  try {
    new MutationObserver((records) => { state.mutations += records.length })
      .observe(document, { subtree: true, childList: true, attributes: true, characterData: true })
  } catch { state.broken = true }
  try {
    addEventListener('scroll', () => { state.scrolls += 1 }, true)
    addEventListener('focusin', () => { state.focus += 1 }, true)
    addEventListener('focusout', () => { state.focus += 1 }, true)
    // UA-level state that repaints without a DOM mutation: checkbox/radio/
    // select/file activation fires change, while popovers and command targets
    // fire beforetoggle/toggle. A clean click snapshot requires both counters
    // to stay put.
    addEventListener('change', () => { state.changes += 1 }, true)
    addEventListener('beforetoggle', () => { state.toggles += 1 }, true)
    addEventListener('toggle', () => { state.toggles += 1 }, true)
  } catch { state.broken = true }
  // A same-origin subframe document can be mutated by an evaluate but is not
  // covered by the observer above (different node tree), so its presence keeps
  // the conservative wait; cross-origin frames are unreachable from the page and
  // their own async paints are out of scope for this probe.
  const sameOriginFrame = () => {
    try {
      for (const frame of document.querySelectorAll('iframe, frame')) {
        try { if (frame.contentDocument) return true } catch { /* cross-origin access */ }
      }
      return false
    } catch { return true }
  }
  // UA state that a keystroke can change without a DOM mutation: which element
  // holds focus (and whether it can consume text), a non-collapsed document
  // selection, and fullscreen / picture-in-picture (Escape leaves those). The
  // press probe keeps the conservative wait while any of them is set
  // (docs/HEADLESS.md §4.1.12). A closed shadow root cannot be inspected, so a
  // custom-element host (tag with a hyphen) is treated as editable too.
  const activeState = () => {
    try {
      let el = document.activeElement
      for (let depth = 0; depth < 8 && el && el.shadowRoot && el.shadowRoot.activeElement; depth += 1) {
        el = el.shadowRoot.activeElement
      }
      if (!el || el === document.body || el === document.documentElement) {
        return { active: el ? String(el.tagName || '').toLowerCase() : '', editable: false, interactive: false }
      }
      const tag = String(el.tagName || '').toUpperCase()
      const role = String(el.getAttribute && el.getAttribute('role') || '').toLowerCase()
      const editable =
        tag.indexOf('-') >= 0 ||
        tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' ||
        tag === 'IFRAME' || tag === 'FRAME' || tag === 'OBJECT' || tag === 'EMBED' ||
        /^(textbox|searchbox|combobox|spinbutton)$/.test(role) ||
        Boolean(el.isContentEditable)
      const interactive = editable || Boolean(el.closest && el.closest('a[href], button, summary, label, area, [popovertarget], [commandfor], [tabindex]'))
      return { active: tag.toLowerCase(), editable, interactive }
    } catch {
      return { active: '', editable: true, interactive: true }
    }
  }
  const selectionState = () => {
    try {
      const selection = document.getSelection && document.getSelection()
      return Boolean(selection && selection.type === 'Range' && String(selection))
    } catch { return true }
  }
  const fullscreenState = () => {
    try {
      return Boolean(document.fullscreenElement || document.pictureInPictureElement)
    } catch { return true }
  }
  // ":hover" is UA state (docs/HEADLESS.md §4.1.13): moving the pointer onto a
  // styled element repaints with no DOM mutation and with no tracker counter, so
  // the clickAt probe compares the hover chain before and after. The UA hovers
  // exactly the ancestors of the element under the pointer, so the innermost
  // hovered element identifies the whole chain, and a child-index path
  // identifies that element without serialising tags or text.
  const pathOf = (el) => {
    const parts = []
    let node = el
    while (node && node.nodeType === 1) {
      let index = 0
      let sibling = node
      while ((sibling = sibling.previousElementSibling)) index += 1
      parts.push(index)
      node = node.parentElement
    }
    return parts.reverse().join('.')
  }
  const hoverPath = () => {
    try {
      const list = document.querySelectorAll(':hover')
      return list.length ? pathOf(list[list.length - 1]) : ''
    } catch { return null }
  }
  // A real left click runs UA default actions the tracker cannot see: navigation,
  // label/focus forwarding, form-control activation, media controls,
  // popover/command toggles, dialog dismissal, subframe input, contenteditable
  // carets, and custom elements (a shadow tree's inner ":hover" state is
  // invisible to the document-level hover chain). "null" means the click cannot
  // paint through any of those routes.
  const clickAtHazard = (el) => {
    try {
      if (!el || !el.closest) return 'unknown'
      if (el.closest('a[href], area[href]')) return 'navigation'
      if (el.closest('label')) return 'label-activation'
      if (el.closest('video, audio')) return 'media-control'
      if (el.closest('[popovertarget], [commandfor]')) return 'ua-toggle'
      if (el.closest('summary, details')) return 'ua-toggle'
      if (el.closest('dialog')) return 'dialog'
      if (el.closest('iframe, frame, object, embed')) return 'subframe'
      const button = el.closest('button')
      if (button) {
        // A button's own default action is form submission; only a submitter
        // (implicit type=submit) associated with a form can navigate.
        const type = String(button.getAttribute('type') || 'submit').toLowerCase()
        if ((button.form || button.closest('form')) && type !== 'button' && type !== 'reset') return 'form-submit'
        return 'button'
      }
      if (el.closest('input, select, textarea, [contenteditable], [tabindex]')) return 'form-control'
      for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
        if (String(node.tagName || '').indexOf('-') >= 0) return 'custom-element'
      }
    } catch {
      return 'unknown'
    }
    return null
  }
  window.__dshVisual = {
    // "px"/"py" are optional: when both are finite the snapshot also answers
    // "what is under this point" (hit hazard + the hover chain a pointer move
    // there would produce) and reports the current hover chain, which is only
    // meaningful for the pointer-driven click probe.
    snapshot(px, py) {
      // Canvas pixels and media surfaces repaint with no DOM mutation at all,
      // so their presence disables the shortcut (one scan covers both).
      const heavy = document.querySelector('canvas, video, audio')
      const active = activeState()
      const probePoint = Number.isFinite(px) && Number.isFinite(py) ? (() => {
        let hit = null
        try { hit = document.elementFromPoint(px, py) } catch { hit = null }
        return { x: px, y: py, hit: Boolean(hit), hazard: clickAtHazard(hit), hover: hit ? pathOf(hit) : null }
      })() : null
      return {
        doc: docId,
        url: location.href,
        readyState: document.readyState,
        mutations: state.mutations,
        scrolls: state.scrolls,
        focus: state.focus,
        changes: state.changes,
        toggles: state.toggles,
        animations: typeof document.getAnimations === 'function' ? document.getAnimations().length : -1,
        scroll: [window.scrollX, window.scrollY],
        active: active.active,
        editable: active.editable,
        interactive: active.interactive,
        selection: selectionState(),
        fullscreen: fullscreenState(),
        canvas: Boolean(heavy && heavy.tagName === 'CANVAS'),
        media: Boolean(heavy && (heavy.tagName === 'VIDEO' || heavy.tagName === 'AUDIO')),
        frames: sameOriginFrame(),
        broken: Boolean(state.broken),
        // Only computed for the pointer probe: the hover chain is the one paint
        // source a click can hit that no counter records, and every other action
        // (synthetic click, key press, evaluate) cannot move the real pointer.
        hover: probePoint ? hoverPath() : null,
        point: probePoint,
      }
    },
  }
  return true
})()`

// Viewer screencast materialization (docs/HEADLESS.md §4.1.6): the live viewer
// polls `/live/frame` every 300ms, so decoding and rewriting latest.<ext> +
// meta.json for every screencast frame (up to 30/s) is wasted work. Keep only
// the newest frame and flush it at most once per interval; a trailing timer
// makes sure the last frame of a burst still lands, and `tab.screencast_stop`
// flushes synchronously so the final frame is never dropped.
const SCREENCAST_WRITE_INTERVAL_MS = 100

// Keys the press probe may cover (docs/HEADLESS.md §4.1.12): only keys without
// a UA default action outside an editable field. Scrolling keys (arrows, page,
// home/end, space) keep the conservative wait because the compositor scroll can
// land after the after-snapshot; activation/navigation/reload keys (Enter on a
// focused control, Tab, F-keys) keep it because their effect may commit after
// the snapshot; and any editable/selection/fullscreen state keeps it too. The
// page's own key handlers are covered by the same tracker counters a click
// handler is; an asynchronous handler that paints later is out of scope for the
// probe exactly as it is for clicks.
const PRESS_PROBE_PRINTABLE = /^[!-~]$/

function pressProbeEligible(key, before) {
  if (!before) return false
  if (before.readyState !== 'complete') return false
  if (before.broken || before.canvas || before.media || before.frames) return false
  if (before.editable || before.selection || before.fullscreen) return false
  // A printable character has no UA default action outside an editable field.
  if (PRESS_PROBE_PRINTABLE.test(key)) return true
  // Escape leaves a dialog/popover/fullscreen or cancels a load: the first two
  // mutate the DOM (caught by the verdict) and the rest are excluded above.
  if (key === 'Escape') return true
  // Enter activates a focused control, so it only qualifies when the focused
  // element is not one the UA can activate.
  if (key === 'Enter') return !before.interactive
  return false
}

// A real left click at a screen point (docs/HEADLESS.md §4.1.13) can only be
// proven paint-free while every UA default action is out of reach: the pointer
// already rests on the element under (x, y) (a pointer move changes the CSS
// `:hover` chain, which repaints with no DOM mutation), focus sits on the body
// (a click can blur or focus something), no text is selected (a single click
// collapses a selection) and nothing is fullscreen. The page-side snapshot
// answers the hit question; everything else reads the same pre-action snapshot,
// so an ineligible click pays one round trip, not two.
const CLICK_AT_BODY_FOCUS = new Set(['', 'body', 'html'])

function clickAtProbeEligible(before, point) {
  if (!before || !before.point || !point) return false
  if (before.readyState !== 'complete') return false
  if (before.broken || before.canvas || before.media || before.frames) return false
  // `active` is the lowercased tag of document.activeElement: body and html mean
  // "nothing is focused", which is the only state a click cannot blur.
  if (before.editable || !CLICK_AT_BODY_FOCUS.has(before.active) || before.selection || before.fullscreen) return false
  const hit = before.point
  if (hit.x !== point.x || hit.y !== point.y) return false
  if (!hit.hit || hit.hazard !== null) return false
  // The chain the pointer move would produce must be the chain that is already
  // hovered; a fresh page has no hover chain at all, so its first click at a new
  // point keeps the conservative wait.
  if (!before.hover || hit.hover !== before.hover) return false
  return true
}

// `tab.drag` dispatches synthetic DragEvents (docs/HEADLESS.md §4.1.15). The UA
// performs no drag-and-drop default action for untrusted events, so unlike a
// real click there is no invisible navigation/focus/activation path to veto:
// a focus/selection change a page handler makes synchronously is still caught
// by the verdict's own active/selection comparison, and everything a handler
// mutates is a tracker counter. What remains are the pages whose paints are
// invisible to the tracker at all (canvas pixels, media surfaces, same-origin
// subframes), a tab that is still loading, and a fullscreen document.
function dragProbeEligible(before) {
  if (!before) return false
  if (before.readyState !== 'complete') return false
  if (before.broken || before.canvas || before.media || before.frames) return false
  if (before.fullscreen) return false
  return true
}

// `tab.type` (docs/HEADLESS.md §4.1.16) writes a field value and dispatches the
// input/change events a real keystroke would. Repeating the value a field
// already holds therefore repaints nothing: the value, the focused element and
// the caret all stay where they were (probe, /tmp/probe-type-r14.mjs: the same
// type followed by a screenshot paid the full repaint window and missed, the
// same value with a moved caret or focus did paint). `typePage` reports what it
// changed, so a value that really changed — or a caret/focus move, or a
// `submit` that can navigate later — vetoes the shortcut from the action's own
// result. The precheck only rules out the surfaces whose paints the tracker
// cannot see at all (canvas pixels, media surfaces, same-origin subframes), a
// tab that is still loading, and a fullscreen document; every page-side change
// a handler makes is a tracker counter.
function typeProbeEligible(before) {
  if (!before) return false
  if (before.readyState !== 'complete') return false
  if (before.broken || before.canvas || before.media || before.frames) return false
  if (before.fullscreen) return false
  return true
}

// `tab.select` (docs/HEADLESS.md §4.1.17) sets a select's option or a
// checkbox/radio's checked flag and dispatches `input`/`change` either way.
// Choosing the option a select already shows, or setting a checkbox to the
// state it already has, changes no state and repaints nothing (probe,
// /tmp/probe-paint-r15.mjs: the frame bytes are identical for the repeated
// action and differ for the real one), while the next screenshot used to wait
// out the full repaint window for a frame that cannot come. The state change is
// answered by the action's own page-side result, so the same vetoes apply as
// for `tab.type`: a handler's DOM work is a tracker counter, and only the
// surfaces the tracker cannot see at all (canvas pixels, media surfaces,
// same-origin subframes), a still-loading tab and a fullscreen document keep
// the conservative wait.
function selectProbeEligible(before) {
  if (!before) return false
  if (before.readyState !== 'complete') return false
  if (before.broken || before.canvas || before.media || before.frames) return false
  if (before.fullscreen) return false
  return true
}

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
// ------------------------------------------------ driver-side PNG crop (clip/ref)
// `tab.screenshot` with `clip`/`ref` has to return a region of the page. The
// frame stream already holds the last composited frame as a device-pixel PNG,
// so the region shot is decoded, cropped and re-encoded in the driver instead
// of forcing a fresh `Page.captureScreenshot` (~45ms, docs/HEADLESS.md §4.1.4).
// The byte-level helpers live in `src/headless-png.js`; decoded pixels are
// cached on the frame object, so repeated crops of an unchanged page skip the
// decode.

function error(code, message) {
  const err = new Error(message)
  err.code = code
  return err
}

// R-05: chrome_tabs {op:"new"} / attachTab / tab.goto must not become a
// local-file read primitive. Only http(s) and the literal about:blank are
// navigable; file:, data:, javascript:, chrome: and friends are refused before
// any Target.createTarget / Page.navigate call.
const SAFE_TAB_PROTOCOLS = new Set(['http:', 'https:'])

function safeTabUrl(raw) {
  const text = String(raw ?? '').trim()
  if (!text || text === 'about:blank') return 'about:blank'
  let parsed
  try {
    parsed = new URL(text)
  } catch {
    throw error('PROTECTED_PAGE', `not a valid URL: ${text}`)
  }
  if (!SAFE_TAB_PROTOCOLS.has(parsed.protocol)) {
    throw error('PROTECTED_PAGE', `only http(s) URLs are allowed, got ${parsed.protocol}`)
  }
  if (parsed.username || parsed.password) {
    throw error('PROTECTED_PAGE', 'URLs with embedded credentials are not allowed')
  }
  return parsed.toString()
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

// Interactive login window lifecycle (Q21). The driver keeps same-named
// facades; the launcher lookup and the shared error factory are injected so the
// module stays independent of this file's private helpers.
const headlessLogin = createHeadlessLogin({ chromeExecutable, error })

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

// ------------------------------------------------------------------ driver
export class HeadlessDriver {
  constructor({ home, logger, spawnImpl = spawn, profileDir = null, screenshotDir = null, downloadDir = null, visible = false, windowSize = null } = {}) {
    this.home = home
    this.visible = Boolean(visible)
    this.windowSize = windowSize || (this.visible ? { width: 1440, height: 900 } : null)
    this.logger = logger
    this.spawnImpl = spawnImpl
    this.profileDir = profileDir || path.join(home || '.', 'cache', 'dsh-chrome', 'headless', 'profile')
    this.chrome = null
    this.cdp = null
    this.browserVersion = null
    this.owners = new Map()
    this.tabs = new Map() // tabId -> tab (global; ids unique per owner group not guaranteed)
    this.nextTabId = 1
    this.startPromise = null
    this.screenshotDir = screenshotDir || path.join(home || '.', 'cache', 'dsh-chrome', 'headless', 'screenshots')
    this.screenshotDirReady = false
    this.screenshotSeq = 0
    this.downloadDir = downloadDir || path.join(home || '.', 'cache', 'dsh-chrome', 'headless', 'downloads')
    this.bySession = new Map()
    this.consoleBuffers = new Map()
    this.screencastDir = path.join(home || '.', 'cache', 'dsh-chrome', 'screencast')
    this.downloads = []
    this.downloadByGuid = new Map()
    this.idleTimer = null
    this.lastActivity = Date.now()
    this.loginProcess = null
    this.loginProfile = this.profileDir
    this.resumeUrl = null
    this.visibleMode = false
    this.autoPointerEnabled = process.env.DSH_AUTO_POINTER === '1'
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
      const profileDir = this.profileDir
      await fsp.mkdir(profileDir, { recursive: true })
      const activePortPath = path.join(profileDir, 'DevToolsActivePort')

      // Reuse a headless Chrome left over from a previous provider instance
      // (e.g. provider reload) instead of racing a second process on the same
      // profile. A stale DevToolsActivePort is removed before a fresh launch.
      try {
        const existing = parseDevToolsActivePort(fs.readFileSync(activePortPath, 'utf8'))
        if (existing) {
          const existingCdp = new Cdp(existing.url)
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
        buildLaunchArgs({
          visible: this.visible,
          profileDir,
          windowSize: this.windowSize,
          extraArgs: EXTRA_CHROME_ARGS,
        }),
        { stdio: ['ignore', 'ignore', 'pipe'] },
      )
      child.stderr?.on('data', (chunk) => this.logger?.debug?.('headless chrome: %s', String(chunk).trim().slice(0, 300)))
      this.chrome = child
      const deadline = Date.now() + 15000
      let activePort = null
      while (Date.now() < deadline) {
        try {
          activePort = parseDevToolsActivePort(fs.readFileSync(activePortPath, 'utf8'))
          if (activePort) break
        } catch {
          // not ready
        }
        await new Promise((resolve) => setTimeout(resolve, 150))
      }
      if (!activePort) throw error('HEADLESS_LAUNCH_FAILED', 'headless Chrome did not expose DevToolsActivePort')
      const cdp = new Cdp(activePort.url)
      cdp.onMessage((message) => this.onCdpEvent(message))
      await cdp.connect()
      this.cdp = cdp
      this.chrome.on('exit', (code) => {
        this.logger?.warn?.('headless Chrome exited: %s', code)
        this.cdp = null
        this.chrome = null
      })
      // These two CDP round trips are independent of each other; on a cold
      // browser each can take tens of milliseconds, so run them together.
      await fsp.mkdir(this.downloadDir, { recursive: true })
      const [version] = await Promise.all([
        cdp.send('Browser.getVersion').catch(() => null),
        cdp
          .send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: this.downloadDir, eventsEnabled: true })
          .catch((error) => this.logger?.warn?.('headless download behavior failed: %s', error?.message || String(error))),
      ])
      this.browserVersion = version?.product || null
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

  // Throttled viewer-frame materialization (§4.1.6). Runs at most once per
  // SCREENCAST_WRITE_INTERVAL_MS; if a flush just happened, arm one trailing
  // timer instead of dropping the frame so a page that changes once still ends
  // up on disk.
  scheduleScreencastFlush(tab) {
    const state = tab.screencast
    if (!state || state.flushTimer) return
    const waited = Date.now() - (state.lastWriteAt || 0)
    if (waited >= SCREENCAST_WRITE_INTERVAL_MS) {
      this.flushScreencastFrame(tab)
      return
    }
    state.flushTimer = setTimeout(() => {
      state.flushTimer = null
      this.flushScreencastFrame(tab)
    }, SCREENCAST_WRITE_INTERVAL_MS - waited)
    state.flushTimer.unref?.()
  }

  flushScreencastFrame(tab) {
    const state = tab.screencast
    const params = state?.pending
    if (!params) return
    state.pending = null
    state.lastWriteAt = Date.now()
    try {
      const data = Buffer.from(String(params.data || ''), 'base64')
      if (!state.dirReady) {
        fs.mkdirSync(this.screencastDir, { recursive: true })
        state.dirReady = true
      }
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
          owner: state.owner ?? null,
          backend: 'headless',
        })}\n`,
        { mode: 0o600 },
      )
    } catch {
      // best effort
    }
  }

  onNetworkEvent(tab, method, params) {
    // Thin delegate: console/network buffer mapping lives in headless-events.js.
    return handleNetworkEvent(tab, this.captureByTab.get(tab?.tabId), this.cdp.send.bind(this.cdp), method, params)
  }

  onCdpEvent(message) {
    const sessionTab = message.sessionId ? this.bySession.get(message.sessionId) : null
    if (handleConsoleEvent(this.consoleBuffers, sessionTab, message.method, message.params || {})) return
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
        // Decode + atomic write happen on flush, not per frame (§4.1.6).
        state.pending = params
        this.scheduleScreencastFlush(tab)
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
          const buffer = Buffer.from(data, 'base64')
          // Chrome can emit a frame of the wrong geometry right after a
          // capture-with-clip (observed 600x300 and 1440x720 frames where the
          // stream was asked for 1440x813): that is the clip/old surface, not
          // the viewport. Such a frame cannot be mapped back to CSS px, so it
          // must not become the cached frame; it counts as "no frame" so the
          // clip path takes its capture fallback immediately instead of waiting
          // a repaint window for a frame it cannot use.
          const pixelSize = shot.format === 'jpeg' ? jpegFrameSize(buffer) : pngFrameSize(buffer)
          const usable =
            !pixelSize ||
            (Math.abs(pixelSize.width - shot.maxWidth) <= 2 && Math.abs(pixelSize.height - shot.maxHeight) <= 2)
          if (usable) {
            shot.last = {
              buffer,
              composedAt,
              width: Number(params.metadata?.deviceWidth) || 0,
              height: Number(params.metadata?.deviceHeight) || 0,
            }
            this.resolveShotWaiters(shot)
          }
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
    const targetUrl = safeTabUrl(url)
    const created = await this.cdp.send('Target.createTarget', { url: targetUrl })
    const targetId = created.targetId
    const attached = await this.cdp.send('Target.attachToTarget', { targetId, flatten: true })
    const sessionId = attached.sessionId
    const tabId = this.nextTabId++
    if (this.tabs.size >= MAX_TABS) {
      throw error('RESOURCE_LIMIT', `headless tab limit reached (${MAX_TABS}); close a tab first`)
    }
    const tab = {
      tabId,
      targetId,
      sessionId,
      url: targetUrl,
      title: '',
      renderChangeAt: 0,
      shotStream: null,
      visualTracker: false,
      visualSkips: 0,
      renderChangeRetires: 0,
    }
    this.bySession.set(sessionId, tab)
    this.consoleBuffers.set(tabId, [])
    this.tabs.set(tabId, tab)
    entry.tabs.set(tabId, tab)
    entry.activeTabId = tabId
    // Both domain enables are independent; on a fresh target each cold round
    // trip is tens of milliseconds, so don't serialise them.
    await Promise.all([
      this.cdp.send('Page.enable', {}, sessionId).catch(() => {}),
      this.cdp.send('Runtime.enable', {}, sessionId).catch(() => {}),
    ])
    await this.installVisualTracker(tab)
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
    const resumeUrl = this.resumeUrl
    this.resumeUrl = null
    return this.attachTab(entry, resumeUrl || 'about:blank')
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

  async ensureOverlay(tab) {
    if (tab.overlayReady) return true
    const source = overlaySource()
    if (!source) return false
    await this.evalOn(tab, `(() => { if (!window.__dshOverlay) { ${source} } return Boolean(window.__dshOverlay) })()`)
    tab.overlayReady = true
    return true
  }

  async ensureFrameOverlays(tab) {
    if (tab.frameContexts) return tab.frameContexts
    const tree = await this.cdp.send('Page.getFrameTree', {}, tab.sessionId)
    const frames = []
    const walk = (node) => {
      frames.push({ frameId: node.frame.id, url: node.frame.url, parentFrameId: node.frame.parentId || null })
      for (const child of node.childFrames || []) walk(child)
    }
    if (tree?.frameTree) walk(tree.frameTree)
    const contexts = []
    for (const frame of frames) {
      try {
        const { executionContextId } = await this.cdp.send(
          'Page.createIsolatedWorld',
          { frameId: frame.frameId, worldName: 'dsh-overlay', grantUniveralAccess: false },
          tab.sessionId,
        )
        contexts.push({ ...frame, contextId: executionContextId })
      } catch {
        // A detached/crashed frame cannot host an overlay.
      }
    }
    tab.frameContexts = contexts
    return contexts
  }

  async evalInContext(tab, contextId, expression) {
    const result = await this.cdp.send(
      'Runtime.evaluate',
      { expression, contextId, returnByValue: true },
      tab.sessionId,
    )
    if (result.exceptionDetails) {
      const message = result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'frame evaluation failed'
      throw error('INTERNAL', String(message))
    }
    return result.result?.value
  }

  async autoPointer(tab, params = {}, kind = 'move') {
    if (!this.autoPointerEnabled) return null
    try {
      if (!(await this.ensureOverlay(tab))) return null
      const payload = {
        op: 'follow',
        ref: params.ref,
        selector: params.selector,
        x: params.x,
        y: params.y,
        label: 'DSH',
        pulse: kind === 'click' || kind === 'type' || kind === 'key',
      }
      const value = await this.evalOn(tab, `window.__dshOverlay.handle(${JSON.stringify(payload)})`)
      if (value && !value.skipped) {
        tab.renderChangeAt = Date.now() / 1000
        tab.overlayChangedAt = Date.now() / 1000
      }
      return value
    } catch {
      return null
    }
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

  // ------------------------------------------------- page-side visual probe
  // Installed once per tab: the script is registered for every future document
  // (including subframes) and evaluated once into the document that already
  // exists at attach time. A failure just leaves the tab without a probe, so
  // every action keeps the conservative repaint window.
  async installVisualTracker(tab) {
    if (!VISUAL_PROBE_ENABLED) return false
    try {
      // The registered script covers future documents (including subframes);
      // the direct evaluate installs the same tracker into the document that
      // already exists at attach time. They are independent round trips.
      await Promise.all([
        this.cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: VISUAL_TRACKER_SCRIPT }, tab.sessionId),
        this.evalOn(tab, VISUAL_TRACKER_SCRIPT),
      ])
      tab.visualTracker = true
    } catch {
      tab.visualTracker = false
    }
    return tab.visualTracker
  }

  async visualSnapshot(tab, point = null) {
    if (!VISUAL_PROBE_ENABLED || !tab.visualTracker) return null
    // The point form is only used by the pointer probe: it makes the page
    // answer the hit-test question in the same round trip as the snapshot.
    const args = point ? `${JSON.stringify(point.x)}, ${JSON.stringify(point.y)}` : ''
    try {
      return await this.evalOn(tab, `window.__dshVisual ? window.__dshVisual.snapshot(${args}) : null`)
    } catch {
      return null
    }
  }

  // Anything but a well-formed snapshot pair is treated as "cannot prove
  // anything": a page that shadows `window.__dshVisual` must not silently turn
  // the shortcut on.
  visualSnapshotShape(value) {
    return (
      Boolean(value) &&
      typeof value === 'object' &&
      typeof value.doc === 'string' &&
      typeof value.url === 'string' &&
      Number.isFinite(value.mutations) &&
      Number.isFinite(value.scrolls) &&
      Number.isFinite(value.focus) &&
      Number.isFinite(value.changes) &&
      Number.isFinite(value.toggles) &&
      Number.isFinite(value.animations) &&
      Array.isArray(value.scroll) &&
      Number.isFinite(value.scroll[0]) &&
      Number.isFinite(value.scroll[1]) &&
      typeof value.active === 'string' &&
      typeof value.editable === 'boolean' &&
      typeof value.interactive === 'boolean' &&
      typeof value.selection === 'boolean' &&
      typeof value.fullscreen === 'boolean' &&
      // Both are null for every action that is not the pointer probe (a new
      // field: an older shape must never be read as a clean hover chain).
      (value.hover === null || typeof value.hover === 'string') &&
      (value.point === null ||
        (typeof value.point === 'object' &&
          Number.isFinite(value.point.x) &&
          Number.isFinite(value.point.y) &&
          typeof value.point.hit === 'boolean' &&
          (value.point.hazard === null || typeof value.point.hazard === 'string') &&
          (value.point.hover === null || typeof value.point.hover === 'string')))
    )
  }

  // A snapshot pair only proves "painted nothing" when every surface the
  // tracker cannot observe is absent, the document did not change, and no
  // counter moved. `expected` lets an action compare against the counter events
  // it dispatched itself (a `tab.type` fires exactly one synthetic `change` and
  // reports it): anything beyond that count is still a veto.
  visualProbeVerdict(before, after, expected = null) {
    if (!this.visualSnapshotShape(before) || !this.visualSnapshotShape(after)) return 'unknown'
    if (before.broken || before.canvas || before.media || before.frames) return 'unknown'
    if (before.doc !== after.doc || before.url !== after.url || before.readyState !== after.readyState) return 'unknown'
    if (before.mutations !== after.mutations) return 'unknown'
    if (before.scrolls !== after.scrolls) return 'unknown'
    if (before.focus !== after.focus) return 'unknown'
    const expectedChanges = Number.isFinite(expected?.changes) ? expected.changes : 0
    if (before.changes + expectedChanges !== after.changes) return 'unknown'
    if (before.toggles !== after.toggles) return 'unknown'
    // -1 means the page has no Web Animations API: an animation could have
    // started unseen, so keep the conservative wait.
    if (before.animations < 0) return 'unknown'
    if (before.animations !== after.animations) return 'unknown'
    if (before.scroll[0] !== after.scroll[0] || before.scroll[1] !== after.scroll[1]) return 'unknown'
    // Focus/selection/fullscreen can move without a repaint and without a
    // tracker counter for some transitions; a change keeps the conservative
    // wait (the press probe's own eligibility checks also read these).
    if (before.active !== after.active || before.editable !== after.editable) return 'unknown'
    if (before.interactive !== after.interactive) return 'unknown'
    if (before.selection !== after.selection || before.fullscreen !== after.fullscreen) return 'unknown'
    // The pointer probe's hover chain: a hover change repaints with no counter.
    if (typeof before.hover === 'string' && typeof after.hover === 'string' && before.hover !== after.hover) return 'unknown'
    return 'clean'
  }

  // Runs `action` between two tracker snapshots. A clean verdict keeps the
  // previous change marker (`tab.skipRenderChange`), so the next screenshot
  // reuses the cached frame instead of waiting for a frame that cannot come.
  // `accept(value)` can veto the shortcut from the action's own result (a click
  // whose target may navigate or flip a form control); `precheck(before)` can
  // veto it from the pre-action state (a key press over an editable field). A
  // veto skips the second snapshot entirely, so ineligible actions pay one
  // round trip, not two. `point` makes both snapshots answer the hit-test /
  // hover question for a pointer action at that screen point. `expect(value)`
  // returns the counter deltas the action caused itself (a type's synthetic
  // `change` event), so the verdict does not read them as a paint.
  // `actionSnapshot(value)` lets an action that already makes a page round trip
  // carry its own pre-action snapshot back (`tab.type`): the caller promises it
  // was taken at the top of that evaluate, before the action ran. That form
  // spends no extra round trip on actions the accept then vetoes.
  async visualProbeAction(tab, action, accept = null, precheck = null, point = null, expect = null, actionSnapshot = null) {
    let before = actionSnapshot ? null : await this.visualSnapshot(tab, point)
    let value
    let failure = null
    try {
      value = await action()
    } catch (error) {
      failure = error
    }
    if (actionSnapshot && !failure) {
      try {
        before = actionSnapshot(value)
      } catch {
        before = null
      }
    }
    if (!before) {
      if (failure) throw failure
      return value
    }
    let eligible = true
    if (!failure) {
      if (precheck) {
        try {
          eligible = Boolean(precheck(before))
        } catch {
          eligible = false
        }
      }
      if (eligible && accept) {
        try {
          eligible = Boolean(accept(value))
        } catch {
          eligible = false
        }
      }
    }
    if (!failure && !eligible) return value
    const after = await this.visualSnapshot(tab, point)
    if (!failure) {
      let verdict = 'unknown'
      let expected = null
      if (expect) {
        try {
          expected = expect(value)
        } catch {
          expected = null
        }
      }
      try {
        verdict = this.visualProbeVerdict(before, after, expected)
      } catch {
        verdict = 'unknown'
      }
      if (verdict === 'clean') tab.skipRenderChange = true
    }
    if (failure) throw failure
    return value
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
        cropped: 0,
        jpegCropped: 0,
        fallbacks: 0,
        timeouts: 0,
        repaintMisses: 0,
        failures: 0,
        disabledUntil: 0,
        format: 'png',
        quality: 0,
        maxWidth: 0,
        maxHeight: 0,
        startedAt: 0,
        restarts: 0,
        framesAtIdleCheck: 0,
        last: null,
        waiters: [],
        stopTimer: null,
      }
    }
    return tab.shotStream
  }

  async ensureShotStream(tab, { format = 'png', quality = 0 } = {}) {
    if (!SHOT_STREAM_ENABLED) return null
    // The live viewer owns Page.startScreencast while it runs; screenshots fall
    // back to Page.captureScreenshot rather than fighting over the stream.
    if (tab.screencast?.active) return null
    const streamQuality = format === 'jpeg' ? quality : 0
    const state = this.shotStreamState(tab)
    const now = Date.now()
    if (state.disabledUntil > now) return null
    const viewport = await this.viewportSize(tab)
    const dpr = viewport.dpr || 1
    const maxWidth = Math.max(1, Math.round((viewport.w || 0) * dpr))
    const maxHeight = Math.max(1, Math.round((viewport.h || 0) * dpr))
    if (state.active) {
      if (
        state.maxWidth === maxWidth &&
        state.maxHeight === maxHeight &&
        state.format === format &&
        state.quality === streamQuality
      ) {
        return state
      }
      // A PNG frame cannot serve a JPEG request (or a different JPEG quality),
      // so switch the stream instead of returning the cached frame.
      await this.stopShotStream(tab)
    }
    // A hidden target (any non-active headless tab) is not composited, so its
    // screencast would never produce a frame. Keep the capture path there.
    if (!(await this.pageVisible(tab))) return null
    try {
      const params = { format, maxWidth, maxHeight, everyNthFrame: 1 }
      if (format === 'jpeg') params.quality = quality
      await this.cdp.send('Page.startScreencast', params, tab.sessionId)
    } catch {
      state.failures += 1
      if (state.failures >= SHOT_STREAM_FAILURES_BEFORE_BACKOFF) state.disabledUntil = now + SHOT_STREAM_BACKOFF_MS
      return null
    }
    state.active = true
    state.frames = 0
    state.restarts += 1
    state.last = null
    state.format = format
    state.quality = streamQuality
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
    state.framesAtIdleCheck = state.frames
    state.stopTimer = setTimeout(async () => {
      state.stopTimer = null
      if (!state.active) return
      // A screenshot is in flight: the frame it is waiting for is not an
      // "unattended" repaint, so keep the stream for it.
      if (state.waiters.length > 0) {
        this.touchShotStream(tab, state)
        return
      }
      // A visible page that produced no frame during the idle window is static:
      // keeping the stream (and its cached frame) alive turns the next screenshot
      // into a cache hit instead of a stream restart. Hidden tabs are not
      // composited, so their cached frame may predate page changes that happened
      // while hidden; drop it instead of serving it later.
      const idleFrames = state.frames - state.framesAtIdleCheck
      if (
        SHOT_STREAM_KEEPALIVE &&
        state.served > 0 &&
        idleFrames === 0 &&
        (await this.pageVisible(tab))
      ) {
        this.touchShotStream(tab, state)
        return
      }
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

  // `clip` is CSS px (same contract as the desktop backend); `ref` resolves to
  // the element's viewport box, which is exactly the box the extension captures.
  // `fullPage` overrides both, so it never reaches here.
  async resolveScreenshotClip(tab, params) {
    const raw = params?.clip
    if (raw && typeof raw === 'object') {
      const x = Number(raw.x)
      const y = Number(raw.y)
      const width = Number(raw.width)
      const height = Number(raw.height)
      if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) {
        throw error('INVALID_ARGUMENT', 'clip must be {x,y,width,height} with positive width/height')
      }
      return { x, y, width, height }
    }
    if (params?.ref != null) {
      const ref = Number(params.ref)
      const box = await this.evalOn(
        tab,
        `(() => { const el = document.querySelector('[data-dsh-ref="${Number.isFinite(ref) ? ref : -1}"]'); if (!el) return null; const rect = el.getBoundingClientRect(); return { x: rect.x, y: rect.y, width: rect.width, height: rect.height } })()`,
      ).catch(() => null)
      if (!box || !(Number(box.width) > 0) || !(Number(box.height) > 0)) {
        throw error('REF_STALE', `ref ${params.ref} has no visible box; take a new snapshot`)
      }
      return { x: Number(box.x), y: Number(box.y), width: Number(box.width), height: Number(box.height) }
    }
    return null
  }

  // Crop a CSS-px region out of a device-pixel frame, re-encoding it as PNG.
  // Returns null when the region is fully outside the frame or the frame is not
  // a decodable 8-bit RGB/RGBA PNG — the caller then falls back to capture.
  // Only the top-left prefix that contains the crop is decoded (see
  // `unfilterPngRows` in headless-png.js) and the result is kept on the frame
  // object, so repeated shots of an unchanged page skip both the decode and the
  // frame wait.
  async cropScreenshotFrame(tab, frame, clip) {
    const size = frame.pngSize || (frame.pngSize = pngFrameSize(frame.buffer))
    if (!size) return null
    const viewport = await this.viewportSize(tab)
    const scale = size.width / (viewport.w || size.width)
    const requestedX = Math.round(clip.x * scale)
    const requestedY = Math.round(clip.y * scale)
    const requestedWidth = Math.max(1, Math.round(clip.width * scale))
    const requestedHeight = Math.max(1, Math.round(clip.height * scale))
    if (
      requestedX >= size.width ||
      requestedY >= size.height ||
      requestedX + requestedWidth <= 0 ||
      requestedY + requestedHeight <= 0
    ) {
      return null
    }
    const x = Math.max(0, requestedX)
    const y = Math.max(0, requestedY)
    const width = Math.min(size.width - x, requestedWidth - (x - requestedX))
    const height = Math.min(size.height - y, requestedHeight - (y - requestedY))
    if (width < 1 || height < 1) return null
    const neededColumns = x + width
    const neededRows = y + height
    let decoded = frame.decoded
    if (
      !decoded ||
      decoded.width !== size.width ||
      decoded.height !== size.height ||
      decoded.decodedWidth < neededColumns ||
      decoded.decodedHeight < neededRows
    ) {
      decoded = decodePngFrame(frame.buffer, { maxColumns: neededColumns, maxRows: neededRows })
      if (!decoded) return null
      frame.decoded = decoded
    }
    const { channels, pixels } = decoded
    const stride = decoded.decodedWidth * channels
    const cropped = Buffer.allocUnsafe(width * height * channels)
    for (let row = 0; row < height; row += 1) {
      pixels.copy(
        cropped,
        row * width * channels,
        (y + row) * stride + x * channels,
        (y + row) * stride + (x + width) * channels,
      )
    }
    return encodePngFrame(width, height, channels, cropped)
  }

  // The same region crop for JPEG frames, which the driver cannot decode
  // itself. The page has a JPEG codec (the one that decoded the <img> the user
  // is looking at), so the crop is done there with `createImageBitmap` +
  // `canvas.toDataURL('image/jpeg', q)`, and the frame is passed in as a
  // `data:` URL. Two properties make that safe and cheap:
  //
  // - The code runs in a **dedicated isolated world** (`Page.createIsolatedWorld`).
  //   Page scripts have their own globals and DOM prototypes there, so a page
  //   cannot patch `createImageBitmap`/`toDataURL` to break the crop or to forge
  //   pixels for its own screenshot. Anything that fails (context destroyed by a
  //   navigation, no canvas support, encode error, malformed output) returns
  //   null and the caller falls back to a full-viewport capture + crop and then
  //   to Page.captureScreenshot with the clip.
  // - The frame bytes are cached on the isolated world's `window` under a token
  //   derived from the frame (composition timestamp + encoded size). Re-cropping
  //   an unchanged frame therefore skips the transfer; only a new frame pays it.
  //
  // Cost is content-dependent: a light text page crops in ~5ms, a fully-detailed
  // frame pays a full decode (~10ms) + crop encode (~10ms), still ~half of the
  // ~50ms capture. Frames above SHOT_JPEG_CROP_MAX_FRAME_BYTES keep capture.
  async shotCropContext(tab) {
    if (tab.shotCropWorld != null) return tab.shotCropWorld
    // A new world has no cached frame, so the next crop embeds the bytes again.
    tab.shotCropFrameToken = null
    try {
      const tree = await this.cdp.send('Page.getFrameTree', {}, tab.sessionId)
      const frameId = tree?.frameTree?.frame?.id
      if (!frameId) return null
      const world = await this.cdp.send(
        'Page.createIsolatedWorld',
        { frameId, worldName: SHOT_JPEG_CROP_WORLD },
        tab.sessionId,
      )
      const contextId = world?.executionContextId
      tab.shotCropWorld = Number.isFinite(contextId) ? contextId : null
      return tab.shotCropWorld
    } catch {
      tab.shotCropWorld = null
      return null
    }
  }

  async cropJpegScreenshotFrame(tab, frame, clip, quality) {
    if (!frame?.buffer) return null
    if (!frame.jpegSize) frame.jpegSize = jpegFrameSize(frame.buffer)
    return this.cropJpegBuffer(tab, frame.buffer, frame.jpegSize, clip, quality, `${frame.composedAt}:${frame.buffer.length}`)
  }

  // A JPEG+clip shot whose frame-stream crop could not be used is served by
  // capturing the **whole viewport** and cropping that, never by capturing with
  // a clip while the stream runs: a clip capture makes Chrome's screencast emit
  // frames sized to the clip for this tab, which poisons every later crop
  // (measured; see docs/HEADLESS.md §4.1.9). The full capture also repaints the
  // full surface, so the next stream crop has a usable frame again.
  async captureFullJpegClip(tab, clip, quality) {
    if (!SHOT_JPEG_CROP_ENABLED) return null
    try {
      const shot = await this.cdp.send(
        'Page.captureScreenshot',
        { format: 'jpeg', quality, captureBeyondViewport: false },
        tab.sessionId,
      )
      if (!shot?.data) return null
      const buffer = Buffer.from(shot.data, 'base64')
      return await this.cropJpegBuffer(tab, buffer, jpegFrameSize(buffer), clip, quality, `capture:${Date.now()}`)
    } catch {
      return null
    }
  }

  // The exact clipped capture. Cheap (Chrome encodes only the region) and used
  // for a cold JPEG region shot *before* any screencast exists for the tab;
  // afterwards the stream is warmed for the shots that follow. The caller must
  // not use this while the stream is running — see captureFullJpegClip.
  async captureClippedJpeg(tab, clip, quality) {
    try {
      const shot = await this.cdp.send(
        'Page.captureScreenshot',
        { format: 'jpeg', quality, captureBeyondViewport: false, clip: { ...clip, scale: 1 } },
        tab.sessionId,
      )
      if (!shot?.data) return null
      return Buffer.from(shot.data, 'base64')
    } catch {
      return null
    }
  }

  async cropJpegBuffer(tab, buffer, size, clip, quality, token) {
    if (!SHOT_JPEG_CROP_ENABLED) return null
    if (!buffer || !size) return null
    if (buffer.length > SHOT_JPEG_CROP_MAX_FRAME_BYTES) return null
    const viewport = await this.viewportSize(tab)
    // Chrome can emit frames of the wrong geometry right after a capture with a
    // clip (observed 1440x720 and 600x300 where the stream was asked for
    // 1440x813). Cropping one of those would silently return the right region
    // at the wrong resolution, so anything that does not match the current
    // device size keeps the capture path instead. The +-2px tolerance covers
    // encoder rounding.
    const expectedWidth = Math.max(1, Math.round((viewport.w || size.width) * (viewport.dpr || 1)))
    const expectedHeight = Math.max(1, Math.round((viewport.h || size.height) * (viewport.dpr || 1)))
    if (Math.abs(size.width - expectedWidth) > 2 || Math.abs(size.height - expectedHeight) > 2) return null
    const scale = size.width / (viewport.w || size.width)
    const requestedX = Math.round(clip.x * scale)
    const requestedY = Math.round(clip.y * scale)
    const requestedWidth = Math.max(1, Math.round(clip.width * scale))
    const requestedHeight = Math.max(1, Math.round(clip.height * scale))
    if (
      requestedX >= size.width ||
      requestedY >= size.height ||
      requestedX + requestedWidth <= 0 ||
      requestedY + requestedHeight <= 0
    ) {
      return null
    }
    const x = Math.max(0, requestedX)
    const y = Math.max(0, requestedY)
    const width = Math.min(size.width - x, requestedWidth - (x - requestedX))
    const height = Math.min(size.height - y, requestedHeight - (y - requestedY))
    if (width < 1 || height < 1) return null
    const encodeQuality = Math.max(0.1, Math.min(1, quality / 100))
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const contextId = await this.shotCropContext(tab)
      if (contextId == null) return null
      const reuse = tab.shotCropFrameToken === token
      const expression = `(async () => {
  ${reuse ? '' : `window.__dshShotFrame = ${JSON.stringify(buffer.toString('base64'))}`}
  const image = await createImageBitmap(await (await fetch('data:image/jpeg;base64,' + window.__dshShotFrame)).blob())
  const canvas = document.createElement('canvas')
  canvas.width = ${width}
  canvas.height = ${height}
  canvas.getContext('2d').drawImage(image, ${x}, ${y}, ${width}, ${height}, 0, 0, ${width}, ${height})
  image.close()
  const url = canvas.toDataURL('image/jpeg', ${encodeQuality})
  return url.slice(url.indexOf(',') + 1)
})()`
      let value
      try {
        const result = await this.cdp.send(
          'Runtime.evaluate',
          { expression, contextId, returnByValue: true, awaitPromise: true },
          tab.sessionId,
        )
        if (result.exceptionDetails) {
          throw new Error(result.exceptionDetails.exception?.description || 'jpeg crop failed')
        }
        value = result.result?.value
      } catch {
        // The isolated world dies with its document (navigation). Drop it and
        // retry once with a fresh world; the retry re-embeds the frame.
        tab.shotCropWorld = null
        tab.shotCropFrameToken = null
        continue
      }
      if (typeof value !== 'string' || value.length < 32) return null
      const bytes = Buffer.from(value, 'base64')
      if (
        bytes.length < 128 ||
        bytes[0] !== 0xff ||
        bytes[1] !== 0xd8 ||
        bytes[2] !== 0xff ||
        bytes[bytes.length - 2] !== 0xff ||
        bytes[bytes.length - 1] !== 0xd9
      ) {
        // Do not trust the world's frame cache after a malformed result.
        tab.shotCropFrameToken = null
        return null
      }
      tab.shotCropFrameToken = token
      return bytes
    }
    return null
  }

  // A change marker is a *promise* that a paint is owed: `tab.screenshot` waits
  // up to SHOT_STREAM_FRAME_TIMEOUT_MS for a frame composed at or after it.
  // Two independent pieces of evidence can retire that promise once the marker
  // is already older than the wait the driver grants: (a) the wait expired with
  // no frame (see screenshotFromStream), and (b) a probe proved the following
  // action paint-free. Without retirement the marker stays in the future
  // forever, so *every* later screenshot re-pays the full window for a paint
  // that is already known not to come — one conservative no-op could poison
  // all screenshot latency that follows it. Lowering the marker to the newest
  // painted frame is safe for a late paint: a frame that composes afterwards
  // still updates `state.last` and is served by the freshness check, so only
  // the repeated wait is dropped, never a frame that has arrived.
  retireRenderChange(tab) {
    const last = tab.shotStream?.last
    const marker = tab.renderChangeAt || 0
    if (!last || !Number.isFinite(last.composedAt)) return false
    if (last.composedAt >= marker) return false
    tab.renderChangeAt = last.composedAt
    tab.renderChangeRetires = (tab.renderChangeRetires || 0) + 1
    return true
  }

  // Returns a PNG buffer for the current viewport (or for the requested `clip`
  // region), or null when no frame is available at all (caller falls back to
  // Page.captureScreenshot).
  //
  // Freshness rule: a cached frame is only reused when its composition
  // timestamp is at or after the last page-changing request. Otherwise wait for
  // the compositor's next frame. If that frame does not arrive within
  // SHOT_STREAM_FRAME_TIMEOUT_MS the change was not painted (yet), so the
  // latest painted frame is returned — that is still what the page looks like,
  // and a capture would force a repaint just to show the same pixels. The wait
  // is longer for the very first frame of a new stream (Chrome has to start the
  // capture pipeline), where there is no cached frame to fall back on. A miss
  // also retires the marker (see retireRenderChange): the window was granted
  // once for that change, so screenshots issued later must not grant it again.
  //
  // JPEG + clip is the one case that does not wait for a first frame: nothing
  // is cached yet on a just-started stream, and taking the capture right away
  // (see captureJpegClip, ~full-viewport capture + crop) is cheaper than the
  // up-to-150ms first-frame wait. The stream keeps warming in the background,
  // so the next clip shot within the idle window is a crop.
  async screenshotFromStream(tab, options = {}) {
    const state = await this.ensureShotStream(tab, options)
    if (!state) return null
    if (options.clip && options.format === 'jpeg' && !state.last) return null
    const changeAt = tab.renderChangeAt || 0
    let repaintMiss = false
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
        repaintMiss = true
        frame = state.last
        // The window has been paid for this marker and it produced no frame:
        // retire it, otherwise this same wait is re-paid by every screenshot
        // that follows (measured: one conservative no-op made all later shots
        // cost ~43ms instead of ~1ms, docs/HEADLESS.md §4.1.14).
        this.retireRenderChange(tab)
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
    if (!options.clip) return frame.buffer
    if (options.format === 'jpeg') {
      // A repaint-miss frame is the *previous* paint: honest for a page that
      // provably did not repaint, but the JPEG crop path cannot tell the two
      // apart from its own side, so it keeps the capture for that case instead
      // of possibly returning pre-action pixels. (The PNG path has always used
      // the miss frame; its bytes are lossless and driver-side, so a stale
      // frame there is a freshness question, not a resolution one.)
      if (repaintMiss) {
        state.fallbacks += 1
        return null
      }
      const jpegCropped = await this.cropJpegScreenshotFrame(tab, frame, options.clip, options.quality)
      if (jpegCropped) {
        state.cropped += 1
        state.jpegCropped += 1
        return jpegCropped
      }
      state.fallbacks += 1
      return null
    }
    const cropped = await this.cropScreenshotFrame(tab, frame, options.clip)
    if (!cropped) {
      state.fallbacks += 1
      return null
    }
    state.cropped += 1
    return cropped
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
      await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS))
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
    // A previous request that proved itself paint-free leaves the flag clear
    // before dispatching, so only a verdict from *this* action can skip the
    // change marker (`tab.evaluate` / `tab.scroll` set it inside dispatch).
    const before = this.tabForParams(params)
    if (before) before.skipRenderChange = false
    const result = await this.dispatch(method, params)
    if (SHOT_STREAM_METHODS.has(method)) {
      const tab = this.tabForParams(params)
      if (tab) {
        if (tab.skipRenderChange) {
          tab.skipRenderChange = false
          tab.visualSkips = (tab.visualSkips || 0) + 1
          // A proven paint-free action also retires an older marker, but only
          // once that marker is older than the repaint window the driver grants
          // anyway: a paint requested moments ago can still be in flight, and
          // this proof says nothing about it. Waiting out the window first means
          // this path never shortens a wait — it only stops granting it twice
          // (docs/HEADLESS.md §4.1.14).
          if (Date.now() / 1000 - (tab.renderChangeAt || 0) > SHOT_STREAM_FRAME_TIMEOUT_MS / 1000) {
            this.retireRenderChange(tab)
          }
        } else {
          tab.renderChangeAt = Date.now() / 1000
        }
      }
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
        const tab = await this.ensureTab(owner, params.tabId)
        await this.syncTabMeta(tab)
        let origin = null
        try {
          const parsed = new URL(tab.url)
          if (parsed.protocol === 'http:' || parsed.protocol === 'https:') origin = parsed.origin
        } catch {
          origin = null
        }
        return { origin, url: tab.url, title: tab.title, tabId: tab.tabId }
      }
      case 'tab.tabs':
        return this.tabsRequest(owner, params)
      case 'tab.goto': {
        const url = safeTabUrl(params.url)
        const tab = await this.ensureTab(owner, params.tabId)
        tab.overlayReady = false
        tab.frameContexts = null
        await this.cdp.send('Page.navigate', { url }, tab.sessionId)
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
        // Re-selecting the option a select already shows (or setting a checkbox
        // to the state it is already in) dispatches the same input/change events
        // as a real change but moves no state, so it cannot repaint: keep the
        // change marker and let the next screenshot reuse the cached frame
        // (docs/HEADLESS.md §4.1.17). The page-side result reports whether the
        // state actually moved and carries the pre-action tracker snapshot back
        // in the same evaluate, so a real change — the common case — pays only
        // the page-side snapshot work and is vetoed before the second snapshot.
        // The single synthetic `change` event is declared to the verdict as the
        // action's own counter; a handler dispatching another one still vetoes.
        const result = await this.visualProbeAction(
          tab,
          () =>
            this.pageAction(tab, 'selectPage', [
              params.ref ?? null,
              params.selector ?? null,
              params.value ?? null,
              params.checked,
              VISUAL_PROBE_ENABLED,
            ]),
          (value) => value?.ok === true && value.changed === false,
          (before) => selectProbeEligible(before),
          null,
          (value) => ({ changes: Number(value?.changeEvents) === 1 ? 1 : 0 }),
          (value) => (value?.ok === true && value.probeBefore ? value.probeBefore : null),
        )
        if (!result?.ok) throw error(result?.code || 'REF_NOT_FOUND', result?.message || 'select failed')
        return { ok: true, tag: result.tag, value: result.value }
      }
      case 'tab.drag': {
        const tab = await this.ensureTab(owner, params.tabId)
        // A synthetic drag that leaves every tracker counter untouched cannot
        // have painted, so the next screenshot reuses the cached frame instead
        // of paying the repaint window (docs/HEADLESS.md §4.1.15).
        const result = await this.visualProbeAction(
          tab,
          () => this.pageAction(tab, 'dragPage', [params.fromRef, params.toRef]),
          (value) => value?.ok === true,
          (before) => dragProbeEligible(before),
        )
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
      case 'tab.overlay': {
        const tab = await this.ensureTab(owner, params.tabId)
        const payload = { ...params }
        delete payload.owner
        delete payload.tabId
        if (payload.frame) {
          delete payload.frame
          const contexts = await this.ensureFrameOverlays(tab)
          let firstError = null
          for (const context of contexts) {
            try {
              await this.evalInContext(tab, context.contextId, `(() => { if (!window.__dshOverlay) { ${overlaySource()} } return true })()`)
              const value = await this.evalInContext(tab, context.contextId, `window.__dshOverlay.handle(${JSON.stringify(payload)})`)
              if (value?.ok) {
                tab.renderChangeAt = Date.now() / 1000
                tab.overlayChangedAt = Date.now() / 1000
                return { ...value, frameId: context.frameId, frameUrl: context.url }
              }
              if (value && !firstError) firstError = { ...value, frameId: context.frameId, frameUrl: context.url }
            } catch {
              // try the next frame
            }
          }
          return firstError || { ok: false, error: 'FRAME_TARGET_NOT_FOUND' }
        }
        if (!(await this.ensureOverlay(tab))) throw error('UNSUPPORTED_BACKEND', 'overlay script is not available')
        if (String(params.op) === 'auto') this.autoPointerEnabled = params.enabled !== false
        const result = await this.evalOn(tab, `window.__dshOverlay.handle(${JSON.stringify(payload)})`)
        // Overlay changes are page paints; make the next screenshot wait for a
        // fresh frame instead of serving the cached pre-overlay frame.
        tab.renderChangeAt = Date.now() / 1000
        tab.overlayChangedAt = Date.now() / 1000
        return result
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
        // A click on a plain element (no navigation, no form control, no media
        // control) that leaves every page-side counter untouched cannot have
        // painted, so the next screenshot is a frame cache hit instead of a
        // ~40ms repaint-window wait (docs/HEADLESS.md §4.1.8). `hazard` vetoes
        // the shortcut for targets whose UA default action paints invisibly to
        // the tracker; the veto also skips the second snapshot.
        const result = await this.visualProbeAction(
          tab,
          () => this.pageAction(tab, 'clickPage', [params.ref ?? null, params.selector ?? null, params.clickCount || 1, params.button === 'right' ? 2 : params.button === 'middle' ? 1 : 0]),
          (value) => value?.ok === true && value.hazard === null,
        )
        if (!result?.ok) throw error(result?.code || 'REF_NOT_FOUND', result?.message || 'click failed')
        if (result.url) tab.url = result.url
        if (result.title != null) tab.title = result.title
        await this.autoPointer(tab, params, 'click')
        return { ok: true, tag: result.tag, label: result.label, tabId: tab.tabId }
      }
      case 'tab.type': {
        const tab = await this.ensureTab(owner, params.tabId)
        // A type that leaves the field value, the focused element and the caret
        // exactly as they were (repeating the value a field already holds)
        // cannot repaint, so the next screenshot is a frame cache hit instead of
        // a ~40ms repaint-window wait (docs/HEADLESS.md §4.1.16). The page-side
        // result is the proof: a changed value, a moved caret or a focus move is
        // a real paint, and a `submit` can navigate after the snapshot. Those
        // veto after the action, so a type that does change something never pays
        // the second snapshot. The single synthetic `change` event is declared
        // to the verdict as the action's own counter, not a paint. `typePage`
        // carries its own pre-action tracker snapshot back (the type is one page
        // round trip either way), so even the common value-changing type pays
        // only the page-side snapshot work, not an extra round trip.
        const result = await this.visualProbeAction(
          tab,
          () =>
            this.pageAction(tab, 'typePage', [
              params.ref ?? null,
              params.selector ?? null,
              String(params.text ?? ''),
              Boolean(params.replace),
              Boolean(params.submit),
              VISUAL_PROBE_ENABLED,
            ]),
          (value) => value?.ok === true && value.changed === false && value.submitted === false,
          (before) => typeProbeEligible(before),
          null,
          (value) => ({ changes: Number(value?.changeEvents) === 1 ? 1 : 0 }),
          (value) => (value?.ok === true && value.probeBefore ? value.probeBefore : null),
        )
        if (!result?.ok) throw error(result?.code || 'REF_NOT_FOUND', result?.message || 'type failed')
        await this.autoPointer(tab, params, 'type')
        return { ok: true, value: result.value, submitted: result.submitted, tabId: tab.tabId }
      }
      case 'tab.clickAt': {
        const tab = await this.ensureTab(owner, params.tabId)
        const x = Number(params.x)
        const y = Number(params.y)
        const clickCount = params.clickCount || 1
        // A real left click at a point where the pointer already rests, on a
        // target no UA default action can reach, cannot paint: the pointer move
        // is a no-op hover update, focus stays on the body and a click handler's
        // DOM work is caught by the tracker counters (docs/HEADLESS.md §4.1.13).
        // A double click selects text and a non-left button has its own UA
        // action, so only the plain single left click is covered; everything
        // else keeps the conservative wait (the precheck always vetoes).
        const leftClick = params.button == null || params.button === 'left'
        const point = leftClick && clickCount === 1 && Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null
        await this.visualProbeAction(
          tab,
          async () => {
            await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, tab.sessionId)
            await this.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount }, tab.sessionId)
            await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount }, tab.sessionId)
            return true
          },
          null,
          (before) => (point ? clickAtProbeEligible(before, point) : false),
          point,
        )
        await this.autoPointer(tab, params, 'click')
        return { ok: true, tabId: tab.tabId, x, y }
      }
      case 'tab.hover': {
        const tab = await this.ensureTab(owner, params.tabId)
        // Hover shares clickPage (it dispatches the same synthetic events), so it
        // shares the click probe and its target hazards (docs/HEADLESS.md §4.1.8).
        const result = await this.visualProbeAction(
          tab,
          () => this.pageAction(tab, 'clickPage', [params.ref ?? null, params.selector ?? null, 1, 0]),
          (value) => value?.ok === true && value.hazard === null,
        )
        if (result?.ok) await this.autoPointer(tab, params, 'hover')
        return result?.ok ? { ok: true, tag: result.tag, label: result.label, tabId: tab.tabId } : { ok: false, message: result?.message }
      }
      case 'tab.scroll': {
        const tab = await this.ensureTab(owner, params.tabId)
        const amount = Number(params.amount || 600)
        const direction = String(params.direction || 'down')
        // Scroll and read the resulting position in a single evaluate. `moved`
        // lets the driver keep the previous change marker when the viewport did
        // not actually move (already at the boundary): such a scroll cannot have
        // repainted anything, so the next screenshot is a frame cache hit
        // instead of a repaint-window wait (docs/HEADLESS.md §4.1.7). Smooth
        // scrolling animates after this evaluate returns, so it keeps the
        // conservative marker.
        const scrollCall =
          direction === 'top' || direction === 'bottom'
            ? `window.scrollTo(0, ${direction === 'top' ? 0 : 'document.body.scrollHeight'})`
            : `window.scrollBy(0, ${direction === 'up' ? -amount : amount})`
        const expression = `(() => {
          const smooth = [document.documentElement, document.body].some((el) => el && getComputedStyle(el).scrollBehavior === 'smooth')
          const beforeX = window.scrollX
          const beforeY = window.scrollY
          ${scrollCall}
          const x = window.scrollX
          const y = window.scrollY
          return { x, y, moved: x !== beforeX || y !== beforeY, smooth }
        })()`
        const pos = await this.evalOn(tab, expression)
        if (pos && pos.moved === false && pos.smooth === false) tab.skipRenderChange = true
        return { ok: true, tabId: tab.tabId, x: pos?.x ?? 0, y: pos?.y ?? 0 }
      }
      case 'tab.press': {
        const tab = await this.ensureTab(owner, params.tabId)
        const key = String(params.key || '')
        const keyCode = key === 'Enter' ? 13 : key === 'Tab' ? 9 : key === 'Escape' ? 27 : 0
        // A key press with no UA default action outside an editable field cannot
        // paint unless a page handler changes something the tracker sees, so the
        // same probe the click path uses keeps the previous change marker and
        // the next screenshot reuses the cached frame instead of paying the
        // repaint window (docs/HEADLESS.md §4.1.12). `pressProbeEligible` vetoes
        // the key classes whose effect can commit after the after-snapshot;
        // a veto skips the second snapshot entirely.
        const result = await this.visualProbeAction(
          tab,
          async () => {
            await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode: keyCode }, tab.sessionId)
            await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: keyCode }, tab.sessionId)
            return { ok: true, tabId: tab.tabId, key }
          },
          null,
          (before) => pressProbeEligible(key, before),
        )
        return result
      }
      case 'tab.history': {
        const tab = await this.ensureTab(owner, params.tabId)
        tab.overlayReady = false
        tab.frameContexts = null
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
        const quality = Math.max(1, Math.min(100, Number(params.quality) || 70))
        // Element/region semantics match the desktop backend: `clip` is CSS px,
        // `ref` is the element's viewport box, and `fullPage` overrides both.
        const fullPage = Boolean(params.fullPage)
        const clip = fullPage ? null : await this.resolveScreenshotClip(tab, params)
        // A plain viewport shot (the common case for both formats) is served
        // from the compositor's own frames, PNG clip/ref shots are cropped out
        // of that frame in the driver (see cropScreenshotFrame), and JPEG
        // clip/ref shots are cropped by the page's own codec inside an isolated
        // world (see cropJpegScreenshotFrame, docs/HEADLESS.md §4.1.9). The
        // slow-PNG opt-out, full-page, frameRef and highlight keep the exact
        // Page.captureScreenshot path; the resolved clip is passed through so
        // the fallback is still the requested region (except for JPEG regions,
        // which take the clipped capture before the stream exists and a
        // full-viewport capture + crop after, see captureClippedJpeg /
        // captureFullJpegClip).
        const needsCapture =
          Boolean(fullPage || params.frameRef || params.highlight) ||
          (format === 'png' && params.optimizeForSpeed === false) ||
          // Overlay changes are DOM paints the compositor stream can lag behind;
          // use the capture path for a short window so screenshots always show
          // the fresh pointer/annotations.
          Boolean(tab.overlayChangedAt && Date.now() / 1000 - tab.overlayChangedAt < 5)
        // A cold JPEG region shot (no screencast running yet) takes the cheap
        // clipped capture *first* and only then starts the stream: taken while
        // the stream runs, a clipped capture makes Chrome emit clip-sized
        // screencast frames for the tab and poisons every following crop.
        const coldJpegRegion = format === 'jpeg' && clip && !needsCapture && !tab.shotStream?.active
        let data = coldJpegRegion ? await this.captureClippedJpeg(tab, clip, quality) : null
        if (coldJpegRegion) {
          // Warm the stream for the shots that follow; a failure only means the
          // next shot takes the same cold path again.
          await this.ensureShotStream(tab, { format, quality }).catch(() => null)
        }
        if (!data && !needsCapture) {
          data = await this.screenshotFromStream(tab, { format, quality, clip })
        }
        if (!data && format === 'jpeg' && clip) {
          // The stream is running (or its crop failed): capture the whole
          // viewport and crop it the same way, which also repaints the full
          // surface so the next stream crop is usable again.
          data = await this.captureFullJpegClip(tab, clip, quality)
        }
        if (!data) {
          const captureParams = { format, captureBeyondViewport: fullPage }
          if (clip) captureParams.clip = { ...clip, scale: 1 }
          if (format === 'jpeg') {
            captureParams.quality = quality
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
          width: clip ? Math.round(clip.width) : viewport.w,
          height: clip ? Math.round(clip.height) : viewport.h,
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
        // A read-only evaluate paints nothing, so the visual probe keeps the
        // previous change marker and the next screenshot is a cache hit
        // (docs/HEADLESS.md §4.1.7). Semantics of the expression are unchanged:
        // the probe only wraps it in two snapshot round trips.
        const value = await this.visualProbeAction(tab, () =>
          this.evalOn(tab, String(params.expression || 'undefined'), { awaitPromise: true }),
        )
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
        tab.screencast = {
          active: true,
          format,
          frames: 0,
          startedAt: Date.now(),
          lastAt: null,
          owner: String(owner || 'default'),
          pending: null,
          flushTimer: null,
          lastWriteAt: 0,
          dirReady: false,
        }
        tab.screencast.timer = setTimeout(() => {
          if (tab.screencast?.flushTimer) clearTimeout(tab.screencast.flushTimer)
          if (tab.screencast) this.flushScreencastFrame(tab)
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
        if (state?.flushTimer) clearTimeout(state.flushTimer)
        // Write the newest frame synchronously so stopping never loses it
        // (§4.1.6: with the throttle the last frame may still be pending).
        if (state) this.flushScreencastFrame(tab)
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
              // Page-side visual probe (docs/HEADLESS.md §4.1.7): whether the
              // tracker is installed, and how many page-changing actions were
              // proven paint-free and therefore kept the previous frame marker.
              visualTracker: Boolean(tab.visualTracker),
              visualSkips: tab.visualSkips || 0,
              // Markers retired after a repaint-window miss (or a proven
              // paint-free action past the window): how often the driver
              // stopped re-waiting for a change it already knew had no paint.
              renderChangeRetires: tab.renderChangeRetires || 0,
              screenshotStream: stream
                ? {
                    active: stream.active,
                    format: stream.format,
                    quality: stream.quality,
                    frames: stream.frames,
                    restarts: stream.restarts,
                    served: stream.served,
                    cropped: stream.cropped,
                    jpegCropped: stream.jpegCropped,
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
      const url = safeTabUrl(params.url)
      const tab = await this.attachTab(entry, url)
      if (url !== 'about:blank') await this.waitReady(tab)
      await this.syncTabMeta(tab)
      return { tabId: tab.tabId, url: tab.url, title: tab.title }
    }
    if (op === 'close') {
      const tab = entry.tabs.get(Number(params.tabId))
      if (!tab) throw error('TAB_NOT_FOUND', `tab ${params.tabId} is not owned by this session`)
      this.dropShotStream(tab)
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

  async loginStart(options) {
    return headlessLogin.loginStart(this, options)
  }

  async showVisible(options) {
    return headlessLogin.showVisible(this, options)
  }

  loginStatus() {
    return headlessLogin.loginStatus(this)
  }

  loginFinish() {
    return headlessLogin.loginFinish(this)
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
    this.tabs.clear()
    this.owners.clear()
    this.bySession.clear()
    this.consoleBuffers.clear()
    this.captures.clear()
    this.captureByTab.clear()
    this.visibleMode = false
  }
}

export function headlessSupported() {
  return Boolean(chromeExecutable())
}

export function headlessChromeExecutable() {
  return chromeExecutable()
}
