/**
 * Release feed parsing for the update checker (Q29): version comparison,
 * GitHub release selection, the timeout-bound fetch and the SHA-256 asset
 * lookup. Parsing/version/SHA behavior is unchanged.
 */

const RELEASES_URL = 'https://api.github.com/repos'
const CHECK_TIMEOUT_MS = 15_000

export function parseVersion(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(String(value || '').trim())
  if (!match) return null
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

export function compareVersions(a, b) {
  const left = Array.isArray(a) ? a : parseVersion(a)
  const right = Array.isArray(b) ? b : parseVersion(b)
  if (!left || !right) return 0
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1
  }
  return 0
}

async function fetchWithTimeout(fetchImpl, url, options = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS)
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

async function readSha(fetchImpl, release) {
  const asset = (release.assets || []).find((item) => /\.sha256$/i.test(String(item.name || '')))
  if (!asset?.browser_download_url) return null
  const response = await fetchWithTimeout(fetchImpl, asset.browser_download_url, { headers: { 'user-agent': 'dsh-chrome-update' } })
  if (!response.ok) return null
  const body = await response.text()
  const match = /([a-f0-9]{64})/i.exec(body)
  return match ? match[1].toLowerCase() : null
}

function pickRelease(releases, channel) {
  const candidates = (Array.isArray(releases) ? releases : [])
    .filter((release) => release && !release.draft)
    .filter((release) => channel === 'preview' || !release.prerelease)
    .map((release) => ({ release, version: parseVersion(release.tag_name) }))
    .filter((item) => item.version)
    .sort((a, b) => compareVersions(b.version, a.version))
  return candidates[0] || null
}

function releasesUrl(repository) {
  return `${RELEASES_URL}/${repository}/releases?per_page=20`
}

export { releasesUrl, fetchWithTimeout, readSha, pickRelease }
