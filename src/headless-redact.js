/**
 * Redaction and body budgeting for the headless network-capture surface.
 *
 * Captured request/response metadata is model-facing, so URLs, JSON keys and
 * text bodies are masked before they leave the driver and the amount of body
 * text kept per capture is bounded. The shared cases are still a contract with
 * the desktop extension's capture implementation (test/capture-parity.mjs
 * checks both). Q33 intentionally widened only the headless key-name, fragment
 * and inline `key=value` rules ahead of the extension, so those three rule sets
 * are no longer byte-for-byte identical; keep the shared cases in sync.
 */

const CAPTURE_BODY_TOTAL_LIMIT = 8 * 1024 * 1024
export const CAPTURE_RESPONSE_BODY_CHARS = 4096
export const CAPTURE_REQUEST_BODY_CHARS = 2048
const CAPTURE_TEXT_MIME = /^text\/|json|xml|javascript|x-www-form-urlencoded|graphql/i
// Query/form/JSON key names that must never carry a value into a capture.
// `pwd`/`otp`/`cvv` match as whole key segments (delimited, exact or trailing)
// so ordinary words such as `author` stay readable. The desktop extension keeps
// the older list; this headless-only widening is the Q33 hardening.
const CAPTURE_SECRET_PARAM =
  /(pass(word|wd|phrase)?|secret|token|api[-_]?key|access[-_]?token|refresh[-_]?token|authorization|cookie|session[-_]?id|csrf|xsrf|signature|sig|credential|private[-_]?key|(?:^|[-_.])auth(?:[-_.]|$)|(?:^|[-_.])(?:pwd|otp|cvv2?)(?:[-_.]|$)|(?:pwd|otp|cvv2?)$)/i
// `key=value` / `key: value` inside free text (a plain text body, a JSON string
// value, a URL fragment). The value ends at the usual body delimiters.
const CAPTURE_INLINE_SECRET =
  /(pass(?:word|wd|phrase)?|pwd|otp|cvv2?|secret|token|api[-_]?key|access[-_]?token|refresh[-_]?token|authorization|cookie|session[-_]?id|csrf|xsrf|signature|sig|credential|private[-_]?key|\bauth\b)(["']?\s*[:=]\s*["']?)([^\s,;"'&}]{1,256})/gi

function maskSecretsInText(text) {
  return String(text)
    .replace(/\b(Bearer\s+)[A-Za-z0-9._\-]{6,}/gi, '$1«redacted»')
    .replace(/\bsk-[A-Za-z0-9]{10,}\b/g, '«redacted»')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g, '«redacted»')
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, '«redacted»')
    .replace(CAPTURE_INLINE_SECRET, '$1$2«redacted»')
}

// Fragments can carry OAuth tokens (`#access_token=…`) or a bare secret. Apply
// the query-parameter rule to key/value pairs and the inline token masks to the
// rest, so `#section` and other harmless anchors survive unchanged.
function redactFragment(fragment) {
  const body = String(fragment || '').replace(/^#/, '')
  if (!body) return fragment
  const parts = body.split('&').map((part) => {
    const index = part.indexOf('=')
    if (index < 0) return maskSecretsInText(part)
    const name = part.slice(0, index)
    const value = part.slice(index + 1)
    return CAPTURE_SECRET_PARAM.test(name) ? `${name}=«redacted»` : `${name}=${maskSecretsInText(value)}`
  })
  return `#${parts.join('&')}`
}

export function redactUrl(rawUrl) {
  let url = String(rawUrl || '')
  try {
    const parsed = new URL(url)
    if (parsed.username) parsed.username = '«redacted»'
    if (parsed.password) parsed.password = '«redacted»'
    for (const name of [...parsed.searchParams.keys()]) {
      if (CAPTURE_SECRET_PARAM.test(name)) parsed.searchParams.set(name, '«redacted»')
    }
    if (parsed.hash) parsed.hash = redactFragment(parsed.hash)
    url = parsed.toString().replace(/%C2%ABredacted%C2%BB/gi, '«redacted»')
  } catch {
    // keep non-URL strings
  }
  return url.length > 2048 ? `${url.slice(0, 2048)}…` : url
}

function redactJsonValue(value) {
  if (Array.isArray(value)) return value.map((item) => redactJsonValue(item))
  if (value && typeof value === 'object') {
    const out = {}
    for (const [key, item] of Object.entries(value)) {
      out[key] = CAPTURE_SECRET_PARAM.test(key) ? '«redacted»' : redactJsonValue(item)
    }
    return out
  }
  if (typeof value === 'string') return maskSecretsInText(value)
  return value
}

function redactBodyText(text, mimeType, maxChars) {
  let out = String(text ?? '')
  const trimmed = out.trim()
  const isJson = /json/i.test(String(mimeType || '')) || trimmed.startsWith('{') || trimmed.startsWith('[')
  if (isJson) {
    try {
      out = JSON.stringify(redactJsonValue(JSON.parse(trimmed)))
    } catch {
      out = maskSecretsInText(out)
    }
  } else if (/x-www-form-urlencoded/i.test(String(mimeType || ''))) {
    out = out
      .split('&')
      .map((pair) => {
        const [name, ...rest] = pair.split('=')
        if (CAPTURE_SECRET_PARAM.test(decodeURIComponent(name || ''))) return `${name}="«redacted»"`
        return `${name}${rest.length ? `=${rest.join('=')}` : ''}`
      })
      .join('&')
  } else {
    out = maskSecretsInText(out)
  }
  const truncated = out.length > maxChars
  return { text: truncated ? `${out.slice(0, maxChars)}… <truncated>` : out, truncated }
}

export function materializeCaptureBody(capture, raw, mimeType, maxChars) {
  if (raw == null) return null
  let text
  if (!CAPTURE_TEXT_MIME.test(String(mimeType || ''))) {
    text = `<binary ${String(raw).length} chars>`
  } else {
    text = redactBodyText(raw, mimeType, maxChars).text
  }
  const bytes = text.length
  if (capture.bodyBytes + bytes > CAPTURE_BODY_TOTAL_LIMIT) {
    capture.bodiesDropped += 1
    return { text: '<body not captured: capture body budget exceeded>', truncated: false }
  }
  capture.bodyBytes += bytes
  return { text, truncated: text.length >= maxChars }
}
