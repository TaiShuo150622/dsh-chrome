/**
 * Local handoff for loopback viewer URLs (H3).
 *
 * Viewer URLs carry a bearer token (and the context viewer also carries a
 * per-context `access` capability). The model must never receive those URLs
 * through a tool result, render block or operation-log line. Instead the tool
 * writes the URL to a 0600 file under the provider cache and returns only that
 * local path plus a hint; a human can open the file and paste the URL.
 *
 * Rename-over-write keeps a planted symlink from redirecting the secret: the
 * rename replaces the directory entry instead of following it.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export const VIEWER_HANDOFF_DIR = ['cache', 'dsh-chrome', 'viewer']

function safeName(name) {
  const value = String(name ?? '')
  return /^[a-z0-9][a-z0-9._-]{0,80}$/i.test(value) ? value : null
}

export function viewerHandoffDir(home) {
  return path.join(String(home), ...VIEWER_HANDOFF_DIR)
}

/**
 * Write `url` to `<home>/cache/dsh-chrome/viewer/<name>.url` (0600) and return
 * the absolute path. The URL itself is never part of the return value.
 */
export function writeViewerUrlFile(home, name, url) {
  const safe = safeName(name)
  if (!safe) throw new Error('invalid viewer handoff name')
  if (typeof url !== 'string' || !url) throw new Error('viewer URL is empty')
  const directory = viewerHandoffDir(home)
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  try {
    fs.chmodSync(directory, 0o700)
  } catch {
    // Existing cache directories may be owned by an older install.
  }
  const file = path.join(directory, `${safe}.url`)
  const temporary = path.join(directory, `.${safe}-${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`)
  fs.writeFileSync(temporary, `${url}\n`, { mode: 0o600 })
  try {
    fs.chmodSync(temporary, 0o600)
  } catch {
    // The mode passed to writeFileSync already restricts the new file.
  }
  try {
    fs.renameSync(temporary, file)
  } catch (error) {
    // Windows cannot always rename over an existing file; unlink removes the
    // directory entry (a symlink itself, never its target) and retries.
    if (error?.code !== 'EEXIST' && error?.code !== 'EPERM') throw error
    try {
      fs.unlinkSync(file)
    } catch {
      // best effort; the retry reports the real failure
    }
    fs.renameSync(temporary, file)
  }
  try {
    fs.chmodSync(file, 0o600)
  } catch {
    // Best effort on filesystems that ignore chmod.
  }
  return file
}

/** A model-safe description: the local path, never the bearer URL. */
export function viewerOpenHint(file, label = 'viewer') {
  return `The ${label} URL is stored locally at ${file}; open that file and use its URL in a local browser. The bearer URL is intentionally not returned to the model.`
}
