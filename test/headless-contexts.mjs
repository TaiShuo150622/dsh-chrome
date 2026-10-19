import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { DEFAULT_CONFIG } from '../src/config.js'
import { BrowserContextManager } from '../src/contexts.js'
import { HeadlessContextRouter } from '../src/headless-contexts.js'
import { BackendRouter } from '../src/backend.js'
import { chromeTools } from '../src/tools.js'
import { HeadlessDriver } from '../src/headless.js'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-headless-contexts-'))
const config = {
  ...DEFAULT_CONFIG,
  browser: { ...DEFAULT_CONFIG.browser, preset: 'sandbox', maxContexts: 2, idleTimeoutMs: 60_000 },
}
const calls = []
const manager = new BrowserContextManager({
  config,
  home,
  createDriver: async ({ contextId, profileDir }) => ({
    contextId,
    profileDir,
    browserVersion: 'test-1',
    async request(method, params) {
      calls.push({ contextId, method, params })
      return { ok: true, method, owner: params.owner }
    },
    async close() {},
  }),
})
const router = new HeadlessContextRouter({ manager })
try {
  const visibleDriver = new HeadlessDriver({ home, visible: true })
  assert.equal(visibleDriver.visible, true)
  assert.deepEqual(visibleDriver.windowSize, { width: 1440, height: 900 })
  const hiddenDriver = new HeadlessDriver({ home })
  assert.equal(hiddenDriver.visible, false)
  assert.equal(router.connected, false)
  const first = await router.request('tab.goto', { owner: 'a', url: 'https://example.com' })
  assert.equal(first.ok, true)
  assert.equal(router.connected, true)
  assert.equal(calls.length, 1)
  assert.ok(calls[0].params.owner === 'a')
  const activeA = manager.activeFor('a')
  assert.ok(activeA)
  assert.equal(manager.view(activeA.contextId).owner, 'a')

  const second = await router.request('tab.snapshot', { owner: 'a' })
  assert.equal(calls.length, 2)
  assert.equal(calls[1].contextId, calls[0].contextId, 'same owner must reuse the active context')

  await router.request('tab.goto', { owner: 'b', url: 'https://example.org' })
  assert.notEqual(calls[2].contextId, calls[0].contextId, 'different owners get isolated contexts')
  assert.equal(manager.stats().active, 2)

  await manager.close(activeA.contextId)
  assert.equal(manager.activeFor('a'), null)
  assert.equal(manager.driverFor(activeA.contextId), null)

  await router.close()
  assert.equal(manager.stats().active, 0)

  // A2: concurrent headless requests for one owner share a single context.
  let concurrentCreates = 0
  const concurrentCalls = []
  const concurrentManager = new BrowserContextManager({
    config,
    home,
    createDriver: async ({ contextId, profileDir }) => {
      concurrentCreates += 1
      await new Promise((resolve) => setTimeout(resolve, 20))
      return {
        contextId,
        profileDir,
        browserVersion: 'test-concurrent',
        async request(method, params) {
          concurrentCalls.push({ contextId, method, owner: params.owner })
          return { ok: true, contextId, method }
        },
        async close() {},
      }
    },
  })
  const concurrentRouter = new HeadlessContextRouter({ manager: concurrentManager })
  const [firstRequest, secondRequest] = await Promise.all([
    concurrentRouter.request('tab.goto', { owner: 'same', url: 'https://example.com/a' }),
    concurrentRouter.request('tab.snapshot', { owner: 'same' }),
  ])
  assert.equal(concurrentCreates, 1, 'concurrent requests must create one browser context')
  assert.equal(concurrentManager.stats().active, 1)
  assert.equal(firstRequest.contextId, secondRequest.contextId)
  assert.ok(concurrentCalls.every((call) => call.contextId === firstRequest.contextId))
  await concurrentRouter.close()
  assert.equal(concurrentManager.stats().active, 0)

  // C4: the provider's `bridge.headless` route has no login methods. With the
  // context manager wired, chrome_headless_login drives the active context's
  // driver instead of throwing UNSUPPORTED_BACKEND.
  const loginHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-headless-login-contexts-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = loginHome
  try {
    const loginDrivers = new Map()
    const loginCalls = []
    const loginManager = new BrowserContextManager({
      config,
      home: loginHome,
      createDriver: async ({ contextId, profileDir }) => {
        const loginDriver = {
          contextId,
          profileDir,
          loginProfile: profileDir,
          browserVersion: null,
          async request() {
            return { ok: true }
          },
          async close() {},
          async loginStart(options) {
            loginCalls.push({ method: 'loginStart', contextId, options })
            return { running: true, alreadyRunning: false, pid: 5151, profile: profileDir, url: options?.url }
          },
          async showVisible(options) {
            loginCalls.push({ method: 'showVisible', contextId, options })
            return { running: true, alreadyRunning: false, visible: true, pid: 5151, profile: profileDir, url: options?.url }
          },
          loginStatus() {
            loginCalls.push({ method: 'loginStatus', contextId })
            return { running: false, profile: profileDir, visible: false, resumeUrl: null }
          },
          loginFinish() {
            loginCalls.push({ method: 'loginFinish', contextId })
            return { running: false, stopped: true, profile: profileDir }
          },
        }
        loginDrivers.set(contextId, loginDriver)
        return loginDriver
      },
    })
    const loginRouter = new HeadlessContextRouter({ manager: loginManager })
    assert.equal(typeof loginRouter.loginStart, 'undefined', 'the provider headless route has no login methods')
    const loginBridge = new BackendRouter({
      desktop: { async call() { return {} } },
      headless: loginRouter,
      headlessSupported: true,
    })
    const loginTools = chromeTools({
      bridge: loginBridge,
      attachments: () => null,
      assets: () => ({}),
      approval: () => null,
      userQuestions: () => ({ ask: async () => ({ answers: [{ id: 'confirm', selected: ['允许一次'] }] }) }),
      config: () => ({ evaluateConfirmTimeoutMs: 1000 }),
      contexts: loginManager,
    })
    const loginTool = loginTools.find((tool) => tool.name === 'chrome_headless_login')
    const loginExec = () => ({ agent: { id: 'login-owner' }, callId: 'login-1', signal: new AbortController().signal })

    let noContextError = null
    try {
      await loginTool.execute({ op: 'status' }, loginExec())
    } catch (error) {
      noContextError = error
    }
    assert.equal(noContextError?.code, 'NO_ACTIVE_CONTEXT', 'login must say how to get a context instead of UNSUPPORTED_BACKEND')

    const ownContext = await loginManager.create({ owner: 'login-owner' })
    const otherContext = await loginManager.create({ owner: 'other-owner' })
    let foreignError = null
    try {
      await loginTool.execute({ op: 'status', contextId: otherContext.contextId }, loginExec())
    } catch (error) {
      foreignError = error
    }
    assert.equal(foreignError?.code, 'CONTEXT_NOT_FOUND', 'another owner context must not be reachable')

    const status = await loginTool.execute({ op: 'status', contextId: ownContext.contextId }, loginExec())
    assert.equal(status.running, false)
    assert.equal(status.profile, loginDrivers.get(ownContext.contextId).profileDir)
    assert.equal(loginCalls.at(-1).method, 'loginStatus')
    assert.equal(loginCalls.at(-1).contextId, ownContext.contextId)

    const started = await loginTool.execute({ op: 'start', url: 'https://example.test/login' }, loginExec())
    assert.equal(started.running, true)
    assert.equal(started.pid, 5151)
    assert.equal(loginCalls.at(-1).method, 'loginStart')
    assert.equal(loginCalls.at(-1).contextId, ownContext.contextId)
    assert.equal(loginCalls.at(-1).options.url, 'https://example.test/login')

    const shown = await loginTool.execute({ op: 'show' }, loginExec())
    assert.equal(shown.visible, true)
    assert.equal(loginCalls.at(-1).method, 'showVisible')

    const finished = await loginTool.execute({ op: 'finish' }, loginExec())
    assert.equal(finished.stopped, true)
    assert.equal(loginCalls.at(-1).method, 'loginFinish')

    await loginManager.closeAll()
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    fs.rmSync(loginHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
  console.log('HEADLESS CONTEXTS TEST: PASS')
} finally {
  await router.close()
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}
