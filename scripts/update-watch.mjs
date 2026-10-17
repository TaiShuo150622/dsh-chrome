#!/usr/bin/env node
/**
 * Observe extension auto-update state: disk version, watcher status, last
 * change/reload timestamps and the host update log. Polls every 2s.
 *
 * Usage: npm run watch:update
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const cacheDir = path.join(home, 'cache', 'dsh-chrome')
const updateStatePath = path.join(cacheDir, 'update-state.json')
const updateLogPath = path.join(cacheDir, 'update.log')
const manifestPath = path.resolve(import.meta.dirname, '..', 'extension', 'manifest.json')

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function tail(file, count) {
  try {
    return fs.readFileSync(file, 'utf8').trim().split('\n').slice(-count)
  } catch {
    return []
  }
}

function snapshot() {
  const manifest = readJson(manifestPath)
  const state = readJson(updateStatePath) || {}
  return {
    diskVersion: manifest?.version ?? 'unknown',
    watcher: state.watching ? 'on' : 'off',
    lastCheckedAt: state.lastCheckedAt ?? '-',
    lastChangeAt: state.lastChangeAt ?? '-',
    lastReloadRequestedAt: state.lastReloadRequestedAt ?? '-',
    updateLogTail: tail(updateLogPath, 3).join(' | '),
  }
}

let last = JSON.stringify(snapshot())
console.log(`[${new Date().toLocaleTimeString()}] watching ${cacheDir}`)
console.log(JSON.stringify(snapshot(), null, 2))
setInterval(() => {
  const current = snapshot()
  const serialized = JSON.stringify(current)
  if (serialized === last) return
  last = serialized
  console.log(`[${new Date().toLocaleTimeString()}] update state changed`)
  console.log(JSON.stringify(current, null, 2))
}, 2000)
