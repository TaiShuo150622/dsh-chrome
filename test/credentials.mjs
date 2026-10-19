/**
 * Credential-store safety foundation tests (src/credentials.js).
 *
 * Self-contained: no browser, no network, no real Keychain. Every macOS case
 * injects a fake `exec`, so this test never runs `security` and never asks for
 * a real password. Sentinel values prove the secret is handed only to the fill
 * sink and never appears in a public result, error or log line.
 *
 * Run with: node test/credentials.mjs
 */
import assert from 'node:assert/strict'

import {
  CREDENTIAL_ERROR_CODES,
  CREDENTIAL_SERVICE,
  CredentialError,
  SECURITY_TIMEOUT_MS,
  createCredentialStore,
  keychainAccountFor,
} from '../src/credentials.js'

const SENTINEL = 'DSH_SENTINEL_CREDENTIAL_DO_NOT_USE'
const META = Object.freeze({
  scope: 'headless:ctx-1',
  origin: 'https://example.com',
  username: 'alice',
})

let checks = 0
let failures = 0

async function check(name, fn) {
  try {
    await fn()
    checks += 1
    console.log(`  ok  ${name}`)
  } catch (error) {
    failures += 1
    console.log(`  FAIL ${name}: ${error?.stack || error}`)
  }
}

function fakeExec({ stdout = '', stderr = '', code = 0, throwError = null } = {}) {
  const calls = []
  const exec = async (file, args, options) => {
    calls.push({ file, args: [...args], options })
    if (throwError) throw throwError
    return { stdout, stderr, code }
  }
  exec.calls = calls
  return exec
}

function captureLogger() {
  const lines = []
  const write = (...args) => lines.push(args.map((value) => String(value)).join(' '))
  return { lines, info: write, warn: write, debug: write, error: write }
}

// The fill sink is injected at composition time, not passed per call. The spy
// records the one legitimate plaintext hand-off so the tests can assert it
// never appears anywhere else.
function sinkSpy() {
  const calls = []
  const sink = (secret, descriptor) => {
    calls.push({ secret, descriptor })
    return SENTINEL // fill must ignore the sink's return value
  }
  sink.calls = calls
  return sink
}

function noSentinel(label, value) {
  assert.equal(String(value).includes(SENTINEL), false, `${label} leaked the sentinel`)
}

async function expectCredentialError(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof CredentialError, `expected CredentialError, got ${error?.name || typeof error}`)
    assert.equal(error.code, code)
    noSentinel('error message', error.message)
    noSentinel('error stack', error.stack)
    return true
  })
}

function storeWith(exec, options = {}) {
  return createCredentialStore({ platform: 'darwin', exec, ...options })
}

await check('darwin status advertises the Keychain backend without account data', () => {
  const store = storeWith(fakeExec())
  const status = store.status()
  assert.deepEqual(status, { supported: true, platform: 'darwin', backend: 'macos-keychain' })
  noSentinel('status', JSON.stringify(status))
  assert.equal('username' in status, false)
  assert.equal('credentialId' in status, false)
})

await check('register returns an opaque id and metadata only', () => {
  const store = storeWith(fakeExec())
  const first = store.register({ ...META, label: 'work' })
  const second = store.register(META)

  assert.match(first.credentialId, /^cred_[0-9a-f]{32}$/)
  assert.notEqual(first.credentialId, second.credentialId)
  assert.equal(first.credentialId.includes('alice'), false)
  assert.equal(first.credentialId.includes('example.com'), false)
  noSentinel('credential id', first.credentialId)

  assert.deepEqual(Object.keys(first).sort(), [
    'backend',
    'credentialId',
    'label',
    'origin',
    'scope',
    'username',
  ])
  assert.equal(first.backend, 'macos-keychain')
  assert.equal(first.scope, META.scope)
  assert.equal(first.origin, META.origin)
  assert.equal(first.username, META.username)
  assert.equal(first.label, 'work')
  assert.equal('account' in first, false)
  assert.equal('service' in first, false)
  assert.equal('secret' in first, false)
  noSentinel('register metadata', JSON.stringify(first))

  const described = store.describe(first.credentialId)
  assert.deepEqual(described, first)
  first.username = 'mallory'
  assert.equal(store.describe(first.credentialId).username, 'alice', 'public metadata must be a copy')
})

await check('macOS Keychain success hands the secret only to the sink', async () => {
  const exec = fakeExec({ stdout: `${SENTINEL}\n` })
  const logger = captureLogger()
  const sink = sinkSpy()
  const store = storeWith(exec, { logger, fillSink: sink })
  const meta = store.register(META)

  const result = await store.fill(meta.credentialId)

  assert.equal(sink.calls.length, 1)
  const seen = sink.calls[0]
  assert.equal(seen.secret, SENTINEL)
  assert.equal(seen.descriptor.credentialId, meta.credentialId)
  assert.deepEqual(seen.descriptor, meta)
  noSentinel('sink descriptor', JSON.stringify(seen.descriptor))

  assert.deepEqual(result, { filled: true })
  assert.equal(Object.keys(result).length, 1)
  noSentinel('fill result', JSON.stringify(result))

  assert.equal(exec.calls.length, 1)
  const call = exec.calls[0]
  assert.equal(call.file, 'security')
  assert.deepEqual(call.args, [
    'find-generic-password',
    '-s',
    CREDENTIAL_SERVICE,
    '-a',
    keychainAccountFor(META),
    '-w',
  ])
  assert.equal(call.args.some((arg) => String(arg).includes(SENTINEL)), false)
  assert.equal(call.options.encoding, 'utf8')
  assert.equal(call.options.timeout, SECURITY_TIMEOUT_MS)
  assert.ok(Number.isInteger(call.options.maxBuffer) && call.options.maxBuffer > 0)

  noSentinel('log lines', logger.lines.join('\n'))
  assert.deepEqual(logger.lines, ['dsh-chrome credentials: macOS Keychain read requested'])
})

await check('Keychain output keeps leading/trailing spaces and strips one trailing newline', async () => {
  const exec = fakeExec({ stdout: `  ${SENTINEL}  \r\n` })
  const sink = sinkSpy()
  const store = storeWith(exec, { fillSink: sink })
  const meta = store.register(META)
  await store.fill(meta.credentialId)
  assert.equal(sink.calls[0].secret, `  ${SENTINEL}  `)
})

await check('Keychain not-found (exit 44) fails closed without leaking CLI output', async () => {
  const failure = Object.assign(new Error('The specified item could not be found in the keychain.'), {
    code: 44,
    stdout: SENTINEL,
    stderr: SENTINEL,
  })
  const exec = fakeExec({ throwError: failure })
  const logger = captureLogger()
  const sink = sinkSpy()
  const store = storeWith(exec, { logger, fillSink: sink })
  const meta = store.register(META)

  await expectCredentialError(store.fill(meta.credentialId), CREDENTIAL_ERROR_CODES.NOT_FOUND)
  assert.equal(sink.calls.length, 0)
  noSentinel('log lines', logger.lines.join('\n'))
})

await check('a non-zero Keychain exit reported without throwing is not found', async () => {
  const exec = fakeExec({ stdout: '', stderr: SENTINEL, code: 44 })
  const logger = captureLogger()
  const sink = sinkSpy()
  const store = storeWith(exec, { logger, fillSink: sink })
  const meta = store.register(META)
  await expectCredentialError(store.fill(meta.credentialId), CREDENTIAL_ERROR_CODES.NOT_FOUND)
  assert.equal(sink.calls.length, 0)
  noSentinel('log lines', logger.lines.join('\n'))
})

await check('a generic Keychain error is mapped to not-found and never echoes stdout/stderr', async () => {
  const failure = Object.assign(new Error('keychain is locked'), {
    code: 1,
    stdout: SENTINEL,
    stderr: SENTINEL,
  })
  const exec = fakeExec({ throwError: failure })
  const logger = captureLogger()
  const sink = sinkSpy()
  const store = storeWith(exec, { logger, fillSink: sink })
  const meta = store.register(META)
  await expectCredentialError(store.fill(meta.credentialId), CREDENTIAL_ERROR_CODES.NOT_FOUND)
  assert.equal(sink.calls.length, 0)
  noSentinel('log lines', logger.lines.join('\n'))
})

await check('a missing security CLI is UNSUPPORTED_PLATFORM, not a leaked spawn error', async () => {
  const failure = Object.assign(new Error('spawn security ENOENT'), {
    code: 'ENOENT',
    stdout: SENTINEL,
    stderr: SENTINEL,
  })
  const exec = fakeExec({ throwError: failure })
  const logger = captureLogger()
  const sink = sinkSpy()
  const store = storeWith(exec, { logger, fillSink: sink })
  const meta = store.register(META)
  await expectCredentialError(store.fill(meta.credentialId), CREDENTIAL_ERROR_CODES.UNSUPPORTED_PLATFORM)
  assert.equal(sink.calls.length, 0)
  noSentinel('log lines', logger.lines.join('\n'))
})

await check('an empty Keychain value is not treated as a credential', async () => {
  const exec = fakeExec({ stdout: '\n' })
  const sink = sinkSpy()
  const store = storeWith(exec, { fillSink: sink })
  const meta = store.register(META)
  await expectCredentialError(store.fill(meta.credentialId), CREDENTIAL_ERROR_CODES.NOT_FOUND)
  assert.equal(sink.calls.length, 0)
})

await check('Windows/Linux are declared, report NOT_SUPPORTED and never execute a fake backend', async () => {
  const cases = [
    ['win32', 'windows-credential-manager'],
    ['linux', 'linux-secret-service'],
    ['freebsd', 'unsupported'],
  ]
  for (const [platform, backend] of cases) {
    const exec = fakeExec({ stdout: `${SENTINEL}\n` })
    const logger = captureLogger()
    const store = createCredentialStore({ platform, exec, logger })
    const status = store.status()
    assert.equal(status.supported, false, `${platform}: supported`)
    assert.equal(status.platform, platform, `${platform}: platform`)
    assert.equal(status.backend, backend, `${platform}: backend`)
    assert.equal(status.code, CREDENTIAL_ERROR_CODES.UNSUPPORTED_PLATFORM, `${platform}: status code`)
    noSentinel(`${platform} status`, JSON.stringify(status))

    const meta = store.register(META)
    assert.equal(meta.backend, backend)
    // No sink is configured: the platform error must win over the wiring error.
    await expectCredentialError(store.fill(meta.credentialId), CREDENTIAL_ERROR_CODES.UNSUPPORTED_PLATFORM)
    assert.equal(exec.calls.length, 0, `${platform}: exec must not run`)
    noSentinel(`${platform} log lines`, logger.lines.join('\n'))
  }
})

await check('unknown or malformed credential ids fail closed without touching Keychain', async () => {
  const exec = fakeExec()
  const store = storeWith(exec)
  // No sink is configured: lookup failures must still be CREDENTIAL_NOT_FOUND.
  await expectCredentialError(store.fill(`cred_${'0'.repeat(32)}`), CREDENTIAL_ERROR_CODES.NOT_FOUND)
  await expectCredentialError(store.fill('not-a-credential-id'), CREDENTIAL_ERROR_CODES.NOT_FOUND)
  assert.throws(
    () => store.describe('not-a-credential-id'),
    (error) => error instanceof CredentialError && error.code === CREDENTIAL_ERROR_CODES.NOT_FOUND,
  )
  assert.equal(exec.calls.length, 0)
})

await check('fill without a helper-internal sink is a programming error and reads nothing', async () => {
  const exec = fakeExec({ stdout: `${SENTINEL}\n` })
  const store = storeWith(exec)
  const meta = store.register(META)
  await assert.rejects(store.fill(meta.credentialId), (error) => {
    assert.ok(error instanceof TypeError, 'expected TypeError')
    noSentinel('error message', error.message)
    return true
  })
  assert.equal(exec.calls.length, 0)
})

await check('registration rejects non-exact origins and invalid scopes/usernames', () => {
  const store = storeWith(fakeExec())
  const badOrigins = [
    'https://example.com/login',
    'https://example.com/?q=1',
    'https://example.com/#fragment',
    'https://user:pass@example.com',
    'ftp://example.com',
    'not a url',
  ]
  for (const origin of badOrigins) {
    assert.throws(() => store.register({ origin, username: 'alice' }), TypeError, origin)
  }
  assert.throws(() => store.register({ ...META, scope: 'global' }), TypeError)
  assert.throws(() => store.register({ ...META, scope: 'headless:' }), TypeError)
  assert.throws(() => store.register({ ...META, username: '' }), TypeError)
  assert.throws(() => store.register({ ...META, username: 'ali\nce' }), TypeError)

  const normalized = store.register({ origin: 'https://Example.COM:443', username: 'alice' })
  assert.equal(normalized.origin, 'https://example.com')
  assert.equal(normalized.scope, 'desktop')
  assert.equal(
    keychainAccountFor({ scope: 'headless:ctx-1', origin: 'https://example.com', username: 'alice' }),
    'dsh-chrome/headless:ctx-1/https://example.com/alice',
  )
})

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`)
  process.exitCode = 1
} else {
  console.log(`\nCREDENTIALS TEST: PASS (${checks} checks)`)
}
