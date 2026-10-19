/**
 * One real-headless soak round, end to end.
 *
 * The fixed workload's fixed counts are kept (4 tabs, 10 capture cycles, 10
 * screencast cycles); only the report directory and the small settle windows
 * are overridden. This is the layer the fake cannot cover: a real Chrome
 * launch, the real Network.getResponseBody accounting, real process-tree RSS
 * and a real `Browser.close` that must actually end the process tree.
 *
 * The long 20-round run is intentionally not part of `npm test`; run
 * `node benchmarks/soak.mjs` for that (see benchmarks/README.md).
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { headlessSupported, headlessChromeExecutable } from '../../src/headless.js'

if (process.env.CI && process.env.DSH_SOAK_STRICT !== '1') {
  console.log('SOAK REAL TEST: SKIP (CI: set DSH_SOAK_STRICT=1 to run a real Chrome soak)')
  process.exit(0)
}

if (!headlessSupported()) {
  console.log('SOAK REAL TEST: SKIP (no Chrome/Chromium found; set DSH_HEADLESS_CHROME)')
  process.exit(0)
}

const root = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))))
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-soak-real-'))
const reportDir = path.join(base, 'report')
try {
  const run = spawnSync(
    process.execPath,
    [
      path.join(root, 'benchmarks', 'soak.mjs'),
      '--rounds', '1',
      '--tabs', '4',
      '--captures', '10',
      '--screencasts', '10',
      '--settle-ms', '250',
      '--capture-settle-ms', '100',
      '--screencast-settle-ms', '120',
      '--no-gc',
      '--out', reportDir,
      '--quiet',
    ],
    { cwd: root, encoding: 'utf8', timeout: 240000 },
  )
  assert.equal(run.status, 0, `soak exited ${run.status}\nstdout: ${run.stdout}\nstderr: ${run.stderr}`)

  const files = fs.readdirSync(reportDir).filter((name) => name.endsWith('.json'))
  assert.equal(files.length, 1, `expected one JSON report: ${JSON.stringify(fs.readdirSync(reportDir))}`)
  const jsonPath = path.join(reportDir, files[0])
  const markdownPath = jsonPath.replace(/\.json$/, '.md')
  assert.ok(fs.existsSync(markdownPath), 'Markdown report was not written')
  const report = JSON.parse(fs.readFileSync(jsonPath, 'utf8'))

  assert.equal(report.kind, 'dsh-chrome-soak')
  assert.equal(report.scenario.driver, 'headless')
  assert.equal(report.scenario.rounds, 1)
  assert.equal(report.scenario.tabsPerRound, 4)
  assert.equal(report.scenario.captureCyclesPerRound, 10)
  assert.equal(report.scenario.screencastCyclesPerRound, 10)
  assert.equal(report.rounds.length, 1)
  assert.equal(report.summary.failedRounds, 0, `unexpected failures: ${JSON.stringify(report.summary.invariantFailures)}`)
  assert.equal(report.summary.invariantFailures.length, 0)
  assert.ok(report.run.executable, 'the real run did not record its browser executable')
  assert.equal(report.run.executable, headlessChromeExecutable())

  const round = report.rounds[0]
  assert.equal(round.ok, true)
  assert.deepEqual(round.actions, {
    contextCreate: 1,
    contextClose: 1,
    tabNew: 4,
    goto: 4,
    snapshot: 4,
    screenshot: 4,
    captureStart: 10,
    captureStop: 10,
    captureReload: 10,
    screencastStart: 10,
    screencastStop: 10,
    tabClose: 4,
  })
  assert.deepEqual(round.errors, [])
  assert.equal(round.peak.objects.tabs, 4)
  assert.equal(round.peak.objects.bySession, 4)
  assert.equal(round.peak.objects.owners, 1)
  assert.ok(round.peak.objects.captures >= 8 && round.peak.objects.captures <= 9, `capture peak wrong: ${round.peak.objects.captures}`)
  assert.ok(round.peak.objects.captureBodyBytes > 0, 'the capture body path was never exercised')
  assert.ok(round.peak.objects.captureEntries > 0)
  if (process.platform === 'win32') {
    assert.equal(round.peak.chromeRss, null, 'Windows must report Chrome RSS as unsupported')
  } else {
    assert.ok(round.peak.chromeRss > 0, 'Chrome process-tree RSS was not measured')
    assert.ok(round.peak.processCount > 0, 'Chrome process count was not measured')
  }
  assert.equal(round.close.exited, true, 'Chrome did not exit after context close')
  assert.ok(round.close.waitedMs >= 0)
  assert.equal(round.close.driverAfterClose.tabs, 0)
  assert.equal(round.close.driverAfterClose.bySession, 0)
  assert.equal(round.close.driverAfterClose.owners, 0)
  assert.equal(round.close.driverAfterClose.captures, 0)
  assert.equal(round.close.driverAfterClose.captureBodyBytes, 0)
  assert.equal(round.close.driverAfterClose.chromePid, null)
  assert.equal(round.endBaseline.objects.tabs, 0)
  assert.equal(round.endBaseline.objects.captures, 0)
  assert.equal(round.endBaseline.chromeRss, null)
  assert.equal(round.endBaseline.objects.pending, 0)
  assert.deepEqual(round.phases.map((phase) => phase.label), [
    'context-created',
    'tabs-open',
    'captures-done',
    'screencasts-done',
    'tabs-closed',
  ])
  assert.ok(Number.isFinite(report.summary.retainedAfterRun.node.rss))
  assert.ok(report.summary.peak.node.rss > 0)
  assert.ok(report.summary.peak.node.external > 0)

  const markdown = fs.readFileSync(markdownPath, 'utf8')
  assert.ok(markdown.includes('**Verdict: PASS**'))
  assert.ok(markdown.includes('driver: **headless**'))
  assert.ok(markdown.includes('Chrome subtree RSS'))

  console.log('SOAK REAL TEST: PASS')
} finally {
  try {
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  } catch {}
}
