/**
 * Page-side visual-change probe for HeadlessDriver (Q27).
 *
 * The tracker script is installed in every document; the driver snapshots it
 * around an action and only a clean verdict keeps the previous screenshot
 * change marker. HeadlessDriver keeps same-named facade methods, and the
 * verdict / snapshot shape / cache behavior are unchanged.
 */

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
export const VISUAL_PROBE_ENABLED = process.env.DSH_HEADLESS_VISUAL_PROBE !== '0'
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

export class HeadlessVisualProbe {
  constructor(driver) {
    this.driver = driver
  }

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
        this.driver.cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: VISUAL_TRACKER_SCRIPT }, tab.sessionId),
        this.driver.evalOn(tab, VISUAL_TRACKER_SCRIPT),
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
      return await this.driver.evalOn(tab, `window.__dshVisual ? window.__dshVisual.snapshot(${args}) : null`)
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
}
