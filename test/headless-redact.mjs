/**
 * headless capture redaction (src/headless-redact.js).
 *
 * Self-contained: no browser, no network, no files. Every check uses a sentinel
 * value and asserts the sentinel never survives redaction, so a future rule
 * change cannot silently start persisting passwords/OTPs in a capture.
 */
import assert from 'node:assert/strict'

import {
  CAPTURE_RESPONSE_BODY_CHARS,
  materializeCaptureBody,
  redactUrl,
} from '../src/headless-redact.js'

const SENTINEL = 'DSH_SENTINEL_CAPTURE_DO_NOT_USE'
let checks = 0

function check(name, fn) {
  fn()
  checks += 1
  console.log(`  ok  ${name}`)
}

function body(raw, mimeType, maxChars = CAPTURE_RESPONSE_BODY_CHARS) {
  const capture = { bodyBytes: 0, bodiesDropped: 0 }
  return materializeCaptureBody(capture, raw, mimeType, maxChars)
}

function noSentinel(label, text) {
  assert.equal(String(text).includes(SENTINEL), false, `${label} leaked the sentinel: ${text}`)
}

check('JSON keys pwd/otp/cvv/auth are redacted and author is not', () => {
  const result = body(
    JSON.stringify({
      pwd: SENTINEL,
      otp: SENTINEL,
      cvv: SENTINEL,
      auth: SENTINEL,
      password: SENTINEL,
      token: SENTINEL,
      author: 'keep',
      nested: { apiKey: SENTINEL, user_pwd: SENTINEL, userPwd: SENTINEL, otp_code: SENTINEL },
    }),
    'application/json',
  )
  noSentinel('JSON body', result.text)
  assert.ok(result.text.includes('"author":"keep"'), result.text)
  assert.ok(result.text.includes('«redacted»'), result.text)
  assert.equal(result.truncated, false)
})

check('JSON string values still get inline secret masking', () => {
  const result = body(JSON.stringify({ note: `password=${SENTINEL}`, ok: true }), 'application/json')
  noSentinel('JSON string value', result.text)
  assert.ok(result.text.includes('"ok":true'))
})

check('form-urlencoded pwd/otp/cvv/auth values are redacted and author is not', () => {
  const result = body(
    `pwd=${SENTINEL}&otp=${SENTINEL}&cvv=${SENTINEL}&auth=${SENTINEL}&author=keep&token=${SENTINEL}`,
    'application/x-www-form-urlencoded',
  )
  noSentinel('form body', result.text)
  assert.ok(result.text.includes('author=keep'), result.text)
})

check('plain text key=value secrets are masked and author survives', () => {
  const result = body(
    `author=keep password=${SENTINEL} pwd=${SENTINEL} otp=${SENTINEL} cvv=${SENTINEL} token=${SENTINEL} secret=${SENTINEL}`,
    'text/plain',
  )
  noSentinel('plain text body', result.text)
  assert.ok(result.text.includes('author=keep'), result.text)
})

check('URL query secrets incl. pwd/otp/cvv/auth are redacted and author is not', () => {
  const url = redactUrl(
    `https://user:${SENTINEL}@example.test/p?pwd=${SENTINEL}&otp=${SENTINEL}&cvv=${SENTINEL}&auth=${SENTINEL}&author=keep&token=${SENTINEL}&q=1`,
  )
  noSentinel('URL query', url)
  assert.ok(url.includes('author=keep'), url)
  assert.ok(url.includes('q=1'), url)
  assert.equal(url.includes('user:'), false, 'userinfo must not survive')
})

check('URL fragment key/value secrets are redacted', () => {
  const url = redactUrl(`https://example.test/callback#access_token=${SENTINEL}&pwd=${SENTINEL}&state=ok`)
  noSentinel('URL fragment', url)
  assert.ok(url.includes('access_token=«redacted»'), url)
  assert.ok(url.includes('state=ok'), url)
})

check('URL fragment bare secrets/tokens are masked without touching plain anchors', () => {
  const jwt = `eyJhbGciOiJIUzI1NiJ9.${SENTINEL}.c2lnc2ln`
  const tokenUrl = redactUrl(`https://example.test/#${jwt}`)
  noSentinel('URL fragment token', tokenUrl)
  assert.ok(tokenUrl.includes('«redacted»'), tokenUrl)
  const anchor = redactUrl('https://example.test/page#section-2')
  assert.ok(anchor.endsWith('#section-2'), anchor)
})

check('redaction happens before truncation so a cut never leaves half a secret', () => {
  const result = body(`author=abcdefghij&pwd=${SENTINEL}`, 'application/x-www-form-urlencoded', 24)
  assert.equal(result.truncated, true)
  noSentinel('truncated body', result.text)
  assert.ok(result.text.endsWith('… <truncated>'), result.text)
})

check('existing token shapes stay masked', () => {
  const result = body(
    'Authorization: Bearer abcdef123456 and sk-abcdefghijkl and AKIAABCDEFGHIJKLMNOP and eyJhbGciOiJIUzI1NiJ9.abcdefgh.c2lnc2ln',
    'text/plain',
  )
  for (const raw of ['abcdef123456', 'sk-abcdefghijkl', 'AKIAABCDEFGHIJKLMNOP', 'eyJhbGciOiJIUzI1NiJ9.abcdefgh.c2lnc2ln']) {
    assert.equal(result.text.includes(raw), false, `raw token survived: ${raw}`)
  }
})

check('non-text bodies keep the binary placeholder', () => {
  const result = body('x'.repeat(100), 'image/png')
  assert.ok(result.text.startsWith('<binary '), result.text)
})

console.log(`\nHEADLESS REDACT TEST: PASS (${checks} checks)`)
