import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { DEFAULT_CONFIG } from '../src/config.js'
import { BrowserContextManager } from '../src/contexts.js'
import { driverState } from '../src/driver-state.js'
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

  // H8: a crashed driver stays visible (context kept, connected false) and is
  // only rebuilt by an explicit chrome_context restart. A request must never
  // silently relaunch it.
  let crashMode = 'ok'
  const crashDrivers = []
  const crashManager = new BrowserContextManager({
    config,
    home,
    createDriver: async ({ contextId, profileDir }) => {
      const driver = {
        contextId,
        profileDir,
        connected: true,
        dead: false,
        deathReason: null,
        chrome: { pid: 4000 + crashDrivers.length + 1 },
        async request(method) {
          if (crashMode === 'crash') {
            driver.dead = true
            driver.deathReason = 'browser-exit:1'
            driver.connected = false
            driver.chrome = null
            throw Object.assign(new Error('the headless browser exited unexpectedly'), { code: 'CONTEXT_CRASHED' })
          }
          return { ok: true, method }
        },
        async close() {
          driver.closed = true
        },
      }
      crashDrivers.push(driver)
      return driver
    },
  })
  const crashRouter = new HeadlessContextRouter({ manager: crashManager })
  const crashExec = { agent: { id: 'crash-owner' } }
  await crashRouter.request('tab.goto', { owner: 'crash-owner', url: 'https://example.com' })
  const crashContextId = crashManager.activeFor('crash-owner').contextId
  assert.equal(crashManager.view(crashContextId).state, 'ready')
  assert.equal(crashManager.view(crashContextId).chromePid, 4001)
  assert.equal(crashRouter.connected, true)

  const crashBridge = new BackendRouter({
    desktop: { connected: false, async call() { return {} } },
    headless: crashRouter,
    headlessSupported: true,
  })
  const crashTools = chromeTools({ bridge: crashBridge, contexts: crashManager, assets: () => ({}) })
  const statusTool = crashTools.find((tool) => tool.name === 'chrome_status')
  const contextTool = crashTools.find((tool) => tool.name === 'chrome_context')

  // H8 state vocabulary: closing wins over crashed, a missing driver is dead.
  assert.equal(driverState(null), 'dead')
  assert.equal(driverState({}), 'ready')
  assert.equal(driverState({ closing: true }), 'closing')
  assert.equal(driverState({ closePromise: Promise.resolve() }), 'closing')
  assert.equal(driverState({ dead: true, deathReason: 'browser-exit:1' }), 'crashed')
  assert.equal(driverState({ dead: true, closing: true }), 'closing')

  const readyStatus = await statusTool.execute({}, crashExec)
  assert.equal(readyStatus.headless.running, true)
  assert.equal(readyStatus.headless.state, 'ready')
  assert.equal(readyStatus.headless.chromePid, 4001)

  crashMode = 'crash'
  await assert.rejects(
    crashRouter.request('tab.snapshot', { owner: 'crash-owner' }),
    (error) => error.code === 'CONTEXT_CRASHED',
  )
  assert.equal(crashManager.stats().active, 1, 'a crashed context is kept for status/restart')
  assert.equal(crashRouter.connected, false, 'a crashed driver must not report connected')
  const crashedView = crashManager.view(crashContextId)
  assert.equal(crashedView.state, 'crashed')
  assert.equal(crashedView.deathReason, 'browser-exit:1')
  assert.equal(crashedView.chromePid, null, 'the dead Chrome process no longer has a pid')

  // The next request sees the same crashed context: no silent relaunch.
  const driversBeforeRetry = crashDrivers.length
  await assert.rejects(
    crashRouter.request('tab.snapshot', { owner: 'crash-owner' }),
    (error) => error.code === 'CONTEXT_CRASHED',
  )
  assert.equal(crashDrivers.length, driversBeforeRetry, 'a crashed context must not be silently relaunched')
  assert.equal(crashManager.activeFor('crash-owner').contextId, crashContextId)

  // chrome_status carries the crash reason/state and shows it in the render.
  const crashStatus = await statusTool.execute({}, crashExec)
  assert.equal(crashStatus.headless.running, false)
  assert.equal(crashStatus.headless.state, 'crashed')
  assert.equal(crashStatus.headless.deathReason, 'browser-exit:1')
  assert.equal(crashStatus.headless.activeContextId, crashContextId)
  const crashStatusText = statusTool.output.render({}, crashStatus)[0]?.text || ''
  assert.ok(crashStatusText.includes('headless driver: crashed'), crashStatusText)
  assert.ok(crashStatusText.includes('last exit: browser-exit:1'), crashStatusText)

  // chrome_context list/current expose the same state.
  const crashCurrent = await contextTool.execute({ op: 'current' }, crashExec)
  assert.equal(crashCurrent.state, 'crashed')
  assert.equal(crashCurrent.deathReason, 'browser-exit:1')
  const crashList = await contextTool.execute({ op: 'list' }, crashExec)
  assert.equal(crashList.contexts[0].state, 'crashed')
  const crashListText = contextTool.output.render({ op: 'list' }, crashList)[0]?.text || ''
  assert.ok(crashListText.includes('crashed'), crashListText)

  // A live context must refuse restart; a crashed one is rebuilt explicitly.
  crashMode = 'ok'
  await crashRouter.request('tab.goto', { owner: 'other-owner', url: 'https://example.org' })
  const otherContextId = crashManager.activeFor('other-owner').contextId
  const refusedRestart = await contextTool.execute({ op: 'restart', contextId: otherContextId }, { agent: { id: 'crash-owner' } })
  assert.equal(refusedRestart.ok, false, 'restart must be owner-scoped')
  assert.equal(refusedRestart.error, 'CONTEXT_NOT_FOUND')

  const readyRefusal = await contextTool.execute(
    { op: 'restart', contextId: otherContextId },
    { agent: { id: 'other-owner' } },
  )
  assert.equal(readyRefusal.ok, false, 'restarting a live context must be refused')
  assert.equal(readyRefusal.error, 'CONTEXT_NOT_CRASHED')
  assert.equal(readyRefusal.state, 'ready')
  assert.ok(readyRefusal.message.includes('restart is only for crashed/dead drivers'), readyRefusal.message)

  const restarted = await contextTool.execute({ op: 'restart' }, crashExec)
  assert.equal(restarted.ok, true, JSON.stringify(restarted))
  assert.equal(restarted.restarted, true)
  assert.notEqual(restarted.contextId, crashContextId)
  assert.equal(restarted.previous.state, 'crashed')
  assert.equal(restarted.state, 'ready')
  assert.equal(crashDrivers.length, driversBeforeRetry + 2, 'restart creates exactly one fresh driver')
  assert.equal(crashDrivers[0].closed, true, 'the crashed driver is closed by restart')
  assert.equal(crashRouter.connected, true)
  await crashRouter.close()
  assert.equal(crashManager.stats().active, 0)

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
