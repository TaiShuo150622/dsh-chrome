#!/usr/bin/env node
/**
 * Local diagnostic: provider bridge, native host, extension manifest versions.
 * No network, no Chrome API — reads the same files the plugin uses.
 *
 * Usage: npm run status
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const cacheDir = path.join(home, 'cache', 'dsh-chrome')
const bridgePath = path.join(cacheDir, 'bridge.json')
const hostLogPath = path.join(cacheDir, 'host.log')
const devPath = path.join(cacheDir, 'dev.json')
const nativeManifestPath =
  process.platform === 'darwin'
    ? path.join(
        os.homedir(),
        'Library',
        'Application Support',
        'Google',
        'Chrome',
        'NativeMessagingHosts',
        'com.deepseek.dsh.chrome.json',
      )
    : path.join(cacheDir, 'native-messaging-hosts', 'com.deepseek.dsh.chrome.json')

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function processAlive(pid) {
  if (!Number.isFinite(pid)) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const bridge = readJson(bridgePath)
const dev = readJson(devPath)
const extensionManifest = readJson(path.join(root, 'extension', 'manifest.json'))

const report = {
  repo: root,
  extension: {
    manifestVersion: extensionManifest?.version ?? null,
    dir: path.join(root, 'extension'),
  },
  provider: {
    discovery: bridgePath,
    discoveryPresent: Boolean(bridge),
    pid: bridge?.pid ?? null,
    pidAlive: processAlive(bridge?.pid),
    socketPath: bridge?.socketPath ?? null,
    socketPresent: bridge ? fs.existsSync(bridge.socketPath) : false,
    startedAt: bridge?.startedAt ? new Date(bridge.startedAt).toISOString() : null,
  },
  nativeHost: {
    manifestPath: nativeManifestPath,
    manifestPresent: fs.existsSync(nativeManifestPath),
    devConfig: dev ?? null,
    logTail: [],
  },
}

try {
  const lines = fs.readFileSync(hostLogPath, 'utf8').trim().split('\n')
  report.nativeHost.logTail = lines.slice(-8)
} catch {
  report.nativeHost.logTail = []
}

console.log(JSON.stringify(report, null, 2))
