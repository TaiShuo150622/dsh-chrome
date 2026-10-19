import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { HeadlessDriver } from '../src/headless.js'
import { createLoginTool } from '../src/tools-login.js'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-headless-login-test-'))
const spawned = []
const makeChild = () => {
  const child = {
    pid: 4242,
    killed: null,
    once() {},
    kill(signal) {
      this.killed = signal
    },
  }
  spawned.push(child)
  return child
}
const driver = new HeadlessDriver({ home, spawnImpl: (...args) => { spawned.push(args); return makeChild() } })

try {
  const status = driver.loginStatus()
  assert.equal(status.running, false)
  assert.ok(status.profile.includes('headless/profile'))

  const started = await driver.loginStart({ url: 'https://example.com/login' })
  assert.equal(started.running, true)
  assert.equal(started.alreadyRunning, false)
  const spawnArgs = spawned.find((entry) => Array.isArray(entry))
  assert.ok(spawnArgs, 'loginStart must spawn a browser')
  const args = spawnArgs[1]
  assert.ok(args.some((arg) => arg.startsWith('--user-data-dir=') && arg.includes('headless/profile')), JSON.stringify(args))
  assert.ok(args.includes('--new-window'))
  assert.ok(args.includes('https://example.com/login'))

  let busyCode = null
  try {
    await driver.ensureStarted()
  } catch (error) {
    busyCode = error?.code
  }
  assert.equal(busyCode, 'HEADLESS_LOGIN_OPEN')

  // An owner kept alive only by the login window is released when it closes.
  driver.owners.set('login-owner', { owner: 'login-owner', tabs: new Map(), activeTabId: null, pending: 0 })
  assert.equal(driver.maybeReleaseOwner(driver.owners.get('login-owner')), false)

  const finish = driver.loginFinish()
  assert.equal(finish.stopped, true)
  assert.equal(finish.running, false)
  assert.equal(driver.owners.has('login-owner'), false, 'loginFinish releases an idle owner')
  const child = spawned.filter((entry) => entry?.pid === 4242).at(-1)
  assert.equal(child.killed, 'SIGTERM')
  assert.equal(driver.loginStatus().running, false)

  // Visible handoff: show the current page in a real window, then let the next
  // headless request resume the same URL.
  const shown = await driver.showVisible({ url: 'https://example.com/step' })
  assert.equal(shown.running, true)
  assert.equal(shown.visible, true)
  assert.equal(shown.url, 'https://example.com/step')
  assert.equal(driver.loginStatus().visible, true)
  assert.equal(driver.loginStatus().resumeUrl, 'https://example.com/step')
  const shownArgs = spawned.filter((entry) => Array.isArray(entry)).at(-1)[1]
  assert.ok(shownArgs.includes('https://example.com/step'), JSON.stringify(shownArgs))
  const finished = driver.loginFinish()
  assert.equal(finished.stopped, true)
  assert.equal(finished.resumeUrl, 'https://example.com/step')
  assert.equal(driver.loginStatus().visible, false)
  let protectedCode = null
  try {
    await driver.showVisible({ url: 'file:///etc/hosts' })
  } catch (error) {
    protectedCode = error?.code
  }
  assert.equal(protectedCode, 'PROTECTED_PAGE')

  // H5: the visible-login confirmation card must name the exact URL and its
  // origin. Credentials embedded in a URL are stripped from the preview and
  // from what the driver opens.
  const cards = []
  const loginTool = createLoginTool({
    bridge: { headless: driver },
    ownerOf: () => 'owner',
    hardConfirmAsk: async (_exec, toolName, options) => {
      cards.push({ toolName, ...options })
    },
    evaluateConfirmTimeoutMs: 5000,
    outputSchema: (properties) => ({ type: 'object', properties, additionalProperties: true }),
    renderText: (text) => [{ type: 'text', text }],
  })
  const exec = { agent: { id: 'owner' } }
  const startedCard = await loginTool.execute(
    { op: 'start', url: 'https://example.com/login?next=%2Fhome#step' },
    exec,
  )
  assert.equal(startedCard.running, true)
  assert.equal(cards.length, 1)
  assert.ok(cards[0].question.includes('https://example.com'), cards[0].question)
  assert.ok(cards[0].detail.includes('目标 URL: https://example.com/login?next=%2Fhome#step'), cards[0].detail)
  assert.ok(cards[0].detail.includes('Origin: https://example.com'), cards[0].detail)
  await loginTool.execute({ op: 'finish' }, exec)

  const shownCard = await loginTool.execute({ op: 'show', url: 'https://example.com/step' }, exec)
  assert.equal(shownCard.running, true)
  assert.equal(cards.length, 2)
  assert.ok(cards[1].detail.includes('目标 URL: https://example.com/step'), cards[1].detail)
  assert.ok(cards[1].detail.includes('Origin: https://example.com'), cards[1].detail)
  let toolProtected = null
  try {
    await loginTool.execute({ op: 'show', url: 'file:///etc/hosts' }, exec)
  } catch (error) {
    toolProtected = error?.code
  }
  assert.equal(toolProtected, 'PROTECTED_PAGE')
  assert.equal(cards.length, 2, 'a protected URL must not ask for confirmation')
  await loginTool.execute({ op: 'finish' }, exec)

  const SENTINEL = 'DSH_SENTINEL_LOGIN_URL_DO_NOT_USE'
  const sanitizedCard = await loginTool.execute(
    { op: 'start', url: `https://user:${SENTINEL}@example.com/login` },
    exec,
  )
  assert.equal(sanitizedCard.running, true)
  assert.equal(cards.length, 3)
  assert.equal(JSON.stringify(cards[2]).includes(SENTINEL), false, 'the login card leaked URL credentials')
  assert.ok(cards[2].detail.includes('目标 URL: https://example.com/login'), cards[2].detail)
  assert.ok(cards[2].detail.includes('Origin: https://example.com'), cards[2].detail)
  const sanitizedArgs = spawned.filter((entry) => Array.isArray(entry)).at(-1)[1]
  assert.equal(JSON.stringify(sanitizedArgs).includes(SENTINEL), false, 'the spawned URL leaked credentials')
  await loginTool.execute({ op: 'finish' }, exec)
  console.log('HEADLESS LOGIN TEST: PASS')
} finally {
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}
