#!/usr/bin/env node
/**
 * Aggregate tool usage from the local operation log. Read-only; used to decide
 * whether the default tool surface should be split into core + packs later.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const file = path.join(home, 'cache', 'dsh-chrome', 'operations.jsonl')
const limit = Number(process.argv[2]) > 0 ? Number(process.argv[2]) : 5000
let lines = []
try {
  lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).slice(-limit)
} catch {
  console.error(`no operation log at ${file}`)
  process.exit(1)
}
const tools = new Map()
let total = 0
let failures = 0
for (const line of lines) {
  let row
  try {
    row = JSON.parse(line)
  } catch {
    continue
  }
  const name = row.tool || '(unknown)'
  const entry = tools.get(name) || { tool: name, calls: 0, ok: 0, fail: 0, totalMs: 0, errors: {} }
  entry.calls += 1
  total += 1
  if (row.ok) entry.ok += 1
  else {
    entry.fail += 1
    failures += 1
    const code = row.errorCode || 'INTERNAL'
    entry.errors[code] = (entry.errors[code] || 0) + 1
  }
  entry.totalMs += Number(row.durationMs) || 0
  tools.set(name, entry)
}
const rows = [...tools.values()]
  .map((entry) => ({ ...entry, avgMs: entry.calls ? Math.round(entry.totalMs / entry.calls) : 0 }))
  .sort((a, b) => b.calls - a.calls)
console.log(`operation log: ${file}`)
console.log(`records: ${total}, failures: ${failures}, tools: ${rows.length}`)
console.log('tool\tcalls\tok\tfail\tavgMs\terrors')
for (const row of rows) {
  console.log(`${row.tool}\t${row.calls}\t${row.ok}\t${row.fail}\t${row.avgMs}\t${JSON.stringify(row.errors)}`)
}
