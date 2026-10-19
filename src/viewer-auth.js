/**
 * Viewer authentication, routing and HTTP helpers for the per-context viewer
 * (Q28). The viewer token, per-run access capability, loopback check and route
 * parsing live here so context-viewer.js only orchestrates registration and
 * requests. Token/access/loopback semantics are unchanged.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ROUTE_PREFIX = '/dsh-chrome/context'
const MAX_TOKEN_LENGTH = 256
const MAX_CONTEXT_ID_LENGTH = 128
const CONTEXT_ID_PATTERN = /^[A-Za-z0-9._-]+$/
const TOKEN_PATTERN = /^[A-Za-z0-9._~-]+$/

class ViewerError extends Error {
  constructor(status, code, message, headers = null) {
    super(message)
    this.name = 'ViewerError'
    this.status = status
    this.code = code
    this.headers = headers
  }
}

function defaultHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

function tokenPath(home) {
  return path.join(home || defaultHome(), 'cache', 'dsh-chrome', 'context-viewer-token')
}

function normalizeToken(value) {
  if (typeof value !== 'string') return null
  const token = value.trim()
  if (token.length < 8 || token.length > MAX_TOKEN_LENGTH) return null
  return TOKEN_PATTERN.test(token) ? token : null
}

/**
 * Reuse the token written by an earlier registration, or create a new random
 * one. The file is the only persistence; nothing is stored in configuration.
 */
function readOrCreateToken(home) {
  const file = tokenPath(home)
  try {
    const existing = fs.readFileSync(file, 'utf8').trim()
    if (normalizeToken(existing)) return existing
  } catch {
    // create below
  }
  const token = crypto.randomBytes(24).toString('hex')
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    fs.writeFileSync(file, `${token}\n`, { mode: 0o600 })
    fs.chmodSync(file, 0o600)
  } catch {
    // token stays in memory even if the file cannot be written
  }
  return token
}

function readOrigin(webServer) {
  try {
    return typeof webServer.getOrigin === 'function' ? webServer.getOrigin() : null
  } catch {
    return null
  }
}

function isLoopback(req) {
  const address = req?.socket?.remoteAddress || ''
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

function parseUrl(reqUrl) {
  try {
    const parsed = new URL(String(reqUrl || '/'), 'http://127.0.0.1')
    return {
      pathname: parsed.pathname,
      token: parsed.searchParams.get('token') || '',
      access: parsed.searchParams.get('access') || '',
      searchParams: parsed.searchParams,
    }
  } catch {
    return null
  }
}

function tokenMatches(supplied, expected) {
  const a = Buffer.from(String(supplied || ''))
  const b = Buffer.from(String(expected || ''))
  return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b)
}

/**
 * Per-run capability for one context. `urlFor` is the only issuer: the map is
 * created fresh on each registration, so a capability never survives a provider
 * reload and is never shared between contexts.
 */
function accessFor(state, contextId) {
  let access = state.access.get(contextId)
  if (!access) {
    access = crypto.randomBytes(24).toString('hex')
    state.access.set(contextId, access)
  }
  return access
}

function requireAccess(state, contextId, supplied) {
  const expected = state.access.get(contextId)
  if (!expected || !tokenMatches(supplied, expected)) {
    throw new ViewerError(403, 'INVALID_ACCESS', 'invalid or missing viewer access capability')
  }
}

function contextIdFromPath(rawId) {
  let decoded
  try {
    decoded = decodeURIComponent(rawId)
  } catch {
    return null
  }
  if (!decoded || decoded.length > MAX_CONTEXT_ID_LENGTH) return null
  return CONTEXT_ID_PATTERN.test(decoded) ? decoded : null
}

/** Resolve `/dsh-chrome/context/<id>/<action>` under the registered prefix. */
function parseRoute(pathname) {
  if (!pathname.startsWith(`${ROUTE_PREFIX}/`)) return null
  const rest = pathname.slice(ROUTE_PREFIX.length + 1)
  const slash = rest.indexOf('/')
  if (slash <= 0) return null
  const contextId = contextIdFromPath(rest.slice(0, slash))
  if (!contextId) return null
  const action = rest.slice(slash + 1)
  if (action !== 'view' && action !== 'frame' && action !== 'input') return null
  return { contextId, action }
}

function plain(res, status, body, headers = null) {
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...(headers || {}),
  })
  res.end(body)
}

function sendJson(res, status, value) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(JSON.stringify(value))
}

function methodNotAllowed(allowed) {
  return new ViewerError(405, 'METHOD_NOT_ALLOWED', `method not allowed; use ${allowed}`, { allow: allowed })
}

function badRequest(code, message) {
  return new ViewerError(400, code, message)
}

export {
  ROUTE_PREFIX,
  MAX_CONTEXT_ID_LENGTH,
  CONTEXT_ID_PATTERN,
  ViewerError,
  defaultHome,
  tokenPath,
  normalizeToken,
  readOrCreateToken,
  readOrigin,
  isLoopback,
  parseUrl,
  tokenMatches,
  accessFor,
  requireAccess,
  contextIdFromPath,
  parseRoute,
  plain,
  sendJson,
  methodNotAllowed,
  badRequest,
}
