/**
 * F1 viewer (option A): serve the latest screencast frame as a tiny live page
 * from the Host web server. No client plugin/build is required; the user opens
 * a loopback URL with a random token.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

const state = {
  origin: null,
  token: null,
  home: null,
  dispose: null,
}

function cacheDir(home) {
  return path.join(home, 'cache', 'dsh-chrome')
}

function tokenPath(home) {
  return path.join(cacheDir(home), 'live-token')
}

function readOrCreateToken(home) {
  const file = tokenPath(home)
  try {
    const existing = fs.readFileSync(file, 'utf8').trim()
    if (existing) return existing
  } catch {
    // create below
  }
  const token = crypto.randomBytes(24).toString('hex')
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, `${token}\n`, { mode: 0o600 })
  } catch {
    // token stays in memory even if the file cannot be written
  }
  return token
}

function isLoopback(req) {
  const address = req?.socket?.remoteAddress || ''
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

function parsePath(reqUrl) {
  try {
    const parsed = new URL(String(reqUrl || '/'), 'http://127.0.0.1')
    return { pathname: parsed.pathname, token: parsed.searchParams.get('token') || '' }
  } catch {
    return { pathname: '', token: '' }
  }
}

function plain(res, status, body, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'content-type': contentType, 'cache-control': 'no-store' })
  res.end(body)
}

function viewerHtml(token) {
  const frameUrl = `/dsh-chrome/live/frame?token=${encodeURIComponent(token)}`
  return `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>DSH Chrome Live</title>
<style>
  body { margin: 0; background: #111; color: #ddd; font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  header { padding: 8px 12px; display: flex; gap: 12px; align-items: baseline; border-bottom: 1px solid #333; }
  header b { color: #fff; font-size: 14px; }
  header span { color: #888; }
  img { display: block; max-width: 100vw; max-height: calc(100vh - 40px); margin: 0 auto; }
</style></head>
<body>
<header><b>DSH · Chrome Live</b><span>最新帧（页面有变化时刷新）</span><span id="st">连接中…</span></header>
<img id="frame" alt="screencast frame" src="${frameUrl}">
<script>
  const img = document.getElementById('frame')
  const st = document.getElementById('st')
  let failures = 0
  const frameUrl = ${JSON.stringify(frameUrl)}
  setInterval(() => {
    img.src = frameUrl + '&t=' + Date.now()
  }, 300)
  img.addEventListener('load', () => { failures = 0; st.textContent = '已连接 ' + new Date().toLocaleTimeString() })
  img.addEventListener('error', () => { failures += 1; st.textContent = failures > 2 ? '暂无帧（先 chrome_screencast start）' : '等待帧…' })
</script>
</body></html>`
}

async function serveFrame(req, res, home) {
  const directory = path.join(cacheDir(home), 'screencast')
  for (const name of ['latest.jpg', 'latest.png']) {
    const file = path.join(directory, name)
    try {
      const data = await fsp.readFile(file)
      res.writeHead(200, {
        'content-type': name.endsWith('.png') ? 'image/png' : 'image/jpeg',
        'cache-control': 'no-store, max-age=0',
        'content-length': data.byteLength,
      })
      res.end(data)
      return
    } catch {
      // try next
    }
  }
  plain(res, 404, 'no screencast frame yet; call chrome_screencast {op:"start"} first')
}

/**
 * Register the viewer routes on the Host web server.
 * Returns { url, token, dispose }.
 */
export function registerLiveView({ webServer, home, logger }) {
  if (state.dispose) return { url: getLiveViewUrl(), enabled: true, token: state.token }
  const disposers = []
  const token = readOrCreateToken(home)
  state.home = home
  state.token = token
  state.origin = typeof webServer.getOrigin === 'function' ? webServer.getOrigin() : null
  try {
    disposers.push(
      webServer.register({
        kind: 'exact',
        path: '/dsh-chrome/live',
        handler: (req, res) => {
          if (req.method !== 'GET') return plain(res, 405, 'method not allowed')
          if (!isLoopback(req)) return plain(res, 403, 'loopback only')
          const { pathname, token: supplied } = parsePath(req.url)
          if (pathname !== '/dsh-chrome/live' || supplied !== token) return plain(res, 403, 'invalid live token')
          plain(res, 200, viewerHtml(token), 'text/html; charset=utf-8')
        },
      }),
    )
    disposers.push(
      webServer.register({
        kind: 'exact',
        path: '/dsh-chrome/live/frame',
        handler: (req, res) => {
          if (req.method !== 'GET') return plain(res, 405, 'method not allowed')
          if (!isLoopback(req)) return plain(res, 403, 'loopback only')
          const { pathname, token: supplied } = parsePath(req.url)
          if (pathname !== '/dsh-chrome/live/frame' || supplied !== token) return plain(res, 403, 'invalid live token')
          serveFrame(req, res, home).catch((error) => plain(res, 500, `frame read failed: ${error?.message || error}`))
        },
      }),
    )
    state.dispose = () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          // unloading continues
        }
      }
      state.dispose = null
      state.origin = null
      state.token = null
    }
    logger?.info?.('dsh-chrome: live viewer registered at %s', `${state.origin}/dsh-chrome/live`)
    return { url: getLiveViewUrl(), enabled: true, token }
  } catch (error) {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        // ignore
      }
    }
    logger?.warn?.('dsh-chrome: live viewer registration failed: %s', error?.message || String(error))
    return { url: null, enabled: false, token: null }
  }
}

export function getLiveViewUrl() {
  if (!state.origin || !state.token) return null
  return `${state.origin}/dsh-chrome/live?token=${encodeURIComponent(state.token)}`
}

export function getLiveViewInfo() {
  return { enabled: Boolean(state.origin && state.token), url: getLiveViewUrl(), origin: state.origin }
}

export function unregisterLiveView() {
  try {
    state.dispose?.()
  } catch {
    // ignore
  }
}
