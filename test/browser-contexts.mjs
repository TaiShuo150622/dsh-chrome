import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { DEFAULT_CONFIG, PRESETS, loadConfig, presetToMode } from '../src/config.js'
import { BrowserContextManager, ContextError } from '../src/contexts.js'

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

  assert.deepEqual(PRESETS, ['sandbox', 'sandbox-persistent', 'debug', 'collab'])
  console.log('BROWSER CONTEXTS TEST: PASS')
} finally {
  await new Promise((resolve) => setTimeout(resolve, 20))
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}
