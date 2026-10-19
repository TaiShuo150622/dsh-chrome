/**
 * Soak harness logic tests — no Chrome required.
 *
 * These run the *exact* workload through the real BrowserContextManager and the
 * real memory aggregation, with a deterministic fake driver. They assert:
 *
 *   - the fixed workload really performs 4 tabs × (goto+snapshot+screenshot),
 *     10 capture cycles, 10 screencast cycles and a full close per round;
 *   - peak / after-close baseline / retainedAfterRun are computed and written
 *     to both JSON and Markdown;
 *   - a clean run has zero invariant failures;
 *   - injected leaks (tabs, capture bodies, a Chrome process that refuses to
 *     die) produce the matching invariant failures instead of a false PASS;
 *   - the CLI smoke path writes the same report shape and exits 1 when strict
 *     and a leak is injected.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { runSoak } from '../../benchmarks/lib/run-soak.mjs'
import { createFakeDriverFactory } from '../../benchmarks/lib/fake-driver.mjs'

const root = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))))
const sleep = async () => {}
const makeBase = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `dsh-soak-${name}-`))
const cleanup = (base) => {
  try {
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  } catch {}
}
const failureCodes = (report) => report.summary.invariantFailures.map((failure) => failure.code)

async function runFake(base, { factory = createFakeDriverFactory({}), ...options } = {}) {
  return runSoak({
    rounds: 2,
    driverKind: 'fake',
    createDriver: factory.createDriver,
    home: path.join(base, 'home'),
    outDir: path.join(base, 'report'),
    gc: false,
    strict: true,
    settleMs: 0,
    exitTimeoutMs: 10,
    exitPollMs: 1,
    captureSettleMs: 0,
    screencastSettleMs: 0,
    sleep,
    ...options,
  })
}

// ---------------------------------------------------------------- clean run
{
  const base = makeBase('clean')
  try {
    const factory = createFakeDriverFactory({})
    const { report, jsonPath, markdownPath } = await runFake(base, { factory, rounds: 2 })
    assert.equal(report.schemaVersion, 1)
    assert.equal(report.kind, 'dsh-chrome-soak')
    assert.equal(report.scenario.driver, 'fake')
    assert.equal(report.scenario.rounds, 2)
    assert.equal(report.scenario.tabsPerRound, 4)
    assert.equal(report.scenario.captureCyclesPerRound, 10)
    assert.equal(report.scenario.screencastCyclesPerRound, 10)
    assert.equal(report.rounds.length, 2)
    assert.equal(factory.drivers.length, 2, 'one driver must be created per round')
    assert.equal(report.summary.failedRounds, 0)
    assert.equal(report.summary.invariantFailures.length, 0)

    const expected = {
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
    }
    for (const round of report.rounds) {
      assert.equal(round.ok, true, `round ${round.round} not clean: ${JSON.stringify(round.invariants.failures)}`)
      assert.deepEqual(round.actions, expected, `round ${round.round} action counts drifted`)
      assert.deepEqual(round.errors, [])
      assert.equal(round.close.exited, true)
      assert.equal(round.close.driverAfterClose.tabs, 0)
      assert.equal(round.close.driverAfterClose.owners, 0)
      assert.equal(round.close.driverAfterClose.bySession, 0)
      assert.equal(round.close.driverAfterClose.captures, 0)
      assert.equal(round.close.driverAfterClose.captureBodyBytes, 0)
      assert.equal(round.peak.objects.tabs, 4)
      assert.equal(round.peak.objects.bySession, 4)
      assert.equal(round.peak.objects.owners, 1)
      assert.ok(round.peak.objects.captures >= 8 && round.peak.objects.captures <= 9, `capture peak wrong: ${round.peak.objects.captures}`)
      assert.ok(round.peak.objects.captureBodyBytes > 0, 'capture body peak was not exercised')
      assert.equal(round.endBaseline.objects.tabs, 0)
      assert.equal(round.endBaseline.objects.captures, 0)
      assert.equal(round.endBaseline.objects.captureBodyBytes, 0)
      assert.deepEqual(round.phases.map((phase) => phase.label), [
        'context-created',
        'tabs-open',
        'captures-done',
        'screencasts-done',
        'tabs-closed',
      ])
      assert.ok(round.retained && Number.isFinite(round.retained.node.rss))
    }
    assert.equal(report.summary.peak.objects.tabs, 4)
    assert.equal(report.summary.peak.objects.bySession, 4)
    assert.ok(report.summary.peak.objects.captureBodyBytes > 0)
    assert.equal(report.summary.retainedAfterRun.objects.tabs, 0)
    assert.equal(report.summary.endBaseline.node.rss.samples, 2)
    assert.equal(report.summary.perRound.rssEnd.length, 2)

    assert.ok(jsonPath && fs.existsSync(jsonPath), 'JSON report was not written')
    assert.ok(markdownPath && fs.existsSync(markdownPath), 'Markdown report was not written')
    const onDisk = JSON.parse(fs.readFileSync(jsonPath, 'utf8'))
    assert.equal(onDisk.rounds.length, 2)
    assert.equal(onDisk.scenario.id, report.scenario.id)
    const markdown = fs.readFileSync(markdownPath, 'utf8')
    assert.ok(markdown.includes('**Verdict: PASS**'), 'Markdown does not carry the verdict')
    assert.ok(markdown.includes('| 1 |'), 'Markdown has no per-round table')
    assert.ok(markdown.includes('retained after run'), 'Markdown has no retained summary')
    console.log('clean fake run: PASS (2 rounds, JSON+Markdown)')
  } finally {
    cleanup(base)
  }
}

// ------------------------------------------------- injected tab-close leak
{
  const base = makeBase('leak-tabs')
  try {
    const factory = createFakeDriverFactory({ leakTabs: true })
    const { report } = await runFake(base, { factory, rounds: 1 })
    const codes = failureCodes(report)
    assert.equal(report.summary.failedRounds, 1)
    assert.ok(
      codes.some((code) => code.startsWith('tabs-closed-')),
      `expected a tabs-closed invariant failure, got ${JSON.stringify(codes)}`,
    )
    assert.equal(report.strictFailure, true)
    console.log('leak tabs: PASS (failure detected, strictFailure set)')
  } finally {
    cleanup(base)
  }
}

// ------------------------------------------------- injected capture leak
{
  const base = makeBase('leak-captures')
  try {
    const factory = createFakeDriverFactory({ leakCaptures: true })
    const { report } = await runFake(base, { factory, rounds: 1 })
    const codes = failureCodes(report)
    assert.equal(report.summary.failedRounds, 1)
    assert.ok(codes.includes('capture-body-released-on-stop'), `missing body-release failure: ${JSON.stringify(codes)}`)
    assert.ok(codes.includes('capture-summaries-over-limit'), `missing capture-limit failure: ${JSON.stringify(codes)}`)
    console.log('leak captures: PASS (body + summary limit detected)')
  } finally {
    cleanup(base)
  }
}

// ------------------------------------- Chrome that refuses to exit after close
{
  const base = makeBase('chrome-stuck')
  try {
    const factory = createFakeDriverFactory({})
    const { report } = await runFake(base, {
      factory,
      rounds: 1,
      probeChrome: () => ({ rss: 1024 * 1024, processCount: 1 }),
      exitTimeoutMs: 0,
    })
    assert.equal(report.rounds[0].close.exited, false)
    assert.ok(failureCodes(report).includes('chrome-process-exited'), `missing chrome exit failure: ${JSON.stringify(failureCodes(report))}`)
    console.log('chrome still alive: PASS (exit timeout detected)')
  } finally {
    cleanup(base)
  }
}

// ---------------------------------------------------------------- CLI smoke
{
  const base = makeBase('cli')
  try {
    const reportDir = path.join(base, 'report')
    const common = [
      path.join(root, 'benchmarks', 'soak.mjs'),
      '--fake',
      '--rounds',
      '1',
      '--tabs',
      '2',
      '--captures',
      '2',
      '--screencasts',
      '2',
      '--no-gc',
      '--out',
      reportDir,
      '--quiet',
    ]
    const clean = spawnSync(process.execPath, common, { cwd: root, encoding: 'utf8', timeout: 120000 })
    assert.equal(clean.status, 0, `clean CLI exited ${clean.status}\nstdout: ${clean.stdout}\nstderr: ${clean.stderr}`)
    const files = fs.readdirSync(reportDir).filter((name) => name.endsWith('.json'))
    assert.equal(files.length, 1, `expected one JSON report, got ${JSON.stringify(fs.readdirSync(reportDir))}`)
    const cliReport = JSON.parse(fs.readFileSync(path.join(reportDir, files[0]), 'utf8'))
    assert.equal(cliReport.scenario.tabsPerRound, 2)
    assert.equal(cliReport.scenario.captureCyclesPerRound, 2)
    assert.equal(cliReport.summary.invariantFailures.length, 0)
    assert.match(cliReport.scenario.id, /^[0-9a-f]{12}$/)
    assert.equal(cliReport.scenario.driver, 'fake')

    const leak = spawnSync(process.execPath, [...common, '--fake-leak', 'tabs'], { cwd: root, encoding: 'utf8', timeout: 120000 })
    assert.equal(leak.status, 1, `strict leak CLI should exit 1, got ${leak.status}\nstdout: ${leak.stdout}\nstderr: ${leak.stderr}`)
    const leakFiles = fs.readdirSync(reportDir).filter((name) => name.endsWith('.json'))
    assert.equal(leakFiles.length, 2, 'strict leak run did not write its report')
    const leakReport = JSON.parse(fs.readFileSync(path.join(reportDir, leakFiles.sort().at(-1)), 'utf8'))
    assert.equal(leakReport.summary.failedRounds, 1)
    assert.ok(leakReport.summary.invariantFailures.length > 0)
    console.log('CLI fake smoke: PASS (clean exit 0, injected leak exit 1)')
  } finally {
    cleanup(base)
  }
}

console.log('SOAK LOGIC TEST: PASS')
