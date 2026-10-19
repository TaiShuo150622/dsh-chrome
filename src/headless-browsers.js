/**
 * Headless browser executable resolution (multi-engine MVP).
 *
 * One declarative place that answers "which Chromium-family executable should
 * the headless backend launch?" for Chrome / Chromium / Edge / Brave on
 * macOS / Linux / Windows. Candidates come from `src/platform.js`
 * (`browserPaths()`), so the Windows `%PROGRAMFILES%` table and the macOS
 * application bundles stay the single source of truth; this module only adds
 * environment/config selection, PATH lookup and executable validation.
 *
 * Selection precedence (highest first):
 *   1. `executable` argument / `DSH_HEADLESS_CHROME` — an explicit binary path;
 *   2. `engine` argument / `DSH_CHROME_BROWSER` — a named engine whose
 *      candidates are probed;
 *   3. default — the legacy probe order Chrome -> Chromium.
 *
 * Explicit selection never falls back to another engine: asking for Edge on a
 * machine without Edge throws `HEADLESS_EXECUTABLE_NOT_FOUND` (with the looked
 * at candidates) instead of silently launching Chrome. The default order keeps
 * the pre-multi-engine behavior for existing installs, including
 * Chromium-only machines.
 *
 * `env` here is the process environment (for the selectors and `%VAR%`
 * expansion); `PATH` is only used to resolve bare Linux command names such as
 * `google-chrome` / `microsoft-edge`. Windows candidates are absolute by
 * construction, so they never depend on `PATH`.
 */
import fs from 'node:fs'

import { browserPaths, getPlatform } from './platform.js'

export const HEADLESS_ENGINES = Object.freeze(['chrome', 'chromium', 'edge', 'brave'])

export const HEADLESS_ENGINE_ENV = 'DSH_CHROME_BROWSER'
export const HEADLESS_EXECUTABLE_ENV = 'DSH_HEADLESS_CHROME'

/** Default probe order when neither engine nor executable was configured. */
const DEFAULT_PROBE_ORDER = Object.freeze(['chrome', 'chromium'])

/**
 * Friendly aliases accepted from users / installers. The canonical ids are the
 * keys of `BROWSERS`; aliases mainly cover executable names (`msedge`).
 */
const ENGINE_ALIASES = Object.freeze({
  chrome: 'chrome',
  'google-chrome': 'chrome',
  chromium: 'chromium',
  edge: 'edge',
  msedge: 'edge',
  'microsoft-edge': 'edge',
  brave: 'brave',
  'brave-browser': 'brave',
})

export class HeadlessBrowserError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'HeadlessBrowserError'
    this.code = code
    Object.assign(this, details)
  }
}

function envValue(env, name) {
  if (!env) return undefined
  if (env[name] !== undefined) return env[name]
  const lowered = name.toLowerCase()
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === lowered) return env[key]
  }
  return undefined
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (value == null) continue
    const text = String(value).trim()
    if (text) return text
  }
  return null
}

function normalizeEngine(value, { source = null } = {}) {
  const raw = String(value ?? '').trim().toLowerCase()
  if (!raw) return null
  const engine = ENGINE_ALIASES[raw]
  if (!engine) {
    throw new HeadlessBrowserError(
      'HEADLESS_ENGINE_UNKNOWN',
      `unknown headless browser engine ${JSON.stringify(value)}${source ? ` (${source})` : ''} ` +
        `(supported: ${HEADLESS_ENGINES.join(', ')})`,
      { engine: raw, source },
    )
  }
  return engine
}

function pathDirectories(env, platform) {
  const raw = envValue(env, 'PATH')
  if (!raw) return []
  const delimiter = platform === 'win' ? ';' : ':'
  return String(raw)
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean)
}

function isAbsoluteCandidate(candidate, platform) {
  if (platform === 'win') return /^[A-Za-z]:[\\/]/.test(candidate) || candidate.startsWith('\\\\')
  return candidate.startsWith('/')
}

function joinExecutable(directory, name, platform) {
  const separator = platform === 'win' ? '\\' : '/'
  return `${directory.replace(/[\\/]+$/, '')}${separator}${name}`
}

/**
 * Expand one table candidate into the actual paths probed: absolute candidates
 * stay as-is, bare Linux command names are looked up in `PATH`.
 */
function expandCandidate(candidate, { platform, env }) {
  const text = String(candidate)
  if (isAbsoluteCandidate(text, platform)) return [text]
  return pathDirectories(env, platform).map((directory) => joinExecutable(directory, text, platform))
}

function defaultIsExecutable(file, platform) {
  try {
    const stat = fs.statSync(file)
    if (!stat.isFile()) return false
    // Windows has no X_OK; a regular file is the closest check.
    if (platform !== 'win') fs.accessSync(file, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

function probeEngine(engine, { platform, home, dshHome, env, probe }) {
  const rawCandidates = browserPaths(engine, platform, { home, dshHome, env }).executableCandidates
  const candidates = []
  for (const raw of rawCandidates) {
    for (const candidate of expandCandidate(raw, { platform, env })) {
      if (!candidates.includes(candidate)) candidates.push(candidate)
      if (probe(candidate)) return { engine, executable: candidate, candidates, rawCandidates }
    }
  }
  return { engine, executable: null, candidates, rawCandidates }
}

function describeCandidates(searched, raw) {
  const list = searched.length > 0 ? searched : raw
  return list.length > 0 ? list.join('; ') : '(no candidates; PATH is empty)'
}

/**
 * Expand the executable candidates declared by the platform table for one
 * engine (bare Linux commands are returned as-is).
 *
 * @param {'chrome'|'chromium'|'edge'|'brave'|string} engine
 * @param {{ platform?: string, home?: string, dshHome?: string, env?: object }} [options]
 * @returns {string[]}
 */
export function headlessExecutableCandidates(engine, options = {}) {
  const engineId = normalizeEngine(engine)
  if (!engineId) throw new HeadlessBrowserError('HEADLESS_ENGINE_UNKNOWN', 'headless browser engine is required')
  const platform = getPlatform(options.platform ?? process.platform)
  return browserPaths(engineId, platform, {
    home: options.home,
    dshHome: options.dshHome,
    env: options.env ?? process.env,
  }).executableCandidates
}

/**
 * Resolve the executable for one headless launch.
 *
 * @param {object} [options]
 * @param {string|null} [options.engine] explicit engine id (config `browser.engine`)
 * @param {string|null} [options.executable] explicit binary path (config
 *   `browser.headless.chromeExecutable`)
 * @param {object} [options.env] environment used for selectors, `%VAR%`
 *   expansion and `PATH`; defaults to `process.env`
 * @param {string} [options.platform] platform id / `process.platform` value
 * @param {string} [options.home] test hook for `~` expansion
 * @param {string} [options.dshHome] test hook for `{dshHome}`
 * @param {(file: string) => boolean} [options.isExecutable] test hook; defaults
 *   to a real file + `X_OK` check (exists + regular file on Windows)
 * @returns {{
 *   engine: string|null, executable: string|null, source: string,
 *   explicit: boolean, candidates: string[], rawCandidates: string[]
 * }}
 *   `executable: null` only in default probing when no browser is installed.
 * @throws {HeadlessBrowserError} `HEADLESS_ENGINE_UNKNOWN` for an unknown
 *   selector, `HEADLESS_EXECUTABLE_NOT_FOUND` when an explicitly selected
 *   engine/binary is not installed.
 */
export function resolveHeadlessExecutable({
  engine = null,
  executable = null,
  env = process.env,
  platform = process.platform,
  home,
  dshHome,
  isExecutable,
} = {}) {
  const platformId = getPlatform(platform)
  const environment = env ?? {}
  const probe = typeof isExecutable === 'function' ? isExecutable : (file) => defaultIsExecutable(file, platformId)

  const envExecutable = firstNonEmpty(envValue(environment, HEADLESS_EXECUTABLE_ENV))
  const envEngine = firstNonEmpty(envValue(environment, HEADLESS_ENGINE_ENV))
  // Environment overrides win over config values; explicit executable wins
  // over engine probing because it names the exact binary.
  const explicitExecutable = envExecutable ?? firstNonEmpty(executable)
  const explicitEngine = envEngine ?? firstNonEmpty(engine)

  if (explicitExecutable) {
    const source = envExecutable ? `env:${HEADLESS_EXECUTABLE_ENV}` : 'config'
    const engineId = explicitEngine
      ? normalizeEngine(explicitEngine, { source: envEngine ? `env:${HEADLESS_ENGINE_ENV}` : 'config' })
      : null
    if (!probe(explicitExecutable)) {
      throw new HeadlessBrowserError(
        'HEADLESS_EXECUTABLE_NOT_FOUND',
        `headless browser executable not found: ${explicitExecutable} (${source})`,
        { engine: engineId, source, candidates: [explicitExecutable], rawCandidates: [explicitExecutable] },
      )
    }
    return {
      engine: engineId,
      executable: explicitExecutable,
      source,
      explicit: true,
      candidates: [explicitExecutable],
      rawCandidates: [explicitExecutable],
    }
  }

  if (explicitEngine) {
    const source = envEngine ? `env:${HEADLESS_ENGINE_ENV}` : 'config'
    const engineId = normalizeEngine(explicitEngine, { source })
    const found = probeEngine(engineId, { platform: platformId, home, dshHome, env: environment, probe })
    if (!found.executable) {
      throw new HeadlessBrowserError(
        'HEADLESS_EXECUTABLE_NOT_FOUND',
        `headless browser executable not found for engine "${engineId}" (${source}); ` +
          `looked for: ${describeCandidates(found.candidates, found.rawCandidates)}`,
        {
          engine: engineId,
          source,
          candidates: found.candidates.length > 0 ? found.candidates : found.rawCandidates,
          rawCandidates: found.rawCandidates,
        },
      )
    }
    return {
      engine: engineId,
      executable: found.executable,
      source,
      explicit: true,
      candidates: found.candidates.length > 0 ? found.candidates : found.rawCandidates,
      rawCandidates: found.rawCandidates,
    }
  }

  // No explicit selection: preserve the pre-multi-engine probe order. This is
  // deliberately the only path that falls back from Chrome to Chromium.
  const candidates = []
  const rawCandidates = []
  for (const engineId of DEFAULT_PROBE_ORDER) {
    const found = probeEngine(engineId, { platform: platformId, home, dshHome, env: environment, probe })
    candidates.push(...found.candidates)
    rawCandidates.push(...found.rawCandidates)
    if (found.executable) {
      return {
        engine: engineId,
        executable: found.executable,
        source: 'default',
        explicit: false,
        candidates,
        rawCandidates,
      }
    }
  }

  return { engine: null, executable: null, source: 'default', explicit: false, candidates, rawCandidates }
}
