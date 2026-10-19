/**
 * External-user browser configuration (I1).
 *
 * Loads the user-level config plus an optional project override, validates the
 * known fields, and never accepts secrets. Unknown fields are dropped with a
 * warning; a version mismatch falls back to defaults.
 *
 * Settings MVP (2026-10-19): an explicit DSH plugin entry config is merged as
 * the highest layer. Only the safe fields in `src/settings.js` are accepted
 * there, and only the values the user actually wrote (the profile-patch
 * override), never the schema defaults DSH resolves. Each known key records
 * its winning layer in `sources`.
 */
import fs from 'node:fs'
import path from 'node:path'

import {
  PLUGIN_CONFIG_PATHS,
  PROJECT_FORBIDDEN,
  SETTING_SPECS,
  checkSettingValue,
  isProjectForbidden,
} from './settings.js'

export const CONFIG_VERSION = 1
export const PRESETS = ['sandbox', 'sandbox-persistent', 'debug', 'collab']

export const DEFAULT_CONFIG = Object.freeze({
  version: CONFIG_VERSION,
  browser: {
    preset: SETTING_SPECS['browser.preset'].default,
    maxContexts: SETTING_SPECS['browser.maxContexts'].default,
    idleTimeoutMs: SETTING_SPECS['browser.idleTimeoutMs'].default,
    headless: {
      chromeExecutable: null,
      viewport: { width: 1440, height: 900 },
    },
    profilesDir: null,
    shared: { enabled: false, requireLease: true },
  },
  verification: {
    screenshotFormat: 'png',
    captureConsole: true,
    captureNetwork: 'metadata',
    artifactDir: null,
    maxArtifactBytes: 52_428_800,
    artifactRetentionRuns: SETTING_SPECS['verification.artifactRetentionRuns'].default,
  },
  externalAgents: {
    claude: { preset: 'debug' },
    codex: { preset: 'debug' },
  },
  update: {
    enabled: SETTING_SPECS['update.enabled'].default,
    autoInstall: SETTING_SPECS['update.autoInstall'].default,
    channel: 'stable',
    checkIntervalHours: SETTING_SPECS['update.checkIntervalHours'].default,
    repository: 'TaiShuo150622/dsh-chrome',
  },
  safety: { allowedOrigins: null },
})

const SECRET_KEY = /(password|passwd|secret|token|api[-_]?key|credential|private[-_]?key)/i
const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

/**
 * Merge one file layer into the working config.
 *
 * The project layer passes `forbidden`, so paths in PROJECT_FORBIDDEN are
 * ignored before they can reach a known field (for example
 * `browser.shared.enabled`). `sources` records the last accepted leaf, which
 * lets callers explain which layer won.
 */
function merge(target, source, warnings, prefix = '', options = {}) {
  const { sourceName = '', sources = null, forbidden = null } = options
  if (!isPlainObject(source)) return
  for (const [key, value] of Object.entries(source)) {
    const full = prefix ? `${prefix}.${key}` : key
    if (SECRET_KEY.test(key)) {
      warnings.push(`ignored secret-shaped key: ${full}`)
      continue
    }
    if (forbidden && isProjectForbidden(full)) {
      warnings.push(`ignored project-level dangerous key: ${full}`)
      continue
    }
    if (!(key in target)) {
      warnings.push(`ignored unknown key: ${full}`)
      continue
    }
    if (isPlainObject(target[key])) {
      if (!isPlainObject(value)) {
        warnings.push(`ignored invalid value for: ${full}`)
        continue
      }
      merge(target[key], value, warnings, full, options)
    } else if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
      target[key] = value
      if (sources && Object.hasOwn(sources, full)) sources[full] = sourceName
    } else {
      warnings.push(`ignored invalid value for: ${full}`)
    }
  }
}

function readPath(object, dotted) {
  let node = object
  for (const key of dotted.split('.')) {
    if (!isPlainObject(node) || !Object.hasOwn(node, key)) return undefined
    node = node[key]
  }
  return node
}

function writePath(object, dotted, value) {
  const parts = dotted.split('.')
  let node = object
  for (const key of parts.slice(0, -1)) node = node[key]
  node[parts.at(-1)] = value
}

/**
 * Warn about entry keys that are not part of the MVP Config surface. Secret
 * values are never read or echoed.
 */
function warnUnknownEntryKeys(raw, warnings, prefix = '') {
  if (!isPlainObject(raw)) return
  for (const [key, value] of Object.entries(raw)) {
    const full = prefix ? `${prefix}.${key}` : key
    if (SECRET_KEY.test(key)) {
      warnings.push(`ignored secret-shaped key: ${full}`)
      continue
    }
    if (isPlainObject(value) && PLUGIN_CONFIG_PATHS.some((candidate) => candidate.startsWith(`${full}.`))) {
      warnUnknownEntryKeys(value, warnings, full)
      continue
    }
    if (!Object.hasOwn(SETTING_SPECS, full)) warnings.push(`ignored non-Config entry key: ${full}`)
  }
}

/**
 * Merge the explicit DSH entry override as the highest-precedence layer.
 * Invalid values are skipped with a warning instead of being coerced, so a
 * typo cannot silently erase a valid file value.
 */
function mergePluginConfig(config, raw, warnings, sources) {
  if (raw === undefined || raw === null) return
  if (!isPlainObject(raw)) {
    warnings.push('ignored non-object DSH entry config')
    return
  }
  warnUnknownEntryKeys(raw, warnings)
  for (const dotted of PLUGIN_CONFIG_PATHS) {
    const value = readPath(raw, dotted)
    if (value === undefined) continue
    const checked = checkSettingValue(dotted, value)
    if (!checked.ok) {
      warnings.push(`ignored invalid DSH entry setting ${dotted} (${checked.reason})`)
      continue
    }
    writePath(config, dotted, checked.value)
    sources[dotted] = 'entry'
  }
}

function sanitize(config, warnings) {
  if (config.version !== CONFIG_VERSION) {
    warnings.push(`unsupported config version ${config.version}; using defaults`)
    return clone(DEFAULT_CONFIG)
  }
  if (!PRESETS.includes(config.browser.preset)) {
    warnings.push(`unknown browser.preset ${JSON.stringify(config.browser.preset)}; using sandbox`)
    config.browser.preset = 'sandbox'
  }
  config.browser.maxContexts = clampInt(config.browser.maxContexts, 1, 16, 4, warnings, 'browser.maxContexts')
  config.browser.idleTimeoutMs = clampInt(config.browser.idleTimeoutMs, 10_000, 3_600_000, 300_000, warnings, 'browser.idleTimeoutMs')
  config.browser.headless.viewport.width = clampInt(config.browser.headless.viewport.width, 200, 7680, 1440, warnings, 'browser.headless.viewport.width')
  config.browser.headless.viewport.height = clampInt(config.browser.headless.viewport.height, 200, 4320, 900, warnings, 'browser.headless.viewport.height')
  config.browser.shared.enabled = clampBool(config.browser.shared.enabled, false, warnings, 'browser.shared.enabled')
  config.verification.captureNetwork = ['off', 'metadata', 'bodies'].includes(config.verification.captureNetwork)
    ? config.verification.captureNetwork
    : 'metadata'
  config.verification.screenshotFormat = ['png', 'jpeg'].includes(config.verification.screenshotFormat) ? config.verification.screenshotFormat : 'png'
  config.verification.maxArtifactBytes = clampInt(config.verification.maxArtifactBytes, 1_048_576, 2_147_483_648, 52_428_800, warnings, 'verification.maxArtifactBytes')
  config.verification.artifactRetentionRuns = clampInt(config.verification.artifactRetentionRuns, 1, 1000, 50, warnings, 'verification.artifactRetentionRuns')
  config.update.enabled = clampBool(config.update.enabled, false, warnings, 'update.enabled')
  config.update.autoInstall = clampBool(config.update.autoInstall, false, warnings, 'update.autoInstall')
  if (!['stable', 'preview'].includes(config.update.channel)) {
    warnings.push('invalid update.channel; using stable')
    config.update.channel = 'stable'
  }
  config.update.checkIntervalHours = clampInt(config.update.checkIntervalHours, 1, 168, 24, warnings, 'update.checkIntervalHours')
  for (const name of ['claude', 'codex']) {
    if (!PRESETS.includes(config.externalAgents[name].preset)) {
      warnings.push(`unknown externalAgents.${name}.preset; using debug`)
      config.externalAgents[name].preset = 'debug'
    }
  }
  return config
}

function clampInt(value, min, max, fallback, warnings, label) {
  const number = Number(value)
  if (!Number.isInteger(number) || number < min || number > max) {
    warnings.push(`invalid ${label}; using ${fallback}`)
    return fallback
  }
  return number
}

function clampBool(value, fallback, warnings, label) {
  if (typeof value !== 'boolean') {
    warnings.push(`invalid ${label}; using ${fallback}`)
    return fallback
  }
  return value
}

function readJson(file, warnings, fsImpl = fs) {
  try {
    return JSON.parse(fsImpl.readFileSync(file, 'utf8'))
  } catch (error) {
    if (error?.code !== 'ENOENT') warnings.push(`cannot read ${file}: ${error.message}`)
    return null
  }
}

/**
 * Load the effective config.
 *
 * Precedence (low to high):
 *   DEFAULT_CONFIG
 *     < legacy provider file   (~/.dsh/cache/dsh-chrome/config.json)
 *     < user file              (~/.dsh/config.json)
 *     < project file           (<cwd>/.dsh-chrome/config.json, safe fields only)
 *     < explicit DSH entry     (profile patch `config:` for dsh-chrome)
 *
 * @param {object} [options]
 * @param {string} [options.home] DSH home.
 * @param {string} [options.cwd] Project directory.
 * @param {object} [options.fsImpl] File-system seam for tests.
 * @param {object|null} [options.pluginConfig] Explicit DSH entry override.
 * @returns {{config: object, warnings: string[], files: object, sources: object}}
 */
export function loadConfig({
  home = process.env.DSH_HOME || path.join(process.env.HOME || '', '.dsh'),
  cwd = process.cwd(),
  fsImpl = fs,
  pluginConfig = null,
} = {}) {
  const warnings = []
  const sources = Object.fromEntries(PLUGIN_CONFIG_PATHS.map((key) => [key, 'default']))
  const userPath = path.join(home, 'config.json')
  const legacyPath = path.join(home, 'cache', 'dsh-chrome', 'config.json')
  const projectPath = path.join(cwd, '.dsh-chrome', 'config.json')
  const config = clone(DEFAULT_CONFIG)
  // Lowest to highest precedence: legacy user -> canonical user -> project.
  for (const [source, file] of [['legacy-user', legacyPath], ['user', userPath], ['project', projectPath]]) {
    const raw = readJson(file, warnings, fsImpl)
    if (!raw) continue
    if (!isPlainObject(raw)) {
      warnings.push(`ignored non-object config at ${file}`)
      continue
    }
    merge(config, raw, warnings, '', {
      sourceName: source,
      sources,
      forbidden: source === 'project' ? PROJECT_FORBIDDEN : null,
    })
  }
  mergePluginConfig(config, pluginConfig, warnings, sources)
  return { config: sanitize(config, warnings), warnings, files: { userPath, legacyPath, projectPath }, sources }
}

export function presetToMode(preset) {
  switch (preset) {
    case 'sandbox':
      return { isolation: 'ephemeral', visible: false }
    case 'sandbox-persistent':
      return { isolation: 'named', visible: false }
    case 'debug':
      return { isolation: 'named', visible: true }
    case 'collab':
      return { isolation: 'shared', visible: true }
    default:
      return { isolation: 'ephemeral', visible: false }
  }
}
