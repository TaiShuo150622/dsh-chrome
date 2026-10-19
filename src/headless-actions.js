/**
 * Navigation/input action handlers for HeadlessDriver.dispatch() (Q25).
 *
 * The driver keeps its `dispatch` facade (ensureStarted/noteActivity, the
 * SUPPORTED check, the UNSUPPORTED_BACKEND error and every output envelope);
 * this table only holds the handler bodies for goto/history/click/clickAt/
 * type/press/scroll/select/hover/drag/wait. Handlers receive the driver as
 * their first argument, so they can use the same driver methods and page
 * actions the inline switch cases used.
 *
 * The page-side probe helpers live here with the actions they gate. Output,
 * screenshot and probe semantics are unchanged.
 */

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

export function createHeadlessActions({ error, safeTabUrl, visualProbeEnabled }) {
  const actions = new Map()

  actions.set('tab.goto', async (driver, params, owner) => {
    const url = safeTabUrl(params.url)
    const tab = await driver.ensureTab(owner, params.tabId)
    tab.overlayReady = false
    tab.frameContexts = null
    await driver.cdp.send('Page.navigate', { url }, tab.sessionId)
    await driver.waitReady(tab)
    await driver.syncTabMeta(tab)
    return { tabId: tab.tabId, url: tab.url, title: tab.title, loadState: 'complete' }
  })

  actions.set('tab.select', async (driver, params, owner) => {
    const tab = await driver.ensureTab(owner, params.tabId)
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
    const result = await driver.visualProbeAction(
      tab,
      () =>
        driver.pageAction(tab, 'selectPage', [
          params.ref ?? null,
          params.selector ?? null,
          params.value ?? null,
          params.checked,
          visualProbeEnabled,
        ]),
      (value) => value?.ok === true && value.changed === false,
      (before) => selectProbeEligible(before),
      null,
      (value) => ({ changes: Number(value?.changeEvents) === 1 ? 1 : 0 }),
      (value) => (value?.ok === true && value.probeBefore ? value.probeBefore : null),
    )
    if (!result?.ok) throw error(result?.code || 'REF_NOT_FOUND', result?.message || 'select failed')
    return { ok: true, tag: result.tag, value: result.value }
  })

  actions.set('tab.drag', async (driver, params, owner) => {
    const tab = await driver.ensureTab(owner, params.tabId)
    // A synthetic drag that leaves every tracker counter untouched cannot
    // have painted, so the next screenshot reuses the cached frame instead
    // of paying the repaint window (docs/HEADLESS.md §4.1.15).
    const result = await driver.visualProbeAction(
      tab,
      () => driver.pageAction(tab, 'dragPage', [params.fromRef, params.toRef]),
      (value) => value?.ok === true,
      (before) => dragProbeEligible(before),
    )
    if (!result?.ok) throw error(result?.code || 'REF_NOT_FOUND', result?.message || 'drag failed')
    return result
  })

  actions.set('tab.click', async (driver, params, owner) => {
    const tab = await driver.ensureTab(owner, params.tabId)
    // A click on a plain element (no navigation, no form control, no media
    // control) that leaves every page-side counter untouched cannot have
    // painted, so the next screenshot is a frame cache hit instead of a
    // ~40ms repaint-window wait (docs/HEADLESS.md §4.1.8). `hazard` vetoes
    // the shortcut for targets whose UA default action paints invisibly to
    // the tracker; the veto also skips the second snapshot.
    const result = await driver.visualProbeAction(
      tab,
      () => driver.pageAction(tab, 'clickPage', [params.ref ?? null, params.selector ?? null, params.clickCount || 1, params.button === 'right' ? 2 : params.button === 'middle' ? 1 : 0]),
      (value) => value?.ok === true && value.hazard === null,
    )
    if (!result?.ok) throw error(result?.code || 'REF_NOT_FOUND', result?.message || 'click failed')
    if (result.url) tab.url = result.url
    if (result.title != null) tab.title = result.title
    await driver.autoPointer(tab, params, 'click')
    return { ok: true, tag: result.tag, label: result.label, tabId: tab.tabId }
  })

  actions.set('tab.type', async (driver, params, owner) => {
    const tab = await driver.ensureTab(owner, params.tabId)
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
    const result = await driver.visualProbeAction(
      tab,
      () =>
        driver.pageAction(tab, 'typePage', [
          params.ref ?? null,
          params.selector ?? null,
          String(params.text ?? ''),
          Boolean(params.replace),
          Boolean(params.submit),
          visualProbeEnabled,
        ]),
      (value) => value?.ok === true && value.changed === false && value.submitted === false,
      (before) => typeProbeEligible(before),
      null,
      (value) => ({ changes: Number(value?.changeEvents) === 1 ? 1 : 0 }),
      (value) => (value?.ok === true && value.probeBefore ? value.probeBefore : null),
    )
    if (!result?.ok) throw error(result?.code || 'REF_NOT_FOUND', result?.message || 'type failed')
    await driver.autoPointer(tab, params, 'type')
    return { ok: true, value: result.value, submitted: result.submitted, tabId: tab.tabId }
  })

  actions.set('tab.clickAt', async (driver, params, owner) => {
    const tab = await driver.ensureTab(owner, params.tabId)
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
    await driver.visualProbeAction(
      tab,
      async () => {
        await driver.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, tab.sessionId)
        await driver.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount }, tab.sessionId)
        await driver.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount }, tab.sessionId)
        return true
      },
      null,
      (before) => (point ? clickAtProbeEligible(before, point) : false),
      point,
    )
    await driver.autoPointer(tab, params, 'click')
    return { ok: true, tabId: tab.tabId, x, y }
  })

  actions.set('tab.hover', async (driver, params, owner) => {
    const tab = await driver.ensureTab(owner, params.tabId)
    // Hover shares clickPage (it dispatches the same synthetic events), so it
    // shares the click probe and its target hazards (docs/HEADLESS.md §4.1.8).
    const result = await driver.visualProbeAction(
      tab,
      () => driver.pageAction(tab, 'clickPage', [params.ref ?? null, params.selector ?? null, 1, 0]),
      (value) => value?.ok === true && value.hazard === null,
    )
    if (result?.ok) await driver.autoPointer(tab, params, 'hover')
    return result?.ok ? { ok: true, tag: result.tag, label: result.label, tabId: tab.tabId } : { ok: false, message: result?.message }
  })

  actions.set('tab.scroll', async (driver, params, owner) => {
    const tab = await driver.ensureTab(owner, params.tabId)
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
    const pos = await driver.evalOn(tab, expression)
    if (pos && pos.moved === false && pos.smooth === false) tab.skipRenderChange = true
    return { ok: true, tabId: tab.tabId, x: pos?.x ?? 0, y: pos?.y ?? 0 }
  })

  actions.set('tab.press', async (driver, params, owner) => {
    const tab = await driver.ensureTab(owner, params.tabId)
    const key = String(params.key || '')
    const keyCode = key === 'Enter' ? 13 : key === 'Tab' ? 9 : key === 'Escape' ? 27 : 0
    // A key press with no UA default action outside an editable field cannot
    // paint unless a page handler changes something the tracker sees, so the
    // same probe the click path uses keeps the previous change marker and
    // the next screenshot reuses the cached frame instead of paying the
    // repaint window (docs/HEADLESS.md §4.1.12). `pressProbeEligible` vetoes
    // the key classes whose effect can commit after the after-snapshot;
    // a veto skips the second snapshot entirely.
    const result = await driver.visualProbeAction(
      tab,
      async () => {
        await driver.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode: keyCode }, tab.sessionId)
        await driver.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: keyCode }, tab.sessionId)
        return { ok: true, tabId: tab.tabId, key }
      },
      null,
      (before) => pressProbeEligible(key, before),
    )
    return result
  })

  actions.set('tab.history', async (driver, params, owner) => {
    const tab = await driver.ensureTab(owner, params.tabId)
    tab.overlayReady = false
    tab.frameContexts = null
    if (params.op === 'back') await driver.evalOn(tab, 'history.back()')
    else if (params.op === 'forward') await driver.evalOn(tab, 'history.forward()')
    else await driver.cdp.send('Page.reload', {}, tab.sessionId)
    await driver.waitReady(tab)
    await driver.syncTabMeta(tab)
    return { tabId: tab.tabId, url: tab.url, title: tab.title }
  })

  actions.set('tab.wait', async (driver, params, owner) => {
    const tab = await driver.ensureTab(owner, params.tabId)
    const deadline = Date.now() + Math.min(Number(params.timeoutMs) || 30000, 120000)
    while (Date.now() < deadline) {
      const state = await driver.evalOn(tab, 'document.readyState').catch(() => null)
      let done = false
      if (params.until === 'load') done = state === 'complete'
      else if (params.until === 'text') done = await driver.evalOn(tab, `(() => (document.body?.innerText || '').includes(${JSON.stringify(String(params.text || ''))}))()`).catch(() => false)
      else if (params.until === 'selector') done = await driver.evalOn(tab, `Boolean(document.querySelector(${JSON.stringify(String(params.selector || ''))}))`).catch(() => false)
      else if (params.until === 'url') done = await driver.evalOn(tab, `location.href.includes(${JSON.stringify(String(params.url || ''))})`).catch(() => false)
      if (done) {
        await driver.syncTabMeta(tab)
        return { tabId: tab.tabId, url: tab.url, title: tab.title, loadState: state || 'unknown' }
      }
      await new Promise((resolve) => setTimeout(resolve, 150))
    }
    throw error('TIMEOUT', `wait timed out after ${params.timeoutMs || 30000}ms`)
  })

  return actions
}
