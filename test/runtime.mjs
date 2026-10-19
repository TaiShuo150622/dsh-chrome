import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createUpdateRuntime, createViewerRuntime } from '../src/runtime.js'
import { getLiveViewUrl } from '../src/liveview.js'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-runtime-'))
const routes = new Map()
const registered = []
const webServer = {
  getOrigin: () => 'http://127.0.0.1:9999',
  register(route) {
    assert.ok(!routes.has(route.path), `duplicate route ${route.path}`)
    routes.set(route.path, route.handler)
    registered.push(route.path)
    return () => routes.delete(route.path)
  },
}
const logger = { info() {}, warn() {} }
const getContext = (contextId) => (contextId === 'ctx-1' ? { driver: { request: async () => ({}) }, owner: 'session-a' } : null)
const runtime = createViewerRuntime({ webServer, home: root, logger, getContext })

try {
  // Both viewers register on the same web server, liveview first.
  assert.equal(runtime.liveview.enabled, true)
  assert.equal(runtime.viewer.enabled, true)
  assert.deepEqual(registered, ['/dsh-chrome/live', '/dsh-chrome/live/frame', '/dsh-chrome/context'])
  assert.ok(runtime.viewer.urlFor('ctx-1'))
  assert.ok(getLiveViewUrl())

  // One dispose removes both route sets and stops handing out URLs.
  runtime.dispose()
  assert.equal(routes.size, 0)
  assert.equal(runtime.viewer.urlFor('ctx-1'), null)
  assert.equal(getLiveViewUrl(), null)
  runtime.dispose()
  assert.equal(routes.size, 0)

  // The update checker is created by the runtime; index.js only registers the
  // start/stop effect and keeps the checker for chrome_status.
  const lifecycle = []
  let received = null
  const updateRuntime = createUpdateRuntime({
    home: root,
    currentVersion: '1.2.3',
    config: { enabled: true },
    logger,
    createChecker: (options) => {
      received = options
      return {
        start() { lifecycle.push('start') },
        stop() { lifecycle.push('stop') },
      }
    },
  })
  assert.equal(received.home, root)
  assert.equal(received.currentVersion, '1.2.3')
  assert.deepEqual(received.config, { enabled: true })
  assert.equal(received.logger, logger)
  assert.equal(typeof updateRuntime.updateChecker?.start, 'function')
  updateRuntime.start()
  updateRuntime.stop()
  assert.deepEqual(lifecycle, ['start', 'stop'])

  console.log('RUNTIME TEST: PASS')
} finally {
  runtime.dispose()
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}
