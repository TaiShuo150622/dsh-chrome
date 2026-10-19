#!/usr/bin/env node
/**
 * Fixed memory soak for the headless backend.
 *
 * Default workload (docs/LIFECYCLE.md "固定压测"): 20 rounds, 1 context and 4
 * tabs per round, each tab goto+snapshot+screenshot, 10 capture start/stop,
 * 10 screencast start/stop, close tabs/context, wait for Chrome to exit, then
 * sample the after-close baseline.
 *
 * Usage:
 *   node benchmarks/soak.mjs
 *   node benchmarks/soak.mjs --rounds 1 --out /tmp/soak --strict
 *   node benchmarks/soak.mjs --fake --rounds 1          # report-path smoke, no Chrome
 *   node --expose-gc benchmarks/soak.mjs                # no child re-exec
 *
 * Output: one JSON report and one Markdown report (printed paths). Default
 * directory is ~/.dsh/cache/dsh-chrome/soak; nothing is written into the repo
 * unless --out points there. Reports declare `driver: "fake"` for --fake and
 * are not comparable to real runs.
 *
 * Exit code: 0 clean; 1 when a round failed or an invariant failed (unless
 * --no-strict); 2 when the real driver was requested but no browser exists.
 */
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { headlessSupported } from '../src/headless.js'
import { formatSummary } from './lib/report.mjs'
import { SOAK_DEFAULTS, runSoak } from './lib/run-soak.mjs'

const HELP = `DSH Chrome fixed memory soak

Usage: node benchmarks/soak.mjs [options]

Workload options (defaults are the fixed workload):
  --rounds N                rounds (default ${SOAK_DEFAULTS.rounds})
  --tabs N                  tabs per round (default ${SOAK_DEFAULTS.tabsPerRound})
  --captures N              capture start/stop cycles per round (default ${SOAK_DEFAULTS.captureCyclesPerRound})
  --screencasts N           screencast start/stop cycles per round (default ${SOAK_DEFAULTS.screencastCyclesPerRound})
  --page-bytes N            local page body size (default ${SOAK_DEFAULTS.pageBytes})
  --capture-traffic reload|none
                            reload/capture a page in each capture cycle (default reload)

Measurement options:
  --settle-ms N             wait after Chrome exit before the end baseline (default ${SOAK_DEFAULTS.settleMs})
  --exit-timeout-ms N       max wait for Chrome exit (default ${SOAK_DEFAULTS.exitTimeoutMs})
  --capture-settle-ms N     body-capture settle inside a capture cycle (default ${SOAK_DEFAULTS.captureSettleMs})
  --screencast-settle-ms N  frame settle inside a screencast cycle (default ${SOAK_DEFAULTS.screencastSettleMs})
  --out DIR                 report directory (default ~/.dsh/cache/dsh-chrome/soak)
  --home DIR                browser/profile home (kept; default a temp dir removed after the run)
  --keep-home               keep the generated temp home
  --no-gc                   do not auto re-exec with --expose-gc (heap baselines less comparable)
  --no-strict               exit 0 even when rounds/invariants fail

Other:
  --fake                    deterministic fake driver (report smoke test only)
  --fake-leak tabs|captures  --fake only: inject a known leak (failure-path test)
  --json                    print the full JSON report to stdout
  --quiet                   no per-round progress on stderr
  --help                    this text
`

function parseNumber(value, name) {
  const number = Number(value)
  if (!Number.isFinite(number)) throw new Error(`${name} expects a number, got ${JSON.stringify(value)}`)
  return number
}

function parseArgs(argv) {
  const options = {
    rounds: SOAK_DEFAULTS.rounds,
    tabsPerRound: SOAK_DEFAULTS.tabsPerRound,
    captureCyclesPerRound: SOAK_DEFAULTS.captureCyclesPerRound,
    screencastCyclesPerRound: SOAK_DEFAULTS.screencastCyclesPerRound,
    pageBytes: SOAK_DEFAULTS.pageBytes,
    captureTraffic: SOAK_DEFAULTS.captureTraffic,
    settleMs: SOAK_DEFAULTS.settleMs,
    exitTimeoutMs: SOAK_DEFAULTS.exitTimeoutMs,
    captureSettleMs: SOAK_DEFAULTS.captureSettleMs,
    screencastSettleMs: SOAK_DEFAULTS.screencastSettleMs,
    gc: true,
    strict: true,
    fake: false,
    fakeLeak: null,
    json: false,
    quiet: false,
    keepHome: false,
    outDir: null,
    home: null,
  }
  const take = (index, name) => {
    if (index + 1 >= argv.length) throw new Error(`${name} requires a value`)
    return argv[index + 1]
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    switch (arg) {
      case '--rounds': options.rounds = parseNumber(take(index, arg), arg); index += 1; break
      case '--tabs': options.tabsPerRound = parseNumber(take(index, arg), arg); index += 1; break
      case '--captures': options.captureCyclesPerRound = parseNumber(take(index, arg), arg); index += 1; break
      case '--screencasts': options.screencastCyclesPerRound = parseNumber(take(index, arg), arg); index += 1; break
      case '--page-bytes': options.pageBytes = parseNumber(take(index, arg), arg); index += 1; break
      case '--settle-ms': options.settleMs = parseNumber(take(index, arg), arg); index += 1; break
      case '--exit-timeout-ms': options.exitTimeoutMs = parseNumber(take(index, arg), arg); index += 1; break
      case '--capture-settle-ms': options.captureSettleMs = parseNumber(take(index, arg), arg); index += 1; break
      case '--screencast-settle-ms': options.screencastSettleMs = parseNumber(take(index, arg), arg); index += 1; break
      case '--capture-traffic': {
        const value = take(index, arg)
        if (value !== 'reload' && value !== 'none') throw new Error(`--capture-traffic expects reload|none, got ${value}`)
        options.captureTraffic = value
        index += 1
        break
      }
      case '--out': options.outDir = take(index, arg); index += 1; break
      case '--home': options.home = take(index, arg); index += 1; break
      case '--keep-home': options.keepHome = true; break
      case '--no-gc': options.gc = false; break
      case '--no-strict': options.strict = false; break
      case '--fake': options.fake = true; break
      case '--fake-leak': {
        const value = take(index, arg)
        if (value !== 'tabs' && value !== 'captures') throw new Error(`--fake-leak expects tabs|captures, got ${value}`)
        options.fakeLeak = value
        index += 1
        break
      }
      case '--json': options.json = true; break
      case '--quiet': options.quiet = true; break
      case '--help': options.help = true; break
      default:
        throw new Error(`unknown option ${arg}`)
    }
  }
  return options
}

function defaultOutDir() {
  return path.join(os.homedir(), '.dsh', 'cache', 'dsh-chrome', 'soak')
}

async function maybeReexecWithGc(options) {
  if (!options.gc || typeof global.gc === 'function') return false
  if (process.env.DSH_SOAK_REEXEC === '1') return false
  const script = fileURLToPath(import.meta.url)
  const child = spawn(process.execPath, ['--expose-gc', script, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: { ...process.env, DSH_SOAK_REEXEC: '1' },
  })
  const result = await new Promise((resolve) => {
    child.once('error', (error) => resolve({ error }))
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })
  if (result.error) throw result.error
  process.exit(result.code ?? (result.signal ? 1 : 0))
  return true
}

async function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error(`soak: ${error.message}`)
    console.error(HELP)
    process.exitCode = 2
    return
  }
  if (options.help) {
    console.log(HELP)
    return
  }
  await maybeReexecWithGc(options)
  if (!options.fake && !headlessSupported()) {
    console.error('soak: no Chrome/Chromium found for the headless backend; set DSH_HEADLESS_CHROME or use --fake')
    process.exitCode = 2
    return
  }
  const outDir = options.outDir || defaultOutDir()
  const log = options.quiet ? () => {} : (line) => process.stderr.write(`${line}\n`)
  let result
  try {
    result = await runSoak({
      rounds: options.rounds,
      tabsPerRound: options.tabsPerRound,
      captureCyclesPerRound: options.captureCyclesPerRound,
      screencastCyclesPerRound: options.screencastCyclesPerRound,
      pageBytes: options.pageBytes,
      captureTraffic: options.captureTraffic,
      settleMs: options.settleMs,
      exitTimeoutMs: options.exitTimeoutMs,
      captureSettleMs: options.captureSettleMs,
      screencastSettleMs: options.screencastSettleMs,
      gc: options.gc,
      strict: options.strict,
      driverKind: options.fake ? 'fake' : 'headless',
      fakeLeak: options.fakeLeak,
      outDir,
      home: options.home || undefined,
      keepHome: options.keepHome,
      log,
    })
  } catch (error) {
    console.error(`soak: failed: ${error?.stack || error?.message || String(error)}`)
    process.exitCode = 1
    return
  }
  if (options.json) {
    console.log(JSON.stringify(result.report, null, 2))
  } else {
    console.log(formatSummary(result.report))
  }
  if (result.report.strictFailure) process.exitCode = 1
}

await main()
