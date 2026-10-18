/**
 * DSH page overlay: virtual pointer + annotations (highlight/box/circle/arrow/
 * label). MAIN-world content script so CDP Runtime.evaluate and screenshots see
 * it; pointer-events:none and data-dsh-overlay keep it out of page interactions.
 *
 * Single source shared by the extension content script and the headless backend
 * (provider reads this file and evaluates it in the page).
 */
;(() => {
  if (window.__dshOverlay && window.__dshOverlay.version === 1) return
  const VERSION = 1
  const ROOT_ID = '__dsh_overlay__'
  const COLORS = ['#007aff', '#ff3b30', '#34c759', '#ff9f0a', '#af52de', '#5ac8fa']
  const state = { annotations: new Map(), seq: 1, auto: true }
  const STORAGE_KEY = '__dsh_annotations_v1__'
  const targetSpec = (t = {}) => {
    const out = {}
    for (const key of ['ref', 'selector', 'text', 'x', 'y']) if (t[key] != null) out[key] = t[key]
    return out
  }
  const persist = () => {
    try {
      const list = [...state.annotations.values()].map((a) => ({
        kind: a.kind,
        color: a.color,
        label: a.label || undefined,
        index: a.index,
        target: a.spec.target,
        from: a.spec.from,
      }))
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ url: location.href, annotations: list }))
    } catch {}
  }
  const restore = () => {
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY)
      if (!raw) return
      const saved = JSON.parse(raw)
      if (!saved || saved.url !== location.href || !Array.isArray(saved.annotations)) return
      for (const spec of saved.annotations) add(spec.kind, { ...(spec.target || {}), from: spec.from, color: spec.color, label: spec.label, index: spec.index, restoring: true })
    } catch {}
  }

  const root = () => {
    let el = document.getElementById(ROOT_ID)
    if (el) return el
    el = document.createElement('div')
    el.id = ROOT_ID
    el.dataset.dshOverlay = '1'
    el.setAttribute('aria-hidden', 'true')
    el.style.cssText =
      'position:fixed;inset:0;z-index:2147483646;pointer-events:none;contain:layout style size;overflow:hidden'
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('width', '100%')
    svg.setAttribute('height', '100%')
    svg.style.cssText = 'position:absolute;inset:0;overflow:visible'
    const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs')
    defs.innerHTML = `<marker id="__dsh_arrow__" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="context-stroke"/></marker>`
    svg.appendChild(defs)
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g')
    g.setAttribute('data-dsh-overlay-shapes', '1')
    svg.appendChild(g)
    el.appendChild(svg)
    const labels = document.createElement('div')
    labels.setAttribute('data-dsh-overlay-labels', '1')
    labels.style.cssText = 'position:absolute;inset:0'
    const highlights = document.createElement('div')
    highlights.setAttribute('data-dsh-overlay-highlights', '1')
    highlights.style.cssText = 'position:absolute;inset:0'
    el.append(highlights, labels)
    const pointer = document.createElement('div')
    pointer.setAttribute('data-dsh-overlay-pointer', '1')
    pointer.style.cssText =
      'position:absolute;left:0;top:0;width:0;height:0;opacity:0;transition:transform .22s cubic-bezier(.2,.8,.2,1),opacity .2s;will-change:transform'
    const ring = document.createElement('div')
    ring.setAttribute('data-dsh-pointer-ring', '1')
    ring.style.cssText =
      'position:absolute;left:-16px;top:-16px;width:32px;height:32px;border-radius:50%;border:2px solid rgba(0,122,255,.6);opacity:0;transition:opacity .2s,transform .35s'
    const dot = document.createElement('div')
    dot.setAttribute('data-dsh-pointer-dot', '1')
    dot.style.cssText =
      'position:absolute;left:-7px;top:-7px;width:14px;height:14px;border-radius:50%;background:#007aff;border:2px solid #fff;box-shadow:0 1px 6px rgba(0,0,0,.35)'
    const tag = document.createElement('div')
    tag.setAttribute('data-dsh-pointer-label', '1')
    tag.style.cssText =
      'position:absolute;left:16px;top:-12px;padding:2px 7px;border-radius:6px;background:#007aff;color:#fff;font:600 11px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,.25)'
    pointer.append(ring, dot, tag)
    el.appendChild(pointer)
    ;(document.documentElement || document.body).appendChild(el)
    return el
  }

  const colorFor = (color, fallbackIndex) =>
    color || COLORS[fallbackIndex % COLORS.length]

  const rectsOfTarget = (target = {}) => {
    try {
      if (Number.isFinite(target.x) && Number.isFinite(target.y)) {
        return [{ x: target.x, y: target.y, width: 0, height: 0 }]
      }
      let el = null
      if (Number.isFinite(target.ref)) el = document.querySelector(`[data-dsh-ref="${target.ref}"]`)
      else if (target.selector) el = document.querySelector(String(target.selector))
      if (el) return [...el.getClientRects()].filter((r) => r.width > 0 || r.height > 0)
      if (target.text) {
        const needle = String(target.text)
        const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT)
        let node
        while ((node = walker.nextNode())) {
          const hay = node.nodeValue || ''
          const idx = hay.toLowerCase().indexOf(needle.toLowerCase())
          if (idx < 0) continue
          const range = document.createRange()
          range.setStart(node, idx)
          range.setEnd(node, idx + needle.length)
          return [...range.getClientRects()].filter((r) => r.width > 0 || r.height > 0)
        }
      }
    } catch {
      // fall through
    }
    return []
  }

  const union = (rects) => {
    if (!rects || rects.length === 0) return null
    let left = Infinity
    let top = Infinity
    let right = -Infinity
    let bottom = -Infinity
    for (const rect of rects) {
      left = Math.min(left, rect.left ?? rect.x)
      top = Math.min(top, rect.top ?? rect.y)
      right = Math.max(right, (rect.left ?? rect.x) + (rect.width || 0))
      bottom = Math.max(bottom, (rect.top ?? rect.y) + (rect.height || 0))
    }
    return { x: left, y: top, width: right - left, height: bottom - top }
  }

  const svgEl = (name, attrs) => {
    const el = document.createElementNS('http://www.w3.org/2000/svg', name)
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value != null) el.setAttribute(key, String(value))
    }
    return el
  }

  const labelEl = (text, rect, color, badge) => {
    const el = document.createElement('div')
    el.style.cssText = [
      'position:fixed',
      `left:${Math.max(4, rect.x + rect.width + 8)}px`,
      `top:${Math.max(4, rect.y - 6)}px`,
      `background:${color}`,
      'color:#fff',
      'padding:2px 7px',
      'border-radius:6px',
      'font:600 12px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
      'white-space:nowrap',
      'box-shadow:0 2px 8px rgba(0,0,0,.25)',
      'pointer-events:none',
    ].join(';')
    el.textContent = text
    el.setAttribute('data-dsh-overlay-label', '1')
    if (badge != null) el.dataset.badge = String(badge)
    return el
  }

  const clearAll = () => {
    const el = document.getElementById(ROOT_ID)
    state.annotations.clear()
    if (el) {
      el.querySelector('[data-dsh-overlay-shapes]')?.replaceChildren()
      el.querySelector('[data-dsh-overlay-labels]')?.replaceChildren()
      el.querySelector('[data-dsh-overlay-highlights]')?.replaceChildren()
    }
    persist()
    return { ok: true, cleared: true }
  }

  const drawAnnotation = (rootEl, ann) => {
    const shapes = rootEl.querySelector('[data-dsh-overlay-shapes]')
    const labels = rootEl.querySelector('[data-dsh-overlay-labels]')
    const highlights = rootEl.querySelector('[data-dsh-overlay-highlights]')
    if (!shapes || !labels || !highlights) return
    if (ann.kind === 'highlight') {
      for (const rect of ann.rects || []) {
        const div = document.createElement('div')
        div.style.cssText = `position:fixed;left:${rect.x}px;top:${rect.y}px;width:${rect.width}px;height:${rect.height}px;background:${ann.color};opacity:.28;border-radius:3px;pointer-events:none`
        div.setAttribute('data-dsh-overlay-highlight', String(ann.id))
        highlights.appendChild(div)
      }
      if (ann.label && ann.rects?.[0]) labels.appendChild(labelEl(ann.label, ann.rects[0], ann.color))
      return
    }
    const rect = union(ann.rects)
    if (!rect || rect.width < 0) return
    if (ann.kind === 'box') {
      shapes.appendChild(
        svgEl('rect', {
          x: rect.x - 2,
          y: rect.y - 2,
          width: rect.width + 4,
          height: rect.height + 4,
          rx: 6,
          fill: 'none',
          stroke: ann.color,
          'stroke-width': 2.5,
          opacity: 0.95,
        }),
      )
    } else if (ann.kind === 'circle') {
      shapes.appendChild(
        svgEl('ellipse', {
          cx: rect.x + rect.width / 2,
          cy: rect.y + rect.height / 2,
          rx: rect.width / 2 + 8,
          ry: rect.height / 2 + 8,
          fill: 'none',
          stroke: ann.color,
          'stroke-width': 2.5,
          opacity: 0.95,
        }),
      )
    } else if (ann.kind === 'arrow') {
      const from = union(ann.fromRects || [])
      const start = from
        ? { x: from.x + from.width / 2, y: from.y + from.height / 2 }
        : { x: rect.x - 70, y: rect.y - 40 }
      const end = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
      shapes.appendChild(
        svgEl('line', {
          x1: start.x,
          y1: start.y,
          x2: end.x,
          y2: end.y,
          stroke: ann.color,
          'stroke-width': 2.5,
          'marker-end': 'url(#__dsh_arrow__)',
          opacity: 0.95,
        }),
      )
      if (ann.label) {
        labels.appendChild(labelEl(ann.label, { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 - 18, width: 0, height: 0 }, ann.color))
      }
    } else if (ann.kind === 'label') {
      labels.appendChild(labelEl(ann.label || ann.text || '', rect, ann.color, ann.index))
    }
  }

  const redraw = () => {
    const el = document.getElementById(ROOT_ID)
    if (!el) return
    const shapes = el.querySelector('[data-dsh-overlay-shapes]')
    const labels = el.querySelector('[data-dsh-overlay-labels]')
    shapes?.replaceChildren()
    labels?.replaceChildren()
    el.querySelector('[data-dsh-overlay-highlights]')?.replaceChildren()
    for (const ann of state.annotations.values()) {
      ann.rects = ann.resolve ? ann.resolve() : ann.rects
      if (ann.fromResolve) ann.fromRects = ann.fromResolve()
      drawAnnotation(el, ann)
    }
  }

  const nextId = () => `a${state.seq++}`

  const add = (kind, params) => {
    const el = root()
    const color = colorFor(params.color, state.seq)
    const ann = {
      id: nextId(),
      kind,
      color,
      label: params.label || params.note || '',
      index: params.index,
      rects: [],
      fromRects: [],
      spec: { target: targetSpec(params), from: targetSpec(params.from || (params.fromSelector ? { selector: params.fromSelector } : params.fromRef != null ? { ref: params.fromRef } : {})) },
    }
    ann.resolve = () => rectsOfTarget(params)
    if (kind === 'arrow') ann.fromResolve = () => rectsOfTarget(params.from || (params.fromSelector ? { selector: params.fromSelector } : params.fromRef != null ? { ref: params.fromRef } : {}))
    ann.rects = ann.resolve()
    if (kind === 'arrow') ann.fromRects = ann.fromResolve()
    if (ann.rects.length === 0) return { ok: false, error: 'TARGET_NOT_FOUND', kind }
    state.annotations.set(ann.id, ann)
    drawAnnotation(el, ann)
    persist()
    return {
      ok: true,
      id: ann.id,
      kind,
      count: state.annotations.size,
      rect: union(ann.rects),
      text: params.text || params.label || '',
    }
  }

  const pointer = (params = {}) => {
    const el = root()
    const p = el.querySelector('[data-dsh-overlay-pointer]')
    const tag = p.querySelector('[data-dsh-pointer-label]')
    let point = null
    if (Number.isFinite(params.x) && Number.isFinite(params.y)) point = { x: params.x, y: params.y }
    else {
      const rect = union(rectsOfTarget(params))
      if (rect) point = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
    }
    if (!point) return { ok: false, error: 'TARGET_NOT_FOUND' }
    p.style.transform = `translate(${point.x}px,${point.y}px)`
    p.style.opacity = '1'
    tag.textContent = params.label || 'DSH'
    tag.style.display = params.label === '' ? 'none' : 'block'
    if (params.pulse) {
      const ring = p.querySelector('[data-dsh-pointer-ring]')
      ring.style.transition = 'none'
      ring.style.opacity = '1'
      ring.style.transform = 'scale(.6)'
      requestAnimationFrame(() => {
        ring.style.transition = 'opacity .35s,transform .35s'
        ring.style.opacity = '0'
        ring.style.transform = 'scale(2.4)'
      })
    }
    return { ok: true, x: point.x, y: point.y, label: params.label || 'DSH', visible: true }
  }

  const autoFollow = (params = {}) => {
    if (!state.auto) return { ok: true, skipped: 'auto-disabled' }
    return pointer({ ...params, label: params.label ?? 'DSH' })
  }

  const hidePointer = () => {
    const p = document.querySelector('[data-dsh-overlay-pointer]')
    if (p) p.style.opacity = '0'
    return { ok: true, visible: false }
  }

  let redrawQueued = false
  const scheduleRedraw = () => {
    if (redrawQueued) return
    redrawQueued = true
    requestAnimationFrame(() => {
      redrawQueued = false
      redraw()
    })
  }
  window.addEventListener('scroll', scheduleRedraw, { passive: true, capture: true })
  window.addEventListener('resize', scheduleRedraw, { passive: true })

  const handle = (params = {}) => {
    const op = String(params.op || params.kind || '')
    if (op === 'auto') {
      state.auto = params.enabled !== false
      return { ok: true, auto: state.auto }
    }
    if (op === 'follow') return autoFollow(params)
    if (op === 'pointer' || op === 'move' || op === 'show') return pointer(params)
    if (op === 'hide-pointer') return hidePointer()
    if (op === 'list') return { ok: true, annotations: [...state.annotations.values()].map((a) => ({ id: a.id, kind: a.kind, label: a.label, color: a.color, spec: a.spec })), count: state.annotations.size }
    if (op === 'export') {
      const annotations = [...state.annotations.values()].map((a) => ({ id: a.id, kind: a.kind, label: a.label, color: a.color, rect: union(a.rects), spec: a.spec }))
      return { ok: true, url: location.href, count: annotations.length, annotations, json: JSON.stringify({ url: location.href, annotations }) }
    }
    if (op === 'restore') {
      restore()
      return { ok: true, count: state.annotations.size }
    }
    if (op === 'clear') {
      if (params.id) {
        state.annotations.delete(params.id)
        scheduleRedraw()
        persist()
        return { ok: true, cleared: params.id }
      }
      return clearAll()
    }
    if (['highlight', 'box', 'circle', 'arrow', 'label'].includes(op)) return add(op, params)
    return { ok: false, error: `UNKNOWN_OP:${op}` }
  }

  window.__dshOverlay = { version: VERSION, handle, get auto() { return state.auto } }
  try { if (document.readyState !== 'loading') restore() } catch {}
})();
