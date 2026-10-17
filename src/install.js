/**
 * Installation assets for the Chrome side:
 * - copy host.mjs and generate a launcher that runs it with the DSH app's
 *   own Electron-as-Node binary (no system Node requirement);
 * - register the Chrome native messaging host manifest for this user;
 * - derive the pinned extension id from the extension manifest key;
 * - write INSTALL.md next to the discovery file.
 */
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'

export const HOST_NAME = 'com.deepseek.dsh.chrome'

export function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

export function chromeNativeHostsDir() {
  if (process.platform === 'darwin') {
    return path.join(
      os.homedir(),
      'Library',
      'Application Support',
      'Google',
      'Chrome',
      'NativeMessagingHosts',
    )
  }
  // P0 targets macOS only; keep a predictable non-macOS location for diagnostics.
  return path.join(dshHome(), 'cache', 'dsh-chrome', 'native-messaging-hosts')
}

/** Chrome extension ids are the first 32 hex chars of SHA-256(public key DER), mapped 0-f -> a-p. */
export function extensionIdFromKey(keyBase64) {
  const der = Buffer.from(String(keyBase64 || ''), 'base64')
  if (der.length === 0) throw new Error('extension manifest key is missing')
  const hash = createHash('sha256').update(der).digest('hex').slice(0, 32)
  return [...hash].map((char) => String.fromCharCode(97 + Number.parseInt(char, 16))).join('')
}

function launcherScript({ nodePath }) {
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

export async function ensureInstallAssets({ root, logger }) {
  const home = dshHome()
  const cacheDir = path.join(home, 'cache', 'dsh-chrome')
  const hostDir = path.join(cacheDir, 'host')
  await fsp.mkdir(hostDir, { recursive: true, mode: 0o700 })

  const extensionDir = path.join(root, 'extension')
  const manifest = JSON.parse(await fsp.readFile(path.join(extensionDir, 'manifest.json'), 'utf8'))
  const extensionId = extensionIdFromKey(manifest.key)

  const hostSource = path.join(root, 'host', 'host.mjs')
  const hostTarget = path.join(hostDir, 'host.mjs')
  await fsp.copyFile(hostSource, hostTarget)

  const launcherPath = path.join(hostDir, 'dsh-chrome-host')
  await fsp.writeFile(launcherPath, launcherScript({ nodePath: process.execPath }), { mode: 0o755 })
  await fsp.chmod(launcherPath, 0o755)

  const nativeManifestPath = path.join(chromeNativeHostsDir(), `${HOST_NAME}.json`)
  await fsp.mkdir(path.dirname(nativeManifestPath), { recursive: true })
  await fsp.writeFile(
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

  const instructions = `# DSH Desktop Chrome — 安装（P0，macOS）

1. 打开 chrome://extensions
2. 右上角打开「开发者模式」
3. 点「加载已解压的扩展程序」，选择：
   ${extensionDir}
4. **完全退出 Chrome（⌘Q）再打开**（Chrome 启动时读取下面的 native messaging manifest）
5. 点浏览器工具栏的 DSH Chrome 图标，应显示 Connected

- 扩展 ID: ${extensionId}
- native messaging manifest: ${nativeManifestPath}
- native host launcher: ${launcherPath}
- 桥接 discovery: ${path.join(cacheDir, 'bridge.json')}
- host 日志: ${path.join(cacheDir, 'host.log')}
`
  const instructionsPath = path.join(cacheDir, 'INSTALL.md')
  await fsp.writeFile(instructionsPath, instructions, { mode: 0o600 })

  logger?.info?.('dsh-chrome: extension dir %s (id %s)', extensionDir, extensionId)
  return {
    extensionId,
    extensionDir,
    nativeManifestPath,
    launcherPath,
    hostDir,
    instructionsPath,
    chromeNativeHostsDir: chromeNativeHostsDir(),
    cacheDir,
  }
}
