/**
 * DSH page overlay: virtual pointer + annotations (highlight/box/circle/arrow/
 * label). MAIN-world content script so CDP Runtime.evaluate and screenshots see
 * it; pointer-events:none and data-dsh-overlay keep it out of page interactions.
 *
 * Single source shared by the extension content script and the headless backend
 * (provider reads this file and evaluates it in the page).
 */
;(() => {
  if (window.__dshOverlay && window.__dshOverlay.version === 3) return
  const VERSION = 3
  const ROOT_ID = '__dsh_overlay__'
  const COLORS = ['#007aff', '#ff3b30', '#34c759', '#ff9f0a', '#af52de', '#5ac8fa']
  const state = { annotations: new Map(), seq: 1, auto: true, cursor: { preset: 'whale', image: null, size: 30, defaultMarkup: null } }
  const STORAGE_KEY = '__dsh_annotations_v1__'
  // One page can carry many annotations, but the DOM/state must stay bounded:
  // restore() re-adds the persisted list on every reload/op, and without a cap
  // a crafted sessionStorage value could pin thousands of nodes.
  const MAX_ANNOTATIONS = 200
  // Built-in cursor presets. The whale is the DSH brand mark; custom images
  // are local data URLs (validated by the extension popup/background) and are
  // rendered through the same overlay node.
  const CURSOR_PRESETS = {
    arrow:
      '<svg width="24" height="26" viewBox="0 0 24 26" style="position:absolute;left:-3px;top:-2px">' +
      '<path d="M2 1.5 L2 21 L7.6 16.2 L10.8 23.5 L15.2 21.6 L11.9 14.2 L20 14.0 Z" fill="#007aff" stroke="#fff" stroke-width="1.8" stroke-linejoin="round"/></svg>',
    dot:
      '<svg width="22" height="22" viewBox="0 0 22 22" style="position:absolute;left:-11px;top:-11px">' +
      '<circle cx="11" cy="11" r="7" fill="#007aff" stroke="#fff" stroke-width="2.2"/></svg>',
    crosshair:
      '<svg width="24" height="24" viewBox="0 0 24 24" style="position:absolute;left:-12px;top:-12px">' +
      '<circle cx="12" cy="12" r="6" fill="none" stroke="#fff" stroke-width="3"/>' +
      '<circle cx="12" cy="12" r="6" fill="none" stroke="#007aff" stroke-width="1.5"/>' +
      '<path d="M12 1v7M12 16v7M1 12h7M16 12h7" stroke="#007aff" stroke-width="2" stroke-linecap="round"/></svg>',
  }
  const CURSOR_IMAGE_RE = /^data:image\/(?:png|jpe?g|webp);base64,[A-Za-z0-9+/=\s]+$/i
  const cursorImage = (value) => {
    const image = typeof value === 'string' ? value : ''
    if (!image || image.length > 360000 || !CURSOR_IMAGE_RE.test(image)) return null
    return image
  }
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
    let restored = 0
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY)
      if (!raw) return 0
      const saved = JSON.parse(raw)
      if (!saved || saved.url !== location.href || !Array.isArray(saved.annotations)) return 0
      // Reload the persisted set instead of appending a second copy: calling
      // op="restore" twice used to duplicate every annotation (DOM + state +
      // sessionStorage) on each call.
      clearAll()
      for (const spec of saved.annotations.slice(0, MAX_ANNOTATIONS)) {
        const result = add(spec.kind, {
          ...(spec.target || {}),
          from: spec.from,
          color: spec.color,
          label: spec.label,
          index: spec.index,
          restoring: true,
        })
        if (result.ok) restored += 1
      }
    } catch {}
    return restored
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
      'position:absolute;left:-20px;top:-20px;width:40px;height:40px;border-radius:50%;border:2px solid rgba(0,122,255,.65);opacity:0;transition:opacity .2s,transform .35s'
    // GPT/Claude-style arrow cursor. Kept as a data-attribute node so older
    // selectors still find it; the ring remains the click ripple.
    const dot = document.createElement('div')
    dot.setAttribute('data-dsh-pointer-dot', '1')
    dot.style.cssText = 'position:absolute;left:0;top:0;width:0;height:0;filter:drop-shadow(0 2px 3px rgba(0,0,0,.35))'
    dot.innerHTML =
      '<svg width="30" height="30" viewBox="0 0 50 50" style="position:absolute;left:-4px;top:-3px;filter:drop-shadow(0 2px 3px rgba(0,0,0,.35))">' +
      '<path d="M48.8354 10.0479C48.3232 9.79199 48.1025 10.2798 47.8032 10.5278C47.7007 10.6079 47.6143 10.7119 47.5273 10.8076C46.7793 11.624 45.9048 12.1597 44.7622 12.0957C43.0923 12 41.666 12.5356 40.4058 13.8398C40.1377 12.2319 39.2476 11.272 37.8926 10.6558C37.1836 10.3359 36.4668 10.0156 35.9702 9.31982C35.6235 8.82373 35.5293 8.27197 35.356 7.72754C35.2456 7.3999 35.1353 7.06396 34.7651 7.00781C34.3633 6.94385 34.2056 7.2876 34.0479 7.57568C33.418 8.75195 33.1733 10.0479 33.1973 11.3599C33.2524 14.312 34.4736 16.6641 36.8999 18.3359C37.1758 18.5278 37.2466 18.7197 37.1597 19C36.9946 19.5757 36.7974 20.1357 36.624 20.7119C36.5137 21.0801 36.3486 21.1597 35.9624 21C34.6309 20.4321 33.481 19.5918 32.4644 18.5757C30.7393 16.8721 29.1792 14.9917 27.2334 13.52C26.7764 13.1758 26.3193 12.856 25.8467 12.5518C23.8618 10.584 26.1069 8.96777 26.627 8.77588C27.1704 8.57568 26.8159 7.8877 25.0591 7.896C23.3022 7.90381 21.6953 8.50391 19.647 9.30371C19.3477 9.42383 19.0322 9.51172 18.7095 9.58398C16.8501 9.22363 14.9199 9.14355 12.9033 9.37598C9.10596 9.80762 6.07275 11.6396 3.84326 14.7681C1.16455 18.5278 0.53418 22.7998 1.30664 27.2559C2.11768 31.9521 4.46582 35.8398 8.07373 38.8799C11.8159 42.0322 16.1255 43.5762 21.041 43.2803C24.0269 43.104 27.3516 42.6963 31.1016 39.4561C32.0469 39.936 33.0396 40.1279 34.686 40.272C35.9546 40.3921 37.1758 40.208 38.1211 40.0078C39.6021 39.688 39.4995 38.2881 38.9639 38.0322C34.623 35.9678 35.5762 36.8081 34.71 36.1279C36.9155 33.4639 40.2402 30.6958 41.54 21.728C41.6426 21.0161 41.5557 20.5679 41.54 19.9917C41.5322 19.6396 41.6108 19.5039 42.0049 19.4639C43.0923 19.3359 44.1479 19.0317 45.1167 18.4878C47.9292 16.9199 49.064 14.3438 49.3315 11.2559C49.3711 10.7837 49.3237 10.2959 48.8354 10.0479ZM24.3262 37.8398C20.1196 34.4639 18.0791 33.3521 17.2358 33.3999C16.4482 33.4482 16.5898 34.3682 16.7632 34.9678C16.9443 35.5601 17.1812 35.9683 17.5117 36.4878C17.7402 36.832 17.8979 37.3442 17.2832 37.728C15.9282 38.584 13.5728 37.4399 13.4624 37.3838C10.7207 35.7358 8.42822 33.5601 6.81348 30.584C5.25342 27.7197 4.34766 24.6479 4.19775 21.3677C4.1582 20.5757 4.38672 20.2959 5.15869 20.1519C6.17529 19.96 7.22314 19.9199 8.23926 20.0718C12.5327 20.7119 16.1885 22.6719 19.2529 25.7759C21.002 27.5439 22.3252 29.6558 23.6885 31.7202C25.1377 33.9121 26.6978 36 28.6831 37.7119C29.3843 38.312 29.9434 38.7681 30.479 39.104C28.8643 39.2881 26.1699 39.3281 24.3262 37.8398ZM26.3433 24.6001C26.3433 24.248 26.6191 23.9678 26.9658 23.9678C27.0444 23.9678 27.1152 23.9839 27.1782 24.0078C27.2651 24.04 27.3438 24.0879 27.4067 24.1602C27.5171 24.272 27.5801 24.4321 27.5801 24.6001C27.5801 24.9521 27.3042 25.2319 26.9575 25.2319C26.6108 25.2319 26.3433 24.9521 26.3433 24.6001ZM32.6064 27.8799C32.2046 28.0479 31.8027 28.1919 31.4165 28.208C30.8179 28.2397 30.1641 27.9922 29.8096 27.688C29.2583 27.2158 28.8643 26.9521 28.6987 26.1279C28.6279 25.7759 28.6675 25.2319 28.7305 24.9199C28.8721 24.248 28.7144 23.8159 28.2495 23.4238C27.8716 23.104 27.3911 23.0161 26.8633 23.0161C26.666 23.0161 26.4849 22.9277 26.3511 22.856C26.1304 22.7441 25.9492 22.4639 26.1226 22.1201C26.1777 22.0078 26.4458 21.7358 26.5088 21.688C27.2256 21.272 28.0527 21.4077 28.8169 21.7197C29.5259 22.0161 30.0615 22.5601 30.834 23.3281C31.6216 24.2559 31.7632 24.5117 32.2124 25.208C32.5669 25.752 32.8901 26.312 33.1104 26.9521C33.2446 27.3521 33.0713 27.6802 32.6064 27.8799Z" fill="#007aff" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/>' +
      '</svg>'
    state.cursor.defaultMarkup = dot.innerHTML
    const tag = document.createElement('div')
    tag.setAttribute('data-dsh-pointer-label', '1')
    tag.style.cssText =
      'position:absolute;left:24px;top:18px;padding:2px 7px;border-radius:6px;background:#007aff;color:#fff;font:600 11px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,.25)'
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
    if (state.annotations.size >= MAX_ANNOTATIONS) {
      return { ok: false, error: 'RESOURCE_LIMIT', kind, limit: MAX_ANNOTATIONS }
    }
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

  const applyCursor = (params = {}) => {
    if (!document.querySelector('[data-dsh-pointer-dot]')) root()
    const dot = document.querySelector('[data-dsh-pointer-dot]')
    if (!dot) return { ok: false, error: 'OVERLAY_NOT_READY' }
    if (['whale', 'arrow', 'dot', 'crosshair'].includes(params.preset)) state.cursor.preset = params.preset
    if (params.image !== undefined) state.cursor.image = cursorImage(params.image)
    const size = Number(params.size)
    if (Number.isFinite(size)) state.cursor.size = Math.max(16, Math.min(64, Math.round(size)))
    const image = state.cursor.image
    if (image) {
      dot.innerHTML = `<img src="${image}" alt="" style="position:absolute;left:-4px;top:-3px;width:${state.cursor.size}px;height:${state.cursor.size}px;object-fit:contain;pointer-events:none">`
    } else if (state.cursor.preset !== 'whale') {
      dot.innerHTML = CURSOR_PRESETS[state.cursor.preset] || ''
    } else {
      dot.innerHTML = state.cursor.defaultMarkup || ''
    }
    return { ok: true, preset: state.cursor.preset, custom: Boolean(image), size: state.cursor.size }
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
    if (params.preset !== undefined || params.image !== undefined || params.size !== undefined) applyCursor(params)
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
    if (op === 'cursor') return applyCursor(params)
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

  // Auto-follow bridge for the MAIN-world page actions. The cursor helper is
  // injected into MAIN by the background and can no longer touch this isolated
  // world (P4); it publishes the action coordinates on a DOM event and this
  // listener moves the overlay pointer. A page script can dispatch the same
  // event, but that only moves a visual pointer: no overlay state or API is
  // reachable from the page.
  const CURSOR_EVENT = '__dsh_cursor_follow__'
  document.addEventListener(
    CURSOR_EVENT,
    (event) => {
      try {
        const payload = typeof event?.detail === 'string' ? JSON.parse(event.detail) : null
        if (!payload || !Number.isFinite(payload.x) || !Number.isFinite(payload.y)) return
        if (payload.cursor) applyCursor(payload.cursor)
        const fallback = document.getElementById('__dsh_cursor__')
        if (fallback) fallback.style.opacity = '0'
        if (!state.auto) return
        const kind = String(payload.kind || 'move')
        autoFollow({
          x: payload.x,
          y: payload.y,
          label: 'DSH · ' + kind,
          pulse: kind === 'click' || kind === 'type' || kind === 'key',
        })
      } catch {}
    },
    true,
  )

  window.__dshOverlay = { version: VERSION, handle, get auto() { return state.auto } }
  try { if (document.readyState !== 'loading') restore() } catch {}
})();
