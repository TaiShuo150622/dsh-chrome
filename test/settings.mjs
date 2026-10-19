import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { loadConfig } from '../src/config.js'
import { Config, pluginConfigWarnings, validatePluginConfig } from '../src/config-schema.js'
import { SETTING_SPECS, checkSettingValue, isProjectForbidden, readPluginOverride } from '../src/settings.js'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-settings-'))
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-settings-cwd-'))
try {
  // Defaults stay backward compatible and all MVP fields are declared.
  const base = loadConfig({ home, cwd })
  assert.equal(base.config.browser.preset, 'sandbox')
  assert.equal(base.config.browser.maxContexts, 4)
  assert.equal(base.config.update.enabled, false)
  assert.ok(SETTING_SPECS['browser.preset'])
  assert.equal(base.sources['browser.preset'], 'default')

  // DSH entry override wins over user/project files, but only safe fields.
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ browser: { preset: 'sandbox-persistent' } }))
  fs.mkdirSync(path.join(cwd, '.dsh-chrome'), { recursive: true })
  fs.writeFileSync(path.join(cwd, '.dsh-chrome', 'config.json'), JSON.stringify({ browser: { maxContexts: 2 } }))
  const withEntry = loadConfig({
    home,
    cwd,
    pluginConfig: { browser: { preset: 'debug', maxContexts: 8 }, update: { enabled: true }, allowEvaluate: true },
  })
  assert.equal(withEntry.config.browser.preset, 'debug')
  assert.equal(withEntry.config.browser.maxContexts, 8)
  assert.equal(withEntry.config.update.enabled, true)
  assert.equal(withEntry.sources['browser.preset'], 'entry')
  assert.ok(withEntry.warnings.some((warning) => warning.includes('allowEvaluate')), withEntry.warnings.join('\n'))
  assert.equal(withEntry.config.allowEvaluate, undefined, 'dangerous field must not be writable from entry config')

  // Project config cannot widen security-sensitive fields.
  fs.writeFileSync(path.join(cwd, '.dsh-chrome', 'config.json'), JSON.stringify({ browser: { shared: { enabled: true } } }))
  const project = loadConfig({ home, cwd })
  assert.equal(project.config.browser.shared.enabled, false)
  assert.ok(isProjectForbidden('browser.shared.enabled'))
  assert.ok(project.warnings.some((warning) => warning.includes('project')))

  // Invalid entry values are skipped, not coerced, so a typo cannot erase a lower layer.
  const invalid = loadConfig({
    home,
    cwd,
    pluginConfig: { browser: { preset: 'bogus', maxContexts: 999 } },
  })
  assert.equal(invalid.config.browser.preset, 'sandbox-persistent', 'file value must survive invalid entry')
  assert.ok(invalid.warnings.some((warning) => warning.includes('ignored invalid DSH entry setting')))

  assert.deepEqual(checkSettingValue('browser.preset', 'debug'), { ok: true, value: 'debug' })
  assert.equal(checkSettingValue('browser.preset', 'collab').ok, false)
  assert.equal(checkSettingValue('browser.maxContexts', 0).ok, false)

  // Config is a schemastery-compatible graph and validates the same safe subset.
  assert.equal(Config[Symbol.for('schemastery')], true)
  const validated = validatePluginConfig({ browser: { preset: 'debug' }, update: { enabled: true } })
  const preset = validated.value.browser.preset
  assert.equal(typeof preset?.get === 'function' ? preset.get() : preset, 'debug')
  assert.equal(validated.value.update.enabled, true)
  assert.deepEqual(pluginConfigWarnings(validated.value), [])

  // readPluginOverride prefers configEditor.configuration().override.
  const fakeCtx = {
    get(name) {
      if (name !== 'configEditor') return null
      return { configuration: () => [{ entry: { id: 'include:dsh-chrome' }, override: { browser: { preset: 'debug' } } }] }
    },
  }
  const override = readPluginOverride(fakeCtx)
  assert.equal(override.source, 'config-editor')
  assert.deepEqual(override.override, { browser: { preset: 'debug' } })

  console.log('SETTINGS TEST: PASS')
} finally {
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  fs.rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}
