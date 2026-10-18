import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { headlessSupported } from '../src/headless.js'

if (!headlessSupported()) {
  console.log(`BENCH SCENARIO TEST: SKIP (no Chrome/Chromium found; set DSH_HEADLESS_CHROME)`)
  process.exit(0)
}

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
// Four seconds of mixed rounds at the 150-400ms cadence is at least six rounds
// even on a loaded machine, so the rotation has to have visited every kind.
const result = spawnSync(
  process.execPath,
  [path.join(root, 'scripts', 'headless-bench.mjs'), '--seconds', '4', '--mixed', '--idle-seconds', '1'],
  { cwd: root, encoding: 'utf8', timeout: 120000 },
)
assert.equal(result.status, 0, `bench exited ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`)
const report = JSON.parse(result.stdout)

// The new scenario itself: rotation coverage, deterministic agent-like cadence,
// and an idle window that really waited.
assert.equal(report.mixedMode, true)
assert.ok(report.scenario.includes('headless mixed'), `unexpected scenario: ${report.scenario}`)
assert.ok(report.actions >= 6, `too few rounds to cover the rotation: ${report.actions}`)
assert.equal(
  Object.values(report.mixed.kinds).reduce((sum, count) => sum + count, 0),
  report.actions,
  `rotation counts do not add up to the rounds: ${JSON.stringify(report.mixed.kinds)}`,
)
for (const kind of ['type', 'click', 'evaluate', 'noopClick', 'scroll']) {
  assert.ok(report.mixed.kinds[kind] >= 1, `mixed rotation never ran ${kind}: ${JSON.stringify(report.mixed.kinds)}`)
}
assert.equal(report.mixed.gapMode, 'cadence-150-400')
assert.equal(report.mixed.gapMs.samples, report.actions, 'cadence was not applied to every round')
assert.ok(report.mixed.gapMs.min >= 150 && report.mixed.gapMs.max <= 400, `cadence out of range: ${JSON.stringify(report.mixed.gapMs)}`)
assert.ok(report.mixed.gapMs.mean >= 150 && report.mixed.gapMs.mean <= 400, `cadence mean out of range: ${JSON.stringify(report.mixed.gapMs)}`)
// The top-level gapMs is the effective gap (it used to be 0 for mixed because
// --gap-ms was absent, which contradicted the realized 150-400ms cadence).
assert.ok(report.gapMs >= 150 && report.gapMs <= 400, `effective gap not reported: ${report.gapMs}`)
assert.equal(report.idle.requestedSeconds, 1)
assert.equal(report.idle.settleSeconds, 0)
assert.ok(report.idle.browserUptimeSeconds > 0, `idle sample lost browser uptime: ${JSON.stringify(report.idle)}`)
assert.ok(report.idle.seconds >= 0.9, `idle window was cut short: ${JSON.stringify(report.idle)}`)
assert.ok(report.idle.rssMb > 0 && report.idle.processes > 0, `idle sample lost the process tree: ${JSON.stringify(report.idle)}`)
assert.ok(Number.isFinite(report.idle.streamFrames) && report.idle.streamFrames >= 0, `idle frame counter missing: ${JSON.stringify(report.idle)}`)

// Snapshot response bytes: the metric a text-budget regression moves. The bench
// page is small, so this is a contract check (one sample per round, non-zero,
// max >= mean), not a calibration.
assert.equal(report.snapshot.maxChars, 2000)
assert.equal(report.snapshot.calls, report.actions)
assert.ok(report.snapshot.bytesMean > 100, `snapshot bytes look unmeasured: ${JSON.stringify(report.snapshot)}`)
assert.ok(report.snapshot.bytesMax >= report.snapshot.bytesMean, `snapshot byte bounds wrong: ${JSON.stringify(report.snapshot)}`)

// The pre-existing metrics must still be there and still mean the same thing.
assert.ok(report.perActionMs.snapshot > 0 && report.perActionMs.screenshot > 0, `per-action timing missing: ${JSON.stringify(report.perActionMs)}`)
assert.ok(report.perActionMs.roundTotal > 0)
assert.ok(report.cpuMsPerAction > 0 && report.cpuPercent > 0, `CPU metrics missing: ${JSON.stringify(report)}`)
assert.ok(report.screenshotStream !== null && report.screenshotStream.served > 0, `frame-stream counters missing: ${JSON.stringify(report.screenshotStream)}`)
assert.equal(report.screenshot.format, 'png')
assert.ok(Number.isFinite(report.delta.rssPercent))

// `--press` (docs/HEADLESS.md §4.1.12): the no-op key press scenario must
// spend its rounds in the shortcut (every round paint-free), not in the ~40ms
// repaint window. Before the press probe every round was a repaint miss.
const pressRun = spawnSync(
  process.execPath,
  [path.join(root, 'scripts', 'headless-bench.mjs'), '--seconds', '4', '--press'],
  { cwd: root, encoding: 'utf8', timeout: 120000 },
)
assert.equal(pressRun.status, 0, `press bench exited ${pressRun.status}\nstdout: ${pressRun.stdout}\nstderr: ${pressRun.stderr}`)
const press = JSON.parse(pressRun.stdout)
assert.equal(press.pressMode, true)
assert.ok(press.scenario.includes('snapshot/press'), `unexpected press scenario: ${press.scenario}`)
assert.ok(press.actions >= 100, `too few press rounds: ${press.actions}`)
assert.ok(press.perActionMs.press > 0 && press.perActionMs.screenshot > 0, `press timings missing: ${JSON.stringify(press.perActionMs)}`)
assert.ok(press.perActionMs.screenshot < 5, `press screenshots still pay the repaint window: ${press.perActionMs.screenshot}ms`)
assert.equal(
  press.visualSkips,
  press.actions + 1,
  `not every press round was proven paint-free: ${JSON.stringify({ visualSkips: press.visualSkips, actions: press.actions })}`,
)
assert.equal(press.screenshotStream.repaintMisses, 0, `press rounds paid the repaint window: ${JSON.stringify(press.screenshotStream)}`)
assert.ok(press.press.keys.Escape > 0 && press.press.keys.k > 0, `press rotation missing keys: ${JSON.stringify(press.press)}`)

// `--click-at` (docs/HEADLESS.md §4.1.13): real pointer rounds at one settled
// point. Every measured round must be proven paint-free; a driver without the
// pointer probe pays the ~40ms repaint window on every round instead.
const clickAtRun = spawnSync(
  process.execPath,
  [path.join(root, 'scripts', 'headless-bench.mjs'), '--seconds', '4', '--click-at'],
  { cwd: root, encoding: 'utf8', timeout: 120000 },
)
assert.equal(clickAtRun.status, 0, `click-at bench exited ${clickAtRun.status}\nstdout: ${clickAtRun.stdout}\nstderr: ${clickAtRun.stderr}`)
const clickAt = JSON.parse(clickAtRun.stdout)
assert.equal(clickAt.clickAtMode, true)
assert.ok(clickAt.scenario.includes('snapshot/clickAt'), `unexpected click-at scenario: ${clickAt.scenario}`)
assert.ok(clickAt.clickAtPoint && Number.isFinite(clickAt.clickAtPoint.x) && Number.isFinite(clickAt.clickAtPoint.y), `click-at point missing: ${JSON.stringify(clickAt.clickAtPoint)}`)
assert.ok(clickAt.actions >= 100, `too few click-at rounds: ${clickAt.actions}`)
assert.ok(clickAt.perActionMs.clickAt > 0 && clickAt.perActionMs.screenshot > 0, `click-at timings missing: ${JSON.stringify(clickAt.perActionMs)}`)
assert.ok(clickAt.perActionMs.screenshot < 5, `click-at screenshots still pay the repaint window: ${clickAt.perActionMs.screenshot}ms`)
assert.ok(
  clickAt.visualSkips >= clickAt.actions,
  `click-at rounds were not proven paint-free: ${JSON.stringify({ visualSkips: clickAt.visualSkips, actions: clickAt.actions })}`,
)
assert.equal(clickAt.screenshotStream.repaintMisses, 0, `click-at rounds paid the repaint window: ${JSON.stringify(clickAt.screenshotStream)}`)

console.log('BENCH SCENARIO TEST: PASS')
