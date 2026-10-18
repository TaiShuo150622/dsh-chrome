#!/usr/bin/env node
/**
 * Headless backend CPU/RSS benchmark.
 *
 * Starts a local HTTP page, runs a fixed scripted action sequence through the
 * headless CDP driver, and samples the Chrome process tree (CPU time / RSS)
 * before and after. Use the idle numbers from docs/HEADLESS.md for comparison.
 *
 * Usage: node scripts/headless-bench.mjs [--actions 20] [--seconds 10]
 */
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

import { HeadlessDriver } from '../src/headless.js'

const args = process.argv.slice(2)
const argValue = (name, fallback) => {
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] ? Number(args[index + 1]) : fallback
}
const ACTIONS = Math.max(5, Math.min(200, argValue('--actions', 20)))
const DURATION = Math.max(5, Math.min(60, argValue('--seconds', 10)))

const html = `<!doctype html><html><head><title>Headless Bench</title></head><body>
<h1>Headless Bench</h1>
<label>Q <input id="q" placeholder="q"></label>
<button id="go" onclick="document.getElementById('out').textContent=document.getElementById('q').value">Go</button>
<div id="out">ready</div>
<div id="bulk">${'<p>row</p>'.repeat(40)}</div>
</body></html>`

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' })
  res.end(html)
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const { port } = server.address()
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-headless-bench-'))
const profilePattern = path.join(home, 'cache', 'dsh-chrome', 'headless', 'profile')
const driver = new HeadlessDriver({ home })

function profilePids() {
  try {
    const out = execSync('ps -axo pid=,command=', { encoding: 'utf8' })
    return out
      .split('\n')
      .filter((line) => line.includes(profilePattern))
      .map((line) => Number(line.trim().split(/\s+/)[0]))
      .filter((pid) => Number.isFinite(pid))
  } catch {
    return []
  }
}

function processStats() {
  const pids = profilePids()
  if (pids.length === 0) return { cpuSeconds: 0, rssKb: 0, processes: 0 }
  const out = execSync(`ps -o pid=,time=,rss= -p ${pids.join(',')}`, { encoding: 'utf8' })
  let cpuSeconds = 0
  let rssKb = 0
  let processes = 0
  for (const line of out.trim().split('\n')) {
    const parts = line.trim().split(/\s+/)
    if (parts.length < 3) continue
    const time = parts[1]
    const rss = Number(parts[2]) || 0
    const chunks = time.split(/[-:]/).map(Number)
    let seconds = 0
    if (chunks.length === 2) seconds = chunks[0] * 60 + chunks[1]
    else if (chunks.length === 3) seconds = chunks[0] * 3600 + chunks[1] * 60 + chunks[2]
    else if (chunks.length === 4) seconds = chunks[0] * 86400 + chunks[1] * 3600 + chunks[2] * 60 + chunks[3]
    cpuSeconds += seconds
    rssKb += rss
    processes += 1
  }
  return { cpuSeconds, rssKb, processes }
}

try {
  await driver.ensureStarted()
  await driver.request('tab.goto', { owner: 'bench', url: `http://127.0.0.1:${port}/` })
  await driver.request('tab.snapshot', { owner: 'bench', maxChars: 5000 })
  const before = processStats()
  const t0 = Date.now()
  const until = t0 + DURATION * 1000
  let actions = 0
  while (Date.now() < until && actions < ACTIONS * 20) {
    const snap = await driver.request('tab.snapshot', { owner: 'bench', maxChars: 2000 })
    const input = snap.controls.find((control) => control.tag === 'input')
    if (input) await driver.request('tab.type', { owner: 'bench', ref: input.ref, text: `v${actions}`, replace: true })
    await driver.request('tab.screenshot', { owner: 'bench' })
    await driver.request('tab.scroll', { owner: 'bench', direction: actions % 2 === 0 ? 'down' : 'up', amount: 200 })
    actions += 1
  }
  const elapsed = (Date.now() - t0) / 1000
  const after = processStats()
  const cpuPercent = Math.round(((after.cpuSeconds - before.cpuSeconds) / elapsed) * 10000) / 100
  console.log(
    JSON.stringify(
      {
        scenario: `headless active: ${actions} snapshot/type/screenshot/scroll rounds`,
        elapsedSeconds: Math.round(elapsed * 10) / 10,
        actions,
        processes: after.processes,
        rssMb: Math.round(after.rssKb / 1024),
        cpuPercent,
        cpuSeconds: Math.round((after.cpuSeconds - before.cpuSeconds) * 100) / 100,
      },
      null,
      2,
    ),
  )
} finally {
  await driver.close()
  server.close()
  await new Promise((resolve) => setTimeout(resolve, 300))
  try {
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  } catch {
    // temp profile leak is harmless
  }
}
