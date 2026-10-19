/**
 * Loopback/link-local/private target classification for `chrome_verify`.
 *
 * `chrome_verify` is the only tool that navigates a model-supplied URL inside
 * an isolated headless context without the desktop page itself being the user's
 * own browsing target. That makes it the one navigation path where a URL is a
 * potential SSRF primitive against local services (`127.0.0.1`, `10/8`,
 * `169.254.169.254`, `::1`, `fc00::/7`, …), so navigations reject those targets
 * by default. The allowlist is injected by tests; it is not read from config,
 * environment variables or model input, so there is no runtime switch a caller
 * can flip to reach the local network through this tool.
 *
 * WHATWG URL normalizes the shorthand IPv4 forms (`2130706433`, `0x7f.1`) to
 * dotted quads and embedded IPv4 (`::ffff:127.0.0.1`) to hextets, so parsing the
 * normalized `hostname` is enough for literal addresses. Names are matched
 * against known-local suffixes; no DNS resolution is performed here (a DNS
 * rebinding check belongs at navigation time, not in this pure classifier).
 */

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

// RFC 6761/6762/8375 and the common cloud metadata aliases. A bare single-label
// hostname has no public DNS meaning: it resolves through a local search domain,
// which is exactly the private network this guard keeps the model out of.
const LOCAL_HOST_SUFFIXES = ['localhost', 'local', 'internal', 'home.arpa']

function normalizeHost(hostname) {
  let host = String(hostname || '').trim().toLowerCase()
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1)
  if (host.endsWith('.')) host = host.slice(0, -1)
  return host
}

function classifyIpv4(a, b, c, d) {
  if ([a, b, c, d].some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null
  if (a === 127) return 'loopback' // 127.0.0.0/8
  if (a === 169 && b === 254) return 'link-local' // 169.254.0.0/16 (incl. cloud metadata)
  if (a === 10) return 'private' // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return 'private' // 172.16.0.0/12
  if (a === 192 && b === 168) return 'private' // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return 'private' // 100.64.0.0/10 CGNAT
  if (a === 0) return 'unspecified' // 0.0.0.0/8
  if (a === 192 && b === 0 && c === 0) return 'reserved' // 192.0.0.0/24
  if (a === 192 && b === 0 && c === 2) return 'reserved' // TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return 'reserved' // 198.18.0.0/15
  if (a === 198 && b === 51 && c === 100) return 'reserved' // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return 'reserved' // TEST-NET-3
  if (a >= 224) return 'reserved' // multicast + reserved + broadcast
  return null
}

/** Expand an IPv6 literal (without brackets) to eight 16-bit groups. */
function expandIpv6(host) {
  const halves = host.split('::')
  if (halves.length > 2) return null
  const parse = (part) =>
    part
      ? part.split(':').map((group) => {
          if (!/^[0-9a-f]{1,4}$/i.test(group)) return NaN
          return parseInt(group, 16)
        })
      : []
  const head = parse(halves[0])
  const tail = halves.length === 2 ? parse(halves[1]) : []
  if ([...head, ...tail].some((group) => Number.isNaN(group))) return null
  if (halves.length === 2) {
    const missing = 8 - head.length - tail.length
    if (missing < 1) return null
    return [...head, ...Array.from({ length: missing }, () => 0), ...tail]
  }
  return head.length === 8 ? head : null
}

function classifyIpv6(host) {
  const groups = expandIpv6(host)
  if (!groups) return null
  if (groups.every((group) => group === 0)) return 'unspecified'
  if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) return 'loopback'
  // ::ffff:0:0/96 IPv4-mapped and the deprecated ::/96 IPv4-compatible space.
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    return classifyIpv4(groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff)
  }
  if (groups.slice(0, 6).every((group) => group === 0)) {
    return classifyIpv4(groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff)
  }
  const first = groups[0]
  if ((first & 0xfe00) === 0xfc00) return 'private' // fc00::/7 unique local
  if ((first & 0xffc0) === 0xfe80) return 'link-local' // fe80::/10
  if ((first & 0xffc0) === 0xfec0) return 'private' // fec0::/10 deprecated site-local
  if (first === 0x2001 && groups[1] === 0x0db8) return 'reserved' // 2001:db8::/32 docs
  if (first === 0x0064 && groups[1] === 0xff9b) {
    // 64:ff9b::/96 NAT64: the embedded IPv4 decides whether the target is local.
    return classifyIpv4(groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff)
  }
  if ((first & 0xff00) === 0xff00) return 'reserved' // ff00::/8 multicast
  return null
}

function classifyHostname(hostname) {
  const host = normalizeHost(hostname)
  if (!host) return null
  const ipv4 = host.match(IPV4)
  if (ipv4) {
    return classifyIpv4(
      Number(ipv4[1]),
      Number(ipv4[2]),
      Number(ipv4[3]),
      Number(ipv4[4]),
    )
  }
  if (host.includes(':')) return classifyIpv6(host)
  if (host === 'metadata.google.internal' || host === 'metadata.goog') return 'link-local'
  for (const suffix of LOCAL_HOST_SUFFIXES) {
    if (host === suffix || host.endsWith(`.${suffix}`)) {
      return suffix === 'localhost' ? 'loopback' : 'local-hostname'
    }
  }
  // A single-label name has no public DNS identity.
  if (!host.includes('.')) return 'local-hostname'
  return null
}

function effectivePort(url) {
  if (url.port) return Number(url.port)
  return url.protocol === 'https:' ? 443 : 80
}

/**
 * Classify one URL as a verify navigation target.
 *
 * Returns `{ http, protocol, hostname, port, origin, reason }`. `reason` is
 * `null` for a public target and one of `loopback` / `link-local` / `private` /
 * `unspecified` / `reserved` / `local-hostname` for a blocked one. URLs that are
 * not http(s) are reported with `http:false` and no reason: the navigation
 * validator rejects those separately with PROTECTED_PAGE.
 */
export function classifyTarget(rawUrl) {
  let url
  try {
    url = new URL(String(rawUrl ?? ''))
  } catch {
    return { http: false, protocol: null, hostname: '', port: null, origin: null, reason: null }
  }
  const http = url.protocol === 'http:' || url.protocol === 'https:'
  return {
    http,
    protocol: http ? url.protocol : null,
    hostname: normalizeHost(url.hostname),
    port: http ? effectivePort(url) : null,
    origin: http ? url.origin : null,
    reason: http ? classifyHostname(url.hostname) : null,
  }
}

/**
 * Does an explicit allowlist entry cover this target?
 *
 * Entries are hosts (`localhost`, `[::1]`), host:port pairs (`127.0.0.1:8765`)
 * or full URLs (`http://127.0.0.1:8765`). An entry without a port matches every
 * port on that host; an entry with a port must match the effective port. The
 * list is expected to be injected by tests, never taken from a tool argument.
 */
export function targetAllowedByAllowlist(target, allowlist) {
  if (!target?.http || !Array.isArray(allowlist) || allowlist.length === 0) return false
  for (const raw of allowlist) {
    const entry = String(raw ?? '').trim()
    if (!entry) continue
    let parsed
    let scheme = null
    try {
      if (entry.includes('://')) {
        parsed = new URL(entry)
        scheme = parsed.protocol
      } else {
        parsed = new URL(`http://${entry}`)
      }
    } catch {
      continue
    }
    const host = normalizeHost(parsed.hostname)
    if (host !== target.hostname) continue
    if (scheme && scheme !== target.protocol) continue
    if (parsed.port && Number(parsed.port) !== target.port) continue
    return true
  }
  return false
}
