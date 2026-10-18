/**
 * Bounded operation log for chrome_* tool calls.
 *
 * Every registered chrome tool is wrapped once (after backend routing, before
 * ctx.tools.register) and appends one JSON line per execution to:
 *
 *   ~/.dsh/cache/dsh-chrome/operations.jsonl   (mode 0600)
 *
 * Design constraints, in order:
 *  - never change tool behavior or output: logging is best-effort in a
 *    `finally` block and appendOperation() never throws;
 *  - bounded disk: one line <= 2048 bytes, active file rotates to `.1` at the
 *    size limit (default 4 MiB, DSH_OPERATION_LOG_MAX_BYTES overrides);
 *  - no secrets / page bodies: arguments are key-redacted, URLs lose userinfo
 *    and secret query values, long strings are truncated, HTML/body/base64
 *    content is reduced to a length, and results are summarized through a
 *    strict field allowlist (never raw page text or screenshot data).
 *
 * The log is for audit/replay of *what happened*, not content replay.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const OPERATION_LOG_FILE = 'operations.jsonl'
export const DEFAULT_MAX_BYTES = 4 * 1024 * 1024

// A line (JSON + newline) never exceeds this. Kept small so the log stays
// cheap to append and to read back.
export const MAX_RECORD_BYTES = 2048

export const OPERATION_RECORD_FIELDS = Object.freeze([
  'v',
  'startedAt',
  'tool',
  'backend',
  'durationMs',
  'ok',
  'errorCode',
  'args',
  'result',
  'truncated',
])

const VERSION = 1
const REDACTED = '«redacted»'
const TRUNCATED_MARKER = '_truncated'

const MAX_TOOL_CHARS = 80
const MAX_ERROR_CODE_CHARS = 64
const MAX_ARGS_BYTES = 800
const MAX_RESULT_BYTES = 400
const STRING_CHARS = 160
const URL_CHARS = 400
const TITLE_CHARS = 120
const TOKEN_CHARS = 40
const ID_CHARS = 80
const URL_VALUE_CHARS = 80
const MAX_DEPTH = 2
const ARRAY_ITEMS = 6
const MAX_KEYS_BY_DEPTH = [16, 12, 8]
const NESTED_BUDGET_BYTES = 240

// Key names that must never carry their value into the log. `key` itself is
// deliberately not sensitive: chrome_press uses it for a keyboard key name,
// while chrome_storage values are handled via the sibling-key hint below.
const SECRET_KEY_PATTERN =
  /(pass(word|wd|phrase)?|secret|token|api[-_]?key|access[-_]?token|refresh[-_]?token|authorization|cookie|session[-_]?id|csrf|xsrf|signature|credential|private[-_]?key)/i
const SECRET_EXACT_KEYS = new Set(['auth', 'pwd', 'otp', 'cvv'])
const STORAGE_HINT_KEYS = ['key', 'name', 'field', 'storageKey', 'storage_key']
const STORAGE_VALUE_KEYS = new Set(['value', 'values'])

const CONTENT_KEY_PATTERN =
  /^(html|body|content|pagecontent|htmlcontent|data|database64|base64|image|imagedata|screenshot|responsebody|requestbody)$/i

const QUERY_SECRET_EXACT = new Set([
  'auth',
  'authorization',
  'key',
  'api_key',
  'apikey',
  'access_token',
  'refresh_token',
  'id_token',
  'token',
  'secret',
  'client_secret',
  'password',
  'pass',
  'passwd',
  'pwd',
  'passphrase',
  'session',
  'sessionid',
  'session_id',
  'sid',
  'csrf',
  'xsrf',
  'signature',
  'sig',
  'credential',
  'credentials',
  'cookie',
  'jwt',
  'code',
])
const QUERY_SECRET_PATTERN = /token|secret|passw|credential|signature|api[-_]?key/i

const INLINE_SECRET_PATTERN =
  /(pass(?:word|wd|phrase)?|secret|token|api[-_]?key|access[-_]?token|refresh[-_]?token|authorization|cookie|session[-_]?id|csrf|xsrf|signature|sig|credential|private[-_]?key)(["']?\s*[:=]\s*["']?)([^\s,;"'&}]{1,256})/gi
const DATA_URL_PATTERN = /^data:[^,]*;base64,/i

// Result fields are summarized through allowlists; unknown keys are ignored.
// This is the barrier that keeps page text / HTML / screenshot base64 out.
const RESULT_CONTENT_KEYS = new Set([
  'text',
  'html',
  'body',
  'content',
  'data',
  'database64',
  'base64',
  'image',
  'screenshot',
  'responsebody',
  'requestbody',
])
const RESULT_URL_KEYS = new Set(['url', 'finalurl', 'pageurl', 'href', 'origin', 'documenturl'])
const RESULT_TOKEN_KEYS = new Set([
  'backend',
  'loadstate',
  'mode',
  'status',
  'op',
  'state',
  'tag',
  'role',
  'format',
  'kind',
  'provider',
  'hostversion',
  'extensionversion',
  'providerversion',
  'diskversion',
  'extensionid',
  'captureid',
])
const RESULT_ID_KEYS = new Set(['tabid', 'ref', 'frameref', 'groupid', 'windowid', 'frameid', 'callid', 'id'])
const RESULT_NUMBER_KEYS = new Set([
  'count',
  'total',
  'remaining',
  'groupcount',
  'changedcount',
  'samecount',
  'framecount',
  'tabcount',
  'protocol',
  'width',
  'height',
  'scrollx',
  'scrolly',
  'bytes',
  'size',
  'length',
  'bytesreceived',
  'totalbytes',
])
const RESULT_BOOLEAN_KEYS = new Set([
  'ok',
  'connected',
  'supported',
  'running',
  'autoreload',
  'truncated',
  'active',
  'alreadyactive',
  'claimed',
  'visible',
  'exists',
  'changed',
  'same',
  'canceled',
  'loginopen',
  'mobile',
  'reset',
  'captured',
  'hasmore',
  'done',
])
const RESULT_LIST_KEYS = new Set([
  'tabs',
  'frames',
  'items',
  'entries',
  'files',
  'downloads',
  'requests',
  'groups',
  'removedrefs',
  'errors',
  'matches',
  'blocks',
  'logs',
  'results',
  'shots',
  'captures',
])

const WRAPPED = Symbol('dsh-chrome.operation-log.wrapped')

export function operationLogPath(home) {
  return path.join(resolveHome(home), 'cache', 'dsh-chrome', OPERATION_LOG_FILE)
}

function resolveHome(home) {
  if (typeof home === 'string' && home) return home
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

export function operationLogEnabled() {
  const raw = String(process.env.DSH_OPERATION_LOG ?? '').trim().toLowerCase()
  return raw !== '0' && raw !== 'false' && raw !== 'off'
}

export function operationLogMaxBytes() {
  const raw = Number(process.env.DSH_OPERATION_LOG_MAX_BYTES)
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_MAX_BYTES
}

function lineBytes(json) {
  return Buffer.byteLength(json, 'utf8') + 1
}

function byteLength(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

function truncate(value, maxChars) {
  const text = String(value)
  if (maxChars <= 0) return ''
  if (text.length <= maxChars) return text
  let cut = maxChars - 1
  // Do not split a surrogate pair: JSON.stringify would escape the lone half.
  const code = text.charCodeAt(cut - 1)
  if (cut > 0 && code >= 0xd800 && code <= 0xdbff) cut -= 1
  return `${text.slice(0, cut)}…`
}

function sanitizeLabel(value) {
  const text = String(value ?? 'unknown')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .trim()
  return truncate(text || 'unknown', MAX_TOOL_CHARS)
}

function normalizeErrorCode(value) {
  const text = String(value ?? '')
    .trim()
    .replace(/[^A-Za-z0-9_.:-]+/g, '_')
    .slice(0, MAX_ERROR_CODE_CHARS)
  return text || 'INTERNAL'
}

function errorCodeFrom(error) {
  if (typeof error?.code === 'string' && error.code.trim()) return normalizeErrorCode(error.code)
  if (typeof error?.name === 'string' && error.name && error.name !== 'Error') return normalizeErrorCode(error.name)
  return 'INTERNAL'
}

function toIso(value) {
  const date = value instanceof Date ? value : new Date(value ?? Date.now())
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString()
}

function toDuration(value) {
  const duration = Number(value)
  return Number.isFinite(duration) && duration >= 0 ? Math.round(duration) : 0
}

function isSensitiveKey(key) {
  const name = String(key ?? '').toLowerCase()
  if (!name) return false
  if (SECRET_EXACT_KEYS.has(name)) return true
  if (SECRET_KEY_PATTERN.test(name)) return true
  return /(^|[-_.])auth([-_.]|$)/.test(name)
}

function isSecretQueryName(name) {
  const normalized = String(name ?? '').toLowerCase()
  return QUERY_SECRET_EXACT.has(normalized) || QUERY_SECRET_PATTERN.test(normalized)
}

function maskInlineSecrets(text) {
  return String(text)
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{6,}/gi, (_match, scheme) => `${scheme} ${REDACTED}`)
    .replace(/\bsk-[A-Za-z0-9]{10,}\b/g, REDACTED)
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g, REDACTED)
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, REDACTED)
    .replace(INLINE_SECRET_PATTERN, (_match, name, separator) => `${name}${separator}${REDACTED}`)
}

function sanitizeHash(hash) {
  if (!hash) return ''
  const body = hash.slice(1)
  if (!body) return ''
  const parts = body.split('&').map((part) => {
    const index = part.indexOf('=')
    if (index < 0) return maskInlineSecrets(part)
    const name = part.slice(0, index)
    const rawValue = part.slice(index + 1)
    const value = isSecretQueryName(name) ? REDACTED : truncate(maskInlineSecrets(rawValue), URL_VALUE_CHARS)
    return `${name}=${value}`
  })
  return `#${truncate(parts.join('&'), URL_CHARS)}`
}

function sanitizeUrl(raw) {
  const text = String(raw ?? '')
  if (!text) return ''
  if (DATA_URL_PATTERN.test(text)) return `[data-url ${text.length} chars]`
  let parsed
  try {
    parsed = new URL(text)
  } catch {
    return `[invalid-url ${text.length} chars]`
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return `[non-http-url ${text.length} chars]`
  }

  // Drop userinfo entirely (task contract), keep host/path/query/fragment.
  const query = []
  for (const [name, value] of parsed.searchParams) {
    const safeName = encodeURIComponent(name)
    const safeValue = isSecretQueryName(name)
      ? REDACTED
      : encodeURIComponent(truncate(maskInlineSecrets(value), URL_VALUE_CHARS))
    query.push(`${safeName}=${safeValue}`)
  }
  const search = query.length > 0 ? `?${query.join('&')}` : ''
  const hash = sanitizeHash(parsed.hash)
  return truncate(`${parsed.protocol}//${parsed.host}${parsed.pathname}${search}${hash}`, URL_CHARS)
}

function looksLikeBase64(text) {
  const compact = String(text).replace(/\s+/g, '')
  if (compact.length < 128) return false
  const sample = compact.slice(0, 512)
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(sample)) return false
  // Require several base64 character classes; plain repeated prose ("hello
  // hello ...") is all lowercase and must fall through to normal truncation.
  let classes = 0
  if (/[a-z]/.test(sample)) classes += 1
  if (/[A-Z]/.test(sample)) classes += 1
  if (/[0-9]/.test(sample)) classes += 1
  if (/[+/=]/.test(sample)) classes += 1
  return classes >= 3
}

function sanitizeString(text) {
  // Only scan a bounded prefix; the recorded value is much shorter anyway.
  const limited = text.length > 4000 ? text.slice(0, 4000) : text
  const masked = maskInlineSecrets(limited)
  return /^https?:\/\//i.test(masked) ? sanitizeUrl(masked) : masked
}

function summarizeString(value, key) {
  const text = String(value)
  const name = String(key ?? '')
  if (CONTENT_KEY_PATTERN.test(name)) return `[omitted ${text.length} chars]`
  if (DATA_URL_PATTERN.test(text)) return `[data-url ${text.length} chars]`
  if (text.length > 64 && looksLikeBase64(text)) return `[base64 ${text.length} chars]`
  const safe = sanitizeString(text)
  return truncate(safe, /(url|href|origin)$/i.test(name) ? URL_CHARS : STRING_CHARS)
}

function boundObject(object, maxBytes) {
  if (!object || typeof object !== 'object' || Array.isArray(object)) return {}
  const entries = Object.entries(object)
  const out = {}
  let dropped = false
  for (const [key, value] of entries) {
    const trial = { ...out, [key]: value }
    if (byteLength(trial) > maxBytes) {
      dropped = true
      break
    }
    out[key] = value
  }
  if (!dropped) return out
  if (byteLength({ ...out, [TRUNCATED_MARKER]: true }) <= maxBytes) {
    out[TRUNCATED_MARKER] = true
    return out
  }
  const keys = Object.keys(out)
  while (keys.length > 0) {
    delete out[keys.pop()]
    if (byteLength({ ...out, [TRUNCATED_MARKER]: true }) <= maxBytes) {
      out[TRUNCATED_MARKER] = true
      return out
    }
  }
  return { [TRUNCATED_MARKER]: true }
}

function boundArray(array, maxBytes = NESTED_BUDGET_BYTES) {
  const out = []
  for (const item of array) {
    const trial = [...out, item]
    if (byteLength(trial) > maxBytes) break
    out.push(item)
  }
  if (out.length < array.length) {
    const withMarker = [...out, '…']
    if (byteLength(withMarker) <= maxBytes) return withMarker
  }
  return out
}

function summarizeValue(value, depth, key, seen) {
  if (value === undefined) return undefined
  if (value === null) return null
  if (typeof value === 'string') return summarizeString(value, key)
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'boolean') return value
  if (typeof value === 'bigint') return truncate(`${value.toString()}n`, STRING_CHARS)
  if (typeof value !== 'object') return `[${typeof value}]`
  if (Buffer.isBuffer(value)) return `[buffer ${value.length} bytes]`
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null
  if (Array.isArray(value)) {
    if (depth > MAX_DEPTH) return `[array ${value.length}]`
    const items = []
    for (const item of value.slice(0, ARRAY_ITEMS)) {
      const summarized = summarizeValue(item, depth + 1, '', seen)
      if (summarized !== undefined) items.push(summarized)
    }
    if (value.length > ARRAY_ITEMS) items.push('…')
    return boundArray(items)
  }
  if (seen.has(value)) return '[circular]'
  if (depth > MAX_DEPTH) return '[object]'
  return summarizeObject(value, depth, seen)
}

function summarizeObject(object, depth, seen) {
  if (seen.has(object)) return '[circular]'
  seen.add(object)
  const out = {}
  const keys = Object.keys(object)
  const maxKeys = MAX_KEYS_BY_DEPTH[Math.min(depth, MAX_KEYS_BY_DEPTH.length - 1)]
  const sensitiveHint = STORAGE_HINT_KEYS.some(
    (key) => typeof object[key] === 'string' && isSensitiveKey(object[key]),
  )
  let included = 0
  try {
    for (const key of keys) {
      if (included >= maxKeys) break
      if (depth === 0 && key === 'backend') continue // already a top-level record field
      let value
      if (isSensitiveKey(key)) value = REDACTED
      else if (sensitiveHint && STORAGE_VALUE_KEYS.has(key)) value = REDACTED
      else value = summarizeValue(object[key], depth + 1, key, seen)
      if (value !== undefined) {
        out[key] = value
        included += 1
      }
    }
    const meaningfulKeys = keys.filter((key) => !(depth === 0 && key === 'backend')).length
    if (meaningfulKeys > included) out[TRUNCATED_MARKER] = true
  } finally {
    seen.delete(object)
  }
  return boundObject(out, depth === 0 ? MAX_ARGS_BYTES : NESTED_BUDGET_BYTES)
}

function summarizeArgs(args) {
  if (args == null) return {}
  if (typeof args !== 'object') {
    const value = summarizeValue(args, 1, 'value', new WeakSet())
    return value === undefined ? {} : { value }
  }
  const seen = new WeakSet()
  if (Array.isArray(args)) {
    const items = summarizeValue(args, 0, '', seen)
    return boundObject({ args: items }, MAX_ARGS_BYTES)
  }
  return boundObject(summarizeObject(args, 0, seen), MAX_ARGS_BYTES)
}

function resultToken(value) {
  return truncate(maskInlineSecrets(String(value)), TOKEN_CHARS)
}

function summarizeResult(result) {
  if (result == null) return {}
  if (Array.isArray(result)) return { items: result.length }
  if (typeof result === 'string') return { valueLength: result.length }
  if (typeof result !== 'object') {
    if (typeof result === 'boolean') return { value: result }
    return { value: typeof result === 'number' && Number.isFinite(result) ? result : `[${typeof result}]` }
  }

  const out = {}
  for (const [key, value] of Object.entries(result)) {
    const normalized = key.toLowerCase()
    if (RESULT_CONTENT_KEYS.has(normalized)) {
      // Never copy the content itself; a length is enough for audit.
      if (typeof value === 'string') out[`${key}Length`] = value.length
      else if (Buffer.isBuffer(value)) out[`${key}Length`] = value.length
      continue
    }
    if (normalized === 'error') {
      if (value) out.resultError = true
      continue
    }
    if (RESULT_LIST_KEYS.has(normalized)) {
      if (Array.isArray(value)) out[`${key}Count`] = value.length
      else if (typeof value === 'number' && Number.isFinite(value)) out[`${key}Count`] = value
      continue
    }
    if (RESULT_URL_KEYS.has(normalized) && typeof value === 'string') {
      out[key] = sanitizeUrl(value)
      continue
    }
    if (normalized === 'title' && typeof value === 'string') {
      out.title = truncate(maskInlineSecrets(value), TITLE_CHARS)
      continue
    }
    if (RESULT_TOKEN_KEYS.has(normalized) && typeof value === 'string') {
      out[key] = resultToken(value)
      continue
    }
    if (RESULT_ID_KEYS.has(normalized)) {
      if (typeof value === 'number' && Number.isFinite(value)) out[key] = value
      else if (typeof value === 'string') out[key] = truncate(maskInlineSecrets(value), ID_CHARS)
      continue
    }
    if (RESULT_NUMBER_KEYS.has(normalized) && typeof value === 'number' && Number.isFinite(value)) {
      out[key] = value
      continue
    }
    if (RESULT_BOOLEAN_KEYS.has(normalized) && typeof value === 'boolean') {
      out[key] = value
      continue
    }
  }
  return boundObject(out, MAX_RESULT_BYTES)
}

function buildRecord(input) {
  const ok = input?.ok === true
  const record = {
    v: VERSION,
    startedAt: toIso(input?.startedAt),
    tool: sanitizeLabel(input?.tool),
    backend: input?.backend === 'headless' ? 'headless' : 'desktop',
    durationMs: toDuration(input?.durationMs),
    ok,
    errorCode: ok ? null : normalizeErrorCode(input?.errorCode ?? 'INTERNAL'),
    args: summarizeArgs(input?.args),
    result: summarizeResult(input?.result),
  }
  return record
}

function fitRecord(record) {
  let json = JSON.stringify(record)
  if (lineBytes(json) <= MAX_RECORD_BYTES) return json

  record.truncated = true
  record.args = boundObject(record.args, 240)
  record.result = boundObject(record.result, 120)
  json = JSON.stringify(record)
  if (lineBytes(json) <= MAX_RECORD_BYTES) return json

  record.args = {}
  record.result = {}
  json = JSON.stringify(record)
  if (lineBytes(json) <= MAX_RECORD_BYTES) return json

  // The fixed fields alone are far below the limit; this is only a guard
  // against a future field growing unexpectedly.
  record.errorCode = null
  record.tool = truncate(record.tool, 32)
  json = JSON.stringify(record)
  return lineBytes(json) <= MAX_RECORD_BYTES ? json : null
}

/**
 * Append one operation record. Never throws: logging must not change tool
 * behavior. Returns true when a line was written, false when the log is
 * disabled or the write failed.
 *
 * `record` accepts raw tool `args` and `result`; both are summarized and
 * redacted here, so callers must not pre-stringify them.
 */
export function appendOperation(record, options = {}) {
  try {
    if (!operationLogEnabled()) return false
    const settings = options && typeof options === 'object' ? options : {}
    const json = fitRecord(buildRecord(record))
    if (!json) return false
    const file = operationLogPath(settings.home)
    const maxBytes = operationLogMaxBytes()
    const incomingBytes = Buffer.byteLength(json, 'utf8') + 1

    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })

    let stat = null
    try {
      stat = fs.statSync(file)
    } catch {
      // no active file yet
    }
    let created = stat == null
    if (stat) {
      if ((stat.mode & 0o777) !== 0o600) {
        try {
          fs.chmodSync(file, 0o600)
        } catch {
          // best effort; the append below still proceeds
        }
      }
      if (stat.size > 0 && stat.size + incomingBytes > maxBytes) {
        try {
          fs.renameSync(file, `${file}.1`)
          created = true
          stat = null
        } catch {
          // rotation is best effort; append to the active file instead
        }
      }
    }

    fs.appendFileSync(file, `${json}\n`, { mode: 0o600 })
    if (created) {
      try {
        fs.chmodSync(file, 0o600)
      } catch {
        // mode is best effort after creation
      }
    }
    return true
  } catch {
    return false
  }
}

function readLogFile(file) {
  try {
    const stat = fs.statSync(file)
    const raw = fs.readFileSync(file, 'utf8')
    const lines = raw.split('\n').filter((line) => line.trim() !== '')
    return { path: file, exists: true, bytes: stat.size, lines, entries: lines.length }
  } catch {
    return { path: file, exists: false, bytes: 0, lines: [], entries: 0 }
  }
}

function clampLimit(value) {
  const limit = Number(value)
  if (!Number.isFinite(limit) || limit < 0) return 20
  return Math.min(100, Math.floor(limit))
}

/**
 * Read capacity/health information and the latest N records (newest first).
 * Active-file counts are reported separately from the rotated `.1` file.
 * Corrupt/partial lines are skipped for `recent` and still counted by
 * `entries`; this function never throws.
 */
export function readOperationStats(options = {}) {
  const settings = typeof options === 'number' ? { limit: options } : options && typeof options === 'object' ? options : {}
  const limit = clampLimit(settings.limit)
  const file = operationLogPath(settings.home)
  const active = readLogFile(file)
  const rotated = readLogFile(`${file}.1`)
  const recent = []

  const visit = (lines) => {
    for (let index = lines.length - 1; index >= 0 && recent.length < limit; index -= 1) {
      try {
        recent.push(JSON.parse(lines[index]))
      } catch {
        // skip corrupt line
      }
    }
  }
  visit(active.lines)
  if (recent.length < limit) visit(rotated.lines)

  return {
    path: file,
    enabled: operationLogEnabled(),
    maxBytes: operationLogMaxBytes(),
    bytes: active.bytes,
    entries: active.entries,
    rotatedBytes: rotated.bytes,
    rotatedEntries: rotated.entries,
    totalBytes: active.bytes + rotated.bytes,
    totalEntries: active.entries + rotated.entries,
    recent,
  }
}

/**
 * Wrap tool definitions so every execute() appends one operation record.
 * Must run after wrapToolsForBackend() (which owns routing) and before
 * ctx.tools.register(). Returns new definitions; behavior and output are
 * unchanged and an error is rethrown untouched.
 */
export function wrapToolsForOperationLog(tools, options = {}) {
  if (!Array.isArray(tools)) return tools
  const fallbackBackend = typeof options.defaultBackend === 'function' ? options.defaultBackend : () => 'desktop'
  return tools.map((definition) => {
    if (!definition || typeof definition.execute !== 'function') return definition
    if (definition[WRAPPED]) return definition
    const wrapped = {
      ...definition,
      async execute(args, exec) {
        const startedMs = Date.now()
        const backend = resolveBackend(args?.backend, fallbackBackend)
        let error
        let result
        let ok = false
        try {
          result = await definition.execute(args, exec)
          ok = true
          return result
        } catch (caught) {
          error = caught
          throw caught
        } finally {
          try {
            appendOperation({
              startedAt: new Date(startedMs).toISOString(),
              tool: definition.name,
              backend,
              durationMs: Math.max(0, Date.now() - startedMs),
              ok,
              errorCode: ok ? null : errorCodeFrom(error),
              args,
              result,
            })
          } catch {
            // appendOperation already never throws; keep the defensive belt
          }
        }
      },
    }
    Object.defineProperty(wrapped, WRAPPED, { value: true })
    return wrapped
  })
}

function resolveBackend(requested, fallbackBackend) {
  if (requested === 'headless') return 'headless'
  if (requested === 'desktop') return 'desktop'
  try {
    return fallbackBackend() === 'headless' ? 'headless' : 'desktop'
  } catch {
    return 'desktop'
  }
}
