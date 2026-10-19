/**
 * H3 viewer bearer boundary, no Chrome required.
 *
 * The model-facing viewer tools must return an opaque handle plus a 0600 local
 * handoff file, never the bearer URL. The render blocks and the operation log
 * must not contain `token=` / `access=` either; the handoff file is the only
 * place the URL is allowed to appear.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { registerContextViewer } from '../src/context-viewer.js'
import { registerLiveView, unregisterLiveView } from '../src/liveview.js'
import { operationLogPath, wrapToolsForOperationLog } from '../src/operation-log.js'
import { chromeTools } from '../src/tools.js'

const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-viewer-secrets-'))
process.env.DSH_HOME = home

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

const driver = { async request() { return {} } }
const liveview = registerLiveView({ webServer, home })
const viewer = registerContextViewer({
  webServer,
  home,
  token: 'viewer-token-0123456789',
  getContext: () => ({ driver, owner: 'session-a' }),
})
assert.equal(liveview.enabled, true)
assert.equal(viewer.enabled, true)

const tools = chromeTools({
  bridge: {
    supports: () => true,
    async call() {
      throw new Error('viewer secret test must not reach the browser backend')
    },
  },
  attachments: () => null,
  assets: () => ({}),
  approval: () => null,
  contexts: { activeFor: () => ({ contextId: 'ctx-1', preset: 'sandbox', isolation: 'ephemeral' }) },
  contextViewer: () => viewer,
})
const wrapped = wrapToolsForOperationLog(tools, { defaultBackend: () => 'desktop' })
const byName = new Map(wrapped.map((tool) => [tool.name, tool]))
const exec = () => ({ agent: { id: 'viewer-secrets-session' }, callId: 'viewer-secrets-call', signal: new AbortController().signal })

function assertNoViewerSecret(text, label) {
  assert.equal(String(text).includes('token='), false, `${label} leaked token=`)
  assert.equal(String(text).includes('access='), false, `${label} leaked access=`)
}

try {
  // chrome_context viewer: opaque handle + local handoff file only.
  const contextValue = await byName.get('chrome_context').execute({ op: 'viewer' }, exec())
  assert.equal(contextValue.ok, true)
  assert.match(contextValue.handle, /^context:/)
  assert.equal(contextValue.url, undefined, 'chrome_context viewer must not return url')
  assert.equal(typeof contextValue.urlFile, 'string')
  assertNoViewerSecret(JSON.stringify(contextValue), 'chrome_context viewer result')
  const contextRender = byName.get('chrome_context').output.render({ op: 'viewer' }, contextValue)
  assertNoViewerSecret(JSON.stringify(contextRender), 'chrome_context viewer render')
  assert.ok(fs.existsSync(contextValue.urlFile), 'context handoff file was not written')
  assertNoViewerSecret(contextValue.hint, 'context handoff hint')
  assert.ok(fs.readFileSync(contextValue.urlFile, 'utf8').includes('access='), 'context handoff file must contain the real viewer URL')
  assert.equal(fs.statSync(contextValue.urlFile).mode & 0o777, 0o600)

  // chrome_screencast viewer: same boundary.
  const liveValue = await byName.get('chrome_screencast').execute({ op: 'viewer' }, exec())
  assert.equal(liveValue.enabled, true)
  assert.equal(liveValue.handle, 'live')
  assert.equal(liveValue.url, undefined, 'chrome_screencast viewer must not return url')
  assert.equal(typeof liveValue.urlFile, 'string')
  assertNoViewerSecret(JSON.stringify(liveValue), 'chrome_screencast viewer result')
  const liveRender = byName.get('chrome_screencast').output.render({ op: 'viewer' }, liveValue)
  assertNoViewerSecret(JSON.stringify(liveRender), 'chrome_screencast viewer render')
  assert.ok(fs.existsSync(liveValue.urlFile), 'live handoff file was not written')
  assert.ok(fs.readFileSync(liveValue.urlFile, 'utf8').includes('token='), 'live handoff file must contain the real viewer URL')
  assert.equal(fs.statSync(liveValue.urlFile).mode & 0o777, 0o600)

  // The operation log records the calls without the bearer values.
  const log = fs.readFileSync(operationLogPath(home), 'utf8')
  assert.ok(log.trim().split('\n').length >= 2, 'viewer calls must be logged')
  assertNoViewerSecret(log, 'operation log')
  assert.ok(log.includes('chrome_context'), 'operation log must name chrome_context')
  assert.ok(log.includes('chrome_screencast'), 'operation log must name chrome_screencast')

  console.log('VIEWER SECRETS TEST: PASS')
} finally {
  viewer.dispose()
  unregisterLiveView()
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}
