/**
 * Platform / browser path table for the desktop-extension backend.
 *
 * One place for every path difference between the supported desktop browsers
 * (Chrome / Edge / Brave / Chromium) and operating systems (macOS / Linux /
 * Windows). `src/install.js` consumes this table to write the native messaging
 * manifest; platform paths must not be hardcoded anywhere else.
 *
 * The exported `BROWSERS` table is declarative. Path templates may contain:
 *   - a leading `~`      → the user's home directory;
 *   - `{dshHome}`        → the DSH data directory (default `~/.dsh`);
 *   - `%VAR%`            → Windows environment variables (`LOCALAPPDATA`,
 *                          `PROGRAMFILES`, `PROGRAMFILES(X86)`, ...).
 * Use `browserPaths()` to resolve them for the current (or a faked) platform.
 *
 * Windows detail: Chrome/Edge/Brave do not read a fixed NativeMessagingHosts
 * directory on Windows. They find the host through the registry key
 * `HKCU\Software\...\NativeMessagingHosts\<host name>`, whose default value is
 * an arbitrary path to the manifest JSON. The table therefore stores a
 * DSH-owned manifest directory plus the browser's registry key; writing the
 * registry value is a separate, deliberately manual step (see
 * docs/INSTALL-PLATFORM.md).
 */
import os from 'node:os'

export const PLATFORMS = Object.freeze(['mac', 'linux', 'win'])
export const BROWSER_IDS = Object.freeze(['chrome', 'edge', 'brave', 'chromium'])

/** Maps `process.platform` values (and a few friendly aliases) to table keys. */
const PLATFORM_ALIASES = Object.freeze({
  darwin: 'mac',
  mac: 'mac',
  macos: 'mac',
  osx: 'mac',
  linux: 'linux',
  win32: 'win',
  win: 'win',
  windows: 'win',
})

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const key of Object.keys(value)) deepFreeze(value[key])
    Object.freeze(value)
  }
  return value
}

/**
 * Browser × platform table. Every browser has `mac` / `linux` / `win` entries:
 *
 *   userDataDir              user profile directory (future browser selection)
 *   nativeMessagingHostsDir  where the native host manifest is written
 *                            (on Windows: a DSH-owned directory; the registry
 *                            value is what the browser actually reads)
 *   executables              executable candidates, in preference order
 *                            (bare command names on Linux are looked up on PATH)
 *   registryKey              Windows only: `HKCU` key that points at the manifest
 */
export const BROWSERS = deepFreeze({
  chrome: {
    label: 'Google Chrome',
    extensionsUrl: 'chrome://extensions',
    mac: {
      userDataDir: '~/Library/Application Support/Google/Chrome',
      nativeMessagingHostsDir: '~/Library/Application Support/Google/Chrome/NativeMessagingHosts',
      executables: [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '~/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      ],
    },
    linux: {
      userDataDir: '~/.config/google-chrome',
      nativeMessagingHostsDir: '~/.config/google-chrome/NativeMessagingHosts',
      executables: [
        'google-chrome',
        'google-chrome-stable',
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/opt/google/chrome/chrome',
      ],
    },
    win: {
      userDataDir: '%LOCALAPPDATA%/Google/Chrome/User Data',
      nativeMessagingHostsDir: '{dshHome}/cache/dsh-chrome/native-messaging-hosts',
      executables: [
        '%PROGRAMFILES%/Google/Chrome/Application/chrome.exe',
        '%PROGRAMFILES(X86)%/Google/Chrome/Application/chrome.exe',
        '%LOCALAPPDATA%/Google/Chrome/Application/chrome.exe',
      ],
      registryKey: 'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts',
    },
  },
  edge: {
    label: 'Microsoft Edge',
    extensionsUrl: 'edge://extensions',
    mac: {
      userDataDir: '~/Library/Application Support/Microsoft Edge',
      nativeMessagingHostsDir: '~/Library/Application Support/Microsoft Edge/NativeMessagingHosts',
      executables: ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
    },
    linux: {
      userDataDir: '~/.config/microsoft-edge',
      nativeMessagingHostsDir: '~/.config/microsoft-edge/NativeMessagingHosts',
      executables: ['microsoft-edge', 'microsoft-edge-stable', '/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable'],
    },
    win: {
      userDataDir: '%LOCALAPPDATA%/Microsoft/Edge/User Data',
      nativeMessagingHostsDir: '{dshHome}/cache/dsh-chrome/native-messaging-hosts',
      executables: [
        '%PROGRAMFILES(X86)%/Microsoft/Edge/Application/msedge.exe',
        '%PROGRAMFILES%/Microsoft/Edge/Application/msedge.exe',
        '%LOCALAPPDATA%/Microsoft/Edge/Application/msedge.exe',
      ],
      registryKey: 'HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts',
    },
  },
  brave: {
    label: 'Brave',
    extensionsUrl: 'brave://extensions',
    mac: {
      userDataDir: '~/Library/Application Support/BraveSoftware/Brave-Browser',
      nativeMessagingHostsDir: '~/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts',
      executables: ['/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'],
    },
    linux: {
      userDataDir: '~/.config/BraveSoftware/Brave-Browser',
      nativeMessagingHostsDir: '~/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts',
      executables: ['brave-browser', 'brave', '/usr/bin/brave-browser', '/opt/brave.com/brave/brave'],
    },
    win: {
      userDataDir: '%LOCALAPPDATA%/BraveSoftware/Brave-Browser/User Data',
      nativeMessagingHostsDir: '{dshHome}/cache/dsh-chrome/native-messaging-hosts',
      executables: [
        '%PROGRAMFILES%/BraveSoftware/Brave-Browser/Application/brave.exe',
        '%PROGRAMFILES(X86)%/BraveSoftware/Brave-Browser/Application/brave.exe',
        '%LOCALAPPDATA%/BraveSoftware/Brave-Browser/Application/brave.exe',
      ],
      registryKey: 'HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts',
    },
  },
  chromium: {
    label: 'Chromium',
    extensionsUrl: 'chrome://extensions',
    mac: {
      userDataDir: '~/Library/Application Support/Chromium',
      nativeMessagingHostsDir: '~/Library/Application Support/Chromium/NativeMessagingHosts',
      executables: ['/Applications/Chromium.app/Contents/MacOS/Chromium'],
    },
    linux: {
      userDataDir: '~/.config/chromium',
      nativeMessagingHostsDir: '~/.config/chromium/NativeMessagingHosts',
      executables: ['chromium', 'chromium-browser', '/usr/bin/chromium', '/usr/bin/chromium-browser'],
    },
    win: {
      userDataDir: '%LOCALAPPDATA%/Chromium/User Data',
      nativeMessagingHostsDir: '{dshHome}/cache/dsh-chrome/native-messaging-hosts',
      executables: [
        '%PROGRAMFILES%/Chromium/Application/chrome.exe',
        '%PROGRAMFILES(X86)%/Chromium/Application/chrome.exe',
        '%LOCALAPPDATA%/Chromium/Application/chrome.exe',
      ],
      registryKey: 'HKCU\\Software\\Chromium\\NativeMessagingHosts',
    },
  },
})

/**
 * Normalize a platform id to a `BROWSERS` key (`mac` / `linux` / `win`).
 * Accepts `process.platform` values (`darwin` / `linux` / `win32`) and the
 * friendly aliases `mac` / `windows` / `osx`.
 */
export function getPlatform(id = process.platform) {
  const key = String(id ?? '').trim().toLowerCase()
  const platform = PLATFORM_ALIASES[key]
  if (!platform) {
    throw new Error(`unsupported platform: ${id} (supported: ${PLATFORMS.join(', ')})`)
  }
  return platform
}

function toNativeSeparators(value, platform) {
  if (platform === 'win') return value.replace(/\//g, '\\').replace(/\\{2,}/g, '\\')
  return value.replace(/\\/g, '/')
}

function normalizeRoot(value, platform) {
  const native = toNativeSeparators(String(value), platform)
  const isRoot = platform === 'win' ? /^[A-Za-z]:\\?$/.test(native) : /^\/$/.test(native)
  return isRoot ? native : native.replace(/[\\/]+$/, '')
}

function joinFor(platform, base, name) {
  const separator = platform === 'win' ? '\\' : '/'
  return `${base.replace(/[\\/]+$/, '')}${separator}${name}`
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

/** Fallbacks so the table is still testable/diagnosable off Windows. */
function envFallback(name, home) {
  switch (name.toUpperCase()) {
    case 'USERPROFILE':
      return home
    case 'LOCALAPPDATA':
      return `${home}/AppData/Local`
    case 'APPDATA':
      return `${home}/AppData/Roaming`
    case 'PROGRAMFILES':
      return 'C:/Program Files'
    case 'PROGRAMFILES(X86)':
      return 'C:/Program Files (x86)'
    default:
      return null
  }
}

function expandPath(template, { home, dshHome, env, platform }) {
  let value = String(template).replace(/\{dshHome\}/g, dshHome)
  value = value.replace(/%([^%]+)%/g, (match, name) => {
    const found = envValue(env, name) ?? envFallback(name, home)
    return found == null ? match : String(found)
  })
  value = value.replace(/^~(?=$|[\\/])/, home)
  return toNativeSeparators(value, platform)
}

/**
 * Resolve the path table for one browser/platform pair.
 *
 * @param {string} [browser='chrome'] one of `BROWSER_IDS`
 * @param {string} [platform=process.platform] platform id or alias
 * @param {{ home?: string, dshHome?: string, env?: Record<string, string|undefined> }} [options]
 *   Test/injection hooks. `home` replaces `os.homedir()`; `dshHome` replaces
 *   `~/.dsh`; `env` replaces `process.env` for `%VAR%` expansion.
 * @returns {{
 *   browser: string, platform: string, label: string, extensionsUrl: string,
 *   userDataDir: string, nativeMessagingHostsDir: string,
 *   executableCandidates: string[], registryKey: string|null,
 *   nativeMessagingMode: 'directory'|'registry'
 * }}
 */
export function browserPaths(browser = 'chrome', platform = process.platform, options = {}) {
  const browserId = String(browser).toLowerCase()
  const entry = BROWSERS[browserId]
  if (!entry) {
    throw new Error(`unknown browser: ${browser} (supported: ${BROWSER_IDS.join(', ')})`)
  }
  const platformId = getPlatform(platform)
  const table = entry[platformId]
  const env = options.env ?? process.env
  const home = normalizeRoot(options.home ?? os.homedir(), platformId)
  const dshHome =
    options.dshHome == null ? joinFor(platformId, home, '.dsh') : normalizeRoot(options.dshHome, platformId)
  const context = { home, dshHome, env, platform: platformId }

  return {
    browser: browserId,
    platform: platformId,
    label: entry.label,
    extensionsUrl: entry.extensionsUrl,
    userDataDir: expandPath(table.userDataDir, context),
    nativeMessagingHostsDir: expandPath(table.nativeMessagingHostsDir, context),
    executableCandidates: table.executables.map((candidate) => expandPath(candidate, context)),
    registryKey: table.registryKey ?? null,
    nativeMessagingMode: platformId === 'win' ? 'registry' : 'directory',
  }
}
