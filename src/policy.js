/**
 * Provider-side site policy + audit for ordinary browser writes.
 *
 * Policy file (human-edited, never written by tools):
 *   ~/.dsh/cache/dsh-chrome/policy.json
 *   { "origins": { "https://example.com": "allow" | "ask" | "block" } }
 *
 * Audit file (append-only):
 *   ~/.dsh/cache/dsh-chrome/audit.jsonl
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const POLICY_MODES = ['allow', 'ask', 'block']

export function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

export function policyPath(home = dshHome()) {
  return path.join(home, 'cache', 'dsh-chrome', 'policy.json')
}

export function auditPath(home = dshHome()) {
  return path.join(home, 'cache', 'dsh-chrome', 'audit.jsonl')
}

export function originOf(url) {
  try {
    const parsed = new URL(String(url || ''))
    if (!/^https?:$/i.test(parsed.protocol)) return null
    return parsed.origin
  } catch {
    return null
  }
}

export function loadPolicy(home = dshHome()) {
  try {
    const parsed = JSON.parse(fs.readFileSync(policyPath(home), 'utf8'))
    const origins = {}
    for (const [origin, mode] of Object.entries(parsed?.origins || {})) {
      if (POLICY_MODES.includes(mode)) origins[origin] = mode
    }
    return { origins }
  } catch {
    return { origins: {} }
  }
}

export function resolvePolicy(policy, origin) {
  const normalized = originOf(origin) || (typeof origin === 'string' ? origin : '')
  const mode = normalized ? policy?.origins?.[normalized] : undefined
  return {
    origin: normalized || null,
    mode: mode ?? null,
    source: mode ? 'policy.json' : 'default',
  }
}

export function appendAudit(home, record) {
  try {
    const dir = path.dirname(auditPath(home))
    fs.mkdirSync(dir, { recursive: true })
    fs.appendFileSync(auditPath(home), `${JSON.stringify(record)}\n`, { mode: 0o600 })
    return true
  } catch {
    return false
  }
}

export function readAudit(home, { limit = 20, origin = null } = {}) {
  try {
    const lines = fs.readFileSync(auditPath(home), 'utf8').trim().split('\n').filter(Boolean)
    const entries = []
    for (let index = lines.length - 1; index >= 0 && entries.length < limit; index -= 1) {
      try {
        const entry = JSON.parse(lines[index])
        if (origin && entry.origin !== origin) continue
        entries.push(entry)
      } catch {
        // skip corrupt line
      }
    }
    return entries
  } catch {
    return []
  }
}
