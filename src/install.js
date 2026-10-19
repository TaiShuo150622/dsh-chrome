/**
 * Installation assets for the desktop-extension backend:
 * - copy host.mjs and generate a platform launcher that runs it with the DSH
 *   app's own Electron-as-Node binary (no system Node requirement); on Windows
 *   prefer the packaged Node SEA `dsh-chrome-host.exe` when present, because
 *   Chrome cannot CreateProcess a `.cmd` native host (see docs/WINDOWS-HOST.md);
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
import { execFileSync } from 'node:child_process'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'

import { browserPaths, getPlatform } from './platform.js'

export const HOST_NAME = 'com.deepseek.dsh.chrome'

/**
 * Name of the single-file Windows native host built by
 * `scripts/build-windows-host.mjs` (Node SEA with host/host.mjs embedded).
 * Chrome on Windows can only launch an executable, so this is what the native
 * messaging manifest must point at; `.cmd` is a development-only fallback.
 */
export const WINDOWS_HOST_EXE_NAME = 'dsh-chrome-host.exe'

const PLATFORM_LABELS = Object.freeze({ mac: 'macOS', linux: 'Linux', win: 'Windows' })

/**
 * Where a packaged Windows `host.exe` may live, in preference order:
 *
 *   1. `DSH_CHROME_HOST_EXE` (explicit override / custom release layout)
 *   2. `host/bin/win32-<arch>/dsh-chrome-host.exe` — the shipped layout
 *      (`package.json` `files` already includes the whole `host/` tree)
 *   3. `dist/windows-host/win32-<arch>/dsh-chrome-host.exe` — optional local
 *      build dir (`--out dist/windows-host/...`; `dist/` is gitignored)
 *   4. `host/host.exe` — ad-hoc copy used during bring-up
 *
 * `ensureInstallAssets()` returns `[]` for macOS/Linux and never looks here.
 */
export function windowsHostExeCandidates({ root, arch = process.arch, env = process.env } = {}) {
  if (!root) throw new Error('windowsHostExeCandidates requires { root }')
  const binName = `win32-${arch}`
  const candidates = [
    env?.DSH_CHROME_HOST_EXE,
    path.join(root, 'host', 'bin', binName, WINDOWS_HOST_EXE_NAME),
    path.join(root, 'dist', 'windows-host', binName, WINDOWS_HOST_EXE_NAME),
    path.join(root, 'host', 'host.exe'),
  ]
  return candidates.filter((candidate) => typeof candidate === 'string' && candidate.length > 0)
}

async function firstExistingPath(fsImpl, candidates) {
  // Test fakes (test/install-platform.mjs) do not implement access(): treat
  // that as "no packaged host.exe" and keep the historical .cmd scaffold.
  if (typeof fsImpl?.access !== 'function') return null
  for (const candidate of candidates) {
    try {
      await fsImpl.access(candidate)
      return candidate
    } catch {
      // keep looking
    }
  }
  return null
}

async function statFile(fsImpl, file) {
  if (typeof fsImpl?.stat !== 'function') return null
  try {
    const stat = await fsImpl.stat(file)
    return stat?.isFile?.() ? stat : null
  } catch {
    return null
  }
}

/**
 * Copy the SEA exe into the DSH cache.
 *
 * Windows keeps the executable image locked while the native host is running,
 * so a plain `copyFile` fails with EBUSY/EPERM when DSH restarts (or reloads
 * the provider) while Chrome still has a host process. Keep the already
 * installed exe in that case and warn: the next browser exit releases the lock
 * and a later DSH start installs the new build. A failed copy never truncates
 * the destination (the open itself is denied), so the old exe stays runnable.
 */
async function installWindowsHostExe(fsImpl, source, target, logger) {
  const targetStat = await statFile(fsImpl, target)
  try {
    await fsImpl.copyFile(source, target)
    return { copied: true, reason: 'installed' }
  } catch (error) {
    if (targetStat) {
      logger?.warn?.(
        'dsh-chrome: cannot replace the running Windows host.exe (%s); keeping the installed copy. Fully exit the browser and restart DSH to install the new build.',
        error?.message || error,
      )
      return { copied: false, reason: 'locked', error }
    }
    throw error
  }
}

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
 * Development-only Windows fallback launcher. Chrome on Windows expects the
 * manifest `path` to be an executable and cannot CreateProcess a `.cmd`; this
 * file only exists so a source checkout can install *something* without a
 * build step. Release installs must ship `dsh-chrome-host.exe` (Node SEA) and
 * `ensureInstallAssets()` points the manifest at it — see docs/WINDOWS-HOST.md.
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
 * its default value as the arbitrary path to the manifest. The provider writes
 * the HKCU value on Windows so a fresh install can connect without a manual
 * `reg add`; failures are reported and the manual command is still emitted.
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
  launcherKind,
  cacheDir,
  registration,
}) {
  const detailLines = [
    `- 平台 / 浏览器: ${PLATFORM_LABELS[platform]} / ${browserLabel}`,
    `- 扩展 ID: ${extensionId}`,
    `- 扩展目录: ${extensionDir}`,
    `- native messaging manifest: ${nativeManifestPath}`,
    `- native host launcher (${launcherKind}): ${launcherPath}`,
    `- 桥接 discovery: ${path.join(cacheDir, 'bridge.json')}`,
    `- host 日志: ${path.join(cacheDir, 'host.log')}`,
  ]
  if (registration) detailLines.push(`- Windows 注册表键（${registration.applied ? '已自动写入' : '未自动写入'}）: ${registration.key}`)

  const steps = [
    `1. 打开 ${extensionsUrl}`,
    '2. 右上角打开「开发者模式」',
    '3. 点「加载已解压的扩展程序」，选择：',
    `   ${extensionDir}`,
  ]
  if (platform === 'win') {
    steps.push(
      registration.applied
        ? '4. native host 已自动注册（仅当前用户，无需管理员）。如果仍失败，手动执行：'
        : '4. 注册 native host（仅当前用户，无需管理员）：',
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
    )
    if (launcherKind === 'exe') {
      notes.push(
        '- manifest 的 `path` 指向 Node SEA 单文件 `dsh-chrome-host.exe`（内嵌 host.mjs）；浏览器直接启动它，用户无需安装 Node。',
      )
    } else {
      notes.push(
        '- 未找到预编译的 `dsh-chrome-host.exe`，当前 manifest 指向 `.cmd` 脚手架。Chrome 在 Windows 上通常无法直接启动 `.cmd`；正式使用前请构建并随包分发 host.exe（见 docs/WINDOWS-HOST.md）。',
      )
    }
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

  const isWindows = platformId === 'win'
  const hostExeCandidates = isWindows ? windowsHostExeCandidates({ root, env }) : []
  const hostExeSource = isWindows ? await firstExistingPath(fsImpl, hostExeCandidates) : null

  const hostSource = path.join(root, 'host', 'host.mjs')
  const hostTarget = path.join(hostDir, 'host.mjs')

  let launcherPath
  let launcherKind
  if (hostExeSource) {
    // Windows release path: a Node SEA executable with host.mjs embedded.
    // Chrome launches it through CreateProcess; no Node/Electron on the box.
    launcherPath = path.join(hostDir, WINDOWS_HOST_EXE_NAME)
    const installed = await installWindowsHostExe(fsImpl, hostExeSource, launcherPath, logger)
    launcherKind = 'exe'
    if (installed.copied) {
      logger?.info?.('dsh-chrome: Windows native host executable installed at %s', launcherPath)
    }
  } else {
    // macOS/Linux unchanged; Windows keeps the historical .cmd scaffold for
    // source checkouts, with a warning because Chrome usually cannot run it.
    await fsImpl.copyFile(hostSource, hostTarget)
    launcherPath = path.join(hostDir, isWindows ? 'dsh-chrome-host.cmd' : 'dsh-chrome-host')
    launcherKind = isWindows ? 'cmd' : 'script'
    const launcher = isWindows
      ? windowsLauncherScript({ nodePath: process.execPath })
      : posixLauncherScript({ nodePath: process.execPath })
    await fsImpl.writeFile(launcherPath, launcher, { mode: isWindows ? 0o644 : 0o755 })
    if (!isWindows) await fsImpl.chmod(launcherPath, 0o755)
    if (isWindows) {
      logger?.warn?.(
        'dsh-chrome: Windows host.exe not found (looked at %s); falling back to the .cmd scaffold at %s. Chrome normally cannot launch a .cmd — run `node scripts/build-windows-host.mjs` (see docs/WINDOWS-HOST.md).',
        hostExeCandidates.join('; '),
        launcherPath,
      )
    }
  }

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
    // Easy deployment: register HKCU automatically on a real Windows host.
    // The fake-Windows tests run on darwin/linux, so they still exercise the
    // manual command/report path and never touch a real registry.
    if (process.platform === 'win32' && platformId === 'win') {
      try {
        execFileSync('reg', ['add', registration.key, '/ve', '/d', registration.value, '/f'], {
          stdio: 'ignore',
          windowsHide: true,
        })
        registration.applied = true
        logger?.info?.('dsh-chrome: Windows native host registered at %s', registration.key)
      } catch (error) {
        logger?.warn?.(
          'dsh-chrome: Windows native host registration failed (%s); run manually: %s',
          error?.message || String(error),
          registration.command,
        )
      }
    } else {
      logger?.warn?.(
        'dsh-chrome: Windows native host registration is manual (not applied): %s',
        registration.command,
      )
    }
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
    launcherKind,
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
    launcherKind,
    hostExePath: launcherKind === 'exe' ? launcherPath : null,
    hostExeCandidates,
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
