/**
 * Viewer HTML for the per-context viewer (Q28): the inline page (styles,
 * controls and polling/input script) lives here so context-viewer.js only
 * registers routes. The rendered HTML and every URL/header it uses are
 * unchanged.
 */
import { ROUTE_PREFIX } from './viewer-auth.js'

function viewerHtml({ contextId, token, access }) {
  const base = `${ROUTE_PREFIX}/${encodeURIComponent(contextId)}`
  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DSH · 隔离浏览器</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #0b0d10; color: #d7dae0; font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  header { display: flex; flex-wrap: wrap; gap: 10px; align-items: baseline; padding: 8px 10px; border-bottom: 1px solid #242a33; background: #11151b; }
  header b { color: #fff; font-size: 13px; }
  .hint { color: #7d8695; font-size: 12px; }
  .bar { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; padding: 8px 10px; border-bottom: 1px solid #1b212a; }
  .grow { flex: 1 1 280px; display: flex; gap: 6px; min-width: 0; }
  .grow input { flex: 1 1 auto; }
  button, input { font: inherit; color: #e7eaf0; background: #1a2029; border: 1px solid #303949; border-radius: 6px; padding: 4px 8px; }
  button { cursor: pointer; white-space: nowrap; }
  button:hover { background: #242d3a; }
  input { min-width: 0; }
  input:focus, button:focus-visible { outline: 1px solid #4c8dff; outline-offset: 1px; }
  .sep { width: 1px; height: 18px; background: #29313c; margin: 0 2px; }
  #stage { display: flex; justify-content: center; padding: 8px; background: #050608; min-height: 180px; }
  #frame { display: block; max-width: 100%; max-height: calc(100vh - 158px); background: #000; border: 1px solid #1d232c; border-radius: 4px; cursor: crosshair; }
  #status { padding: 6px 10px 12px; color: #8b94a3; font-size: 12px; white-space: pre-wrap; overflow-wrap: anywhere; }
</style>
</head>
<body>
<header>
  <b>DSH · 隔离浏览器</b>
  <span class="hint">方案 A 原型 · 截图轮询约 3 fps</span>
  <span class="hint" id="meta"></span>
  <span class="hint" id="conn">连接中…</span>
</header>
<div class="bar">
  <button id="back" title="后退">←</button>
  <button id="forward" title="前进">→</button>
  <button id="reload" title="刷新页面">⟳</button>
  <form id="navform" class="grow">
    <input id="url" placeholder="https://…" spellcheck="false" autocomplete="off" aria-label="页面地址">
    <button type="submit">打开</button>
  </form>
</div>
<div class="bar">
  <form id="typeform" class="grow">
    <input id="text" placeholder="输入文本（先点击页面里的输入框）" autocomplete="off" aria-label="要发送到页面的文本">
    <button type="submit">输入</button>
  </form>
  <span class="sep"></span>
  <button data-key="Enter">Enter</button>
  <button data-key="Tab">Tab</button>
  <button data-key="Escape">Esc</button>
  <button data-key="ArrowUp">↑</button>
  <button data-key="ArrowDown">↓</button>
  <button data-key="ArrowLeft">←</button>
  <button data-key="ArrowRight">→</button>
</div>
<div id="stage"><img id="frame" alt="隔离浏览器截图"></div>
<div id="status">点击截图发送鼠标点击；滚动滚轮发送滚动；页面里的输入框先用鼠标点一下再发文本。</div>
<script>
  'use strict'
  const base = ${JSON.stringify(base)}
  const token = ${JSON.stringify(token)}
  const access = ${JSON.stringify(access)}
  const framePath = base + '/frame?token=' + encodeURIComponent(token) + '&access=' + encodeURIComponent(access)
  const inputPath = base + '/input?token=' + encodeURIComponent(token) + '&access=' + encodeURIComponent(access)

  const frame = document.getElementById('frame')
  const urlInput = document.getElementById('url')
  const textInput = document.getElementById('text')
  const statusEl = document.getElementById('status')
  const connEl = document.getElementById('conn')
  const metaEl = document.getElementById('meta')

  let lastMetaAt = 0
  let failures = 0
  let pollBusy = false
  let cssWidth = 0
  let cssHeight = 0
  let scrollPending = 0
  let scrollTimer = null

  function decodeHeader(value) {
    if (!value) return ''
    try { return decodeURIComponent(value) } catch { return value }
  }

  function short(value) {
    const text = typeof value === 'string' ? value : JSON.stringify(value)
    return text.length > 240 ? text.slice(0, 240) + '…' : text
  }

  function setStatus(text) {
    statusEl.textContent = text
  }

  async function post(payload) {
    const response = await fetch(inputPath, {
      method: 'POST',
      cache: 'no-store',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    let body = null
    try { body = await response.json() } catch { body = null }
    if (!response.ok || !body || body.ok !== true) {
      const detail = body && body.error ? (body.error.code || 'ERROR') + ': ' + (body.error.message || '') : 'HTTP ' + response.status
      throw new Error(detail)
    }
    return body
  }

  async function act(payload, label) {
    try {
      const result = await post(payload)
      if ((payload.kind === 'navigate' || payload.kind === 'history') && result.url) urlInput.value = result.url
      if (payload.kind === 'navigate' || payload.kind === 'history') lastMetaAt = 0
      if (payload.kind === 'type') {
        // Never show the typed text: the field may be a password/OTP and this
        // page can be seen (or captured) by a second person.
        setStatus(label + ' ✓ ' + (result.submitted ? '已输入并提交' : '已输入'))
        return result
      }
      setStatus(label + ' ✓ ' + short(result))
      return result
    } catch (error) {
      setStatus(label + ' ✗ ' + (error && error.message ? error.message : String(error)))
      return null
    }
  }

  document.getElementById('navform').addEventListener('submit', (event) => {
    event.preventDefault()
    const url = urlInput.value.trim()
    if (url) void act({ kind: 'navigate', url }, '打开 ' + url)
  })

  document.getElementById('typeform').addEventListener('submit', (event) => {
    event.preventDefault()
    const text = textInput.value
    if (!text) return
    void act({ kind: 'type', text }, '输入文本').then((result) => {
      if (result) textInput.value = ''
    })
  })

  for (const button of document.querySelectorAll('button[data-key]')) {
    button.addEventListener('click', () => {
      void act({ kind: 'key', key: button.dataset.key }, '按键 ' + button.dataset.key)
    })
  }

  document.getElementById('back').addEventListener('click', () => { void act({ kind: 'history', op: 'back' }, '后退') })
  document.getElementById('forward').addEventListener('click', () => { void act({ kind: 'history', op: 'forward' }, '前进') })
  document.getElementById('reload').addEventListener('click', () => { void act({ kind: 'history', op: 'reload' }, '刷新页面') })

  frame.addEventListener('click', (event) => {
    const rect = frame.getBoundingClientRect()
    const width = cssWidth || frame.naturalWidth
    const height = cssHeight || frame.naturalHeight
    if (!width || !height || !rect.width || !rect.height) return
    const x = Math.round(((event.clientX - rect.left) / rect.width) * width)
    const y = Math.round(((event.clientY - rect.top) / rect.height) * height)
    void act({ kind: 'click', x, y }, '点击 (' + x + ', ' + y + ')')
  })

  frame.addEventListener('wheel', (event) => {
    event.preventDefault()
    scrollPending += event.deltaY
    if (scrollTimer) return
    scrollTimer = setTimeout(() => {
      scrollTimer = null
      const deltaY = scrollPending
      scrollPending = 0
      if (!deltaY) return
      void act({ kind: 'scroll', deltaY }, '滚动 ' + (deltaY > 0 ? '↓' : '↑'))
    }, 120)
  }, { passive: false })

  async function poll() {
    if (pollBusy || document.hidden) return
    pollBusy = true
    const wantMeta = Date.now() - lastMetaAt > 900
    try {
      const response = await fetch(framePath + '&t=' + Date.now() + (wantMeta ? '&meta=1' : ''), { cache: 'no-store' })
      if (!response.ok) throw new Error('HTTP ' + response.status)
      const width = Number(response.headers.get('x-dsh-view-width'))
      const height = Number(response.headers.get('x-dsh-view-height'))
      if (Number.isFinite(width) && width > 0) cssWidth = width
      if (Number.isFinite(height) && height > 0) cssHeight = height
      if (wantMeta) {
        lastMetaAt = Date.now()
        const pageUrl = decodeHeader(response.headers.get('x-dsh-context-url'))
        if (pageUrl && document.activeElement !== urlInput) urlInput.value = pageUrl
        const title = decodeHeader(response.headers.get('x-dsh-context-title'))
        metaEl.textContent = title ? '· ' + title : ''
      }
      const blob = await response.blob()
      const next = URL.createObjectURL(blob)
      const previous = frame.src
      await new Promise((resolve, reject) => {
        const onLoad = () => { cleanup(); resolve() }
        const onError = () => { cleanup(); reject(new Error('image decode failed')) }
        const cleanup = () => {
          frame.removeEventListener('load', onLoad)
          frame.removeEventListener('error', onError)
        }
        frame.addEventListener('load', onLoad)
        frame.addEventListener('error', onError)
        frame.src = next
      })
      if (previous.indexOf('blob:') === 0) URL.revokeObjectURL(previous)
      failures = 0
      connEl.textContent = '已连接 · ' + frame.naturalWidth + '×' + frame.naturalHeight + ' · ' + new Date().toLocaleTimeString()
    } catch (error) {
      failures += 1
      if (failures >= 2) connEl.textContent = '暂无画面：' + (error && error.message ? error.message : String(error))
    } finally {
      pollBusy = false
    }
  }

  setInterval(() => { void poll() }, 330)
  void poll()
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) void poll()
  })
</script>
</body></html>`
}

export { viewerHtml }
