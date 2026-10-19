/**
 * M4 — user-configurable tab/context limits (no Chrome required).
 *
 * The canonical setting `browser.maxTabs` must reach HeadlessDriver, and the
 * live usage must be visible from both surfaces named in the queue:
 *   - `chrome_status` → headless info gains maxTabs / tabs / maxContexts /
 *     contexts;
 *   - `chrome_context` (the context view) reports the same limits.
 *
 * The driver-level contract (multi-tab, RESOURCE_LIMIT, close frees capacity,
 * live getter) is pinned in test/tab-attach.mjs; this file covers the provider
 * wiring and status projection.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { DEFAULT_CONFIG, loadConfig } from '../src/config.js'
import { BrowserContextManager } from '../src/contexts.js'
import { HeadlessContextRouter } from '../src/headless-contexts.js'
import { BackendRouter } from '../src/backend.js'
import { createContextTool } from '../src/tools-context.js'
import { createStatusTools } from '../src/tools-status.js'
import { outputSchema, renderText } from '../src/tool-support.js'
import { DEFAULT_MAX_TABS } from '../src/headless.js'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tab-config-'))
const home = path.join(root, 'home')
const cwd = path.join(root, 'project')
fs.mkdirSync(home, { recursive: true })
fs.mkdirSync(cwd, { recursive: true })
const previousHome = process.env.DSH_HOME
process.env.DSH_HOME = home

try {
  // ------------------------------------------------ canonical config plumbing
  assert.equal(DEFAULT_CONFIG.browser.maxTabs, 12, 'browser.maxTabs default')
  assert.equal(DEFAULT_CONFIG.browser.maxTabs, DEFAULT_MAX_TABS, 'config default and driver default stay aligned')

  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ version: 1, browser: { maxTabs: 5 } }))
  const configured = loadConfig({ home, cwd })
  assert.equal(configured.config.browser.maxTabs, 5, 'user config reaches the effective config')
  assert.equal(configured.sources['browser.maxTabs'], 'user')
  assert.deepEqual(configured.warnings, [])
  fs.rmSync(path.join(home, 'config.json'), { force: true })

  const defaults = loadConfig({ home, cwd })
  assert.equal(defaults.config.browser.maxTabs, 12)
  assert.equal(defaults.sources['browser.maxTabs'], 'default')

  // Out-of-range values fall back instead of reaching a driver.
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ version: 1, browser: { maxTabs: 65 } }))
  const clamped = loadConfig({ home, cwd })
  assert.equal(clamped.config.browser.maxTabs, 12)
  assert.ok(clamped.warnings.some((line) => line.includes('browser.maxTabs')))
  fs.rmSync(path.join(home, 'config.json'), { force: true })

  // ------------------------------- manager limits + status/context projections
  const config = {
    ...DEFAULT_CONFIG,
    browser: { ...DEFAULT_CONFIG.browser, preset: 'sandbox', maxContexts: 3, maxTabs: 12 },
  }
  const manager = new BrowserContextManager({
    config,
    home,
    createDriver: async ({ contextId, profileDir }) => ({
      contextId,
      profileDir,
      maxTabs: 5,
      tabCount: 2,
      pendingTabs: 0,
      async close() {},
    }),
  })
  const context = await manager.create({ owner: 'session-a' })
  assert.deepEqual(manager.limits(), {
    maxTabs: 5,
    tabs: 2,
    pendingTabs: 0,
    maxContexts: 3,
    contexts: 1,
    pendingContexts: 0,
  })

  const headless = new HeadlessContextRouter({ manager })
  assert.deepEqual(headless.limits(), manager.limits())
  const backend = new BackendRouter({
    desktop: { connected: false, call: async () => ({}) },
    headless,
    headlessSupported: true,
  })
  const info = backend.headlessInfo()
  assert.equal(info.supported, true)
  assert.equal(info.running, true)
  assert.equal(info.maxTabs, 5)
  assert.equal(info.tabs, 2)
  assert.equal(info.maxContexts, 3)
  assert.equal(info.contexts, 1)

  // chrome_status: both the structured value and the rendered text carry the
  // limits, so a model can answer "how many tabs are left?" without guessing.
  const statusTools = createStatusTools({
    bridge: backend,
    assets: () => ({}),
    currentSite: null,
    outputSchema,
    renderText,
  })
  const status = await statusTools.status.execute({})
  assert.equal(status.headless.maxTabs, 5)
  assert.equal(status.headless.tabs, 2)
  assert.equal(status.headless.maxContexts, 3)
  assert.equal(status.headless.contexts, 1)
  const statusText = statusTools.status.output.render({}, status)[0]?.text || ''
  assert.match(statusText, /headless limits: tabs 2\/5  contexts 1\/3/)

  // chrome_context view: list/current expose the same live limits.
  const contextTool = createContextTool({
    contexts: manager,
    contextViewer: null,
    ownerOf: () => 'session-a',
    outputSchema,
    renderText,
  })
  const listed = await contextTool.execute({ op: 'list' }, {})
  assert.equal(listed.ok, true)
  assert.equal(listed.contexts.length, 1)
  assert.deepEqual(listed.limits, manager.limits())
  const listText = contextTool.output.render({ op: 'list' }, listed)[0]?.text || ''
  assert.match(listText, /contexts 1\/3  tabs 2\/5/)
  assert.match(listText, new RegExp(context.contextId))

  const current = await contextTool.execute({ op: 'current' }, {})
  assert.equal(current.ok, true)
  assert.equal(current.contextId, context.contextId)
  assert.deepEqual(current.limits, manager.limits())
  const currentText = contextTool.output.render({ op: 'current' }, current)[0]?.text || ''
  assert.match(currentText, /contexts 1\/3  tabs 2\/5/)

  // Closing the only context releases both usage counters; with no live driver
  // the configured cap is the fallback.
  await manager.close(context.contextId)
  assert.deepEqual(manager.limits(), {
    maxTabs: 12,
    tabs: 0,
    pendingTabs: 0,
    maxContexts: 3,
    contexts: 0,
    pendingContexts: 0,
  })
  const afterClose = await contextTool.execute({ op: 'list' }, {})
  assert.equal(afterClose.contexts.length, 0)
  assert.equal(afterClose.limits.contexts, 0)

  // maxContexts still bounds concurrent browser contexts; the next create is
  // refused before a driver/profile is made.
  const limited = new BrowserContextManager({
    config: { ...config, browser: { ...config.browser, maxContexts: 1 } },
    home,
    createDriver: async ({ contextId, profileDir }) => ({
      contextId,
      profileDir,
      maxTabs: 5,
      tabCount: 0,
      async close() {},
    }),
  })
  const only = await limited.create({ owner: 'owner-1' })
  await assert.rejects(
    () => limited.create({ owner: 'owner-2' }),
    (error) => error.code === 'CONTEXT_LIMIT',
    'the second context must be refused by maxContexts',
  )
  assert.equal(limited.stats().active, 1)
  await limited.close(only.contextId)
  assert.equal(limited.stats().active, 0)

  await manager.closeAll()
  console.log('TAB CONFIG TEST: PASS')
} finally {
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}
