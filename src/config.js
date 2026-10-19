/**
 * External-user browser configuration (I1).
 *
 * Loads the user-level config plus an optional project override, validates the
 * known fields, and never accepts secrets. Unknown fields are dropped with a
 * warning; a version mismatch falls back to defaults.
 */
import fs from 'node:fs'
import path from 'node:path'

export const CONFIG_VERSION = 1
export const PRESETS = ['sandbox', 'sandbox-persistent', 'debug', 'collab']

export const DEFAULT_CONFIG = Object.freeze({
  version: CONFIG_VERSION,
  browser: {
    preset: 'sandbox',
    maxContexts: 4,
    idleTimeoutMs: 300_000,
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
  },
  externalAgents: {
    claude: { preset: 'debug' },
    codex: { preset: 'debug' },
  },
  safety: { allowedOrigins: null },
})

const SECRET_KEY = /(password|passwd|secret|token|api[-_]?key|credential|private[-_]?key)/i
const KNOWN = new Set(['version', 'browser', 'verification', 'externalAgents', 'safety'])

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function merge(target, source, warnings, prefix = '') {
  if (!isPlainObject(source)) return
  for (const [key, value] of Object.entries(source)) {
    const full = prefix ? `${prefix}.${key}` : key
    if (SECRET_KEY.test(key)) {
      warnings.push(`ignored secret-shaped key: ${full}`)
      continue
    }
    if (!(key in target)) {
      warnings.push(`ignored unknown key: ${full}`)
      continue
    }
    if (isPlainObject(target[key])) {
      merge(target[key], value, warnings, full)
    } else if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
      target[key] = value
    } else {
      warnings.push(`ignored invalid value for: ${full}`)
    }
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
  config.verification.captureNetwork = ['off', 'metadata', 'bodies'].includes(config.verification.captureNetwork)
    ? config.verification.captureNetwork
    : 'metadata'
  config.verification.screenshotFormat = ['png', 'jpeg'].includes(config.verification.screenshotFormat) ? config.verification.screenshotFormat : 'png'
  config.verification.maxArtifactBytes = clampInt(config.verification.maxArtifactBytes, 1_048_576, 2_147_483_648, 52_428_800, warnings, 'verification.maxArtifactBytes')
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

function readJson(file, warnings, fsImpl = fs) {
  try {
    return JSON.parse(fsImpl.readFileSync(file, 'utf8'))
  } catch (error) {
    if (error?.code !== 'ENOENT') warnings.push(`cannot read ${file}: ${error.message}`)
    return null
  }
}

export function loadConfig({ home = process.env.DSH_HOME || path.join(process.env.HOME || '', '.dsh'), cwd = process.cwd(), fsImpl = fs } = {}) {
  const warnings = []
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
    merge(config, raw, warnings, '')
  }
  return { config: sanitize(config, warnings), warnings, files: { userPath, legacyPath, projectPath } }
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
