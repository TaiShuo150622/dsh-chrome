import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { Config as ProviderConfig, apply as providerApply, name as providerName } from '../index.js'
import { ArtifactStore } from '../src/artifact-store.js'
import { DEFAULT_CONFIG, PRESETS, loadConfig } from '../src/config.js'
import { Config, pluginConfigWarnings, validatePluginConfig } from '../src/config-schema.js'
import { BrowserContextManager } from '../src/contexts.js'
import {
  LIVE_PATHS,
  PLUGIN_CONFIG_PATHS,
  PROJECT_FORBIDDEN,
  SETTING_SPECS,
  checkSettingValue,
  isProjectForbidden,
  readPluginOverride,
} from '../src/settings.js'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-settings-'))
const readPath = (object, dotted) => dotted.split('.').reduce((node, key) => node[key], object)
const live = (value) => (value && typeof value === 'object' && typeof value.get === 'function' ? value.get() : value)

try {
  // ---------------------------------------------------------------- SETTING_SPECS
  // The safe subset is deliberately explicit: every key, default, range and
  // volatile flag is part of the user-visible contract. Update fields stay
  // non-volatile because they need a provider reload.
  const expectedSpecs = {
    'browser.preset': { type: 'enum', values: ['sandbox', 'sandbox-persistent', 'debug'], default: 'sandbox', volatile: true },
    'browser.maxContexts': { type: 'integer', min: 1, max: 16, step: 1, default: 4, volatile: true },
    'browser.idleTimeoutMs': { type: 'integer', min: 10_000, max: 3_600_000, step: 1, default: 300_000, volatile: true },
    'verification.artifactRetentionRuns': { type: 'integer', min: 1, max: 1000, step: 1, default: 50, volatile: true },
    'update.enabled': { type: 'boolean', default: false, volatile: false },
    'update.autoInstall': { type: 'boolean', default: false, volatile: false },
    'update.checkIntervalHours': { type: 'integer', min: 1, max: 168, step: 1, default: 24, volatile: false },
  }
  assert.deepEqual(Object.keys(SETTING_SPECS), Object.keys(expectedSpecs))
  assert.equal(Object.isFrozen(SETTING_SPECS), true)
  for (const [dotted, expected] of Object.entries(expectedSpecs)) {
    const spec = SETTING_SPECS[dotted]
    assert.equal(spec.type, expected.type)
    assert.equal(spec.default, expected.default)
    assert.equal(spec.volatile, expected.volatile)
    assert.equal(typeof spec.description, 'string')
    if (spec.type === 'enum') assert.deepEqual(spec.values, expected.values)
    if (spec.type === 'integer') {
      assert.equal(spec.min, expected.min)
      assert.equal(spec.max, expected.max)
      assert.equal(spec.step, expected.step)
      assert.ok(spec.min <= spec.default && spec.default <= spec.max)
      assert.ok(spec.step > 0)
    }
    // The defaults advertised by the schema and by the file loader must agree.
    assert.equal(readPath(DEFAULT_CONFIG, dotted), spec.default)
  }

  // Never expose the safety invariants as editable settings. `update.autoInstall`
  // is intentionally present but non-volatile: it is an explicit profile-patch
  // setting, never an auto-form field.
  for (const dangerous of ['allowEvaluate', 'browser.shared.enabled', 'browser.headless.chromeExecutable', 'update.repository', 'upload.extraRoots', 'safety.allowedOrigins']) {
    assert.equal(SETTING_SPECS[dangerous], undefined)
  }
  assert.equal(SETTING_SPECS['browser.shared'], undefined)
  assert.equal(SETTING_SPECS['update.autoInstall'].volatile, false)

  assert.deepEqual(PLUGIN_CONFIG_PATHS, Object.keys(SETTING_SPECS))
  assert.deepEqual(LIVE_PATHS, [
    'browser.preset',
    'browser.maxContexts',
    'browser.idleTimeoutMs',
    'verification.artifactRetentionRuns',
  ])
  assert.equal(Object.isFrozen(PLUGIN_CONFIG_PATHS), true)
  assert.equal(Object.isFrozen(LIVE_PATHS), true)

  // `collab` is still a legacy file preset; the DSH form deliberately omits it
  // until shared-visible contexts are implemented.
  assert.ok(PRESETS.includes('collab'))
  assert.equal(checkSettingValue('browser.preset', 'collab').ok, false)

  // ------------------------------------------------------------ checkSettingValue
  for (const [dotted, spec] of Object.entries(SETTING_SPECS)) {
    assert.deepEqual(checkSettingValue(dotted, spec.default), { ok: true, value: spec.default })
    if (spec.type === 'integer') {
      assert.deepEqual(checkSettingValue(dotted, spec.min), { ok: true, value: spec.min })
      assert.deepEqual(checkSettingValue(dotted, spec.max), { ok: true, value: spec.max })
    }
  }
  assert.deepEqual(checkSettingValue('not.a.setting', true), { ok: false, reason: 'unknown setting' })
  assert.deepEqual(checkSettingValue('browser', {}), { ok: false, reason: 'unknown setting' })

  for (const value of [true, false, 'true', 1, 0, null, undefined, {}]) {
    if (typeof value === 'boolean') continue
    assert.equal(checkSettingValue('update.enabled', value).ok, false, `boolean accepts only true/false: ${String(value)}`)
  }
  for (const value of ['collab', 'nope', 1, null, undefined, {}]) {
    assert.equal(checkSettingValue('browser.preset', value).ok, false, `enum rejects ${String(value)}`)
  }
  for (const value of [1.5, '4', 'fast', NaN, Infinity, -Infinity, 0, 17, null, undefined, {}]) {
    assert.equal(checkSettingValue('browser.maxContexts', value).ok, false, `integer rejects ${String(value)}`)
  }
  assert.equal(checkSettingValue('browser.idleTimeoutMs', 9_999).ok, false)
  assert.equal(checkSettingValue('browser.idleTimeoutMs', 3_600_001).ok, false)
  assert.equal(checkSettingValue('verification.artifactRetentionRuns', 0).ok, false)
  assert.equal(checkSettingValue('verification.artifactRetentionRuns', 1001).ok, false)
  assert.equal(checkSettingValue('update.checkIntervalHours', 0).ok, false)
  assert.equal(checkSettingValue('update.checkIntervalHours', 169).ok, false)

  // ----------------------------------------------------------- project forbidden
  for (const forbidden of ['allowEvaluate', 'evaluate', 'browser.shared', 'browser.headless.chromeExecutable', 'update.autoInstall', 'update.repository', 'upload.extraRoots', 'safety.allowedOrigins']) {
    assert.ok(PROJECT_FORBIDDEN.includes(forbidden), `missing PROJECT_FORBIDDEN entry: ${forbidden}`)
    assert.equal(isProjectForbidden(forbidden), true)
    assert.equal(isProjectForbidden(`${forbidden}.nested`), true)
  }
  for (const safe of ['browser.maxContexts', 'browser.preset', 'verification.artifactRetentionRuns', 'update.checkIntervalHours', 'update.enabled', 'evaluateConfirmTimeoutMs', 'allowEvaluateNote']) {
    assert.equal(isProjectForbidden(safe), false, `safe path wrongly forbidden: ${safe}`)
  }

  // ------------------------------------------------------------ readPluginOverride
  const row = (entry, override) => ({ entry, override, inherited: {} })
  const fakeCtx = ({ rows, raw, throwEditor = false, withGet = true, fiberConfig } = {}) => {
    const ctx = { fiber: { entry: { options: { config: raw } }, config: fiberConfig } }
    if (withGet) {
      ctx.get = (name) => {
        if (name !== 'configEditor') return undefined
        if (throwEditor) throw new Error('editor exploded')
        if (rows === undefined) return undefined
        return { configuration: () => rows }
      }
    }
    return ctx
  }

  // The raw profile-patch layer is the value DSH settings actually writes.
  let override = readPluginOverride(
    fakeCtx({ rows: [row({ options: { id: 'custom-id', name: 'dsh-desktop-chrome' } }, { browser: { maxContexts: 2 } })] }),
  )
  assert.deepEqual(override, { override: { browser: { maxContexts: 2 } }, source: 'config-editor', notes: [] })
  override = readPluginOverride(
    fakeCtx({ rows: [row({ options: { id: 'dsh-chrome', name: 'other-name' } }, { browser: { maxContexts: 3 } })] }),
  )
  assert.equal(override.source, 'config-editor')
  assert.equal(override.override.browser.maxContexts, 3)
  override = readPluginOverride(
    fakeCtx({ rows: [row({ id: 'include:dsh-chrome' }, { browser: { maxContexts: 4 } })] }),
  )
  assert.equal(override.source, 'config-editor')
  assert.equal(override.override.browser.maxContexts, 4)

  // A matching row with an empty override is still an explicit (empty) layer.
  override = readPluginOverride(fakeCtx({ rows: [row({ options: { name: 'dsh-desktop-chrome' } }, {})] }))
  assert.deepEqual(override, { override: {}, source: 'config-editor', notes: [] })

  // A non-object override is rejected instead of falling back to another layer.
  override = readPluginOverride(fakeCtx({ rows: [row({ options: { name: 'dsh-desktop-chrome' } }, ['bad'])] }))
  assert.deepEqual(override, { override: null, source: 'config-editor', notes: ['ignored non-object DSH entry override'] })

  // Without a matching row, the Loader's raw entry options are the fallback.
  override = readPluginOverride(
    fakeCtx({
      rows: [row({ options: { name: 'some-other-plugin' } }, {})],
      raw: { browser: { maxContexts: 5 } },
    }),
  )
  assert.deepEqual(override, { override: { browser: { maxContexts: 5 } }, source: 'entry-raw', notes: [] })

  // Old DSH / test contexts without configEditor use the same fallback.
  override = readPluginOverride(fakeCtx({ withGet: false, raw: { browser: { maxContexts: 6 } } }))
  assert.deepEqual(override, { override: { browser: { maxContexts: 6 } }, source: 'entry-raw', notes: [] })

  // A broken configEditor must not block provider mount.
  override = readPluginOverride(fakeCtx({ throwEditor: true, raw: { browser: { maxContexts: 7 } } }))
  assert.equal(override.source, 'entry-raw')
  assert.equal(override.override.browser.maxContexts, 7)
  assert.deepEqual(override.notes, ['cannot read DSH entry config: editor exploded'])

  // `entry.fiber.config` is the already-resolved config (defaults included) and
  // must never be used as a user layer.
  override = readPluginOverride(fakeCtx({ fiberConfig: { browser: { maxContexts: 9 } } }))
  assert.deepEqual(override, { override: null, source: 'none', notes: [] })

  override = readPluginOverride(fakeCtx({ withGet: false, raw: 'not-an-object' }))
  assert.deepEqual(override, { override: null, source: 'none', notes: ['ignored non-object DSH entry config'] })

  // ---------------------------------------------------------- Config graph shape
  assert.equal(ProviderConfig, Config)
  assert.equal(providerName, 'dsh-chrome')
  assert.equal(typeof providerApply, 'function')

  // Copied from DSH 0.2.15 `isNativeConfigSchema`; the Loader and the
  // Config.listConfigs inspect provider both gate on this predicate.
  const isNativeConfigSchema = (value) => {
    if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return false
    const meta = Reflect.get(value, 'meta')
    return (
      Reflect.get(value, Symbol.for('schemastery')) === true &&
      typeof Reflect.get(value, 'type') === 'string' &&
      meta !== null &&
      typeof meta === 'object'
    )
  }
  assert.equal(isNativeConfigSchema(Config), true)
  assert.equal('toJSON' in Config, true)
  assert.equal(typeof Config.simplify, 'function')
  assert.equal(Config['~standard'].vendor, 'schemastery')
  assert.equal(Config['~standard'].version, 1)
  assert.equal(typeof Config['~standard'].validate, 'function')

  const json = Config.toJSON()
  assert.deepEqual(Config.toJSON(), json, 'toJSON must be deterministic')
  assert.equal(typeof json.uid, 'number')
  assert.equal(typeof json.refs, 'object')
  assert.ok(Object.hasOwn(json.refs, json.uid))
  assert.equal(json.refs[json.uid].type, 'object')
  assert.deepEqual(Object.keys(json.refs[json.uid].dict), ['browser', 'verification', 'update'])
  assert.deepEqual(json.refs[json.uid].meta.default, {})
  assert.equal(JSON.parse(JSON.stringify(json)).uid, json.uid)

  // Local stand-in for the subset of `createConfigProjector` that
  // Config.listConfigs uses. It deliberately reads only uid/refs/type/meta/
  // dict/list/value, so it fails when the graph is not reconstructable.
  const projectNativeConfig = (graph) => {
    const active = new Set()
    const visit = (uid, at) => {
      assert.equal(typeof uid, 'number', `${at}: dict/list entries must be numeric uids`)
      assert.ok(Object.hasOwn(graph.refs, uid), `${at}: dangling uid ${uid}`)
      const node = graph.refs[uid]
      assert.equal(typeof node.type, 'string', `${at}: type`)
      assert.ok(node.meta !== null && typeof node.meta === 'object', `${at}: meta`)
      assert.equal(active.has(uid), false, `${at}: cyclic schema graph is not projectable`)
      active.add(uid)
      try {
        if (node.type === 'object') {
          assert.ok(node.dict && typeof node.dict === 'object', `${at}: object.dict`)
          const properties = {}
          const required = []
          for (const [key, childUid] of Object.entries(node.dict)) {
            properties[key] = visit(childUid, `${at}.${key}`)
            if (graph.refs[childUid].meta.required === true) required.push(key)
          }
          return { type: 'object', properties, ...(required.length ? { required } : {}) }
        }
        if (node.type === 'number') {
          assert.ok(Number.isFinite(node.meta.min) && Number.isFinite(node.meta.max), `${at}: numeric range`)
          assert.ok(Number.isFinite(node.meta.step) && node.meta.step > 0, `${at}: numeric step`)
          return { type: 'integer', minimum: node.meta.min, maximum: node.meta.max, multipleOf: node.meta.step }
        }
        if (node.type === 'boolean') return { type: 'boolean' }
        if (node.type === 'union') {
          assert.ok(Array.isArray(node.list) && node.list.length > 0, `${at}: union.list`)
          return { anyOf: node.list.map((childUid, index) => visit(childUid, `${at}<${index}>`)) }
        }
        if (node.type === 'const') {
          assert.ok(Object.hasOwn(node, 'value'), `${at}: const.value`)
          return { const: node.value }
        }
        assert.fail(`${at}: unsupported schema type ${node.type}`)
      } finally {
        active.delete(uid)
      }
    }
    return visit(graph.uid, 'config')
  }

  const projected = projectNativeConfig(json)
  assert.deepEqual(Object.keys(projected.properties), ['browser', 'verification', 'update'])
  assert.deepEqual(Object.keys(projected.properties.browser.properties), ['preset', 'maxContexts', 'idleTimeoutMs'])
  assert.deepEqual(Object.keys(projected.properties.verification.properties), ['artifactRetentionRuns'])
  assert.deepEqual(Object.keys(projected.properties.update.properties), ['enabled', 'autoInstall', 'checkIntervalHours'])
  assert.equal(projected.properties.browser.properties.preset.anyOf.length, 3)
  assert.deepEqual(
    projected.properties.browser.properties.preset.anyOf.map((variant) => variant.const),
    ['sandbox', 'sandbox-persistent', 'debug'],
  )
  assert.equal(projected.properties.browser.properties.maxContexts.type, 'integer')
  assert.equal(projected.properties.browser.properties.maxContexts.minimum, 1)
  assert.equal(projected.properties.browser.properties.maxContexts.maximum, 16)
  assert.equal(projected.properties.verification.properties.artifactRetentionRuns.type, 'integer')
  assert.equal(projected.properties.update.properties.enabled.type, 'boolean')
  assert.equal(JSON.stringify(projected).includes('undefined'), false)

  const nodeAt = (dotted) => {
    let uid = json.uid
    for (const key of dotted.split('.')) {
      const node = json.refs[uid]
      assert.equal(node.type, 'object', `${dotted}: ${key} parent must be an object`)
      assert.ok(Object.hasOwn(node.dict, key), `${dotted}: missing key ${key}`)
      uid = node.dict[key]
    }
    return json.refs[uid]
  }
  const leafPaths = []
  const collectLeaves = (uid, prefix) => {
    const node = json.refs[uid]
    if (node.type !== 'object') {
      leafPaths.push(prefix)
      return
    }
    for (const [key, childUid] of Object.entries(node.dict)) collectLeaves(childUid, prefix ? `${prefix}.${key}` : key)
  }
  collectLeaves(json.uid, '')
  assert.deepEqual(leafPaths, Object.keys(SETTING_SPECS))
  assert.deepEqual(leafPaths.filter((key) => nodeAt(key).meta.volatile === true), LIVE_PATHS)
  for (const [dotted, spec] of Object.entries(SETTING_SPECS)) {
    const node = nodeAt(dotted)
    assert.equal(node.meta.default, spec.default)
    assert.equal(node.meta.volatile === true, spec.volatile)
    assert.equal(node.meta.description, spec.description)
    if (spec.type === 'integer') {
      assert.equal(node.type, 'number')
      assert.equal(node.meta.min, spec.min)
      assert.equal(node.meta.max, spec.max)
      assert.equal(node.meta.step, spec.step)
    } else if (spec.type === 'boolean') {
      assert.equal(node.type, 'boolean')
    } else {
      assert.equal(node.type, 'union')
      assert.deepEqual(node.list.map((uid) => json.refs[uid].value), spec.values)
    }
  }

  // `simplify` is the Loader's patch serializer: defaults must disappear so a
  // settings edit does not write every default into the profile patch.
  assert.equal(Config.simplify({}), null)
  assert.equal(Config.simplify(undefined), undefined)
  assert.equal(Config.simplify(null), null)
  assert.equal(Config.simplify({ browser: { maxContexts: 4, idleTimeoutMs: 300_000 } }), null)
  assert.deepEqual(Config.simplify({ browser: { preset: 'debug' } }), { browser: { preset: 'debug' } })
  assert.deepEqual(Config.simplify({ browser: { preset: 'debug', maxContexts: 2, idleTimeoutMs: 300_000 }, update: { enabled: false } }), {
    browser: { preset: 'debug', maxContexts: 2 },
  })

  // -------------------------------------------------- validatePluginConfig()
  const validated = validatePluginConfig({
    browser: { preset: 'debug', maxContexts: 99, idleTimeoutMs: 'fast', apiKey: 'sk-CANARY', unknown: true },
    verification: { artifactRetentionRuns: 0 },
    update: { enabled: 'yes', autoInstall: false, checkIntervalHours: 24 },
  })
  assert.equal('issues' in validated, false)
  assert.equal(live(validated.value.browser.preset), 'debug')
  assert.equal(live(validated.value.browser.maxContexts), 4, 'invalid explicit values use the schema default')
  assert.equal(live(validated.value.browser.idleTimeoutMs), 300_000)
  assert.equal(live(validated.value.verification.artifactRetentionRuns), 50)
  assert.equal(validated.value.update.enabled, false)
  assert.equal(validated.value.update.autoInstall, false)
  assert.equal(validated.value.update.checkIntervalHours, 24)
  const warnings = pluginConfigWarnings(validated.value)
  assert.ok(warnings.some((line) => line.includes('browser.maxContexts')))
  assert.ok(warnings.some((line) => line.includes('browser.idleTimeoutMs')))
  assert.ok(warnings.some((line) => line.includes('browser.apiKey: ignored secret-shaped key')))
  assert.ok(warnings.some((line) => line.includes('browser.unknown: ignored unknown key')))
  assert.ok(warnings.some((line) => line.includes('verification.artifactRetentionRuns')))
  assert.ok(warnings.some((line) => line.includes('update.enabled')))
  assert.equal(JSON.stringify(validated.value).includes('CANARY'), false, 'secret values must never be echoed')

  assert.deepEqual(pluginConfigWarnings(validated.value), warnings, 'warning accessor returns a copy')
  assert.deepEqual(pluginConfigWarnings({}), [])
  for (const raw of [undefined, null, 'nope', [], 42, { browser: null }, { browser: [] }]) {
    assert.doesNotThrow(() => validatePluginConfig(raw), `validation must be fail-soft for ${String(raw)}`)
  }
  for (const raw of ['nope', [], 42, { browser: [] }]) {
    const result = validatePluginConfig(raw)
    assert.equal(typeof result.value, 'object')
    assert.ok(pluginConfigWarnings(result.value).some((line) => line.startsWith('(root)') || line.startsWith('browser')))
  }
  // Invalid values are skipped, not coerced: the schema default replaces them.
  const notCoerced = validatePluginConfig({ browser: { maxContexts: '2' } })
  assert.equal(live(notCoerced.value.browser.maxContexts), 4)

  // index.js adopts a volatile settings edit into the existing config object.
  // The manager and artifact store must read the current values, not the ones
  // captured when they were constructed.
  const liveConfig = {
    ...DEFAULT_CONFIG,
    browser: { ...DEFAULT_CONFIG.browser },
    verification: { ...DEFAULT_CONFIG.verification },
  }
  const manager = new BrowserContextManager({
    config: liveConfig,
    home: path.join(root, 'contexts-home'),
    createDriver: async () => ({ async close() {} }),
  })
  assert.equal(manager.maxContexts, 4)
  assert.equal(manager.idleTimeoutMs, 300_000)
  liveConfig.browser.maxContexts = 9
  liveConfig.browser.idleTimeoutMs = 120_000
  assert.equal(manager.maxContexts, 9)
  assert.equal(manager.idleTimeoutMs, 120_000)

  const retentionRoot = path.join(root, 'artifact-retention')
  const retention = { value: 3 }
  const store = new ArtifactStore({ root: retentionRoot, retentionRuns: () => retention.value })
  const epoch = Date.now() / 1000
  for (const [index, name] of ['a', 'b', 'c'].entries()) {
    const dir = path.join(retentionRoot, `verify-${name}`)
    fs.mkdirSync(dir, { recursive: true })
    fs.utimesSync(dir, epoch - 30 + index * 10, epoch - 30 + index * 10)
  }
  retention.value = 2
  assert.deepEqual(store.pruneArtifacts(), ['verify-a'])
  retention.value = 0
  assert.deepEqual(store.pruneArtifacts(), [], 'an invalid getter value falls back to a safe retention')
  assert.equal(fs.existsSync(path.join(retentionRoot, 'verify-b')), true)

  // -------------------------------------------------------------- loadConfig()
  let caseId = 0
  function loadCase({ legacy, user, project, pluginConfig } = {}) {
    const dir = path.join(root, `case-${++caseId}`)
    const home = path.join(dir, 'home')
    const cwd = path.join(dir, 'project')
    fs.mkdirSync(home, { recursive: true })
    fs.mkdirSync(cwd, { recursive: true })
    const write = (file, value) => {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, JSON.stringify(value))
    }
    if (legacy !== undefined) write(path.join(home, 'cache', 'dsh-chrome', 'config.json'), legacy)
    if (user !== undefined) write(path.join(home, 'config.json'), user)
    if (project !== undefined) write(path.join(cwd, '.dsh-chrome', 'config.json'), project)
    return loadConfig({ home, cwd, pluginConfig })
  }

  const defaults = loadCase()
  assert.deepEqual(defaults.config, DEFAULT_CONFIG)
  assert.deepEqual(defaults.warnings, [])
  assert.deepEqual(defaults.sources, Object.fromEntries(PLUGIN_CONFIG_PATHS.map((key) => [key, 'default'])))
  assert.equal(defaults.files.userPath, path.join(root, 'case-1', 'home', 'config.json'))
  assert.equal(defaults.files.legacyPath, path.join(root, 'case-1', 'home', 'cache', 'dsh-chrome', 'config.json'))
  assert.equal(defaults.files.projectPath, path.join(root, 'case-1', 'project', '.dsh-chrome', 'config.json'))

  const legacy = {
    version: 1,
    browser: { preset: 'sandbox-persistent', maxContexts: 2 },
    update: { enabled: true },
  }
  const user = {
    version: 1,
    browser: { maxContexts: 3, idleTimeoutMs: 20_000 },
    verification: { artifactRetentionRuns: 10 },
  }
  const project = {
    version: 1,
    browser: { preset: 'debug', maxContexts: 4, idleTimeoutMs: 30_000 },
    verification: { artifactRetentionRuns: 20 },
  }

  // Precedence: legacy user file < canonical user file < project file < DSH entry.
  const layered = loadCase({
    legacy,
    user,
    project,
    pluginConfig: {
      browser: { maxContexts: 6, idleTimeoutMs: 40_000 },
      verification: { artifactRetentionRuns: 30 },
      update: { checkIntervalHours: 12 },
    },
  })
  assert.equal(layered.config.browser.maxContexts, 6)
  assert.equal(layered.config.browser.idleTimeoutMs, 40_000)
  assert.equal(layered.config.verification.artifactRetentionRuns, 30)
  assert.equal(layered.config.browser.preset, 'debug', 'project file wins over legacy file')
  assert.equal(layered.config.update.enabled, true, 'legacy file remains a compatibility layer')
  assert.equal(layered.config.update.checkIntervalHours, 12)
  assert.equal(layered.sources['browser.maxContexts'], 'entry')
  assert.equal(layered.sources['browser.idleTimeoutMs'], 'entry')
  assert.equal(layered.sources['verification.artifactRetentionRuns'], 'entry')
  assert.equal(layered.sources['browser.preset'], 'project')
  assert.equal(layered.sources['update.enabled'], 'legacy-user')
  assert.equal(layered.sources['update.checkIntervalHours'], 'entry')
  assert.deepEqual(layered.warnings, [])

  // An invalid highest layer is skipped (not coerced), so a typo cannot erase a
  // valid lower-precedence value.
  const invalidEntry = loadCase({
    legacy,
    user,
    project,
    pluginConfig: {
      browser: { preset: 'collab', maxContexts: 0, idleTimeoutMs: 'fast' },
      verification: { artifactRetentionRuns: 1001 },
      update: { enabled: 'yes', checkIntervalHours: 169 },
    },
  })
  assert.equal(invalidEntry.config.browser.preset, 'debug')
  assert.equal(invalidEntry.config.browser.maxContexts, 4)
  assert.equal(invalidEntry.config.browser.idleTimeoutMs, 30_000)
  assert.equal(invalidEntry.config.verification.artifactRetentionRuns, 20)
  assert.equal(invalidEntry.config.update.enabled, true)
  assert.equal(invalidEntry.config.update.checkIntervalHours, 24)
  assert.equal(invalidEntry.sources['browser.preset'], 'project')
  assert.equal(invalidEntry.sources['browser.maxContexts'], 'project')
  assert.equal(invalidEntry.sources['browser.idleTimeoutMs'], 'project')
  assert.equal(invalidEntry.sources['verification.artifactRetentionRuns'], 'project')
  assert.equal(invalidEntry.sources['update.enabled'], 'legacy-user')
  assert.equal(invalidEntry.sources['update.checkIntervalHours'], 'default')
  for (const dotted of ['browser.preset', 'browser.maxContexts', 'browser.idleTimeoutMs', 'verification.artifactRetentionRuns', 'update.enabled', 'update.checkIntervalHours']) {
    assert.ok(
      invalidEntry.warnings.some((line) => line.includes('invalid DSH entry setting') && line.includes(dotted)),
      `missing invalid-entry warning for ${dotted}`,
    )
  }

  const nonObjectEntry = loadCase({ user, pluginConfig: 'nope' })
  assert.equal(nonObjectEntry.config.browser.maxContexts, 3)
  assert.deepEqual(nonObjectEntry.sources['browser.maxContexts'], 'user')
  assert.ok(nonObjectEntry.warnings.includes('ignored non-object DSH entry config'))

  // Project files may change safe fields but must never widen security.
  const projectDanger = loadCase({
    project: {
      version: 1,
      allowEvaluate: true,
      evaluate: { enabled: true },
      browser: {
        maxContexts: 2,
        shared: { enabled: true, leaseTtlMs: 60_000 },
        headless: { chromeExecutable: '/tmp/evil-chrome' },
      },
      update: { autoInstall: true, repository: 'evil/repo' },
      upload: { extraRoots: ['/'] },
      safety: { allowedOrigins: ['https://evil.test'] },
    },
  })
  assert.equal(projectDanger.config.browser.maxContexts, 2, 'safe project fields still apply')
  assert.equal(projectDanger.config.browser.shared.enabled, false)
  assert.equal(projectDanger.config.browser.headless.chromeExecutable, null)
  assert.equal(projectDanger.config.update.autoInstall, false)
  assert.equal(projectDanger.config.update.repository, DEFAULT_CONFIG.update.repository)
  assert.equal(projectDanger.config.safety.allowedOrigins, null)
  assert.equal(Object.hasOwn(projectDanger.config, 'allowEvaluate'), false)
  for (const dangerous of ['allowEvaluate', 'evaluate', 'browser.shared', 'browser.headless.chromeExecutable', 'update.autoInstall', 'update.repository', 'safety.allowedOrigins']) {
    assert.ok(
      projectDanger.warnings.some((line) => line.includes('project-level dangerous key') && line.includes(dangerous)),
      `missing project-level warning for ${dangerous}`,
    )
  }
  // `upload` has no parent in DEFAULT_CONFIG, so it is dropped as an unknown
  // key before its child can be reached; it still cannot take effect.
  assert.ok(projectDanger.warnings.some((line) => line.includes('upload')))

  // User-level files keep the old compatibility behavior: they are trusted for
  // dangerous switches (project-level files are not).
  const userDanger = loadCase({
    user: { version: 1, browser: { shared: { enabled: true } }, update: { autoInstall: true } },
  })
  assert.equal(userDanger.config.browser.shared.enabled, true)
  assert.equal(userDanger.config.update.autoInstall, true)

  // An explicit DSH entry is also a trusted user layer: non-volatile dangerous
  // fields stay reachable there, but non-Config safety invariants are rejected.
  const entryDanger = loadCase({
    pluginConfig: {
      allowEvaluate: true,
      evaluate: { enabled: true },
      browser: {
        shared: { enabled: true },
        headless: { chromeExecutable: '/tmp/evil-chrome' },
      },
      update: { autoInstall: true, repository: 'evil/repo' },
      upload: { extraRoots: ['/'] },
      safety: { allowedOrigins: ['https://evil.test'] },
    },
  })
  assert.equal(entryDanger.config.update.autoInstall, true)
  assert.equal(entryDanger.config.browser.shared.enabled, false)
  assert.equal(entryDanger.config.browser.headless.chromeExecutable, null)
  assert.equal(entryDanger.config.update.repository, DEFAULT_CONFIG.update.repository)
  assert.equal(entryDanger.config.safety.allowedOrigins, null)
  assert.equal(Object.hasOwn(entryDanger.config, 'allowEvaluate'), false)
  for (const dangerous of ['allowEvaluate', 'evaluate', 'browser.shared', 'browser.headless', 'update.repository']) {
    assert.ok(
      entryDanger.warnings.some((line) => line.includes('ignored non-Config entry key') && line.includes(dangerous)),
      `missing non-Config warning for ${dangerous}`,
    )
  }

  // Secret-shaped keys are rejected from every layer without echoing values.
  const secretEntry = loadCase({
    user: { version: 1, browser: { apiKey: 'sk-USER-CANARY' } },
    pluginConfig: { allowEvaluate: 'sk-ENTRY-CANARY', browser: { token: 'sk-ENTRY-CANARY' } },
  })
  assert.ok(secretEntry.warnings.some((line) => line.includes('apiKey')))
  assert.ok(secretEntry.warnings.some((line) => line.includes('token')))
  assert.equal(JSON.stringify(secretEntry).includes('CANARY'), false, 'warnings must not echo secret values')

  console.log('SETTINGS TEST: PASS')
} finally {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}
