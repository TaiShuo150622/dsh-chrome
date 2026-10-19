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
 *     attach is in flight and no login window is open; read-only calls must
 *     not recreate an empty owner;
 *   - the download history and its guid index stay bounded together and are
 *     dropped with the browser;
 *   - a crashed browser clears every map/timer and marks the driver dead, so
 *     later requests fail with CONTEXT_CRASHED; a normal close clears the same
 *     state without marking a crash;
 *   - `close()` clears the idle timer, captures, downloads and screencast;
 *   - a visible/debug or login window is never killed by the driver idle sweep.
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

  // Read-only calls after the last tab closed must not resurrect an empty
  // owner entry (which would keep `owners` non-zero until browser exit).
  assert.deepEqual(await driver.tabsRequest('owner-a', { op: 'list' }), {
    tabs: [],
    groupId: null,
    activeTabId: null,
  })
  assert.equal(driver.owners.size, 0, 'list does not create an owner')
  assert.deepEqual(await driver.dispatch('tab.resume', { owner: 'owner-a' }), { ok: true, tabId: null })
  assert.equal(driver.owners.size, 0, 'resume does not create an owner')
  await assert.rejects(
    driver.tabsRequest('owner-a', { op: 'close', tabId: 999 }),
    (error) => error.code === 'TAB_NOT_FOUND',
  )
  assert.equal(driver.owners.size, 0, 'closing an unknown tab does not create an owner')
  assert.deepEqual(await driver.dispatch('tab.close_session', { owner: 'owner-a' }), { closed: 0 })
  assert.equal(driver.owners.size, 0, 'close_session does not create an owner')
  await assert.rejects(
    driver.tabsRequest('owner-a', { op: 'new', url: 'file:///etc/passwd' }),
    (error) => error.code === 'PROTECTED_PAGE',
  )
  assert.equal(driver.owners.size, 0, 'an invalid new-tab URL does not create an owner')
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
  driver.browserVersion = 'Fake/1.0'
  const entry = driver.ownerEntry('owner-x')
  const tab = await driver.attachTab(entry, 'about:blank')
  const started = await driver.dispatch('tab.capture_start', { owner: 'owner-x', tabId: tab.tabId })
  const capture = driver.captures.get(started.captureId)
  assert.ok(capture?.timer, 'capture max-duration timer armed')
  const captureTimer = capture.timer
  await driver.dispatch('tab.screencast_start', { owner: 'owner-x', tabId: tab.tabId })
  const screencastTimer = tab.screencast.timer
  const shotTimer = setTimeout(() => {}, 60_000)
  tab.shotStream = { active: true, waiters: [], stopTimer: shotTimer, last: null }
  driver.onCdpEvent({ method: 'Browser.downloadWillBegin', params: { guid: 'gx', suggestedFilename: 'x.txt' } })
  driver.startIdleTimer()
  assert.ok(driver.idleTimer, 'idle timer armed')

  // The child exit handler calls this; a crashed browser must leave nothing
  // that a later request could mistake for a live tab, and must be terminal.
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
  assert.equal(driver.browserVersion, null, 'crashed browser version is not reported as current')
  assert.equal(driver.idleTimer, null, 'browser exit stops the idle timer')
  assert.equal(tab.screencast, null, 'browser exit drops the screencast state')
  assert.equal(screencastTimer._destroyed, true, 'browser exit clears the screencast timer')
  assert.equal(captureTimer._destroyed, true, 'browser exit clears the capture timer')
  assert.equal(shotTimer._destroyed, true, 'browser exit clears the screenshot stream timer')
  assert.equal(driver.dead, true, 'an unexpected exit marks the driver dead')
  assert.equal(driver.deathReason, '1')
  assert.equal(driver.connected, false)
  await assert.rejects(
    driver.ensureStarted(),
    (error) => error.code === 'CONTEXT_CRASHED',
    'a dead driver must not silently relaunch a browser with stale tab ids',
  )

  // Normal close also stops the idle timer and clears maps.
  const second = makeDriver()
  const cdp = attachFake(second)
  second.browserVersion = 'Fake/1.0'
  const secondTab = await second.attachTab(second.ownerEntry('owner-c'), 'about:blank')
  // One stopped summary (TTL timer) plus one active capture (max-duration
  // timer): close must clear both timers, not just the registry entries.
  const stoppedCapture = await second.dispatch('tab.capture_start', { owner: 'owner-c', tabId: secondTab.tabId })
  await second.dispatch('tab.capture_stop', { owner: 'owner-c', captureId: stoppedCapture.captureId })
  const stoppedRecord = second.captures.get(stoppedCapture.captureId)
  const secondExpireTimer = stoppedRecord.expireTimer
  assert.ok(secondExpireTimer, 'stopped capture summary timer armed')
  const activeCapture = await second.dispatch('tab.capture_start', { owner: 'owner-c', tabId: secondTab.tabId })
  const activeRecord = second.captures.get(activeCapture.captureId)
  const secondCaptureTimer = activeRecord.timer
  await second.dispatch('tab.screencast_start', { owner: 'owner-c', tabId: secondTab.tabId })
  const secondScreencastTimer = secondTab.screencast.timer
  second.onCdpEvent({ method: 'Browser.downloadWillBegin', params: { guid: 'gc', suggestedFilename: 'c.txt' } })
  second.startIdleTimer()
  await second.close()
  assertTabGone(second, secondTab)
  assert.equal(second.idleTimer, null, 'close stops the idle timer')
  assert.equal(second.owners.size, 0)
  assert.equal(second.captures.size, 0, 'close clears captures')
  assert.equal(second.captureByTab.size, 0, 'close clears the capture index')
  assert.equal(second.downloads.length, 0, 'close clears the download history')
  assert.equal(second.downloadByGuid.size, 0, 'close clears the download guid index')
  assert.equal(secondCaptureTimer._destroyed, true, 'close clears the active capture timer')
  assert.equal(activeRecord.timer, null, 'close forgets the active capture timer handle')
  assert.equal(secondExpireTimer._destroyed, true, 'close clears the stopped capture TTL timer')
  assert.equal(stoppedRecord.expireTimer, null, 'close forgets the stopped capture TTL timer handle')
  assert.equal(secondScreencastTimer._destroyed, true, 'close clears the screencast timer')
  assert.equal(second.cdp, null)
  assert.equal(second.browserVersion, null)
  assert.equal(second.dead, false, 'an intentional close is not a crash')
  assert.equal(callsOf(cdp, 'Browser.close').length, 1)
  // A websocket can deliver a final frame/event after close detached the CDP
  // client (the real-browser suite hit a null send here). Late events must be
  // ignored, not throw.
  assert.doesNotThrow(() => {
    second.onCdpEvent({
      method: 'Page.screencastFrame',
      sessionId: secondTab.sessionId,
      params: { data: '', metadata: { timestamp: 1 } },
    })
    second.onCdpEvent({ method: 'Network.loadingFinished', sessionId: secondTab.sessionId, params: {} })
  })
}

// ------------------------------------- visible windows are never idle-reaped
{
  const visible = makeDriver({ visible: true })
  const visibleCdp = attachFake(visible)
  visible.lastActivity = 0
  assert.equal(await visible.checkIdle(), false, 'a visible driver is not idle-reaped')
  assert.equal(callsOf(visibleCdp, 'Browser.close').length, 0)

  const handoff = makeDriver()
  const handoffCdp = attachFake(handoff)
  handoff.visibleMode = true
  handoff.lastActivity = 0
  assert.equal(await handoff.checkIdle(), false, 'a visible handoff window is not idle-reaped')
  assert.equal(callsOf(handoffCdp, 'Browser.close').length, 0)

  const login = makeDriver()
  const loginCdp = attachFake(login)
  login.loginProcess = { pid: 1234 }
  login.lastActivity = 0
  assert.equal(await login.checkIdle(), false, 'an open login window is not idle-reaped')
  assert.equal(callsOf(loginCdp, 'Browser.close').length, 0)

  const hidden = makeDriver()
  const hiddenCdp = attachFake(hidden)
  hidden.lastActivity = 0
  hidden.startIdleTimer()
  assert.equal(await hidden.checkIdle(), true, 'a hidden idle browser is still reaped')
  assert.equal(hidden.idleTimer, null)
  assert.equal(callsOf(hiddenCdp, 'Browser.close').length, 1)
  assert.equal(hidden.dead, false)
}

// --------------------- late CDP events are ignored once the client is gone
{
  const stale = makeDriver()
  const staleTab = { tabId: 1, sessionId: 'stale-session', owner: 'stale', shotStream: null }
  stale.tabs.set(1, staleTab)
  stale.bySession.set(staleTab.sessionId, staleTab)
  assert.equal(stale.cdp, null)
  assert.doesNotThrow(
    () => stale.onCdpEvent({ method: 'Page.screencastFrame', sessionId: staleTab.sessionId, params: { data: '', metadata: {} } }),
    'a frame after the client detached must not touch cdp.send',
  )
  assert.doesNotThrow(
    () => stale.onCdpEvent({ method: 'Network.loadingFinished', sessionId: staleTab.sessionId, params: { requestId: 'r1' } }),
    'a network event after the client detached must not touch cdp.send',
  )
}

console.log('TAB LIFECYCLE TEST: PASS')
