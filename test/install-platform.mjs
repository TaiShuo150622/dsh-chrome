/**
 * Platform path table + install asset tests — no Chrome required and no real
 * browser installation is touched.
 *
 * Covers:
 *   1. the BROWSERS table shape (chrome/edge/brave/chromium × mac/linux/win);
 *   2. mac / linux / windows path resolution (faked home + env; the Windows
 *      case uses an in-memory fs so fake `C:\...` paths never hit this disk);
 *   3. unknown browser / platform errors;
 *   4. ensureInstallAssets still writes the pre-refactor macOS Chrome paths
 *      (temp home), plus Linux (Chrome/Edge/Brave) and the Windows
 *      manifest/registration scaffold (registry is never written).
 *
 * Run with: node test/install-platform.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { BROWSER_IDS, BROWSERS, PLATFORMS, browserPaths, getPlatform } from '../src/platform.js'
import { HOST_NAME, chromeNativeHostsDir, ensureInstallAssets, extensionIdFromKey } from '../src/install.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const realExtensionManifest = JSON.parse(
  fs.readFileSync(path.join(root, 'extension', 'manifest.json'), 'utf8'),
)
const extensionId = extensionIdFromKey(realExtensionManifest.key)

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

async function checkThrows(name, fn, pattern) {
  let message
  try {
    await fn()
  } catch (error) {
    message = String(error?.message || error)
  }
  try {
    assert.ok(message, 'expected an error to be thrown')
    assert.match(message, pattern)
    console.log(`PASS ${name} — ${message}`)
  } catch (error) {
    failures += 1
    console.log(`FAIL ${name} — ${error?.message || error}`)
  }
}

function memoryFs(extensionManifest) {
  const files = new Map()
  const calls = []
  return {
    files,
    calls,
    async mkdir(dir, options) {
      calls.push({ op: 'mkdir', dir, options })
    },
    async readFile(file) {
      calls.push({ op: 'readFile', file })
      return JSON.stringify(extensionManifest)
    },
    async copyFile(source, target) {
      calls.push({ op: 'copyFile', source, target })
    },
    async writeFile(file, content, options) {
      calls.push({ op: 'writeFile', file, options })
      files.set(file, { content, options })
    },
    async chmod(file, mode) {
      calls.push({ op: 'chmod', file, mode })
    },
  }
}

// ---------------------------------------------------------------------------
// 1) declarative table shape
// ---------------------------------------------------------------------------

check('PLATFORMS = mac, linux, win', () => {
  assert.deepEqual([...PLATFORMS], ['mac', 'linux', 'win'])
  return PLATFORMS.join(', ')
})

check('BROWSER_IDS = chrome, edge, brave, chromium', () => {
  assert.deepEqual([...BROWSER_IDS], ['chrome', 'edge', 'brave', 'chromium'])
  return BROWSER_IDS.join(', ')
})

check('every browser has a mac/linux/win entry with all path fields', () => {
  for (const browser of BROWSER_IDS) {
    const entry = BROWSERS[browser]
    assert.equal(typeof entry.label, 'string', `${browser}.label`)
    assert.equal(typeof entry.extensionsUrl, 'string', `${browser}.extensionsUrl`)
    for (const platform of PLATFORMS) {
      const table = entry[platform]
      assert.ok(table, `${browser}.${platform} missing`)
      assert.equal(typeof table.userDataDir, 'string', `${browser}.${platform}.userDataDir`)
      assert.equal(typeof table.nativeMessagingHostsDir, 'string', `${browser}.${platform}.nativeMessagingHostsDir`)
      assert.ok(Array.isArray(table.executables), `${browser}.${platform}.executables`)
      assert.ok(table.executables.length > 0, `${browser}.${platform}.executables is empty`)
    }
  }
})

check('only the Windows entries carry a registryKey', () => {
  for (const browser of BROWSER_IDS) {
    assert.equal(BROWSERS[browser].mac.registryKey, undefined)
    assert.equal(BROWSERS[browser].linux.registryKey, undefined)
    assert.match(BROWSERS[browser].win.registryKey, /^HKCU\\Software\\/)
  }
})

check('BROWSERS table is frozen (no accidental runtime mutation)', () => {
  assert.ok(Object.isFrozen(BROWSERS))
  assert.ok(Object.isFrozen(BROWSERS.chrome))
  assert.ok(Object.isFrozen(BROWSERS.chrome.linux.executables))
})

// ---------------------------------------------------------------------------
// 2) platform normalization
// ---------------------------------------------------------------------------

check('getPlatform maps process.platform ids and friendly aliases', () => {
  assert.equal(getPlatform('darwin'), 'mac')
  assert.equal(getPlatform('mac'), 'mac')
  assert.equal(getPlatform('macos'), 'mac')
  assert.equal(getPlatform('linux'), 'linux')
  assert.equal(getPlatform('win32'), 'win')
  assert.equal(getPlatform('win'), 'win')
  assert.equal(getPlatform('windows'), 'win')
  assert.equal(getPlatform(), getPlatform(process.platform))
})

await checkThrows('getPlatform rejects unknown platforms', () => getPlatform('plan9'), /unsupported platform: plan9/)
await checkThrows('getPlatform rejects empty platforms', () => getPlatform(''), /unsupported platform/)

// ---------------------------------------------------------------------------
// 3) macOS paths (must match the pre-refactor hardcoded install.js paths)
// ---------------------------------------------------------------------------

check('macOS Chrome manifest dir equals the old hardcoded path', () => {
  const expected = path.join(
    os.homedir(),
    'Library',
    'Application Support',
    'Google',
    'Chrome',
    'NativeMessagingHosts',
  )
  assert.equal(browserPaths('chrome', 'mac').nativeMessagingHostsDir, expected)
  // compatibility helper resolves the same directory
  assert.equal(chromeNativeHostsDir('chrome', 'mac'), expected)
  return expected
})

check('macOS Chrome userDataDir + launcher candidates', () => {
  const paths = browserPaths('chrome', 'darwin')
  assert.equal(
    paths.userDataDir,
    path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome'),
  )
  assert.equal(paths.platform, 'mac')
  assert.equal(paths.browser, 'chrome')
  assert.equal(paths.label, 'Google Chrome')
  assert.equal(paths.extensionsUrl, 'chrome://extensions')
  assert.equal(paths.registryKey, null)
  assert.equal(paths.nativeMessagingMode, 'directory')
  assert.ok(
    paths.executableCandidates.includes('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
  )
  for (const candidate of paths.executableCandidates) {
    assert.ok(!candidate.startsWith('~'), `unexpanded ~ in ${candidate}`)
  }
  return paths.executableCandidates[0]
})

check('macOS wrapper browsers use Application Support manifest dirs', () => {
  const support = path.join(os.homedir(), 'Library', 'Application Support')
  assert.equal(browserPaths('edge', 'mac').nativeMessagingHostsDir, path.join(support, 'Microsoft Edge', 'NativeMessagingHosts'))
  assert.equal(
    browserPaths('brave', 'mac').nativeMessagingHostsDir,
    path.join(support, 'BraveSoftware', 'Brave-Browser', 'NativeMessagingHosts'),
  )
  assert.equal(browserPaths('chromium', 'mac').nativeMessagingHostsDir, path.join(support, 'Chromium', 'NativeMessagingHosts'))
  assert.equal(browserPaths('edge', 'mac').extensionsUrl, 'edge://extensions')
  assert.equal(browserPaths('brave', 'mac').extensionsUrl, 'brave://extensions')
})

// ---------------------------------------------------------------------------
// 4) Linux paths (fake POSIX home)
// ---------------------------------------------------------------------------

const linuxHome = '/home/alice'
const linuxOptions = { home: linuxHome }

check('Linux manifest dirs follow ~/.config/<browser>/NativeMessagingHosts', () => {
  assert.equal(
    browserPaths('chrome', 'linux', linuxOptions).nativeMessagingHostsDir,
    '/home/alice/.config/google-chrome/NativeMessagingHosts',
  )
  assert.equal(
    browserPaths('chromium', 'linux', linuxOptions).nativeMessagingHostsDir,
    '/home/alice/.config/chromium/NativeMessagingHosts',
  )
  assert.equal(
    browserPaths('edge', 'linux', linuxOptions).nativeMessagingHostsDir,
    '/home/alice/.config/microsoft-edge/NativeMessagingHosts',
  )
  assert.equal(
    browserPaths('brave', 'linux', linuxOptions).nativeMessagingHostsDir,
    '/home/alice/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts',
  )
})

check('Linux userDataDir + executable candidates', () => {
  const chrome = browserPaths('chrome', 'linux', linuxOptions)
  assert.equal(chrome.userDataDir, '/home/alice/.config/google-chrome')
  assert.equal(chrome.executableCandidates[0], 'google-chrome')
  assert.ok(chrome.executableCandidates.includes('/opt/google/chrome/chrome'))
  assert.equal(chrome.registryKey, null)
  assert.equal(chrome.nativeMessagingMode, 'directory')
  const brave = browserPaths('brave', 'linux', linuxOptions)
  assert.equal(brave.userDataDir, '/home/alice/.config/BraveSoftware/Brave-Browser')
  assert.ok(brave.executableCandidates.includes('brave-browser'))
})

// ---------------------------------------------------------------------------
// 5) Windows paths (fake windows env, no disk access)
// ---------------------------------------------------------------------------

const winHome = 'C:/Users/Alice'
const winEnv = {
  USERPROFILE: winHome,
  LOCALAPPDATA: 'C:/Users/Alice/AppData/Local',
  PROGRAMFILES: 'C:/Program Files',
  'PROGRAMFILES(X86)': 'C:/Program Files (x86)',
}
const winOptions = { home: winHome, env: winEnv }

check('Windows paths expand %VARS%, use backslashes and never leak % or /', () => {
  const chrome = browserPaths('chrome', 'win32', winOptions)
  assert.equal(chrome.platform, 'win')
  assert.equal(
    chrome.userDataDir,
    'C:\\Users\\Alice\\AppData\\Local\\Google\\Chrome\\User Data',
  )
  assert.equal(
    chrome.nativeMessagingHostsDir,
    'C:\\Users\\Alice\\.dsh\\cache\\dsh-chrome\\native-messaging-hosts',
  )
  assert.equal(chrome.nativeMessagingMode, 'registry')
  assert.equal(chrome.registryKey, 'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts')
  assert.ok(
    chrome.executableCandidates.includes('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'),
  )
  for (const candidate of chrome.executableCandidates) {
    assert.ok(!candidate.includes('/'), `leftover / in ${candidate}`)
    assert.ok(!candidate.includes('%'), `unexpanded variable in ${candidate}`)
  }
  return chrome.nativeMessagingHostsDir
})

check('Windows registry keys per browser', () => {
  assert.equal(
    browserPaths('edge', 'win', winOptions).registryKey,
    'HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts',
  )
  assert.equal(
    browserPaths('brave', 'win', winOptions).registryKey,
    'HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts',
  )
  assert.equal(
    browserPaths('chromium', 'win', winOptions).registryKey,
    'HKCU\\Software\\Chromium\\NativeMessagingHosts',
  )
})

check('Windows executable candidates cover Program Files, (x86) and per-user installs', () => {
  const chrome = browserPaths('chrome', 'win', winOptions).executableCandidates
  assert.ok(chrome.includes('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'))
  assert.ok(chrome.includes('C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'))
  assert.ok(chrome.includes('C:\\Users\\Alice\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe'))
  const edge = browserPaths('edge', 'win', winOptions).executableCandidates
  assert.ok(edge.some((candidate) => candidate.endsWith('\\Microsoft\\Edge\\Application\\msedge.exe')))
})

check('Windows dshHome override wins over <home>/.dsh', () => {
  const custom = browserPaths('chrome', 'win', {
    ...winOptions,
    dshHome: 'D:/dsh-data',
  })
  assert.equal(
    custom.nativeMessagingHostsDir,
    'D:\\dsh-data\\cache\\dsh-chrome\\native-messaging-hosts',
  )
})

// ---------------------------------------------------------------------------
// 6) unknown browser
// ---------------------------------------------------------------------------

await checkThrows(
  'browserPaths rejects unknown browsers with the supported list',
  () => browserPaths('netscape', 'mac'),
  /unknown browser: netscape \(supported: chrome, edge, brave, chromium\)/,
)

// ---------------------------------------------------------------------------
// 7) ensureInstallAssets: macOS keeps the original paths (temp home)
// ---------------------------------------------------------------------------

const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-chrome-platform-'))
try {
  const macHome = path.join(tmpRoot, 'mac-home')
  const macDsh = path.join(tmpRoot, 'mac-dsh')
  const macLogs = []
  const macLogger = {
    info: (...args) => macLogs.push(['info', ...args]),
    warn: (...args) => macLogs.push(['warn', ...args]),
  }
  const macInfo = await ensureInstallAssets({
    root,
    platform: 'darwin',
    home: macHome,
    dshHome: macDsh,
    logger: macLogger,
  })

  check('ensureInstallAssets (macOS) writes the original Chrome manifest path', () => {
    const expected = path.join(
      macHome,
      'Library',
      'Application Support',
      'Google',
      'Chrome',
      'NativeMessagingHosts',
      `${HOST_NAME}.json`,
    )
    assert.equal(macInfo.platform, 'mac')
    assert.equal(macInfo.browser, 'chrome')
    assert.equal(macInfo.nativeManifestPath, expected)
    assert.equal(macInfo.chromeNativeHostsDir, path.dirname(expected))
    assert.equal(macInfo.nativeMessagingMode, 'directory')
    assert.equal(macInfo.registration, null)
    return expected
  })

  check('ensureInstallAssets (macOS) writes a valid native host manifest', () => {
    const manifest = JSON.parse(fs.readFileSync(macInfo.nativeManifestPath, 'utf8'))
    assert.equal(manifest.name, HOST_NAME)
    assert.equal(manifest.type, 'stdio')
    assert.equal(manifest.path, macInfo.launcherPath)
    assert.deepEqual(manifest.allowed_origins, [`chrome-extension://${extensionId}/`])
    assert.equal(macInfo.extensionId, extensionId)
  })

  check('ensureInstallAssets (macOS) writes the POSIX launcher + host copy', () => {
    const launcher = fs.readFileSync(macInfo.launcherPath, 'utf8')
    assert.match(launcher, /^#!\/bin\/sh\n/)
    assert.ok(launcher.includes('host.mjs'))
    const mode = fs.statSync(macInfo.launcherPath).mode & 0o777
    assert.ok(mode & 0o111, `launcher not executable (mode ${mode.toString(8)})`)
    assert.equal(path.basename(macInfo.launcherPath), 'dsh-chrome-host')
    assert.ok(fs.existsSync(path.join(macInfo.hostDir, 'host.mjs')))
    assert.ok(fs.existsSync(macInfo.instructionsPath))
    assert.ok(fs.existsSync(path.join(macInfo.cacheDir, 'dev.json')))
  })

  check('ensureInstallAssets (macOS) INSTALL.md is macOS/browser specific', () => {
    const instructions = fs.readFileSync(macInfo.instructionsPath, 'utf8')
    assert.match(instructions, /macOS \/ Google Chrome/)
    assert.ok(instructions.includes(macInfo.nativeManifestPath))
    assert.ok(instructions.includes('chrome://extensions'))
    assert.ok(!instructions.includes('reg add'))
    assert.ok(macLogs.some(([, format]) => String(format).includes('extension dir')))
  })

  check('ensureInstallAssets (macOS) keeps every artifact inside the temp home', () => {
    assert.ok(macInfo.nativeManifestPath.startsWith(macHome + path.sep))
    assert.ok(macInfo.cacheDir.startsWith(macDsh + path.sep))
  })

  // -------------------------------------------------------------------------
  // 8) ensureInstallAssets: Linux Chrome / Edge / Brave write each browser's
  //    NativeMessagingHosts directory (temp home)
  // -------------------------------------------------------------------------
  const linuxInstallHome = path.join(tmpRoot, 'linux-home')
  const linuxExpectations = {
    chrome: ['.config', 'google-chrome'],
    edge: ['.config', 'microsoft-edge'],
    brave: ['.config', 'BraveSoftware', 'Brave-Browser'],
  }
  const linuxInfos = {}
  for (const browser of Object.keys(linuxExpectations)) {
    linuxInfos[browser] = await ensureInstallAssets({
      root,
      platform: 'linux',
      browser,
      home: linuxInstallHome,
      dshHome: path.join(tmpRoot, `linux-dsh-${browser}`),
    })
  }

  check('ensureInstallAssets (Linux) writes each browser manifest to its own dir', () => {
    for (const [browser, segments] of Object.entries(linuxExpectations)) {
      const info = linuxInfos[browser]
      const expected = path.join(linuxInstallHome, ...segments, 'NativeMessagingHosts', `${HOST_NAME}.json`)
      assert.equal(info.platform, 'linux')
      assert.equal(info.browser, browser)
      assert.equal(info.nativeManifestPath, expected)
      assert.equal(info.registration, null)
      assert.ok(fs.existsSync(expected))
      const manifest = JSON.parse(fs.readFileSync(expected, 'utf8'))
      assert.equal(manifest.name, HOST_NAME)
      assert.equal(manifest.path, info.launcherPath)
    }
  })

  check('ensureInstallAssets (Linux) launcher is POSIX and executable', () => {
    for (const browser of Object.keys(linuxExpectations)) {
      const info = linuxInfos[browser]
      const launcher = fs.readFileSync(info.launcherPath, 'utf8')
      assert.match(launcher, /^#!\/bin\/sh\n/)
      assert.equal(path.basename(info.launcherPath), 'dsh-chrome-host')
      const mode = fs.statSync(info.launcherPath).mode & 0o777
      assert.ok(mode & 0o111, `${browser}: launcher not executable`)
    }
  })

  check('ensureInstallAssets (Linux, Edge) docs point at edge://extensions', () => {
    const instructions = fs.readFileSync(linuxInfos.edge.instructionsPath, 'utf8')
    assert.match(instructions, /Linux \/ Microsoft Edge/)
    assert.ok(instructions.includes('edge://extensions'))
  })

  // -------------------------------------------------------------------------
  // 9) ensureInstallAssets: Windows writes the manifest + reports the registry
  //    registration, but never writes to the registry or to this disk
  // -------------------------------------------------------------------------
  const winFs = memoryFs(realExtensionManifest)
  const winLogs = []
  const winInfo = await ensureInstallAssets({
    root,
    platform: 'win32',
    home: winHome,
    env: winEnv,
    fs: winFs,
    logger: {
      info: (...args) => winLogs.push(['info', ...args]),
      warn: (...args) => winLogs.push(['warn', ...args]),
    },
  })

  check('ensureInstallAssets (Windows) writes the DSH-owned manifest path', () => {
    assert.equal(winInfo.platform, 'win')
    assert.equal(winInfo.browser, 'chrome')
    assert.equal(winInfo.nativeMessagingMode, 'registry')
    assert.equal(winInfo.registryKey, 'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts')
    assert.equal(
      path.dirname(winInfo.nativeManifestPath),
      'C:\\Users\\Alice\\.dsh\\cache\\dsh-chrome\\native-messaging-hosts',
    )
    assert.equal(path.basename(winInfo.nativeManifestPath), `${HOST_NAME}.json`)
    assert.ok(winFs.files.has(winInfo.nativeManifestPath), 'manifest was not written through the injected fs')
    return winInfo.nativeManifestPath
  })

  check('ensureInstallAssets (Windows) writes a .cmd launcher and the manifest points at it', () => {
    assert.equal(path.basename(winInfo.launcherPath), 'dsh-chrome-host.cmd')
    const launcher = winFs.files.get(winInfo.launcherPath).content
    assert.match(launcher, /^@echo off\r\n/)
    assert.ok(launcher.includes('\r\n'))
    assert.ok(launcher.includes('host.mjs'))
    assert.ok(launcher.includes('ELECTRON_RUN_AS_NODE'))
    assert.ok(!launcher.startsWith('#!/bin/sh'))
    assert.ok(!winFs.calls.some((call) => call.op === 'chmod'), 'chmod should not run on Windows')
    const manifest = JSON.parse(winFs.files.get(winInfo.nativeManifestPath).content)
    assert.equal(manifest.name, HOST_NAME)
    assert.equal(manifest.path, winInfo.launcherPath)
    assert.equal(manifest.type, 'stdio')
    assert.deepEqual(manifest.allowed_origins, [`chrome-extension://${extensionId}/`])
  })

  check('ensureInstallAssets (Windows) reports the registry registration without applying it', () => {
    const registration = winInfo.registration
    assert.ok(registration, 'no registration info returned')
    assert.equal(registration.type, 'registry')
    assert.equal(registration.applied, false)
    assert.equal(registration.hive, 'HKCU')
    assert.equal(
      registration.key,
      `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`,
    )
    assert.equal(registration.value, winInfo.nativeManifestPath)
    assert.match(registration.command, /^reg add "/)
    assert.ok(registration.command.includes('/ve /d'))
    assert.ok(registration.command.includes('/f'))
    assert.ok(registration.query.startsWith('reg query "'))
    assert.ok(winLogs.some(([level, format]) => level === 'warn' && String(format).includes('manual')))
    const instructions = winFs.files.get(winInfo.instructionsPath).content
    assert.match(instructions, /Windows \/ Google Chrome/)
    assert.ok(instructions.includes(registration.command))
    assert.ok(instructions.includes('chrome://extensions'))
  })

  await checkThrows(
    'ensureInstallAssets rejects unknown browsers before touching the fs',
    () => ensureInstallAssets({ root, platform: 'linux', browser: 'netscape', fs: memoryFs(realExtensionManifest) }),
    /unknown browser: netscape/,
  )
  await checkThrows(
    'ensureInstallAssets rejects unknown platforms before touching the fs',
    () => ensureInstallAssets({ root, platform: 'plan9', browser: 'chrome', fs: memoryFs(realExtensionManifest) }),
    /unsupported platform: plan9/,
  )
  await checkThrows(
    'ensureInstallAssets still requires { root }',
    () => ensureInstallAssets({}),
    /requires \{ root \}/,
  )
} finally {
  await fsp.rm(tmpRoot, { recursive: true, force: true })
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`)
  process.exitCode = 1
} else {
  console.log('\nall install-platform checks passed')
}
