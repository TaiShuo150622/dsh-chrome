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

// `--shot-chain` (docs/HEADLESS.md §4.1.14): one conservative paint-free pointer
// move followed by three screenshots. The first screenshot has to pay the
// repaint window (the click cannot be proven paint-free, so the marker is
// pending), and the miss retires the marker: the next two screenshots must be
// frame-cache hits. A driver without retirement re-pays the window on every
// screenshot, so its miss count is three per round instead of one.
const shotChainRun = spawnSync(
  process.execPath,
  [path.join(root, 'scripts', 'headless-bench.mjs'), '--seconds', '4', '--shot-chain'],
  { cwd: root, encoding: 'utf8', timeout: 120000 },
)
assert.equal(shotChainRun.status, 0, `shot-chain bench exited ${shotChainRun.status}\nstdout: ${shotChainRun.stdout}\nstderr: ${shotChainRun.stderr}`)
const shotChain = JSON.parse(shotChainRun.stdout)
assert.equal(shotChain.shotChainMode, true)
assert.ok(shotChain.scenario.includes('snapshot/clickAt(hover move)/screenshot x3'), `unexpected shot-chain scenario: ${shotChain.scenario}`)
assert.equal(shotChain.shotChain.shotsPerRound, 3)
assert.ok(
  shotChain.shotChain.points.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y)),
  `shot-chain points missing: ${JSON.stringify(shotChain.shotChain)}`,
)
assert.ok(shotChain.actions >= 30, `too few shot-chain rounds: ${shotChain.actions}`)
assert.ok(shotChain.perActionMs.clickAt > 0 && shotChain.perActionMs.screenshot > 0, `shot-chain timings missing: ${JSON.stringify(shotChain.perActionMs)}`)
// One repaint window per round, not three: this is the retirement contract.
assert.ok(
  shotChain.screenshotStream.repaintMisses >= shotChain.actions - 1 &&
    shotChain.screenshotStream.repaintMisses <= shotChain.actions + 2,
  `chained screenshots paid the repaint window more than once per round: ${JSON.stringify({
    repaintMisses: shotChain.screenshotStream.repaintMisses,
    actions: shotChain.actions,
  })}`,
)
// The average over the three shots is one window / three + two cache hits.
assert.ok(
  shotChain.perActionMs.screenshot < 20,
  `chained screenshots still pay the repaint window: ${shotChain.perActionMs.screenshot}ms`,
)
// Every round left a marker behind and every miss retired it.
assert.ok(
  shotChain.visualRetires >= shotChain.actions,
  `chained screenshots did not retire the change marker: ${JSON.stringify({ visualRetires: shotChain.visualRetires, actions: shotChain.actions })}`,
)

// `--drag` (docs/HEADLESS.md §4.1.15): synthetic drag between two handler-free
// buttons. The UA performs no drag-and-drop default action for untrusted
// events, so every round must be proven paint-free; a driver without the drag
// probe pays the ~40ms repaint window on every round instead.
const dragRun = spawnSync(
  process.execPath,
  [path.join(root, 'scripts', 'headless-bench.mjs'), '--seconds', '4', '--drag'],
  { cwd: root, encoding: 'utf8', timeout: 120000 },
)
assert.equal(dragRun.status, 0, `drag bench exited ${dragRun.status}\nstdout: ${dragRun.stdout}\nstderr: ${dragRun.stderr}`)
const drag = JSON.parse(dragRun.stdout)
assert.equal(drag.dragMode, true)
assert.ok(drag.scenario.includes('snapshot/drag(handler-free buttons)'), `unexpected drag scenario: ${drag.scenario}`)
assert.ok(
  drag.drag && Number.isFinite(drag.drag.refs.from) && Number.isFinite(drag.drag.refs.to),
  `drag refs missing: ${JSON.stringify(drag.drag)}`,
)
assert.ok(drag.actions >= 100, `too few drag rounds: ${drag.actions}`)
assert.ok(drag.perActionMs.drag > 0 && drag.perActionMs.screenshot > 0, `drag timings missing: ${JSON.stringify(drag.perActionMs)}`)
assert.ok(drag.perActionMs.screenshot < 5, `drag screenshots still pay the repaint window: ${drag.perActionMs.screenshot}ms`)
assert.ok(
  drag.visualSkips >= drag.actions,
  `drag rounds were not proven paint-free: ${JSON.stringify({ visualSkips: drag.visualSkips, actions: drag.actions })}`,
)
assert.equal(drag.screenshotStream.repaintMisses, 0, `drag rounds paid the repaint window: ${JSON.stringify(drag.screenshotStream)}`)

// `--type-same` (docs/HEADLESS.md §4.1.16): every round types the value the
// field already holds. The page-side type result proves the value, focus and
// caret did not move, so every round must skip the repaint window; a driver
// without the type probe pays it on every round instead.
const typeSameRun = spawnSync(
  process.execPath,
  [path.join(root, 'scripts', 'headless-bench.mjs'), '--seconds', '4', '--type-same'],
  { cwd: root, encoding: 'utf8', timeout: 120000 },
)
assert.equal(
  typeSameRun.status,
  0,
  `type-same bench exited ${typeSameRun.status}\nstdout: ${typeSameRun.stdout}\nstderr: ${typeSameRun.stderr}`,
)
const typeSame = JSON.parse(typeSameRun.stdout)
assert.equal(typeSame.typeSameMode, true)
assert.ok(
  typeSame.scenario.includes('snapshot/type(same value)'),
  `unexpected type-same scenario: ${typeSame.scenario}`,
)
assert.equal(typeSame.typeSame.text, 'same')
assert.ok(typeSame.actions >= 100, `too few type-same rounds: ${typeSame.actions}`)
assert.ok(
  typeSame.perActionMs.type > 0 && typeSame.perActionMs.screenshot > 0,
  `type-same timings missing: ${JSON.stringify(typeSame.perActionMs)}`,
)
assert.ok(
  typeSame.perActionMs.screenshot < 5,
  `type-same screenshots still pay the repaint window: ${typeSame.perActionMs.screenshot}ms`,
)
assert.ok(
  typeSame.visualSkips >= typeSame.actions,
  `type-same rounds were not proven paint-free: ${JSON.stringify({ visualSkips: typeSame.visualSkips, actions: typeSame.actions })}`,
)
assert.equal(
  typeSame.screenshotStream.repaintMisses,
  0,
  `type-same rounds paid the repaint window: ${JSON.stringify(typeSame.screenshotStream)}`,
)


// `--select-same` (docs/HEADLESS.md §4.1.17): every round re-selects the option
// the select already shows. The page-side result proves the value did not move,
// so every round must skip the repaint window; a driver without the select
// probe pays it on every round instead.
const selectSameRun = spawnSync(
  process.execPath,
  [path.join(root, 'scripts', 'headless-bench.mjs'), '--seconds', '4', '--select-same'],
  { cwd: root, encoding: 'utf8', timeout: 120000 },
)
assert.equal(
  selectSameRun.status,
  0,
  `select-same bench exited ${selectSameRun.status}\nstdout: ${selectSameRun.stdout}\nstderr: ${selectSameRun.stderr}`,
)
const selectSame = JSON.parse(selectSameRun.stdout)
assert.equal(selectSame.selectSameMode, true)
assert.ok(
  selectSame.scenario.includes('snapshot/select(same option)'),
  `unexpected select-same scenario: ${selectSame.scenario}`,
)
assert.equal(selectSame.selectSame.value, 'a')
assert.ok(selectSame.actions >= 100, `too few select-same rounds: ${selectSame.actions}`)
assert.ok(
  selectSame.perActionMs.select > 0 && selectSame.perActionMs.screenshot > 0,
  `select-same timings missing: ${JSON.stringify(selectSame.perActionMs)}`,
)
assert.ok(
  selectSame.perActionMs.screenshot < 5,
  `select-same screenshots still pay the repaint window: ${selectSame.perActionMs.screenshot}ms`,
)
assert.ok(
  selectSame.visualSkips >= selectSame.actions,
  `select-same rounds were not proven paint-free: ${JSON.stringify({ visualSkips: selectSame.visualSkips, actions: selectSame.actions })}`,
)
assert.equal(
  selectSame.screenshotStream.repaintMisses,
  0,
  `select-same rounds paid the repaint window: ${JSON.stringify(selectSame.screenshotStream)}`,
)

console.log('BENCH SCENARIO TEST: PASS')
