/**
 * M2 — one teardown path for tabs, sessions, owners, captures and downloads
 * (no Chrome required).
 *
 * `cleanupTab` is the single place a tab is unregistered. The assertions below
 * pin the contract around it:
 *
 *   - `tabs op=close`, `close_session`, target detach/destroy and browser exit
 *     all remove the tab from every map and clear its capture timer;
 *   - the last tab of an owner releases the owner entry, but only when no
 *     attach is in flight and no login window is open;
 *   - the download history and its guid index stay bounded together and are
 *     dropped with the browser;
 *   - `close()` clears the idle timer.
 */
import assert from 'node:assert/strict'

import { HeadlessDriver } from '../src/headless.js'

class FakeCdp {
  constructor() {
    this.calls = []
    this.nextTarget = 1
  }

  async send(method, params = {}, sessionId) {
    this.calls.push({ method, params, sessionId })
    switch (method) {
      case 'Target.createTarget': {
        const targetId = `target-${this.nextTarget++}`
        return { targetId }
      }
      case 'Target.attachToTarget':
        return { sessionId: `session-${params.targetId}` }
      default:
        return {}
    }
  }

  onMessage() {
    return () => {}
  }

  close() {}
}

const home = '/tmp/dsh-tab-lifecycle-test'
const makeDriver = (options = {}) => new HeadlessDriver({ home, ...options })
const attachFake = (driver) => {
  const cdp = new FakeCdp()
  driver.cdp = cdp
  return cdp
}
const callsOf = (cdp, method) => cdp.calls.filter((call) => call.method === method)
const assertTabGone = (driver, tab) => {
  assert.equal(driver.tabs.has(tab.tabId), false, `tab ${tab.tabId} in tabs`)
  assert.equal(driver.bySession.has(tab.sessionId), false, `tab ${tab.tabId} session in bySession`)
  assert.equal(driver.consoleBuffers.has(tab.tabId), false, `tab ${tab.tabId} console buffer`)
  assert.equal(driver.captureByTab.has(tab.tabId), false, `tab ${tab.tabId} capture index`)
  assert.equal(tab.cleaned, true, `tab ${tab.tabId} marked cleaned`)
}

// --------------------------------------- tabs op=close clears every structure
{
  const driver = makeDriver()
  const cdp = attachFake(driver)
  const entry = driver.ownerEntry('owner-a')
  const first = await driver.attachTab(entry, 'https://example.com/one')
  const second = await driver.attachTab(entry, 'https://example.com/two')
  assert.equal(second.owner, 'owner-a', 'tab knows its owner')
  assert.equal(entry.pending, 0)

  // A capture is owned by the tab: closing the tab must drop the index entry,
  // the capture object and its max-duration timer.
  const started = await driver.dispatch('tab.capture_start', { owner: 'owner-a', tabId: first.tabId })
  const capture = driver.captures.get(started.captureId)
  assert.ok(capture, 'capture registered')
  assert.ok(capture.timer, 'capture timer armed')

  const closed = await driver.tabsRequest('owner-a', { op: 'close', tabId: first.tabId })
  assert.deepEqual(closed, { closed: first.tabId, remaining: 1 })
  assertTabGone(driver, first)
  assert.equal(driver.captures.has(started.captureId), false, 'capture registry cleaned')
  assert.equal(capture.active, false, 'capture deactivated')
  assert.equal(capture.endedReason, 'tab-closed')
  assert.equal(callsOf(cdp, 'Target.closeTarget').length, 1, 'one CDP close')
  assert.equal(callsOf(cdp, 'Target.closeTarget')[0].params.targetId, first.targetId)
  assert.equal(entry.activeTabId, second.tabId, 'active tab moves to the survivor')
  assert.equal(driver.owners.has('owner-a'), true, 'owner kept while it still has a tab')

  // Closing the last tab of the owner releases the owner entry.
  await driver.tabsRequest('owner-a', { op: 'close', tabId: second.tabId })
  assertTabGone(driver, second)
  assert.equal(entry.tabs.size, 0)
  assert.equal(entry.activeTabId, null)
  assert.equal(driver.owners.has('owner-a'), false, 'last tab releases the owner')
  assert.equal(driver.tabs.size, 0)
  assert.equal(driver.bySession.size, 0)
  assert.equal(driver.consoleBuffers.size, 0)
  assert.equal(driver.captures.size, 0)
  assert.equal(driver.captureByTab.size, 0)
}

// -------------------------------------------- close_session closes all tabs
{
  const driver = makeDriver()
  const cdp = attachFake(driver)
  const a1 = await driver.attachTab(driver.ownerEntry('owner-s'), 'about:blank')
  const a2 = await driver.attachTab(driver.ownerEntry('owner-s'), 'about:blank')
  const b1 = await driver.attachTab(driver.ownerEntry('other'), 'about:blank')
  assert.equal(driver.tabs.size, 3)

  const result = await driver.dispatch('tab.close_session', { owner: 'owner-s' })
  assert.equal(result.closed, 2)
  assertTabGone(driver, a1)
  assertTabGone(driver, a2)
  assert.equal(driver.owners.has('owner-s'), false, 'session owner released')
  assert.equal(driver.tabs.size, 1, 'other owner untouched')
  assert.equal(driver.tabs.get(b1.tabId), b1)
  assert.equal(driver.owners.has('other'), true)
  assert.equal(callsOf(cdp, 'Target.closeTarget').length, 2)
}

// ------------------------------- target detach / destroy run the same cleanup
{
  const driver = makeDriver()
  attachFake(driver)
  const entry = driver.ownerEntry('owner-d')
  const first = await driver.attachTab(entry, 'about:blank')
  const second = await driver.attachTab(entry, 'about:blank')
  assert.equal(entry.activeTabId, second.tabId)

  // A target disappears without going through tabs op=close (e.g. page closed
  // itself): the driver must not keep the phantom tab or its buffers.
  driver.onCdpEvent({ method: 'Target.detachedFromTarget', params: { sessionId: second.sessionId } })
  assertTabGone(driver, second)
  assert.equal(driver.tabs.size, 1)
  assert.equal(entry.activeTabId, first.tabId, 'detach repoints the active tab')
  assert.equal(driver.bySession.size, 1)

  driver.onCdpEvent({ method: 'Target.targetDestroyed', params: { targetId: first.targetId } })
  assertTabGone(driver, first)
  assert.equal(driver.tabs.size, 0)
  assert.equal(driver.owners.has('owner-d'), false, 'destroyed last tab releases owner')

  // The duplicate event a real close produces is a no-op.
  driver.onCdpEvent({ method: 'Target.detachedFromTarget', params: { sessionId: first.sessionId } })
  assert.equal(driver.cleanupTab(first), false, 'second cleanup is a no-op')
}

// ------------------------------------------------- owner retention preconditions
{
  const driver = makeDriver()
  attachFake(driver)
  const entry = driver.ownerEntry('owner-pending')
  const tab = await driver.attachTab(entry, 'about:blank')
  entry.pending = 1
  driver.cleanupTab(tab)
  assert.equal(driver.owners.has('owner-pending'), true, 'in-flight attach keeps the owner')
  entry.pending = 0
  assert.equal(driver.maybeReleaseOwner(entry), true, 'owner released once idle')
  assert.equal(driver.owners.has('owner-pending'), false)

  const loginEntry = driver.ownerEntry('owner-login')
  const loginTab = await driver.attachTab(loginEntry, 'about:blank')
  driver.loginProcess = { pid: 1234 }
  driver.cleanupTab(loginTab)
  assert.equal(driver.owners.has('owner-login'), true, 'login window keeps the owner')
  driver.loginProcess = null
  assert.equal(driver.maybeReleaseOwner(loginEntry), true)
}

// ------------------------------------------------- downloads stay bounded in sync
{
  const driver = makeDriver()
  attachFake(driver)
  driver.onCdpEvent({ method: 'Browser.downloadWillBegin', params: { guid: 'g0', suggestedFilename: 'a.txt' } })
  for (let i = 1; i <= 105; i += 1) {
    driver.onCdpEvent({ method: 'Browser.downloadWillBegin', params: { guid: `g${i}`, suggestedFilename: `${i}.txt` } })
  }
  assert.equal(driver.downloads.length, 100, 'history bounded')
  assert.equal(driver.downloadByGuid.size, 100, 'guid index bounded with the history')
  assert.equal(driver.downloadByGuid.has('g0'), false, 'oldest guid evicted from the index')
  assert.equal(driver.downloadByGuid.has('g5'), false)
  assert.equal(driver.downloadByGuid.has('g6'), true, 'newest guids retained')
  // Progress still reaches the retained record.
  driver.onCdpEvent({ method: 'Browser.downloadProgress', params: { guid: 'g105', state: 'completed', receivedBytes: 10, totalBytes: 10 } })
  assert.equal(driver.downloadByGuid.get('g105').state, 'complete')
}

// ------------------------------ browser exit and close clear the whole browser
{
  const driver = makeDriver()
  attachFake(driver)
  const entry = driver.ownerEntry('owner-x')
  const tab = await driver.attachTab(entry, 'about:blank')
  await driver.dispatch('tab.capture_start', { owner: 'owner-x', tabId: tab.tabId })
  driver.onCdpEvent({ method: 'Browser.downloadWillBegin', params: { guid: 'gx', suggestedFilename: 'x.txt' } })
  driver.startIdleTimer()
  assert.ok(driver.idleTimer, 'idle timer armed')

  // The child exit handler calls this; a crashed browser must leave nothing
  // that a later request could mistake for a live tab.
  driver.handleBrowserExit(1)
  assertTabGone(driver, tab)
  assert.equal(driver.tabs.size, 0)
  assert.equal(driver.bySession.size, 0)
  assert.equal(driver.consoleBuffers.size, 0)
  assert.equal(driver.captures.size, 0)
  assert.equal(driver.captureByTab.size, 0)
  assert.equal(driver.owners.size, 0)
  assert.equal(driver.downloads.length, 0)
  assert.equal(driver.downloadByGuid.size, 0)
  assert.equal(driver.cdp, null)
  assert.equal(driver.chrome, null)
  assert.equal(driver.idleTimer, null, 'browser exit stops the idle timer')

  // Normal close also stops the idle timer and clears maps.
  const second = makeDriver()
  const cdp = attachFake(second)
  const secondTab = await second.attachTab(second.ownerEntry('owner-c'), 'about:blank')
  second.startIdleTimer()
  await second.close()
  assertTabGone(second, secondTab)
  assert.equal(second.idleTimer, null, 'close stops the idle timer')
  assert.equal(second.owners.size, 0)
  assert.equal(second.cdp, null)
  assert.equal(callsOf(cdp, 'Browser.close').length, 1)
}

console.log('TAB LIFECYCLE TEST: PASS')
