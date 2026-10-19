/**
 * Credential-store safety foundation for password management
 * (docs/PASSWORD-MANAGEMENT.md).
 *
 * Scope of this module (P1 safety foundation, deliberately small):
 *  - issue opaque credential ids to the provider/model; metadata is limited to
 *    id/scope/origin/username/label/backend, never the Keychain coordinates and
 *    never the secret;
 *  - read a macOS Keychain generic password through the `security` CLI inside
 *    `fill()`, and hand the plaintext only to the fill sink injected by the
 *    helper composition root (never to provider/model code);
 *  - fail explicitly with `CREDENTIAL_NOT_FOUND` / `UNSUPPORTED_PLATFORM`;
 *  - declare Windows/Linux backends without pretending to implement them.
 *
 * NOT implemented here (do not read this module as a password manager):
 *  - no `chrome_*` tool, no provider wiring, no UDS/native helper;
 *  - no driver/CDP fill sink, so `fill()` is only exercised with a test sink;
 *  - no store/forget, no autofill, no list/get/reveal surface;
 *  - no Windows Credential Manager or Linux Secret Service implementation.
 *
 * The plaintext is a Node string while `fill()` awaits the sink. Node strings
 * cannot be wiped reliably; a production helper must use a native byte buffer
 * and clear it after use (docs/PASSWORD-MANAGEMENT.md §3.3).
 */
import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'

export const CREDENTIAL_SERVICE = 'com.deepseek.dsh.chrome.credentials'
export const CREDENTIAL_ID_PREFIX = 'cred_'
export const KEYCHAIN_SECURITY_BIN = 'security'
export const SECURITY_TIMEOUT_MS = 30_000
const SECURITY_MAX_BUFFER = 64 * 1024
const CREDENTIAL_ID_PATTERN = new RegExp(`^${CREDENTIAL_ID_PREFIX}[0-9a-f]{32}$`)
const SCOPE_PATTERN = /^(?:desktop|headless:[A-Za-z0-9][A-Za-z0-9._-]{0,127})$/

// Declarative backend table: macOS is implemented; Windows/Linux are named so
// the interface is stable, but `credentialBackendFor()` never fakes support.
export const CREDENTIAL_BACKENDS = Object.freeze({
  darwin: 'macos-keychain',
  win32: 'windows-credential-manager',
  linux: 'linux-secret-service',
})

export const CREDENTIAL_ERROR_CODES = Object.freeze({
  NOT_FOUND: 'CREDENTIAL_NOT_FOUND',
  UNSUPPORTED_PLATFORM: 'UNSUPPORTED_PLATFORM',
})

export class CredentialError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'CredentialError'
    this.code = code
  }
}

const PLATFORM_ALIASES = Object.freeze({
  darwin: 'darwin',
  mac: 'darwin',
  macos: 'darwin',
  osx: 'darwin',
  win32: 'win32',
  win: 'win32',
  windows: 'win32',
  linux: 'linux',
})

function normalizePlatform(value) {
  const key = String(value ?? process.platform)
    .trim()
    .toLowerCase()
  return PLATFORM_ALIASES[key] ?? key
}

export function credentialBackendFor(platform = process.platform) {
  return CREDENTIAL_BACKENDS[normalizePlatform(platform)] ?? 'unsupported'
}

function normalizeScope(value) {
  const scope = String(value ?? 'desktop').trim()
  if (!SCOPE_PATTERN.test(scope)) {
    throw new TypeError('scope must be "desktop" or "headless:<profileId>"')
  }
  return scope
}

// Exact origin only: scheme + host + optional non-default port. A path, query,
// fragment or userinfo is rejected instead of being silently normalized, so a
// caller cannot smuggle "https://example.com/login?..." into a credential key.
function normalizeOrigin(value) {
  let parsed
  try {
    parsed = new URL(String(value ?? ''))
  } catch {
    throw new TypeError('origin must be an absolute http(s) origin')
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new TypeError('origin must use http or https')
  }
  if (parsed.username || parsed.password) {
    throw new TypeError('origin must not contain userinfo')
  }
  if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new TypeError('origin must not contain a path, query or fragment')
  }
  return parsed.origin
}

function normalizeUsername(value) {
  const username = String(value ?? '')
  if (!username || username.length > 256 || /[\u0000-\u001f\u007f]/.test(username)) {
    throw new TypeError('username must be a non-empty string without control characters')
  }
  return username
}

function normalizeLabel(value) {
  if (value == null || value === '') return ''
  const label = String(value)
  if (label.length > 120 || /[\u0000-\u001f\u007f]/.test(label)) {
    throw new TypeError('label must be at most 120 characters without control characters')
  }
  return label
}

/**
 * Keychain account derived from the design's (scope, origin, username) tuple.
 * The service is fixed by CREDENTIAL_SERVICE; callers cannot point the adapter
 * at arbitrary Keychain items through a model-supplied account string.
 */
export function keychainAccountFor({ scope = 'desktop', origin, username } = {}) {
  return `dsh-chrome/${normalizeScope(scope)}/${normalizeOrigin(origin)}/${normalizeUsername(username)}`
}

function stripTrailingNewline(value) {
  const text = String(value)
  if (text.endsWith('\r\n')) return text.slice(0, -2)
  if (text.endsWith('\n')) return text.slice(0, -1)
  return text
}

function defaultExec(file, args, options) {
  return new Promise((resolve) => {
    try {
      execFile(file, args, options, (error, stdout, stderr) => {
        if (!error) {
          resolve({ stdout, stderr, code: 0 })
          return
        }
        resolve({
          stdout,
          stderr,
          code: typeof error.code === 'number' ? error.code : 1,
          spawnCode: typeof error.code === 'string' ? error.code : null,
        })
      })
    } catch (error) {
      resolve({
        stdout: '',
        stderr: '',
        code: 1,
        spawnCode: typeof error?.code === 'string' ? error.code : null,
      })
    }
  })
}

// Run an injected exec and retain only stdout/code. stderr is deliberately
// dropped: a failing CLI could conceivably echo something sensitive, and this
// module never needs it. A rejected exec is normalized the same way.
async function runExec(exec, file, args, options) {
  let outcome
  try {
    outcome = await exec(file, args, options)
  } catch (error) {
    return {
      stdout: typeof error?.stdout === 'string' ? error.stdout : '',
      code: Number.isInteger(error?.code) && error.code > 0 ? error.code : 1,
      spawnCode: typeof error?.code === 'string' ? error.code : null,
    }
  }
  if (!outcome || typeof outcome !== 'object') {
    return { stdout: '', code: 1, spawnCode: null }
  }
  return {
    stdout: typeof outcome.stdout === 'string' ? outcome.stdout : String(outcome.stdout ?? ''),
    code: Number.isInteger(outcome.code) ? outcome.code : outcome.spawnCode ? 1 : 0,
    spawnCode: typeof outcome.spawnCode === 'string' ? outcome.spawnCode : null,
  }
}

function publicDescriptor(entry) {
  const out = {
    credentialId: entry.credentialId,
    backend: entry.backend,
    scope: entry.scope,
    origin: entry.origin,
    username: entry.username,
  }
  if (entry.label) out.label = entry.label
  return out
}

function normalizeDescriptor(metadata) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new TypeError('credential metadata must be an object')
  }
  const scope = normalizeScope(metadata.scope)
  const origin = normalizeOrigin(metadata.origin)
  const username = normalizeUsername(metadata.username)
  const label = normalizeLabel(metadata.label)
  return {
    scope,
    origin,
    username,
    label,
    service: CREDENTIAL_SERVICE,
    account: keychainAccountFor({ scope, origin, username }),
  }
}

/**
 * Credential handles for one platform. Constructing the store is cheap and
 * safe everywhere; only `fill()` requires a supported backend and a helper
 * composition root that supplied `fillSink`.
 */
export class CredentialStore {
  #platform
  #backend
  #exec
  #logger
  #fillSink
  #entries

  constructor({ platform = process.platform, exec = defaultExec, logger = null, fillSink = null } = {}) {
    this.#platform = normalizePlatform(platform)
    this.#backend = credentialBackendFor(this.#platform)
    this.#exec = typeof exec === 'function' ? exec : defaultExec
    this.#logger = logger && typeof logger === 'object' ? logger : null
    this.#fillSink = typeof fillSink === 'function' ? fillSink : null
    this.#entries = new Map()
  }

  get platform() {
    return this.#platform
  }

  get backend() {
    return this.#backend
  }

  get supported() {
    return this.#platform === 'darwin'
  }

  /**
   * Status is safe to expose: no account list, usernames, ids or counts.
   * Windows/Linux report `supported:false` with the explicit error code.
   */
  status() {
    const status = {
      supported: this.supported,
      platform: this.#platform,
      backend: this.#backend,
    }
    if (!this.supported) status.code = CREDENTIAL_ERROR_CODES.UNSUPPORTED_PLATFORM
    return status
  }

  /**
   * Turn provider-side metadata into an opaque handle. The returned object is
   * the entire model-visible surface: no Keychain service/account and no
   * secret. Calling register() does not prove the item exists in Keychain.
   */
  register(metadata) {
    const descriptor = normalizeDescriptor(metadata)
    let credentialId
    do {
      credentialId = `${CREDENTIAL_ID_PREFIX}${randomBytes(16).toString('hex')}`
    } while (this.#entries.has(credentialId))
    const entry = Object.freeze({
      ...descriptor,
      credentialId,
      backend: this.#backend,
    })
    this.#entries.set(credentialId, entry)
    return publicDescriptor(entry)
  }

  /** Return metadata for a handle; unknown ids fail closed. */
  describe(credentialId) {
    return publicDescriptor(this.#entry(credentialId))
  }

  /**
   * Read the secret internally and hand it to the constructor's `fillSink`.
   *
   * The sink is a helper-internal driver/CDP writer, injected at composition
   * time; it is not a per-call argument, so a caller cannot smuggle in a
   * callback that captures the plaintext. This MVP wires no sink at all.
   * The only return value is `{ filled: true }` — no secret, no metadata echo.
   */
  async fill(credentialId) {
    const entry = this.#entry(credentialId)
    this.#assertSupported()
    if (!this.#fillSink) {
      // Programming error, not a credential error: this MVP deliberately has
      // no implicit "fill" that would claim success without touching a page.
      throw new TypeError('credential fill is not wired to a browser driver in this MVP')
    }
    let secret = await this.#readKeychainSecret(entry)
    try {
      await this.#fillSink(secret, publicDescriptor(entry))
    } finally {
      // Best effort only: Node strings are immutable and may already be
      // copied by the VM. Do not rely on this for memory hygiene.
      secret = null
    }
    return { filled: true }
  }

  #entry(credentialId) {
    const id = typeof credentialId === 'string' ? credentialId : ''
    if (!CREDENTIAL_ID_PATTERN.test(id)) {
      throw new CredentialError(CREDENTIAL_ERROR_CODES.NOT_FOUND, 'no saved credential matches this id')
    }
    const entry = this.#entries.get(id)
    if (!entry) {
      throw new CredentialError(CREDENTIAL_ERROR_CODES.NOT_FOUND, 'no saved credential matches this id')
    }
    return entry
  }

  #assertSupported() {
    if (!this.supported) {
      throw new CredentialError(
        CREDENTIAL_ERROR_CODES.UNSUPPORTED_PLATFORM,
        `credential storage is not implemented on ${this.#platform}`,
      )
    }
  }

  async #readKeychainSecret(entry) {
    this.#log('info', 'dsh-chrome credentials: macOS Keychain read requested')
    const result = await runExec(
      this.#exec,
      KEYCHAIN_SECURITY_BIN,
      ['find-generic-password', '-s', entry.service, '-a', entry.account, '-w'],
      {
        encoding: 'utf8',
        maxBuffer: SECURITY_MAX_BUFFER,
        timeout: SECURITY_TIMEOUT_MS,
        windowsHide: true,
      },
    )
    if (result.spawnCode === 'ENOENT') {
      this.#log('warn', 'dsh-chrome credentials: security CLI is unavailable')
      throw new CredentialError(
        CREDENTIAL_ERROR_CODES.UNSUPPORTED_PLATFORM,
        'macOS security CLI is not available on this machine',
      )
    }
    if (result.code !== 0) {
      // Not-found and locked/unreadable Keychain items share one public error:
      // distinguishing them would add no useful retry path and the raw CLI
      // diagnostics must not reach the caller.
      this.#log('info', 'dsh-chrome credentials: Keychain item not found or unreadable')
      throw new CredentialError(CREDENTIAL_ERROR_CODES.NOT_FOUND, 'no saved credential matches this id')
    }
    const secret = stripTrailingNewline(result.stdout)
    if (secret === '') {
      this.#log('info', 'dsh-chrome credentials: Keychain item has no secret')
      throw new CredentialError(CREDENTIAL_ERROR_CODES.NOT_FOUND, 'no saved credential matches this id')
    }
    return secret
  }

  // Logs are metadata-only and carry no credential id, account, origin,
  // username, CLI output or secret. Logging must never affect a read.
  #log(level, message) {
    const logger = this.#logger
    if (!logger) return
    try {
      const write = logger[level] ?? logger.info ?? logger.debug
      if (typeof write === 'function') write.call(logger, message)
    } catch {
      // diagnostics are best effort
    }
  }
}

export function createCredentialStore(options = {}) {
  return new CredentialStore(options)
}
