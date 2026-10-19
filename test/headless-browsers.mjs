/**
 * Headless multi-engine executable resolution — no real browser is launched.
 *
 * The resolver is pure when given an injected `isExecutable` predicate, so the
 * test pins the exact contract for every engine x platform candidate table,
 * the environment/config precedence, and the "explicit selection never falls
 * back to another engine" rule without touching this machine's applications.
 *
 * Run with: node test/headless-browsers.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { DEFAULT_CONFIG, loadConfig } from '../src/config.js'
import {
  HEADLESS_ENGINES,
  HeadlessBrowserError,
  headlessExecutableCandidates,
  resolveHeadlessExecutable,
} from '../src/headless-browsers.js'
import { headlessChromeExecutable, headlessSupported } from '../src/headless.js'

let failures = 0

function check(name, fn) {
  try {
    const detail = fn()
    console.log(`PASS ${name}${detail ? ` — ${detail}` : ''}`)
  } catch (error) {
    failures += 1
    console.log(`FAIL ${name} — ${error?.message || error}`)
  }
}

function captureError(fn) {
  try {
    fn()
  } catch (error) {
    return error
  }
  return null
}

function checkThrows(name, fn, expectedCode, pattern) {
  try {
    const error = captureError(fn)
    assert.ok(error, 'expected an error to be thrown')
    assert.equal(error.code, expectedCode, `expected ${expectedCode}, got ${error.code}: ${error.message}`)
    if (pattern) assert.match(error.message, pattern)
    console.log(`PASS ${name} — ${error.code}: ${error.message}`)
    return error
  } catch (error) {
    failures += 1
    console.log(`FAIL ${name} — ${error?.message || error}`)
    return null
  }
}

function fakeExecutables(...files) {
  const present = new Set(files)
  return (file) => present.has(file)
}

const HOME = '/Users/dsh-headless-test'
const MAC = { platform: 'mac', home: HOME, env: {} }
const LINUX = { platform: 'linux', home: '/home/dsh', env: {} }
const WIN_ENV = {
  USERPROFILE: 'C:/Users/dsh',
  LOCALAPPDATA: 'C:/Users/dsh/AppData/Local',
  PROGRAMFILES: 'C:/Program Files',
  'PROGRAMFILES(X86)': 'C:/Program Files (x86)',
}
const WIN = { platform: 'win32', home: 'C:/Users/dsh', env: WIN_ENV }

const MAC_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const MAC_CHROMIUM = '/Applications/Chromium.app/Contents/MacOS/Chromium'
const MAC_EDGE = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
const MAC_BRAVE = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'
const WIN_CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const WIN_EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const WIN_BRAVE = 'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe'

// ---------------------------------------------------------------------------
// 1) engines and platform candidates
// ---------------------------------------------------------------------------

check('headless engines are chrome/chromium/edge/brave', () => {
  assert.deepEqual([...HEADLESS_ENGINES], ['chrome', 'chromium', 'edge', 'brave'])
  return HEADLESS_ENGINES.join(', ')
})

check('macOS candidates match the platform table for all four engines', () => {
  assert.ok(headlessExecutableCandidates('chrome', MAC).includes(MAC_CHROME))
  assert.ok(headlessExecutableCandidates('chromium', MAC).includes(MAC_CHROMIUM))
  assert.ok(headlessExecutableCandidates('edge', MAC).includes(MAC_EDGE))
  assert.ok(headlessExecutableCandidates('brave', MAC).includes(MAC_BRAVE))
  for (const engine of HEADLESS_ENGINES) {
    for (const candidate of headlessExecutableCandidates(engine, MAC)) {
      assert.ok(candidate.startsWith('/'), `${engine}: non-absolute mac candidate ${candidate}`)
      assert.ok(!candidate.includes('~'), `${engine}: unexpanded ~ in ${candidate}`)
    }
  }
  return '4 engines'
})

check('Linux candidates include command names and absolute install paths', () => {
  const edge = headlessExecutableCandidates('edge', LINUX)
  assert.ok(edge.includes('microsoft-edge'))
  assert.ok(edge.includes('/usr/bin/microsoft-edge'))
  const brave = headlessExecutableCandidates('brave', LINUX)
  assert.ok(brave.includes('brave-browser'))
  assert.ok(brave.includes('/opt/brave.com/brave/brave'))
  const chromium = headlessExecutableCandidates('chromium', LINUX)
  assert.ok(chromium.includes('chromium'))
  assert.ok(chromium.includes('/usr/bin/chromium-browser'))
  return edge[0]
})

check('Windows candidates expand %VARS% to absolute msedge/chrome/brave paths', () => {
  const chrome = headlessExecutableCandidates('chrome', WIN)
  const edge = headlessExecutableCandidates('edge', WIN)
  const brave = headlessExecutableCandidates('brave', WIN)
  const chromium = headlessExecutableCandidates('chromium', WIN)
  assert.ok(chrome.includes(WIN_CHROME))
  assert.ok(edge.includes(WIN_EDGE))
  assert.ok(brave.includes(WIN_BRAVE))
  assert.ok(chromium.includes('C:\\Program Files\\Chromium\\Application\\chrome.exe'))
  for (const engine of HEADLESS_ENGINES) {
    for (const candidate of headlessExecutableCandidates(engine, WIN)) {
      assert.ok(!candidate.includes('%'), `${engine}: unexpanded variable in ${candidate}`)
      assert.ok(/^[A-Za-z]:\\/.test(candidate), `${engine}: non-absolute Windows candidate ${candidate}`)
    }
  }
  return edge[0]
})

check('engine aliases used by installers resolve (msedge -> edge)', () => {
  assert.deepEqual(
    headlessExecutableCandidates('msedge', MAC),
    headlessExecutableCandidates('edge', MAC),
  )
  return 'msedge'
})

// ---------------------------------------------------------------------------
// 2) default behavior (no env / config) keeps Chrome -> Chromium
// ---------------------------------------------------------------------------

check('default picks Chrome first', () => {
  const selected = resolveHeadlessExecutable({
    ...MAC,
    isExecutable: fakeExecutables(MAC_CHROME, MAC_CHROMIUM),
  })
  assert.equal(selected.engine, 'chrome')
  assert.equal(selected.executable, MAC_CHROME)
  assert.equal(selected.explicit, false)
  assert.equal(selected.source, 'default')
  return selected.executable
})

check('default still falls back to Chromium (legacy behavior)', () => {
  const selected = resolveHeadlessExecutable({
    ...MAC,
    isExecutable: fakeExecutables(MAC_CHROMIUM),
  })
  assert.equal(selected.engine, 'chromium')
  assert.equal(selected.executable, MAC_CHROMIUM)
  assert.equal(selected.explicit, false)
  return selected.executable
})

check('default returns null (not an error) when nothing is installed', () => {
  const selected = resolveHeadlessExecutable({ ...MAC, isExecutable: () => false })
  assert.equal(selected.engine, null)
  assert.equal(selected.executable, null)
  assert.equal(selected.source, 'default')
  assert.ok(Array.isArray(selected.candidates) && selected.candidates.length > 0)
  return `${selected.candidates.length} candidates probed`
})

check('headlessSupported follows the default probe (true/false, no throw)', () => {
  assert.equal(headlessSupported({ ...MAC, isExecutable: fakeExecutables(MAC_CHROME) }), true)
  assert.equal(headlessSupported({ ...MAC, isExecutable: () => false }), false)
  assert.equal(headlessChromeExecutable({ ...MAC, isExecutable: () => false }), null)
  return 'supported=false without a browser'
})

// ---------------------------------------------------------------------------
// 3) explicit engine selection (env and config)
// ---------------------------------------------------------------------------

check('DSH_CHROME_BROWSER=edge picks Edge, not Chrome', () => {
  const selected = resolveHeadlessExecutable({
    ...MAC,
    env: { DSH_CHROME_BROWSER: 'edge' },
    isExecutable: fakeExecutables(MAC_CHROME, MAC_EDGE),
  })
  assert.equal(selected.engine, 'edge')
  assert.equal(selected.executable, MAC_EDGE)
  assert.equal(selected.source, 'env:DSH_CHROME_BROWSER')
  assert.equal(selected.explicit, true)
  return selected.executable
})

check('config engine=brave picks Brave', () => {
  const selected = resolveHeadlessExecutable({
    ...MAC,
    engine: 'brave',
    isExecutable: fakeExecutables(MAC_CHROME, MAC_BRAVE),
  })
  assert.equal(selected.engine, 'brave')
  assert.equal(selected.executable, MAC_BRAVE)
  assert.equal(selected.source, 'config')
  return selected.executable
})

check('DSH_CHROME_BROWSER=msedge alias works', () => {
  const selected = resolveHeadlessExecutable({
    ...MAC,
    env: { DSH_CHROME_BROWSER: 'msedge' },
    isExecutable: fakeExecutables(MAC_EDGE),
  })
  assert.equal(selected.engine, 'edge')
  return selected.executable
})

check('env selector overrides config engine', () => {
  const selected = resolveHeadlessExecutable({
    ...MAC,
    engine: 'brave',
    env: { DSH_CHROME_BROWSER: 'edge' },
    isExecutable: fakeExecutables(MAC_EDGE, MAC_BRAVE),
  })
  assert.equal(selected.engine, 'edge')
  assert.equal(selected.executable, MAC_EDGE)
  return selected.executable
})

// ---------------------------------------------------------------------------
// 4) explicit executable / config precedence
// ---------------------------------------------------------------------------

check('explicit executable wins over engine probing', () => {
  const custom = '/opt/dsh/custom-chromium'
  const selected = resolveHeadlessExecutable({
    ...MAC,
    engine: 'brave',
    executable: custom,
    env: {},
    isExecutable: fakeExecutables(MAC_CHROME, MAC_BRAVE, custom),
  })
  assert.equal(selected.engine, 'brave')
  assert.equal(selected.executable, custom)
  assert.equal(selected.source, 'config')
  assert.equal(selected.explicit, true)
  return selected.executable
})

check('DSH_HEADLESS_CHROME wins over config executable and engine', () => {
  const fromEnv = '/opt/dsh/from-env'
  const selected = resolveHeadlessExecutable({
    ...MAC,
    engine: 'brave',
    executable: '/opt/dsh/from-config',
    env: { DSH_HEADLESS_CHROME: fromEnv, DSH_CHROME_BROWSER: 'edge' },
    isExecutable: fakeExecutables(fromEnv, '/opt/dsh/from-config', MAC_EDGE),
  })
  assert.equal(selected.executable, fromEnv)
  assert.equal(selected.source, 'env:DSH_HEADLESS_CHROME')
  // The engine label follows the explicit engine; the binary itself is the
  // user's explicit path (no inference from its basename).
  assert.equal(selected.engine, 'edge')
  return selected.executable
})

check('headlessChromeExecutable applies the same precedence', () => {
  const custom = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'
  assert.equal(
    headlessChromeExecutable({ ...MAC, engine: 'brave', isExecutable: fakeExecutables(custom) }),
    custom,
  )
  return custom
})

// ---------------------------------------------------------------------------
// 5) explicit-but-missing must not fall back
// ---------------------------------------------------------------------------

checkThrows(
  'env edge missing reports HEADLESS_EXECUTABLE_NOT_FOUND (no Chrome fallback)',
  () =>
    resolveHeadlessExecutable({
      ...MAC,
      env: { DSH_CHROME_BROWSER: 'edge' },
      isExecutable: fakeExecutables(MAC_CHROME),
    }),
  'HEADLESS_EXECUTABLE_NOT_FOUND',
  /engine "edge"[\s\S]*Microsoft Edge/,
)

checkThrows(
  'config edge missing reports HEADLESS_EXECUTABLE_NOT_FOUND with candidates',
  () =>
    resolveHeadlessExecutable({
      ...MAC,
      engine: 'edge',
      isExecutable: fakeExecutables(MAC_CHROME, MAC_CHROMIUM),
    }),
  'HEADLESS_EXECUTABLE_NOT_FOUND',
  /engine "edge"/,
)

checkThrows(
  'explicit chrome missing does not silently use Chromium',
  () =>
    resolveHeadlessExecutable({
      ...MAC,
      env: { DSH_CHROME_BROWSER: 'chrome' },
      isExecutable: fakeExecutables(MAC_CHROMIUM),
    }),
  'HEADLESS_EXECUTABLE_NOT_FOUND',
  /engine "chrome"/,
)

checkThrows(
  'explicit executable path missing is an error',
  () =>
    resolveHeadlessExecutable({
      ...MAC,
      executable: '/opt/dsh/not-installed',
      isExecutable: fakeExecutables(MAC_CHROME),
    }),
  'HEADLESS_EXECUTABLE_NOT_FOUND',
  /\/opt\/dsh\/not-installed/,
)

checkThrows(
  'headlessChromeExecutable surfaces the explicit miss',
  () =>
    headlessChromeExecutable({
      ...MAC,
      env: { DSH_CHROME_BROWSER: 'brave' },
      isExecutable: () => false,
    }),
  'HEADLESS_EXECUTABLE_NOT_FOUND',
  /engine "brave"/,
)

check('headlessSupported stays true for an explicit miss so launch can explain it', () => {
  assert.equal(
    headlessSupported({ ...MAC, env: { DSH_CHROME_BROWSER: 'edge' }, isExecutable: () => false }),
    true,
  )
  return 'diagnostic error surfaces at launch'
})

checkThrows(
  'unknown env engine reports HEADLESS_ENGINE_UNKNOWN with the supported list',
  () =>
    resolveHeadlessExecutable({
      ...MAC,
      env: { DSH_CHROME_BROWSER: 'netscape' },
      isExecutable: fakeExecutables(MAC_CHROME),
    }),
  'HEADLESS_ENGINE_UNKNOWN',
  /supported: chrome, chromium, edge, brave/,
)

checkThrows(
  'unknown config engine reports HEADLESS_ENGINE_UNKNOWN',
  () =>
    resolveHeadlessExecutable({
      ...MAC,
      engine: 'safari',
      isExecutable: fakeExecutables(MAC_CHROME),
    }),
  'HEADLESS_ENGINE_UNKNOWN',
  /safari/,
)

// ---------------------------------------------------------------------------
// 6) Linux PATH lookup and Windows absolute table paths
// ---------------------------------------------------------------------------

check('Linux bare command names resolve through PATH (edge)', () => {
  const selected = resolveHeadlessExecutable({
    platform: 'linux',
    home: '/home/dsh',
    env: { DSH_CHROME_BROWSER: 'edge', PATH: '/opt/dsh/bin:/usr/bin' },
    isExecutable: fakeExecutables('/opt/dsh/bin/microsoft-edge'),
  })
  assert.equal(selected.engine, 'edge')
  assert.equal(selected.executable, '/opt/dsh/bin/microsoft-edge')
  return selected.executable
})

check('Linux falls back to the absolute table candidate when PATH misses', () => {
  const selected = resolveHeadlessExecutable({
    platform: 'linux',
    home: '/home/dsh',
    env: { DSH_CHROME_BROWSER: 'brave', PATH: '/nonexistent' },
    isExecutable: fakeExecutables('/opt/brave.com/brave/brave'),
  })
  assert.equal(selected.executable, '/opt/brave.com/brave/brave')
  return selected.executable
})

check('Windows engine selection uses the platform table (Edge)', () => {
  const selected = resolveHeadlessExecutable({
    ...WIN,
    env: { ...WIN_ENV, DSH_CHROME_BROWSER: 'edge' },
    isExecutable: fakeExecutables(WIN_EDGE, WIN_CHROME),
  })
  assert.equal(selected.engine, 'edge')
  assert.equal(selected.executable, WIN_EDGE)
  assert.ok(selected.executable.startsWith('C:\\'))
  return selected.executable
})

check('Windows default still picks Chrome first', () => {
  const selected = resolveHeadlessExecutable({
    ...WIN,
    isExecutable: fakeExecutables(WIN_CHROME),
  })
  assert.equal(selected.engine, 'chrome')
  assert.equal(selected.executable, WIN_CHROME)
  return selected.executable
})

checkThrows(
  'Windows explicit Edge missing does not fall back to chrome.exe',
  () =>
    resolveHeadlessExecutable({
      ...WIN,
      env: { ...WIN_ENV, DSH_CHROME_BROWSER: 'edge' },
      isExecutable: fakeExecutables(WIN_CHROME),
    }),
  'HEADLESS_EXECUTABLE_NOT_FOUND',
  /msedge\.exe/,
)

// ---------------------------------------------------------------------------
// 7) config structure: explicit selection is accepted, defaults stay null
// ---------------------------------------------------------------------------

check('config defaults keep browser.engine and chromeExecutable unset', () => {
  assert.equal(DEFAULT_CONFIG.browser.engine, null)
  assert.equal(DEFAULT_CONFIG.browser.headless.chromeExecutable, null)
  return 'engine=null, chromeExecutable=null'
})

check('config normalizes browser.engine and trims chromeExecutable', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-headless-browsers-'))
  try {
    fs.writeFileSync(
      path.join(root, 'config.json'),
      JSON.stringify({
        version: 1,
        browser: { engine: ' EDGE ', headless: { chromeExecutable: ' /opt/dsh/msedge ' } },
      }),
    )
    const loaded = loadConfig({ home: root, cwd: root })
    assert.equal(loaded.config.browser.engine, 'edge')
    assert.equal(loaded.config.browser.headless.chromeExecutable, '/opt/dsh/msedge')
    assert.deepEqual(loaded.warnings, [])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
  return 'engine=edge'
})

check('unknown config engine warns and falls back to the default probe order', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-headless-browsers-'))
  try {
    fs.writeFileSync(
      path.join(root, 'config.json'),
      JSON.stringify({ version: 1, browser: { engine: 'safari' } }),
    )
    const loaded = loadConfig({ home: root, cwd: root })
    assert.equal(loaded.config.browser.engine, null)
    assert.ok(loaded.warnings.some((line) => line.includes('browser.engine')))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
  return 'null'
})

// ---------------------------------------------------------------------------
// 8) error identity
// ---------------------------------------------------------------------------

check('resolution errors are HeadlessBrowserError instances', () => {
  const error = captureError(() =>
    resolveHeadlessExecutable({
      ...MAC,
      env: { DSH_CHROME_BROWSER: 'edge' },
      isExecutable: () => false,
    }),
  )
  assert.ok(error instanceof HeadlessBrowserError)
  assert.equal(error.name, 'HeadlessBrowserError')
  assert.equal(error.engine, 'edge')
  assert.ok(error.candidates.some((candidate) => candidate.includes('Microsoft Edge')))
  return error.code
})

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`)
  process.exitCode = 1
} else {
  console.log('\nall headless-browsers checks passed')
}
