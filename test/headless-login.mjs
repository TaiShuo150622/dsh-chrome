import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { HeadlessDriver } from '../src/headless.js'

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

  const finish = driver.loginFinish()
  assert.equal(finish.stopped, true)
  assert.equal(finish.running, false)
  const child = spawned.filter((entry) => entry?.pid === 4242).at(-1)
  assert.equal(child.killed, 'SIGTERM')
  assert.equal(driver.loginStatus().running, false)
  console.log('HEADLESS LOGIN TEST: PASS')
} finally {
  fs.rmSync(home, { recursive: true, force: true })
}
