/**
 * Update state file location and atomic-ish persistence (Q29): the cache
 * directory, update.json and native host path, plus load/save. Paths, JSON
 * shape and file modes are unchanged.
 */
import fs from 'node:fs'
import path from 'node:path'

function cacheDir(home) {
  return path.join(home, 'cache', 'dsh-chrome')
}

function statePath(home) {
  return path.join(cacheDir(home), 'update.json')
}

function hostPath(home) {
  return path.join(cacheDir(home), 'host', 'dsh-chrome-host.exe')
}

function loadState(home, defaults, currentVersion) {
  let state = { ...defaults }
  try {
    const saved = JSON.parse(fs.readFileSync(statePath(home), 'utf8'))
    if (saved && typeof saved === 'object') state = { ...state, ...saved, current: currentVersion }
  } catch {
    // no state yet
  }
  return state
}

function saveState(home, state, logger) {
  try {
    fs.mkdirSync(cacheDir(home), { recursive: true, mode: 0o700 })
    fs.writeFileSync(statePath(home), `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
  } catch (error) {
    logger?.warn?.('dsh-chrome: update state write failed: %s', error?.message || String(error))
  }
}

export { cacheDir, statePath, hostPath, loadState, saveState }
