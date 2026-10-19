/**
 * M1 — `attachTab` transaction and tab capacity (no Chrome required).
 *
 * The driver's connection is a fake CDP endpoint: every `send` is recorded and
 * can be made to fail per method, which is how the rollback paths are pinned
 * without spawning a browser. The assertions below are the contract:
 *
 *   - the cap is checked before `Target.createTarget` (over-limit creates
 *     nothing), counts in-flight attaches, and is configurable;
 *   - a failure in createTarget / attachToTarget / Page.enable /
 *     Runtime.enable / visual tracker leaves no map entry, does not consume a
 *     tab id and closes (and detaches) the partial target;
 *   - success registers every map once and supports several tabs in one
 *     browser.
 */
import assert from 'node:assert/strict'

import {
  DEFAULT_MAX_TABS,
  HeadlessDriver,
  MAX_TABS_LIMIT,
  resolveMaxTabs,
} from '../src/headless.js'

class FakeCdp {
  constructor({ fail = {}, createTargetResult, attachResult, createGate = null } = {}) {
    this.calls = []
    this.fail = fail
    this.createTargetResult = createTargetResult
    this.attachResult = attachResult
    this.createGate = createGate
    this.nextTarget = 1
    this.targetUrls = new Map()
    this.sessions = new Map()
  }

  async send(method, params = {}, sessionId) {
    this.calls.push({ method, params, sessionId })
    if (method === 'Target.createTarget' && this.createGate) await this.createGate
    const failure = this.fail[method]
    if (failure) throw failure instanceof Error ? failure : Object.assign(new Error(String(failure)), { code: 'HEADLESS_CDP_FAILED' })
    switch (method) {
      case 'Target.createTarget': {
        if (this.createTargetResult !== undefined) return this.createTargetResult
        const targetId = `target-${this.nextTarget++}`
        this.targetUrls.set(targetId, params.url)
        return { targetId }
      }
      case 'Target.attachToTarget': {
        if (this.attachResult !== undefined) return this.attachResult
        const sessionId = `session-${params.targetId}`
        this.sessions.set(sessionId, params.targetId)
        return { sessionId }
      }
      case 'Runtime.evaluate': {
        const expression = String(params.expression || '')
        if (expression === 'document.readyState') return { result: { value: 'complete' } }
        if (expression.includes('document.title')) {
          const targetId = this.sessions.get(sessionId)
          return { result: { value: { title: 'Fake title', url: this.targetUrls.get(targetId) || 'about:blank' } } }
        }
        return { result: { value: true } }
      }
      default:
        return {}
    }
  }

  onMessage() {
    return () => {}
  }

  close() {}
}

const home = '/tmp/dsh-tab-attach-test'
const makeDriver = (options = {}) => new HeadlessDriver({ home, ...options })
const attachFake = (driver, options = {}) => {
  const cdp = new FakeCdp(options)
  driver.cdp = cdp
  return cdp
}
const callsOf = (cdp, method) => cdp.calls.filter((call) => call.method === method)
// `code` null means "any rejection": CDP failures are rethrown unchanged.
const refusalOf = (promise, code = null) =>
  assert.rejects(promise, (error) => {
    if (code) assert.equal(error.code, code)
    else assert.ok(error)
    return true
  })
const assertNoTabs = (driver, entry) => {
  assert.equal(driver.tabs.size, 0, 'no registered tab')
  assert.equal(driver.bySession.size, 0, 'no session map entry')
  assert.equal(driver.consoleBuffers.size, 0, 'no console buffer')
  assert.equal(driver.pendingTabs, 0, 'no reserved attach slot')
  assert.equal(driver.nextTabId, 1, 'tab id not consumed')
  if (entry) {
    assert.equal(entry.tabs.size, 0, 'owner has no tab')
    assert.equal(entry.activeTabId, null, 'owner has no active tab')
  }
}

// ---------------------------------------------------------- resolveMaxTabs
assert.equal(DEFAULT_MAX_TABS, 12)
assert.equal(MAX_TABS_LIMIT, 64)
assert.equal(resolveMaxTabs(null, {}), 12, 'default cap')
assert.equal(resolveMaxTabs(undefined, {}), 12)
assert.equal(resolveMaxTabs(null, { DSH_HEADLESS_MAX_TABS: '3' }), 3, 'env override')
assert.equal(resolveMaxTabs(2, { DSH_HEADLESS_MAX_TABS: '3' }), 2, 'explicit option wins over env')
assert.equal(resolveMaxTabs(null, { DSH_HEADLESS_MAX_TABS: 'nope' }), 12, 'invalid env falls back')
assert.equal(resolveMaxTabs(0, {}), 12, 'non-positive option falls back')
assert.equal(resolveMaxTabs(-4, {}), 12)
assert.equal(resolveMaxTabs(Number.NaN, {}), 12)
assert.equal(resolveMaxTabs(2.9, {}), 2, 'fractional option floors')
assert.equal(resolveMaxTabs(1000, {}), MAX_TABS_LIMIT, 'cap is bounded')
assert.equal(makeDriver().maxTabs, 12, 'driver default')
assert.equal(makeDriver({ maxTabs: 3 }).maxTabs, 3, 'driver option')
const previousEnv = process.env.DSH_HEADLESS_MAX_TABS
process.env.DSH_HEADLESS_MAX_TABS = '5'
try {
  assert.equal(makeDriver().maxTabs, 5, 'env reaches the driver without re-importing')
} finally {
  if (previousEnv === undefined) delete process.env.DSH_HEADLESS_MAX_TABS
  else process.env.DSH_HEADLESS_MAX_TABS = previousEnv
}

// ------------------------------------------------- success: several tabs, one browser
{
  const driver = makeDriver({ maxTabs: 2 })
  const cdp = attachFake(driver)
  const entry = driver.ownerEntry('owner-a')
  const first = await driver.attachTab(entry, 'https://example.com/one')
  const second = await driver.attachTab(entry, 'about:blank')
  assert.notEqual(first.tabId, second.tabId)
  assert.notEqual(first.targetId, second.targetId)
  assert.notEqual(first.sessionId, second.sessionId)
  assert.equal(first.tabId, 1)
  assert.equal(second.tabId, 2)
  assert.equal(driver.nextTabId, 3)
  assert.equal(driver.tabs.size, 2)
  assert.equal(driver.bySession.size, 2)
  assert.equal(driver.consoleBuffers.size, 2)
  assert.equal(driver.bySession.get(first.sessionId), first)
  assert.deepEqual(driver.consoleBuffers.get(first.tabId), [])
  assert.equal(entry.tabs.size, 2)
  assert.equal(entry.activeTabId, second.tabId, 'newest tab becomes active')
  assert.equal(callsOf(cdp, 'Target.createTarget').length, 2)
  assert.deepEqual(callsOf(cdp, 'Target.createTarget')[0].params, { url: 'https://example.com/one' })
  assert.equal(callsOf(cdp, 'Target.attachToTarget').length, 2)
  assert.equal(callsOf(cdp, 'Page.enable').length, 2)
  assert.equal(callsOf(cdp, 'Runtime.enable').length, 2)
  assert.equal(callsOf(cdp, 'Target.detachFromTarget').length, 0)
  assert.equal(callsOf(cdp, 'Target.closeTarget').length, 0)

  // `tab.tabs` list sees both tabs of the owner; ids stay stable.
  const listed = await driver.tabsRequest('owner-a', { op: 'list' })
  assert.deepEqual(listed.tabs.map((tab) => tab.tabId), [1, 2])
  assert.equal(listed.activeTabId, 2)

  // Capacity is per browser: another owner cannot exceed it either, and the
  // over-limit call creates no target at all.
  const createCallsBefore = callsOf(cdp, 'Target.createTarget').length
  await refusalOf(driver.tabsRequest('owner-b', { op: 'new', url: 'about:blank' }), 'RESOURCE_LIMIT')
  assert.equal(callsOf(cdp, 'Target.createTarget').length, createCallsBefore, 'over-limit attach must not create a target')
  assert.equal(driver.pendingTabs, 0)
  assert.equal(driver.tabs.size, 2)
}

// ------------------------------------- rollback: every failing initialization step
const failureCases = [
  {
    name: 'createTarget rejects',
    options: { fail: { 'Target.createTarget': new Error('create failed') } },
    code: null,
    expectDetach: false,
    expectClose: false,
  },
  {
    name: 'createTarget returns no targetId',
    options: { createTargetResult: {} },
    code: 'HEADLESS_CDP_FAILED',
    expectDetach: false,
    expectClose: false,
  },
  {
    name: 'attachToTarget rejects',
    options: { fail: { 'Target.attachToTarget': new Error('attach failed') } },
    code: null,
    expectDetach: false,
    expectClose: true,
  },
  {
    name: 'attachToTarget returns no sessionId',
    options: { attachResult: {} },
    code: 'HEADLESS_CDP_FAILED',
    expectDetach: false,
    expectClose: true,
  },
  {
    name: 'Page.enable rejects',
    options: { fail: { 'Page.enable': new Error('page.enable failed') } },
    code: null,
    expectDetach: true,
    expectClose: true,
  },
  {
    name: 'Runtime.enable rejects',
    options: { fail: { 'Runtime.enable': new Error('runtime.enable failed') } },
    code: null,
    expectDetach: true,
    expectClose: true,
  },
]
for (const testCase of failureCases) {
  const driver = makeDriver({ maxTabs: 2 })
  const cdp = attachFake(driver, testCase.options)
  const entry = driver.ownerEntry('owner-fail')
  await refusalOf(driver.attachTab(entry, 'https://example.com/fail'), testCase.code)
  assertNoTabs(driver, entry)
  const detach = callsOf(cdp, 'Target.detachFromTarget')
  const close = callsOf(cdp, 'Target.closeTarget')
  assert.equal(detach.length, testCase.expectDetach ? 1 : 0, `${testCase.name}: detach count`)
  assert.equal(close.length, testCase.expectClose ? 1 : 0, `${testCase.name}: close count`)
  if (testCase.expectDetach) assert.equal(detach[0].params.sessionId, 'session-target-1', `${testCase.name}: detaches the attached session`)
  if (testCase.expectClose) assert.equal(close.at(-1).params.targetId, 'target-1', `${testCase.name}: closes the created target`)
  if (testCase.expectDetach && testCase.expectClose) {
    assert.ok(
      cdp.calls.findIndex((call) => call.method === 'Target.detachFromTarget') <
        cdp.calls.findIndex((call) => call.method === 'Target.closeTarget'),
      `${testCase.name}: detach runs before close`,
    )
  }
}

// A visual-tracker install that throws is also a failed attach.
{
  const driver = makeDriver({ maxTabs: 2 })
  const cdp = attachFake(driver)
  const entry = driver.ownerEntry('owner-tracker')
  driver.installVisualTracker = async () => {
    throw new Error('tracker install failed')
  }
  await refusalOf(driver.attachTab(entry, 'about:blank'))
  assertNoTabs(driver, entry)
  assert.equal(callsOf(cdp, 'Target.detachFromTarget').length, 1)
  assert.equal(callsOf(cdp, 'Target.closeTarget').length, 1)
}

// Failure after a good tab keeps the existing registration and active tab.
{
  const driver = makeDriver({ maxTabs: 3 })
  const cdp = new FakeCdp()
  driver.cdp = cdp
  const entry = driver.ownerEntry('owner-mixed')
  const live = await driver.attachTab(entry, 'https://example.com/live')
  cdp.fail['Page.enable'] = new Error('second attach failed')
  await refusalOf(driver.attachTab(entry, 'https://example.com/broken'))
  assert.equal(driver.tabs.size, 1)
  assert.equal(driver.bySession.size, 1)
  assert.equal(driver.consoleBuffers.size, 1)
  assert.equal(driver.nextTabId, 2)
  assert.equal(driver.pendingTabs, 0)
  assert.equal(entry.tabs.size, 1)
  assert.equal(entry.activeTabId, live.tabId, 'a failed attach must not steal the active tab')
  assert.equal(callsOf(cdp, 'Target.closeTarget').length, 1, 'only the failed target is closed')
  assert.equal(callsOf(cdp, 'Target.closeTarget')[0].params.targetId, 'target-2')
}

// Concurrent attaches reserve capacity: the second one is refused before it
// creates anything, while the first is still waiting inside createTarget.
{
  let release = () => {}
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const driver = makeDriver({ maxTabs: 1 })
  const cdp = attachFake(driver, { createGate: gate })
  const entry = driver.ownerEntry('owner-concurrent')
  const first = driver.attachTab(entry, 'https://example.com/slow')
  const second = driver.attachTab(entry, 'https://example.com/extra')
  await refusalOf(second, 'RESOURCE_LIMIT')
  assert.equal(callsOf(cdp, 'Target.createTarget').length, 1, 'reserved slot prevents a second createTarget')
  release()
  const tab = await first
  assert.equal(tab.tabId, 1)
  assert.equal(driver.tabs.size, 1)
  assert.equal(driver.pendingTabs, 0, 'reservation released after commit')
}

console.log('TAB ATTACH TEST: PASS')
