import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { getLiveViewInfo, getLiveViewOpenInfo, getLiveViewUrl, registerLiveView, unregisterLiveView } from '../src/liveview.js'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-liveview-test-'))
const routes = new Map()
const webServer = {
  getOrigin() {
    return 'http://127.0.0.1:9999'
  },
  register(route) {
    assert.ok(!routes.has(route.path), `duplicate route ${route.path}`)
    routes.set(route.path, route.handler)
    return () => routes.delete(route.path)
  },
}

function request(handler, url, { method = 'GET', remoteAddress = '127.0.0.1' } = {}) {
  return new Promise((resolve) => {
    const response = {
      status: null,
      headers: null,
      body: null,
      writeHead(status, headers) {
        this.status = status
        this.headers = headers
      },
      end(body) {
        this.body = body
        resolve(this)
      },
    }
    handler({ method, url, headers: {}, socket: { remoteAddress } }, response)
  })
}

try {
  const info = registerLiveView({ webServer, home })
  assert.equal(info.enabled, true)
  const url = getLiveViewUrl()
  assert.ok(url.includes('http://127.0.0.1:9999/dsh-chrome/live?token='))
  const token = new URL(url).searchParams.get('token')
  assert.ok(token && token.length >= 32)

  // H3: the model-facing handoff is a 0600 local file, never the bearer URL.
  const openInfo = getLiveViewOpenInfo()
  assert.equal(openInfo.enabled, true)
  assert.equal(openInfo.handle, 'live')
  assert.equal(openInfo.url, undefined, 'open info must not return the bearer URL')
  assert.equal(JSON.stringify(openInfo).includes('token='), false)
  assert.ok(openInfo.urlFile, 'open info must name a local handoff file')
  assert.equal(fs.statSync(openInfo.urlFile).mode & 0o777, 0o600)
  assert.ok(fs.readFileSync(openInfo.urlFile, 'utf8').includes('token='), 'the local handoff file must contain the live URL')
  const statusInfo = getLiveViewInfo()
  assert.equal(statusInfo.enabled, true)
  assert.equal(statusInfo.url, undefined, 'status info must not return the bearer URL')

  const html = await request(routes.get('/dsh-chrome/live'), `/dsh-chrome/live?token=${token}`)
  assert.equal(html.status, 200)
  assert.ok(String(html.body).includes('/dsh-chrome/live/frame?token='))

  const denied = await request(routes.get('/dsh-chrome/live'), '/dsh-chrome/live?token=wrong')
  assert.equal(denied.status, 403)

  const notLoopback = await request(routes.get('/dsh-chrome/live'), `/dsh-chrome/live?token=${token}`, { remoteAddress: '10.0.0.2' })
  assert.equal(notLoopback.status, 403)

  const missing = await request(routes.get('/dsh-chrome/live/frame'), `/dsh-chrome/live/frame?token=${token}`)
  assert.equal(missing.status, 404)

  const screenshotDir = path.join(home, 'cache', 'dsh-chrome', 'screencast')
  fs.mkdirSync(screenshotDir, { recursive: true })
  fs.writeFileSync(path.join(screenshotDir, 'latest.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]))
  const frame = await request(routes.get('/dsh-chrome/live/frame'), `/dsh-chrome/live/frame?token=${token}`)
  assert.equal(frame.status, 200)
  assert.equal(frame.headers['content-type'], 'image/jpeg')
  assert.equal(frame.headers['cache-control'], 'no-store, max-age=0')
  assert.ok(frame.body.length === 4)

  unregisterLiveView()
  assert.equal(routes.size, 0)
  assert.equal(getLiveViewUrl(), null)
  assert.equal(getLiveViewOpenInfo().enabled, false)
  console.log('LIVEVIEW TEST: PASS')
} finally {
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}
