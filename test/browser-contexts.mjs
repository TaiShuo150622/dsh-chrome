import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { DEFAULT_CONFIG, PRESETS, loadConfig, presetToMode } from '../src/config.js'
import { BrowserContextManager, ContextError } from '../src/contexts.js'
import { createContextTool } from '../src/tools-context.js'
import { outputSchema, renderText } from '../src/tool-support.js'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-browser-contexts-'))
const home = path.join(root, 'home')
const cwd = path.join(root, 'project')
fs.mkdirSync(home, { recursive: true })
fs.mkdirSync(cwd, { recursive: true })

try {
  // Defaults: no files, sandbox preset, ephemeral/hidden.
  const defaults = loadConfig({ home, cwd })
  assert.equal(defaults.config.browser.preset, 'sandbox')
  assert.deepEqual(presetToMode('sandbox'), { isolation: 'ephemeral', visible: false })
  assert.deepEqual(presetToMode('debug'), { isolation: 'named', visible: true })
  assert.deepEqual(defaults.warnings, [])

  // Project config overrides canonical user config; legacy cache path still loads.
  // Secrets/unknown keys are dropped.
  fs.mkdirSync(path.join(cwd, '.dsh-chrome'), { recursive: true })
  fs.mkdirSync(path.join(home, 'cache', 'dsh-chrome'), { recursive: true })
  fs.writeFileSync(path.join(cwd, '.dsh-chrome', 'config.json'), JSON.stringify({
    version: 1,
    browser: { preset: 'sandbox-persistent', maxContexts: 2 },
    verification: { captureNetwork: 'bodies' },
  }))
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
    version: 1,
    browser: { maxContexts: 3, apiKey: 'sk-CANARY-NOT-ALLOWED' },
    unknownTop: true,
    verification: { captureNetwork: 'metadata' },
  }))
  const merged = loadConfig({ home, cwd })
  assert.equal(merged.config.browser.preset, 'sandbox-persistent')
  assert.equal(merged.config.browser.maxContexts, 2, 'project config wins over user config')
  assert.equal(merged.config.browser.preset, 'sandbox-persistent', 'project preset wins')
  assert.equal(merged.config.verification.captureNetwork, 'bodies', 'project verification wins')
  assert.ok(merged.warnings.some((line) => line.includes('apiKey')))
  assert.ok(merged.warnings.some((line) => line.includes('unknownTop')))

  // Invalid version falls back to defaults when no project override is present.
  fs.rmSync(path.join(cwd, '.dsh-chrome', 'config.json'), { force: true })
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ version: 99, browser: { preset: 'nope' } }))
  const bad = loadConfig({ home, cwd })
  assert.equal(bad.config.browser.preset, 'sandbox')
  assert.ok(bad.warnings.some((line) => line.includes('version')))

  // Context manager with a fake driver.
  let now = 1_000_000
  const created = []
  const config = {
    ...DEFAULT_CONFIG,
    browser: { ...DEFAULT_CONFIG.browser, preset: 'sandbox', maxContexts: 2, idleTimeoutMs: 1000 },
  }
  const manager = new BrowserContextManager({
    config,
    home,
    now: () => now,
    createDriver: async (options) => {
      const driver = { options, closed: false, async close() { this.closed = true } }
      created.push(driver)
      return driver
    },
  })
  const first = await manager.create({ owner: 'session-a' })
  assert.equal(first.visible, false)
  assert.equal(first.isolation, 'ephemeral')
  assert.ok(created[0].options.profileDir.includes('ephemeral-'))
  assert.equal(fs.existsSync(created[0].options.profileDir), true)
  const second = await manager.create({ owner: 'session-b', preset: 'sandbox-persistent', profileName: 'named a' })
  assert.equal(second.isolation, 'named')
  assert.ok(created[1].options.profileDir.endsWith('named-a'))
  await assert.rejects(() => manager.create({ owner: 'session-c' }), (error) => error.code === 'CONTEXT_LIMIT')
  await assert.rejects(() => manager.create({ owner: 'session-c', preset: 'sandbox-persistent', profileName: 'named a' }), (error) => error.code === 'CONTEXT_LIMIT')

  await manager.close(first.contextId)
  assert.equal(created[0].closed, true)
  assert.equal(fs.existsSync(created[0].options.profileDir), false, 'ephemeral profile should be removed')
  await assert.rejects(
    () => manager.create({ owner: 'session-c', preset: 'sandbox-persistent', profileName: 'named-a' }),
    (error) => error.code === 'PROFILE_IN_USE',
  )
  await manager.close(second.contextId)
  const reused = await manager.create({ owner: 'session-c', preset: 'sandbox-persistent', profileName: 'named-a' })
  assert.equal(reused.isolation, 'named')
  assert.ok(created[2].options.profileDir.endsWith('named-a'))
  await manager.close(reused.contextId)
  await manager.closeAll()
  assert.equal(manager.stats().active, 0)

  // C1: concurrent creates reserve their slot before awaiting createDriver, so
  // maxContexts is a hard cap and no orphan profile is left behind.
  const concurrentDrivers = []
  const concurrentManager = new BrowserContextManager({
    config,
    home,
    createDriver: async (options) => {
      concurrentDrivers.push(options)
      await new Promise((resolve) => setTimeout(resolve, 15))
      return { options, async close() {} }
    },
  })
  const raced = await Promise.allSettled(
    Array.from({ length: 16 }, (_, index) => concurrentManager.create({ owner: `racer-${index}` })),
  )
  const raceWinners = raced.filter((result) => result.status === 'fulfilled')
  const raceLosers = raced.filter((result) => result.status === 'rejected')
  assert.equal(raceWinners.length, 2, `exactly maxContexts creates should win, got ${raceWinners.length}`)
  assert.equal(raceLosers.length, 14)
  assert.ok(
    raceLosers.every((result) => result.reason?.code === 'CONTEXT_LIMIT'),
    raceLosers.map((result) => result.reason?.code).join(','),
  )
  assert.equal(concurrentManager.stats().active, 2)
  assert.equal(concurrentDrivers.length, 2, 'createDriver must only run for reserved slots')
  const profilesRoot = path.join(home, 'cache', 'dsh-chrome', 'profiles')
  const ephemeralDirs = () => fs.readdirSync(profilesRoot).filter((name) => name.startsWith('ephemeral-'))
  assert.equal(ephemeralDirs().length, 2, `unexpected ephemeral profiles: ${ephemeralDirs().join(',')}`)
  await concurrentManager.closeAll()
  assert.deepEqual(ephemeralDirs(), [], 'closing concurrent ephemeral contexts must clean their profiles')

  // C2: concurrent creates for one owner share the in-flight context.
  let dedupeFactoryCalls = 0
  const dedupeManager = new BrowserContextManager({
    config,
    home,
    createDriver: async (options) => {
      dedupeFactoryCalls += 1
      await new Promise((resolve) => setTimeout(resolve, 15))
      return { options, async close() {} }
    },
  })
  const [firstSame, secondSame] = await Promise.all([
    dedupeManager.create({ owner: 'same-owner' }),
    dedupeManager.create({ owner: 'same-owner' }),
  ])
  assert.equal(firstSame.contextId, secondSame.contextId, 'one owner must get one in-flight context')
  assert.equal(dedupeFactoryCalls, 1)
  assert.equal(dedupeManager.stats().active, 1)
  await dedupeManager.closeAll()

  // C3: a named profile is reserved synchronously; a concurrent create with the
  // same name is refused instead of opening two browser processes on it.
  const namedManager = new BrowserContextManager({
    config,
    home,
    createDriver: async (options) => {
      await new Promise((resolve) => setTimeout(resolve, 15))
      return { options, async close() {} }
    },
  })
  const namedRace = await Promise.allSettled([
    namedManager.create({ owner: 'named-a', preset: 'sandbox-persistent', profileName: 'raced-profile' }),
    namedManager.create({ owner: 'named-b', preset: 'sandbox-persistent', profileName: 'raced-profile' }),
  ])
  assert.equal(namedRace.filter((result) => result.status === 'fulfilled').length, 1)
  assert.equal(namedRace.find((result) => result.status === 'rejected')?.reason?.code, 'PROFILE_IN_USE')
  assert.equal(fs.readdirSync(profilesRoot).filter((name) => name === 'raced-profile').length, 1)
  await namedManager.closeAll()

  // C7: a failed create releases the slot and its ephemeral profile; a named
  // profile reservation is released too, so a retry can reuse the name.
  let failOnce = true
  const failingManager = new BrowserContextManager({
    config,
    home,
    createDriver: async (options) => {
      if (failOnce) {
        failOnce = false
        throw new Error('launch failed')
      }
      return { options, async close() {} }
    },
  })
  await assert.rejects(() => failingManager.create({ owner: 'failed' }), /launch failed/)
  assert.equal(failingManager.stats().active, 0)
  assert.deepEqual(ephemeralDirs(), [], 'a failed create must remove its ephemeral profile')
  await failingManager.create({ owner: 'failed' })
  assert.equal(failingManager.stats().active, 1, 'a failed create must release its slot')
  await failingManager.closeAll()

  let failNamed = true
  const namedFailManager = new BrowserContextManager({
    config,
    home,
    createDriver: async (options) => {
      if (failNamed) {
        failNamed = false
        throw new Error('launch failed')
      }
      return { options, async close() {} }
    },
  })
  await assert.rejects(
    () => namedFailManager.create({ owner: 'n', preset: 'sandbox-persistent', profileName: 'retry-profile' }),
    /launch failed/,
  )
  const namedRetried = await namedFailManager.create({ owner: 'n', preset: 'sandbox-persistent', profileName: 'retry-profile' })
  assert.equal(namedRetried.profileId, 'retry-profile', 'a failed named create must release the profile reservation')
  await namedFailManager.closeAll()

  // H8: a named context that is still shutting down keeps its profile reserved.
  // Removing it from `contexts` before driver.close() resolves must not let a
  // concurrent create open a second browser on the same profile.
  let releaseClose = null
  let closeCalls = 0
  const closingManager = new BrowserContextManager({
    config,
    home,
    createDriver: async (options) => ({
      options,
      async close() {
        closeCalls += 1
        if (closeCalls === 1) await new Promise((resolve) => { releaseClose = resolve })
      },
    }),
  })
  const closing = await closingManager.create({
    owner: 'closing',
    preset: 'sandbox-persistent',
    profileName: 'closing-profile',
  })
  const closingDone = closingManager.close(closing.contextId)
  assert.equal(closingManager.reservedProfiles.has('closing-profile'), true, 'profile held during close')
  await assert.rejects(
    () => closingManager.create({ owner: 'other', preset: 'sandbox-persistent', profileName: 'closing-profile' }),
    (error) => error.code === 'PROFILE_IN_USE',
    'a create during close must not reuse the profile',
  )
  releaseClose()
  await closingDone
  assert.equal(closingManager.reservedProfiles.has('closing-profile'), false, 'close releases the profile')
  const reopened = await closingManager.create({
    owner: 'other',
    preset: 'sandbox-persistent',
    profileName: 'closing-profile',
  })
  assert.equal(reopened.profileId, 'closing-profile', 'the profile is reusable after close resolves')
  await closingManager.closeAll()

  // Idle reaping closes and cleans ephemeral profiles; named profiles remain on disk unless keepProfile false.
  const idleManager = new BrowserContextManager({
    config,
    home,
    now: () => now,
    createDriver: async () => ({ async close() {} }),
  })
  const idle = await idleManager.create({ owner: 'idle' })
  now += 5000
  const reaped = await idleManager.reapIdle()
  assert.deepEqual(reaped, [idle.contextId])
  assert.equal(fs.existsSync(path.join(home, 'cache', 'dsh-chrome', 'profiles', idle.profileId)), false)
  await idleManager.closeAll()

  // Owner-aware access: another session must neither see nor close the context.
  const owned = await manager.create({ owner: 'owner-a', preset: 'sandbox' })
  assert.equal(manager.getOwned(owned.contextId, 'owner-b'), null)
  assert.equal(manager.driverForOwned(owned.contextId, 'owner-b'), null)
  assert.equal(await manager.closeOwned(owned.contextId, 'owner-b'), false)
  assert.ok(manager.get(owned.contextId), 'cross-owner close must not remove the context')
  assert.ok(manager.driverForOwned(owned.contextId, 'owner-a'))
  assert.equal(await manager.closeOwned(owned.contextId, 'owner-a'), true)
  assert.equal(manager.get(owned.contextId), null)

  // Artifact runs are owned by ArtifactStore (test/artifact-store.mjs), not by
  // the context manager: contexts only own browser profiles.

  // I2: visible isolation is a headed Chrome window with its own profile; shared still requires leases.
  const debug = await manager.create({ owner: 'debug', preset: 'debug' })
  assert.equal(debug.visible, true)
  assert.equal(debug.isolation, 'named')
  assert.equal(created.at(-1).options.visible, true)
  await manager.closeAll()
  await assert.rejects(() => manager.create({ owner: 'x', preset: 'collab' }), (error) => error.code === 'UNSUPPORTED_MODE')
  await manager.closeAll()

  // W4: closing the active context auto-falls back to the most recently used
  // remaining context of the same owner (ties: smallest contextId). Only the
  // last close leaves the session without an active context.
  let w4Now = 5_000_000
  const makeW4Manager = (clock = null) =>
    new BrowserContextManager({
      config: {
        ...DEFAULT_CONFIG,
        browser: { ...DEFAULT_CONFIG.browser, preset: 'sandbox', maxContexts: 3, idleTimeoutMs: 60_000 },
      },
      home,
      now: clock || (() => w4Now++),
      createDriver: async () => ({ async close() {} }),
    })

  const mruManager = makeW4Manager()
  const mruContexts = []
  for (let index = 0; index < 3; index += 1) mruContexts.push(await mruManager.create({ owner: 'mru' }))
  assert.equal(mruManager.activeFor('mru').contextId, mruContexts[2].contextId)
  await mruManager.close(mruContexts[2].contextId)
  assert.equal(
    mruManager.activeFor('mru').contextId,
    mruContexts[1].contextId,
    'closing the active context falls back to the most recently used remainder',
  )
  await mruManager.close(mruContexts[1].contextId)
  assert.equal(mruManager.activeFor('mru').contextId, mruContexts[0].contextId)
  await mruManager.close(mruContexts[0].contextId)
  assert.equal(mruManager.activeFor('mru'), null, 'closing the last context leaves no active context')

  const tieManager = makeW4Manager(() => 7_000_000)
  const tieContexts = []
  for (let index = 0; index < 3; index += 1) tieContexts.push(await tieManager.create({ owner: 'tie' }))
  assert.equal(tieContexts[0].lastUsedAt, tieContexts[2].lastUsedAt, 'the fixed clock ties every context')
  await tieManager.close(tieContexts[2].contextId)
  const smallestId = [tieContexts[0], tieContexts[1]].sort((a, b) => (a.contextId < b.contextId ? -1 : 1))[0]
  assert.equal(
    tieManager.activeFor('tie').contextId,
    smallestId.contextId,
    'equal lastUsedAt is broken by the smallest contextId',
  )
  await tieManager.closeAll()

  // chrome_context: current may not turn into NO_ACTIVE_CONTEXT while another
  // context remains, close reports the fallback, and an explicit use survives
  // closing a different context.
  const toolManager = makeW4Manager()
  const contextTool = createContextTool({
    contexts: toolManager,
    contextViewer: null,
    ownerOf: () => 'tool-owner',
    outputSchema,
    renderText,
  })
  const toolContexts = []
  for (let index = 0; index < 3; index += 1) toolContexts.push(await toolManager.create({ owner: 'tool-owner' }))
  const [ctxFirst, ctxSecond, ctxThird] = toolContexts
  const used = await contextTool.execute({ op: 'use', contextId: ctxFirst.contextId }, {})
  assert.equal(used.ok, true)
  assert.equal(toolManager.activeFor('tool-owner').contextId, ctxFirst.contextId)
  const closedOther = await contextTool.execute({ op: 'close', contextId: ctxSecond.contextId }, {})
  assert.equal(closedOther.ok, true)
  assert.equal(closedOther.fallback, undefined, 'closing a non-active context must not report a fallback')
  assert.equal(
    toolManager.activeFor('tool-owner').contextId,
    ctxFirst.contextId,
    'an explicit use is not overridden by closing another context',
  )
  const closedActive = await contextTool.execute({ op: 'close', contextId: ctxFirst.contextId }, {})
  assert.equal(closedActive.ok, true)
  assert.equal(closedActive.fallback, true)
  assert.equal(closedActive.activeContextId, ctxThird.contextId)
  assert.match(String(closedActive.hint), /most recently used remaining context/)
  const currentAfterFallback = await contextTool.execute({ op: 'current' }, {})
  assert.equal(currentAfterFallback.ok, true, 'current must not be NO_ACTIVE_CONTEXT after an active close')
  assert.equal(currentAfterFallback.contextId, ctxThird.contextId)
  const closeRender = contextTool.output.render({ op: 'close' }, closedActive)[0]?.text || ''
  assert.ok(closeRender.includes('most recently used remaining context'), closeRender)
  await contextTool.execute({ op: 'close', contextId: ctxThird.contextId }, {})
  const currentAfterLast = await contextTool.execute({ op: 'current' }, {})
  assert.equal(currentAfterLast.ok, false)
  assert.equal(currentAfterLast.error, 'NO_ACTIVE_CONTEXT', 'closing the last context still reports NO_ACTIVE_CONTEXT')

  assert.deepEqual(PRESETS, ['sandbox', 'sandbox-persistent', 'debug', 'collab'])
  console.log('BROWSER CONTEXTS TEST: PASS')
} finally {
  await new Promise((resolve) => setTimeout(resolve, 20))
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}
