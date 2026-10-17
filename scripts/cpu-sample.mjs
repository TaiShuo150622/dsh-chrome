#!/usr/bin/env node
/**
 * Sample CPU usage of Chrome / DSH / native host over N seconds via ps time deltas.
 * Usage: npm run cpu:sample -- 120
 */
import { execSync } from 'node:child_process'

function snapshot() {
  const out = execSync('ps -axo pid=,time=,command=', { encoding: 'utf8' })
  const rows = []
  for (const line of out.split('\n')) {
    const match = line.trim().match(/^(\d+)\s+([\d:.]+)\s+(.+)$/)
    if (!match) continue
    const [, pid, time, command] = match
    const parts = time.split(':').map(Number)
    let seconds = 0
    for (const part of parts) seconds = seconds * 60 + part
    rows.push({ pid: Number(pid), cpuSeconds: seconds, command })
  }
  return rows
}

const groups = {
  chrome: (row) => row.command.includes('Google Chrome'),
  dsh: (row) => row.command.includes('DeepSeek Harness') && !row.command.includes('host.mjs'),
  host: (row) => row.command.includes('host.mjs'),
  httpServer: (row) => row.command.includes('http.server'),
}

const seconds = Number(process.argv[2] || 60)
const started = Date.now()
const first = snapshot()
await new Promise((resolve) => setTimeout(resolve, seconds * 1000))
const second = snapshot()
const elapsed = (Date.now() - started) / 1000
const firstByPid = new Map(first.map((row) => [row.pid, row.cpuSeconds]))
const report = {}
for (const [name, match] of Object.entries(groups)) {
  let delta = 0
  let procs = 0
  for (const row of second) {
    if (!match(row)) continue
    const before = firstByPid.get(row.pid) ?? row.cpuSeconds
    delta += Math.max(0, row.cpuSeconds - before)
    procs += 1
  }
  report[name] = { cpuPercent: Number(((delta / elapsed) * 100).toFixed(2)), processes: procs }
}
if (elapsed < 10) {
  console.error('sample window too short; pass seconds (e.g. npm run cpu:sample -- 120)')
  process.exit(1)
}
console.log(JSON.stringify({ elapsedSeconds: elapsed, report }, null, 2))
