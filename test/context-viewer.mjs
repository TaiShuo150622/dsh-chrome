import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { registerContextViewer } from '../src/context-viewer.js'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-context-viewer-'))
const jpegPath = path.join(root, 'shot.jpg')
const pngPath = path.join(root, 'shot.png')
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9])
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
fs.writeFileSync(jpegPath, jpeg)
fs.writeFileSync(pngPath, png)

const token = 'test-token-0123456789'
const calls = []
const driver = {
  async request(method, params) {
    calls.push({ method, params })
    if (method === 'tab.screenshot') {
      const wantPng = params.format === 'png'
      return {
        path: wantPng ? pngPath : jpegPath,
        mediaType: wantPng ? 'image/png' : 'image/jpeg',
        width: 800,
        height: 600,
        bytes: wantPng ? png.length : jpeg.length,
      }
    }
    if (method === 'tab.tabs') {
      return { tabs: [{ tabId: 7, url: 'https://example.com/', title: 'Example', active: true }], activeTabId: 7 }
    }
    if (method === 'tab.clickAt') return { ok: true, tabId: 7, x: params.x, y: params.y }
    if (method === 'tab.type') return { ok: true, value: params.text, submitted: params.submit === true, tabId: 7 }
    if (method === 'tab.press') return { ok: true, tabId: 7, key: params.key }
    if (method === 'tab.scroll') return { ok: true, tabId: 7, x: 0, y: params.direction === 'up' ? 0 : 480 }
    if (method === 'tab.goto') return { tabId: 7, url: params.url, title: 'Example', loadState: 'complete' }
    if (method === 'tab.history') return { tabId: 7, url: 'https://example.com/', title: 'Example' }
    throw Object.assign(new Error(`unexpected driver method ${method}`), { code: 'UNEXPECTED' })
  },
}

function makeWebServer(routes) {
  return {
    getOrigin() {
      return 'http://127.0.0.1:9999'
    },
    register(route) {
      assert.equal(route.kind, 'prefix')
      assert.ok(!routes.has(route.path), `duplicate route ${route.path}`)
      routes.set(route.path, route.handler)
      return () => routes.delete(route.path)
    },
  }
}

const routes = new Map()
const warnings = []
const logger = {
  info() {},
  warn(...args) {
    warnings.push(args.map((value) => String(value)).join(' '))
  },
}
const getContext = (contextId) => (contextId === 'ctx-1' ? { driver, owner: 'session-a' } : null)
const viewer = registerContextViewer({
  webServer: makeWebServer(routes),
  getContext,
  token,
  logger,
  home: path.join(root, 'home'),
})

function lastCall(method) {
  for (let index = calls.length - 1; index >= 0; index -= 1) {
    if (calls[index].method === method) return calls[index]
  }
  return null
}

function request(handler, url, { method = 'GET', remoteAddress = '127.0.0.1', body = null } = {}) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve({ status: 'timeout', headers: null, body: null })
    }, 2000)
    const response = {
      status: null,
      headers: null,
      body: null,
      writableEnded: false,
      writeHead(status, headers) {
        this.status = status
        this.headers = headers
      },
      end(body) {
        this.body = body
        this.writableEnded = true
        clearTimeout(timer)
        resolve(this)
      },
    }
    const req = {
      method,
      url,
      headers: {},
      socket: { remoteAddress },
      async *[Symbol.asyncIterator]() {
        if (body != null) yield Buffer.from(body)
      },
    }
    void handler(req, response)
  })
}

try {
  assert.equal(viewer.enabled, true)
  assert.equal(routes.size, 1)
  assert.ok(routes.has('/dsh-chrome/context'))
  assert.equal(
    viewer.urlFor('ctx-1'),
    `http://127.0.0.1:9999/dsh-chrome/context/ctx-1/view?token=${token}`,
  )
  assert.equal(viewer.urlFor('bad id'), null)

  const handler = routes.get('/dsh-chrome/context')
  const viewUrl = `/dsh-chrome/context/ctx-1/view?token=${token}`

  // GET view: inline HTML with the frame/input endpoints, no external assets.
  const view = await request(handler, viewUrl)
  assert.equal(view.status, 200)
  assert.match(view.headers['content-type'], /^text\/html/)
  assert.match(view.headers['content-security-policy'], /default-src 'none'/)
  assert.equal(view.headers['referrer-policy'], 'no-referrer')
  const html = String(view.body)
  assert.ok(html.includes('/dsh-chrome/context/ctx-1'))
  assert.ok(html.includes('/frame?token='))
  assert.ok(html.includes('/input?token='))
  assert.ok(html.includes(token))
  assert.match(view.headers['content-security-policy'], /connect-src 'self'/)
  assert.ok(!/(?:src|href)="https?:\/\//.test(html), 'viewer HTML must not load external resources')

  // Token + loopback gates apply before routing.
  assert.equal((await request(handler, `/dsh-chrome/context/ctx-1/view?token=wrong-token`)).status, 403)
  assert.equal((await request(handler, viewUrl, { remoteAddress: '10.0.0.2' })).status, 403)
  assert.equal((await request(handler, `/dsh-chrome/context/ctx-1/view`)).status, 403)
  assert.equal((await request(handler, `/dsh-chrome/context/ctx-1/view?token=${token}`, { remoteAddress: '::1' })).status, 200)

  // Method + route errors.
  const postView = await request(handler, viewUrl, { method: 'POST' })
  assert.equal(postView.status, 405)
  assert.equal(postView.headers.allow, 'GET')
  assert.equal((await request(handler, `/dsh-chrome/context/missing/view?token=${token}`)).status, 404)
  assert.equal((await request(handler, `/dsh-chrome/context/bad$id/view?token=${token}`)).status, 404)
  assert.equal((await request(handler, `/dsh-chrome/context/ctx-1/unknown?token=${token}`)).status, 404)

  // GET frame: bytes come from the driver screenshot path.
  calls.length = 0
  const frame = await request(handler, `/dsh-chrome/context/ctx-1/frame?token=${token}`)
  assert.equal(frame.status, 200)
  assert.equal(frame.headers['content-type'], 'image/jpeg')
  assert.equal(frame.headers['cache-control'], 'no-store, max-age=0')
  assert.equal(frame.headers['content-length'], jpeg.length)
  assert.equal(frame.headers['x-dsh-view-width'], '800')
  assert.equal(frame.headers['x-dsh-view-height'], '600')
  assert.deepEqual(frame.body, jpeg)
  assert.deepEqual(lastCall('tab.screenshot').params, { format: 'jpeg', quality: 70, owner: 'viewer' })

  // `meta=1` adds the current URL/title headers for the viewer's URL bar.
  calls.length = 0
  const metaFrame = await request(handler, `/dsh-chrome/context/ctx-1/frame?token=${token}&meta=1`)
  assert.equal(metaFrame.status, 200)
  assert.equal(metaFrame.headers['x-dsh-context-url'], encodeURIComponent('https://example.com/'))
  assert.equal(metaFrame.headers['x-dsh-context-title'], encodeURIComponent('Example'))
  assert.equal(metaFrame.headers['x-dsh-context-tab'], '7')
  assert.ok(lastCall('tab.tabs'))
  assert.deepEqual(lastCall('tab.tabs').params, { op: 'list', owner: 'viewer' })

  // PNG frames are supported too.
  const pngFrame = await request(handler, `/dsh-chrome/context/ctx-1/frame?token=${token}&format=png&quality=90`)
  assert.equal(pngFrame.status, 200)
  assert.equal(pngFrame.headers['content-type'], 'image/png')
  assert.deepEqual(pngFrame.body, png)
  assert.deepEqual(lastCall('tab.screenshot').params, { format: 'png', quality: 90, owner: 'viewer' })

  assert.equal((await request(handler, `/dsh-chrome/context/ctx-1/frame?token=${token}`, { method: 'POST' })).status, 405)

  // POST input: click -> tab.clickAt with the fixed owner "viewer".
  const post = (body, options = {}) =>
    request(handler, `/dsh-chrome/context/ctx-1/input?token=${token}`, {
      method: 'POST',
      body: typeof body === 'string' ? body : JSON.stringify(body),
      ...options,
    })

  calls.length = 0
  const click = await post({ kind: 'click', x: 12.4, y: 34.6 })
  assert.equal(click.status, 200)
  assert.match(click.headers['content-type'], /^application\/json/)
  const clickBody = JSON.parse(String(click.body))
  assert.equal(clickBody.ok, true)
  assert.equal(clickBody.kind, 'click')
  assert.equal(clickBody.x, 12.4)
  assert.equal(clickBody.y, 34.6)
  assert.equal(clickBody.clickCount, 1)
  assert.deepEqual(lastCall('tab.clickAt').params, { x: 12.4, y: 34.6, clickCount: 1, owner: 'viewer' })

  // type -> tab.type; without a selector the focused element is targeted.
  calls.length = 0
  const typed = await post({ kind: 'type', text: 'hello' })
  assert.equal(typed.status, 200)
  assert.equal(JSON.parse(String(typed.body)).value, 'hello')
  assert.deepEqual(lastCall('tab.type').params, { text: 'hello', selector: ':focus', owner: 'viewer' })

  calls.length = 0
  const typedSelector = await post({ kind: 'type', text: 'x', selector: '#q', replace: true })
  assert.equal(typedSelector.status, 200)
  assert.deepEqual(lastCall('tab.type').params, { text: 'x', selector: '#q', replace: true, owner: 'viewer' })

  // key / scroll / history / navigate.
  calls.length = 0
  assert.equal((await post({ kind: 'key', key: 'Enter' })).status, 200)
  assert.deepEqual(lastCall('tab.press').params, { key: 'Enter', owner: 'viewer' })

  calls.length = 0
  const scrolled = await post({ kind: 'scroll', deltaY: -480 })
  assert.equal(scrolled.status, 200)
  assert.equal(JSON.parse(String(scrolled.body)).direction, 'up')
  assert.deepEqual(lastCall('tab.scroll').params, { direction: 'up', amount: 480, owner: 'viewer' })

  calls.length = 0
  assert.equal((await post({ kind: 'history', op: 'reload' })).status, 200)
  assert.deepEqual(lastCall('tab.history').params, { op: 'reload', owner: 'viewer' })

  calls.length = 0
  const navigated = await post({ kind: 'navigate', url: 'https://example.com/a' })
  assert.equal(navigated.status, 200)
  assert.equal(JSON.parse(String(navigated.body)).url, 'https://example.com/a')
  assert.deepEqual(lastCall('tab.goto').params, { url: 'https://example.com/a', owner: 'viewer' })

  // Validation happens before the driver sees anything.
  calls.length = 0
  assert.equal((await post({ kind: 'navigate', url: 'javascript:alert(1)' })).status, 400)
  assert.equal((await post({ kind: 'navigate', url: 'file:///etc/passwd' })).status, 400)
  assert.equal((await post({ kind: 'click', x: 'nope', y: 1 })).status, 400)
  assert.equal((await post({ kind: 'scroll', deltaY: 0 })).status, 400)
  assert.equal((await post({ kind: 'type', text: '' })).status, 400)
  assert.equal((await post({ kind: 'key', key: '' })).status, 400)
  assert.equal((await post({ kind: 'what' })).status, 400)
  assert.equal((await post('{')).status, 400)
  assert.equal((await post('')).status, 400)
  assert.equal(calls.length, 0, 'invalid input must not reach the driver')

  const tooLarge = await post({ kind: 'type', text: 'a'.repeat(70 * 1024) })
  assert.equal(tooLarge.status, 413)

  // Input route is POST-only.
  const getInput = await request(handler, `/dsh-chrome/context/ctx-1/input?token=${token}`)
  assert.equal(getInput.status, 405)
  assert.equal(getInput.headers.allow, 'POST')

  // Dispose removes the prefix route and stops handing out URLs.
  viewer.dispose()
  assert.equal(routes.size, 0)
  assert.equal(viewer.urlFor('ctx-1'), null)
  viewer.dispose()

  // Context lookup errors and driver errors surface with the right status.
  const lookupRoutes = new Map()
  const throwingLookup = registerContextViewer({
    webServer: makeWebServer(lookupRoutes),
    getContext: () => {
      throw Object.assign(new Error('context went away'), { code: 'CONTEXT_NOT_FOUND' })
    },
    token,
    logger,
    home: path.join(root, 'lookup-home'),
  })
  const gone = await request(lookupRoutes.get('/dsh-chrome/context'), `/dsh-chrome/context/ctx-1/view?token=${token}`)
  assert.equal(gone.status, 404)
  throwingLookup.dispose()

  const driverRoutes = new Map()
  const failingDriver = registerContextViewer({
    webServer: makeWebServer(driverRoutes),
    getContext: () => ({
      driver: {
        async request() {
          throw Object.assign(new Error('driver exploded'), { code: 'DRIVER_EXPLODED' })
        },
      },
    }),
    token,
    logger,
    home: path.join(root, 'driver-home'),
  })
  const failedFrame = await request(driverRoutes.get('/dsh-chrome/context'), `/dsh-chrome/context/ctx-1/frame?token=${token}`)
  assert.equal(failedFrame.status, 500)
  assert.match(String(failedFrame.body), /driver exploded/)
  failingDriver.dispose()

  // Generated tokens persist in a 0600 file and are reused across registrations.
  const tokenHome = path.join(root, 'token-home')
  const tokenRoutes = new Map()
  const tokenServer = makeWebServer(tokenRoutes)
  const first = registerContextViewer({ webServer: tokenServer, getContext: () => null, home: tokenHome, logger })
  assert.equal(first.enabled, true)
  assert.match(first.token, /^[0-9a-f]{48}$/)
  const tokenFile = path.join(tokenHome, 'cache', 'dsh-chrome', 'context-viewer-token')
  assert.equal(fs.readFileSync(tokenFile, 'utf8').trim(), first.token)
  assert.equal(fs.statSync(tokenFile).mode & 0o777, 0o600)
  assert.ok(first.urlFor('ctx-1').includes(first.token))
  first.dispose()
  const second = registerContextViewer({ webServer: tokenServer, getContext: () => null, home: tokenHome, logger })
  assert.equal(second.token, first.token)
  second.dispose()

  // Missing dependencies fail soft instead of throwing during provider load.
  const disabled = registerContextViewer({ webServer: null, getContext: () => null, logger })
  assert.equal(disabled.enabled, false)
  assert.equal(disabled.token, null)
  assert.equal(disabled.urlFor('ctx-1'), null)
  disabled.dispose()

  console.log('CONTEXT VIEWER TEST: PASS')
} finally {
  viewer.dispose()
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}
