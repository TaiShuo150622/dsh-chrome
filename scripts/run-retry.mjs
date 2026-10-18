#!/usr/bin/env node
/** Run a command, retrying transient machine-load flakes. Not a substitute for fixing real failures. */
import { spawnSync } from 'node:child_process'

const [command, ...rest] = process.argv.slice(2)
const attemptsArg = rest.find((arg) => /^\d+$/.test(arg))
const attempts = attemptsArg ? Number(attemptsArg) : 3
const args = rest.filter((arg) => arg !== attemptsArg)
if (!command) {
  console.error('usage: node scripts/run-retry.mjs <command> [args...] [attempts]')
  process.exit(2)
}
for (let attempt = 1; attempt <= attempts; attempt += 1) {
  const result = spawnSync(command, args, { stdio: 'inherit' })
  if (result.status === 0) process.exit(0)
  console.error(`[run-retry] ${command} failed (attempt ${attempt}/${attempts}, status ${result.status})`)
}
process.exit(1)
