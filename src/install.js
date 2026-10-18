/**
 * Installation assets for the desktop-extension backend:
 * - copy host.mjs and generate a platform launcher that runs it with the DSH
 *   app's own Electron-as-Node binary (no system Node requirement);
 * - write the native messaging host manifest for the selected browser/platform
 *   (macOS / Linux: a well-known per-browser directory; Windows: a DSH-owned
 *   file plus a manual registry registration, which is only printed here and
 *   never applied — see docs/INSTALL-PLATFORM.md);
 * - derive the pinned extension id from the extension manifest key;
 * - write INSTALL.md next to the discovery file.
 *
 * Browser/platform paths live in src/platform.js. macOS Chrome keeps writing
 * exactly the paths it wrote before this module was table-driven.
 */
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'

import { browserPaths, getPlatform } from './platform.js'

export const HOST_NAME = 'com.deepseek.dsh.chrome'

const PLATFORM_LABELS = Object.freeze({ mac: 'macOS', linux: 'Linux', win: 'Windows' })

export function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

/**
 * Native messaging manifest directory for a browser/platform.
 * Kept as a compatibility helper; new code should call `browserPaths()` from
 * `src/platform.js` directly when it needs more than the directory.
 */
export function chromeNativeHostsDir(browser = 'chrome', platform = process.platform, options = {}) {
  return browserPaths(browser, platform, options).nativeMessagingHostsDir
}

/** Chrome extension ids are the first 32 hex chars of SHA-256(public key DER), mapped 0-f -> a-p. */
export function extensionIdFromKey(keyBase64) {
  const der = Buffer.from(String(keyBase64 || ''), 'base64')
  if (der.length === 0) throw new Error('extension manifest key is missing')
  const hash = createHash('sha256').update(der).digest('hex').slice(0, 32)
  return [...hash].map((char) => String.fromCharCode(97 + Number.parseInt(char, 16))).join('')
}

function posixLauncherScript({ nodePath }) {
  return `#!/bin/sh
set -e
dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
host="$dir/host.mjs"
# 1) Chrome launched from a DSH-managed shell
if [ -n "\${DSH_DESKTOP_NODE_EXECUTABLE:-}" ]; then
  exec env ELECTRON_RUN_AS_NODE=1 "$DSH_DESKTOP_NODE_EXECUTABLE" --expose-internals "$host"
fi
# 2) The DSH app binary captured at installation time (Electron runs as Node)
if [ -x ${JSON.stringify(nodePath)} ]; then
  exec env ELECTRON_RUN_AS_NODE=1 ${JSON.stringify(nodePath)} --expose-internals "$host"
fi
# 3) A developer node on PATH
node_path=$(command -v node || true)
if [ -n "$node_path" ]; then
  exec "$node_path" "$host"
fi
echo "dsh-chrome-host: no Node/Electron executable found" >&2
exit 1
`
}

function batchQuote(value) {
  return `"${String(value).replace(/%/g, '%%')}"`
}

/** Quote for a command line printed in INSTALL.md (pasted into cmd.exe/PowerShell). */
function commandQuote(value) {
  return `"${String(value)}"`
}

/**
 * Windows launcher scaffold. Chrome on Windows expects the manifest `path` to
 * be an executable; a `.cmd` is the cheapest thing that keeps the manifest
 * writable without a build step, but it has not been verified on a real
 * Windows box and may need to be replaced by a small `.exe` wrapper before
 * release. See docs/INSTALL-PLATFORM.md ("当前限制").
 */
function windowsLauncherScript({ nodePath }) {
  const lines = [
    '@echo off',
    'rem DSH Desktop Chrome native host launcher (Windows scaffold).',
    'setlocal',
    'set "DIR=%~dp0"',
    'if defined DSH_DESKTOP_NODE_EXECUTABLE goto use_dsh_node',
    `if exist ${batchQuote(nodePath)} goto use_captured_node`,
    'where node >nul 2>nul',
    'if not errorlevel 1 goto use_path_node',
    'echo dsh-chrome-host: no Node/Electron executable found 1>&2',
    'exit /b 1',
    '',
    ':use_dsh_node',
    'set "ELECTRON_RUN_AS_NODE=1"',
    '"%DSH_DESKTOP_NODE_EXECUTABLE%" --expose-internals "%DIR%host.mjs"',
    'exit /b %ERRORLEVEL%',
    '',
    ':use_captured_node',
    'set "ELECTRON_RUN_AS_NODE=1"',
    `${batchQuote(nodePath)} --expose-internals "%DIR%host.mjs"`,
    'exit /b %ERRORLEVEL%',
    '',
    ':use_path_node',
    'node "%DIR%host.mjs"',
    'exit /b %ERRORLEVEL%',
  ]
  return `${lines.join('\r\n')}\r\n`
}

/**
 * Windows has no NativeMessagingHosts directory convention: the browser reads
 * `HKCU\Software\<vendor>\<browser>\NativeMessagingHosts\<host name>` and uses
 * its default value as the arbitrary path to the manifest. We report the
 * registration instead of writing it (never mutates the registry).
 */
function windowsRegistration(platform, paths, manifestPath) {
  if (platform !== 'win') return null
  const key = `${paths.registryKey}\\${HOST_NAME}`
  return {
    type: 'registry',
    hive: 'HKCU',
    key,
    value: manifestPath,
    command: `reg add ${commandQuote(key)} /ve /d ${commandQuote(manifestPath)} /f`,
    query: `reg query ${commandQuote(key)} /ve`,
    applied: false,
  }
}

function installInstructions({
  platform,
  browserLabel,
  extensionsUrl,
  extensionDir,
  extensionId,
  nativeManifestPath,
  launcherPath,
  cacheDir,
  registration,
}) {
  const detailLines = [
    `- 平台 / 浏览器: ${PLATFORM_LABELS[platform]} / ${browserLabel}`,
    `- 扩展 ID: ${extensionId}`,
    `- 扩展目录: ${extensionDir}`,
    `- native messaging manifest: ${nativeManifestPath}`,
    `- native host launcher: ${launcherPath}`,
    `- 桥接 discovery: ${path.join(cacheDir, 'bridge.json')}`,
    `- host 日志: ${path.join(cacheDir, 'host.log')}`,
  ]
  if (registration) detailLines.push(`- Windows 注册表键（未自动写入）: ${registration.key}`)

  const steps = [
    `1. 打开 ${extensionsUrl}`,
    '2. 右上角打开「开发者模式」',
    '3. 点「加载已解压的扩展程序」，选择：',
    `   ${extensionDir}`,
  ]
  if (platform === 'win') {
    steps.push(
      '4. 注册 native host（仅当前用户，无需管理员；provider 不会自动执行这一步）：',
      `   ${registration.command}`,
      `   校验：${registration.query}`,
      `5. **完全退出 ${browserLabel} 再打开**（Windows 上浏览器只在启动时解析注册表与 manifest）`,
      '6. 点浏览器工具栏的 DSH Chrome 图标，应显示 Connected',
    )
  } else if (platform === 'linux') {
    steps.push(
      `4. **完全退出 ${browserLabel} 再打开**（Linux 上 NativeMessagingHosts manifest 也只在启动时读取）`,
      '5. 点浏览器工具栏的 DSH Chrome 图标，应显示 Connected',
    )
  } else {
    steps.push(
      `4. **完全退出 ${browserLabel}（⌘Q）再打开**（浏览器只在启动时读取 native messaging manifest）`,
      '5. 点浏览器工具栏的 DSH Chrome 图标，应显示 Connected',
    )
  }

  const notes = []
  if (platform === 'win') {
    notes.push(
      '- Windows 上浏览器不读固定的 NativeMessagingHosts 目录：manifest 可以放在任意位置，注册表默认值指向它即可。',
      '- 当前 launcher 是 `.cmd` 脚手架（未真机验证；Chrome 通常要求真正的 `.exe`），正式发布前需要替换。',
    )
  }
  if (platform === 'linux') {
    notes.push('- 若 manifest 是在浏览器启动后才写入的，完全退出并重新打开浏览器即可。')
  }

  return `# DSH Desktop Chrome — 安装（${PLATFORM_LABELS[platform]} / ${browserLabel}）

${steps.join('\n')}

${detailLines.join('\n')}
${notes.length > 0 ? `\n${notes.join('\n')}\n` : ''}`
}

/**
 * Write launcher, native messaging manifest and INSTALL.md for the selected
 * browser/platform. Signature is backward compatible: the original call site
 * is `ensureInstallAssets({ root, logger })`.
 *
 * Optional injections (tests / future config):
 *   platform   platform id or process.platform value (default: current host)
 *   browser    chrome | edge | brave | chromium (default: DSH_CHROME_BROWSER or chrome)
 *   home       replaces os.homedir() (also implies dshHome = <home>/.dsh unless given)
 *   dshHome    replaces the DSH data directory
 *   env        replaces process.env for %VAR% expansion in the Windows table
 *   fs         node:fs/promises-compatible implementation (default: the real
 *              fs; used by tests so fake Windows paths never touch this disk)
 */
export async function ensureInstallAssets({
  root,
  logger,
  platform = process.platform,
  browser = process.env.DSH_CHROME_BROWSER || 'chrome',
  home,
  dshHome: dshHomeOverride,
  env,
  fs: fsImpl = fsp,
} = {}) {
  if (!root) throw new Error('ensureInstallAssets requires { root }')
  const platformId = getPlatform(platform)
  const homeDir = home ?? os.homedir()
  // A faked `home` also sandboxes the DSH data dir so tests never touch the
  // real ~/.dsh; real installs keep honoring DSH_HOME.
  const dataDir = dshHomeOverride ?? (home == null ? dshHome() : path.join(homeDir, '.dsh'))
  const paths = browserPaths(browser, platformId, { home: homeDir, dshHome: dataDir, env })

  const cacheDir = path.join(dataDir, 'cache', 'dsh-chrome')
  const hostDir = path.join(cacheDir, 'host')
  await fsImpl.mkdir(hostDir, { recursive: true, mode: 0o700 })

  const extensionDir = path.join(root, 'extension')
  const manifest = JSON.parse(await fsImpl.readFile(path.join(extensionDir, 'manifest.json'), 'utf8'))
  const extensionId = extensionIdFromKey(manifest.key)

  const hostSource = path.join(root, 'host', 'host.mjs')
  const hostTarget = path.join(hostDir, 'host.mjs')
  await fsImpl.copyFile(hostSource, hostTarget)

  const isWindows = platformId === 'win'
  const launcherPath = path.join(hostDir, isWindows ? 'dsh-chrome-host.cmd' : 'dsh-chrome-host')
  const launcher = isWindows
    ? windowsLauncherScript({ nodePath: process.execPath })
    : posixLauncherScript({ nodePath: process.execPath })
  await fsImpl.writeFile(launcherPath, launcher, { mode: isWindows ? 0o644 : 0o755 })
  if (!isWindows) await fsImpl.chmod(launcherPath, 0o755)

  const nativeManifestPath = path.join(paths.nativeMessagingHostsDir, `${HOST_NAME}.json`)
  await fsImpl.mkdir(paths.nativeMessagingHostsDir, { recursive: true })
  await fsImpl.writeFile(
    nativeManifestPath,
    `${JSON.stringify(
      {
        name: HOST_NAME,
        description: 'DSH Desktop Chrome native host',
        path: launcherPath,
        type: 'stdio',
        allowed_origins: [`chrome-extension://${extensionId}/`],
      },
      null,
      2,
    )}\n`,
    { mode: 0o644 },
  )

  const registration = windowsRegistration(platformId, paths, nativeManifestPath)
  if (registration) {
    logger?.warn?.(
      'dsh-chrome: Windows native host registration is manual (not applied): %s',
      registration.command,
    )
  } else {
    logger?.info?.(
      'dsh-chrome: native messaging manifest for %s written at %s',
      paths.label,
      nativeManifestPath,
    )
  }

  const instructions = installInstructions({
    platform: platformId,
    browserLabel: paths.label,
    extensionsUrl: paths.extensionsUrl,
    extensionDir,
    extensionId,
    nativeManifestPath,
    launcherPath,
    cacheDir,
    registration,
  })
  const instructionsPath = path.join(cacheDir, 'INSTALL.md')
  await fsImpl.writeFile(instructionsPath, instructions, { mode: 0o600 })

  // Development convenience: the native host watches the extension directory
  // and asks the browser to reload the unpacked extension when files change.
  // Release installs should not write this file.
  const devConfigPath = path.join(cacheDir, 'dev.json')
  await fsImpl.writeFile(
    devConfigPath,
    `${JSON.stringify({ watch: true, extensionDir }, null, 2)}\n`,
    { mode: 0o600 },
  )

  logger?.info?.('dsh-chrome: extension dir %s (id %s)', extensionDir, extensionId)
  return {
    extensionId,
    extensionDir,
    nativeManifestPath,
    launcherPath,
    hostDir,
    instructionsPath,
    chromeNativeHostsDir: paths.nativeMessagingHostsDir,
    cacheDir,
    platform: platformId,
    browser: paths.browser,
    browserLabel: paths.label,
    extensionsUrl: paths.extensionsUrl,
    nativeMessagingMode: paths.nativeMessagingMode,
    registryKey: paths.registryKey,
    registration,
    executableCandidates: paths.executableCandidates,
  }
}
