#!/usr/bin/env node
/**
 * Headless backend CPU/RSS benchmark.
 *
 * Starts a local HTTP page, runs a fixed scripted action sequence through the
 * headless CDP driver, and samples the Chrome process tree (CPU time / RSS)
 * before and after. Per-action wall time is reported alongside the aggregate so
 * a regression can be attributed to a specific path (snapshot / type /
 * screenshot / scroll).
 *
 * The scenario is the same as the 2026-10-17 baseline in docs/HEADLESS.md §4.1
 * (181 rounds/10s, 69.89% CPU, 1113MB RSS): `BASELINE` below is that original
 * pre-optimization reference, so `delta` tells the historical story. Current
 * numbers (screenshot frame stream, §4.1.1/§4.1.2) are ~585 rounds/10s at ~17ms
 * per round for PNG and ~575 rounds/10s for JPEG; when a faster path completes
 * more actions in the same 10s, the aggregate `cpuPercent` rises even though
 * `cpuMsPerAction` falls — use `cpuMsPerAction` and `perActionMs` to compare
 * efficiency across revisions.
 *
 * Usage:
 *   node scripts/headless-bench.mjs [--seconds 10] [--actions 20]
 *                                   [--shot-format png|jpeg] [--shot-quality 60]
 *                                   [--no-optimize] [--gap-ms 0] [--static]
 *                                   [--readonly-eval] [--noop-click] [--press]
 *                                   [--mixed]
 *                                   [--idle-seconds 0] [--idle-settle-seconds 0]
 *
 * Both formats are served from the tab's screenshot frame stream (PNG or JPEG
 * screencast). The PNG path defaults to Chrome's fast PNG encoder
 * (`optimizeForSpeed`); `--no-optimize` measures the old, smaller-PNG capture
 * path. `--shot-format jpeg` measures the JPEG path (not the tool default) with
 * `--shot-quality`. `--shot-clip WxH` screenshots a fixed viewport region and
 * `--shot-ref` screenshots the round's input element by ref: both exercise the
 * element/region screenshot path (`clip`/`ref` are CSS px). PNG regions are
 * cropped in the driver, JPEG regions by the page's own codec inside an
 * isolated world (docs/HEADLESS.md §4.1.4/§4.1.9); both used to fall back to
 * Page.captureScreenshot. `--gap-ms` inserts
 * that much idle time between rounds, which
 * is the realistic tool-call cadence for the frame-stream idle policy (the
 * default 0 gap is the back-to-back worst case; use a gap longer than
 * DSH_HEADLESS_SHOT_STREAM_IDLE_MS to exercise a stream restart). `--static`
 * drops the page-changing type/scroll actions: every round then screenshots an
 * unchanged page, which measures the cached-frame/idle-stream path (combine it
 * with `--gap-ms` to measure the idle window). `--readonly-eval` replaces the
 * page-changing type/scroll actions with a read-only `tab.evaluate`: the page
 * never repaints, so every round measures the repaint window a screenshot pays
 * after an action that provably painted nothing (docs/HEADLESS.md §4.1.7).
 * `--noop-click` replaces them with a synthetic click on a plain, handler-free
 * `<div>`: the click cannot paint either, so every round measures the same
 * repaint window for click (docs/HEADLESS.md §4.1.8). `--press` replaces them
 * with a key press that has no UA default action (Escape on body / a printable
 * character, alternating): with no focused editable field the press cannot
 * paint, so every round measures the repaint window the keyboard path used to
 * pay (docs/HEADLESS.md §4.1.12; the keys the probe vetoes are covered by
 * test/headless.mjs). The report's `visualSkips` counts the actions proven
 * paint-free, so a run where the shortcut did not fire is visible. The action
 * cap is
 * ACTIONS*50 (ACTIONS*2000 for the shortcut scenarios) so the default 10s run
 * is time-bound rather than cap-bound.
 *
 * `--mixed` is the realistic-cadence scenario (docs/HEADLESS.md §4.1.11): each
 * round takes a snapshot, performs the next action kind in the rotation
 * (type / click / read-only evaluate / no-op click / scroll), then screenshots —
 * and the gap between rounds is a deterministic 150-400ms instead of the
 * back-to-back worst case. `--gap-ms` overrides that cadence when given.
 * `--idle-seconds N` samples the Chrome process tree for N seconds after the
 * active loop and reports idle CPU percent / RSS / processes, so "what does the
 * browser cost while no tool call is in flight" is reproducible instead of hand
 * sampled with `ps` (docs/PERF-LOOP.md §5/§6). Chrome's own launch tail keeps a
 * short-lived process tree busy for tens of seconds after `ensureStarted`
 * (docs/HEADLESS.md §4.1.10), so an idle window that starts right after a short
 * run measures that tail; `--idle-settle-seconds N` waits N seconds first and
 * every idle report carries `browserUptimeSeconds`, so a settled number can be
 * told apart from a tail-contaminated one. Every run also reports the
 * driver-level snapshot response size (`snapshot.bytesMean`/`bytesMax` at
 * `snapshot.maxChars`): the JSON a snapshot returns is the payload that crosses
 * CDP and reaches the model, so its bytes are the leading indicator for a text
 * budget regression (docs/PERF-LOOP.md §6). Bytes are measured after the timed
 * call, so they never inflate `perActionMs.snapshot`.
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
const hasFlag = (name) => args.includes(name)
const ACTIONS = Math.max(5, Math.min(200, argValue('--actions', 20)))
const DURATION = Math.max(5, Math.min(60, argValue('--seconds', 10)))
const IDLE_SECONDS = Math.max(0, Math.min(120, argValue('--idle-seconds', 0)))
const IDLE_SETTLE_SECONDS = Math.max(0, Math.min(300, argValue('--idle-settle-seconds', 0)))
const SNAPSHOT_MAX_CHARS = 2000
const SHOT_FORMAT = hasFlag('--shot-format') && args[args.indexOf('--shot-format') + 1] === 'jpeg' ? 'jpeg' : 'png'
const SHOT_QUALITY = Math.max(1, Math.min(100, argValue('--shot-quality', 60)))
const SHOT_OPTIMIZE = !hasFlag('--no-optimize')
// Explicit `--gap-ms 0` must stay a fixed zero gap (the back-to-back worst
// case), which is why presence is tracked separately from the value.
const GAP_SET = args.includes('--gap-ms')
const GAP_MS = Math.max(0, Math.min(30000, argValue('--gap-ms', 0)))
const STATIC = hasFlag('--static')
// Read-only evaluate scenario (§4.1.7): snapshot + evaluate + screenshot, with
// no page-changing action, so the screenshot must reuse the cached frame.
const READONLY_EVAL = hasFlag('--readonly-eval')
const READONLY_EXPRESSION = 'document.getElementById("out").textContent'
// No-op click scenario (§4.1.8): snapshot + click on a plain div + screenshot.
// The div has no handler and is not focusable, so the click cannot paint; the
// screenshot must reuse the cached frame instead of paying the repaint window.
const NOOP_CLICK = hasFlag('--noop-click')
// Mixed scenario (§4.1.11): round-robin over the action kinds an agent actually
// issues, with a realistic 150-400ms cadence. The cadence step is coprime to the
// 251-wide range, so the sequence covers the whole window before repeating.
const MIXED = hasFlag('--mixed')
const MIXED_KINDS = ['type', 'click', 'evaluate', 'noopClick', 'scroll']
const mixedGapMs = (index) => 150 + ((index * 97) % 251)
// No-op key-press scenario (docs/HEADLESS.md §4.1.12): snapshot + press +
// screenshot, with no focused editable field and a key whose UA default action
// is nothing (Escape on body / a printable character). The press cannot paint,
// so the screenshot must reuse the cached frame instead of paying the repaint
// window. `--press` deliberately uses only keys the press probe covers; the
// keys it vetoes are covered by the driver tests.
const PRESS = hasFlag('--press')
// Element/region screenshot scenarios. Clip coordinates are CSS px like the
// `clip` tool parameter; ref mode uses the input control from the same snapshot
// the round already takes, so it measures ref resolution + crop end to end.
const SHOT_REF = hasFlag('--shot-ref')
const SHOT_CLIP = (() => {
  const index = args.indexOf('--shot-clip')
  if (index < 0) return null
  const match = /^(\d{1,5})x(\d{1,5})$/.exec(String(args[index + 1] || ''))
  if (!match) return null
  return { x: 0, y: 0, width: Math.max(1, Number(match[1])), height: Math.max(1, Number(match[2])) }
})()
const SHOT_MODE = SHOT_CLIP ? 'clip' : SHOT_REF ? 'ref' : 'viewport'

// Measured on this machine (Chrome 155) before the screenshot/round-trip work;
// keep in sync with docs/HEADLESS.md §4.1.
const BASELINE = {
  actions: 181,
  cpuPercent: 69.89,
  rssMb: 1113,
  source: 'docs/HEADLESS.md §4.1, 2026-10-17, png',
}

const html = `<!doctype html><html><head><title>Headless Bench</title></head><body>
<h1>Headless Bench</h1>
<label>Q <input id="q" placeholder="q"></label>
<button id="go" onclick="document.getElementById('out').textContent=document.getElementById('q').value">Go</button>
<div id="out">ready</div>
<div id="noop" style="padding:6px;border:1px solid #999;width:120px">noop</div>
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

const round = (value, digits = 2) => Math.round(value * 10 ** digits) / 10 ** digits
const percentDelta = (current, base) => round(((current - base) / base) * 100, 1)

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

// Wall-clock accumulator per action kind; Chrome CPU is sampled only around the
// whole loop, but wall time isolates which request dominates a round.
function createTimer() {
  const buckets = { snapshot: 0, type: 0, evaluate: 0, click: 0, screenshot: 0, scroll: 0, press: 0 }
  const counts = { snapshot: 0, type: 0, evaluate: 0, click: 0, screenshot: 0, scroll: 0, press: 0 }
  return {
    buckets,
    counts,
    async time(kind, fn) {
      const startedAt = performance.now()
      try {
        return await fn()
      } finally {
        buckets[kind] += performance.now() - startedAt
        counts[kind] += 1
      }
    },
    averages() {
      const out = {}
      for (const kind of Object.keys(buckets)) out[kind] = counts[kind] ? round(buckets[kind] / counts[kind], 2) : 0
      return out
    },
  }
}

// Screenshot frame-stream counters: shows how many region shots were served by
// the crop path (driver PNG crop / page-side JPEG crop) versus the capture
// fallback (docs/HEADLESS.md §4.1.4/§4.1.9).
function shotStreamDiag() {
  for (const tab of driver.tabs.values()) {
    const state = tab.shotStream
    if (!state) continue
    return {
      format: state.format,
      quality: state.quality,
      restarts: state.restarts,
      frames: state.frames,
      served: state.served,
      cropped: state.cropped,
      jpegCropped: state.jpegCropped,
      fallbacks: state.fallbacks,
      repaintMisses: state.repaintMisses,
    }
  }
  return null
}

try {
  await driver.ensureStarted()
  const browserStartedAt = Date.now()
  await driver.request('tab.goto', { owner: 'bench', url: `http://127.0.0.1:${port}/` })
  await driver.request('tab.snapshot', { owner: 'bench', maxChars: 5000 })

  const shotParams = {
    owner: 'bench',
    format: SHOT_FORMAT,
    ...(SHOT_FORMAT === 'jpeg' ? { quality: SHOT_QUALITY } : {}),
    optimizeForSpeed: SHOT_OPTIMIZE,
    ...(SHOT_CLIP ? { clip: SHOT_CLIP } : {}),
  }
  // Snapshot response bytes: this is the JSON that crosses CDP (and, at the tool
  // layer, the bulk of what reaches the model). Measured after the timed call so
  // serializing it never inflates perActionMs.snapshot.
  const payloadStats = { calls: 0, bytes: 0, maxBytes: 0 }
  const recordSnapshotBytes = (snap) => {
    const bytes = Buffer.byteLength(JSON.stringify(snap))
    payloadStats.calls += 1
    payloadStats.bytes += bytes
    if (bytes > payloadStats.maxBytes) payloadStats.maxBytes = bytes
  }
  const mixedStats = {
    kinds: Object.fromEntries(MIXED_KINDS.map((kind) => [kind, 0])),
    gap: { samples: 0, sum: 0, min: Infinity, max: 0 },
  }
  const pressStats = { keys: { Escape: 0, k: 0 } }
  const mixedKindFor = (index) => MIXED_KINDS[((index % MIXED_KINDS.length) + MIXED_KINDS.length) % MIXED_KINDS.length]
  const runRound = async (timer, index, measured) => {
    const timed = timer ? (kind, fn) => timer.time(kind, fn) : (kind, fn) => fn()
    const snap = await timed('snapshot', () => driver.request('tab.snapshot', { owner: 'bench', maxChars: SNAPSHOT_MAX_CHARS }))
    if (measured) recordSnapshotBytes(snap)
    const input = snap.controls.find((control) => control.tag === 'input')
    if (MIXED) {
      const kind = mixedKindFor(index)
      if (measured) mixedStats.kinds[kind] += 1
      if (kind === 'type' && input) {
        await timed('type', () => driver.request('tab.type', { owner: 'bench', ref: input.ref, text: `v${index}`, replace: true }))
      } else if (kind === 'click') {
        // `#go` writes #out from its onclick, so this click really repaints; the
        // no-op click is its own rotation slot rather than a stand-in.
        await timed('click', () => driver.request('tab.click', { owner: 'bench', selector: '#go' }))
      } else if (kind === 'evaluate') {
        await timed('evaluate', () => driver.request('tab.evaluate', { owner: 'bench', expression: READONLY_EXPRESSION }))
      } else if (kind === 'scroll') {
        await timed('scroll', () => driver.request('tab.scroll', { owner: 'bench', direction: index % 2 === 0 ? 'down' : 'up', amount: 200 }))
      } else {
        // 'noopClick' (plus the theoretical missing-input fallback for 'type').
        await timed('click', () => driver.request('tab.click', { owner: 'bench', selector: '#noop' }))
      }
    } else if (NOOP_CLICK) {
      await timed('click', () => driver.request('tab.click', { owner: 'bench', selector: '#noop' }))
    } else if (READONLY_EVAL) {
      await timed('evaluate', () => driver.request('tab.evaluate', { owner: 'bench', expression: READONLY_EXPRESSION }))
    } else if (PRESS) {
      // Alternating UA-neutral key: Escape with no dialog/fullscreen and a
      // printable character with no editable focus both have no default action.
      const key = index % 2 === 0 ? 'Escape' : 'k'
      pressStats.keys[key] += 1
      await timed('press', () => driver.request('tab.press', { owner: 'bench', key }))
    } else if (input && !STATIC) {
      await timed('type', () => driver.request('tab.type', { owner: 'bench', ref: input.ref, text: `v${index}`, replace: true }))
    }
    const params = SHOT_REF && input ? { ...shotParams, ref: input.ref } : shotParams
    await timed('screenshot', () => driver.request('tab.screenshot', params))
    // Ref mode keeps the element in view: it scrolls less than the input's
    // viewport offset, otherwise half the rounds would fall back to capture
    // because the element left the viewport (the honest off-screen case, but
    // not what this scenario is measuring).
    if (!MIXED && !STATIC && !READONLY_EVAL && !NOOP_CLICK && !PRESS) {
      await timed('scroll', () => driver.request('tab.scroll', { owner: 'bench', direction: index % 2 === 0 ? 'down' : 'up', amount: SHOT_REF ? 60 : 200 }))
    }
  }

  // One untimed warm-up round keeps the first screenshot (cold compositor) out
  // of the measurement.
  await runRound(null, -1, false)

  const before = processStats()
  const t0 = Date.now()
  const until = t0 + DURATION * 1000
  const timer = createTimer()
  let actions = 0
  // Hard cap so a stuck fast path cannot loop forever; high enough that the
  // default 10s run is time-bound (the screenshot frame stream made 58+ rounds
  // per second possible, which used to hit the old ACTIONS*20=400 cap early).
  // The read-only evaluate and no-op click scenarios are orders of magnitude
  // cheaper per round, so they need a much higher cap to stay time-bound.
  const ACTION_CAP = ACTIONS * (READONLY_EVAL || NOOP_CLICK || PRESS ? 2000 : 50)
  while (Date.now() < until && actions < ACTION_CAP) {
    await runRound(timer, actions, true)
    actions += 1
    // An explicit `--gap-ms` always wins; the mixed scenario otherwise uses its
    // own deterministic 150-400ms agent-like cadence.
    const gap = GAP_SET ? GAP_MS : MIXED ? mixedGapMs(actions) : 0
    if (MIXED) {
      mixedStats.gap.samples += 1
      mixedStats.gap.sum += gap
      mixedStats.gap.min = Math.min(mixedStats.gap.min, gap)
      mixedStats.gap.max = Math.max(mixedStats.gap.max, gap)
    }
    if (gap > 0) await new Promise((resolve) => setTimeout(resolve, gap))
  }
  const elapsed = (Date.now() - t0) / 1000
  const after = processStats()
  const cpuPercent = round(((after.cpuSeconds - before.cpuSeconds) / elapsed) * 100, 2)
  const cpuSeconds = round(after.cpuSeconds - before.cpuSeconds, 2)
  // Per-action CPU is the latency-efficiency number: the aggregate percentage
  // rises whenever a faster path simply completes more rounds in the same 10s.
  const cpuMsPerAction = round((cpuSeconds * 1000) / Math.max(1, actions), 2)
  const perActionMs = timer.averages()
  const roundTotalMs = round(
    (timer.buckets.snapshot + timer.buckets.type + timer.buckets.evaluate + timer.buckets.click + timer.buckets.screenshot + timer.buckets.scroll + timer.buckets.press) /
      Math.max(1, actions),
    2,
  )
  const roundsPerSecond = round(actions / elapsed, 2)
  const rssMb = Math.round(after.rssKb / 1024)
  // Frame-stream counters describe the active loop; snapshot them before the
  // idle window so frames produced during idle cannot leak into active numbers.
  const streamDiag = shotStreamDiag()
  const visualSkips = [...driver.tabs.values()].reduce((sum, tab) => sum + (tab.visualSkips || 0), 0)
  // Optional idle window: the browser is left exactly as the last round left it
  // (the input may keep focus and blink a caret), which is the honest "no tool
  // call in flight" state for a user who is reading the result.
  let idle = null
  if (IDLE_SECONDS > 0) {
    // Clear Chrome's own launch tail when asked, so the sampled number is
    // steady-state idle rather than browser startup work.
    if (IDLE_SETTLE_SECONDS > 0) await new Promise((resolve) => setTimeout(resolve, IDLE_SETTLE_SECONDS * 1000))
    const streamBeforeIdle = shotStreamDiag()
    const idleBefore = processStats()
    const idleStartedAt = Date.now()
    await new Promise((resolve) => setTimeout(resolve, IDLE_SECONDS * 1000))
    const idleElapsed = (Date.now() - idleStartedAt) / 1000
    const idleAfter = processStats()
    const streamAfterIdle = shotStreamDiag()
    idle = {
      requestedSeconds: IDLE_SECONDS,
      settleSeconds: IDLE_SETTLE_SECONDS,
      // Below ~45s this window still contains Chrome's launch tail; the field
      // lets a reader tell a settled number from a contaminated one.
      browserUptimeSeconds: round((idleStartedAt - browserStartedAt) / 1000, 1),
      seconds: round(idleElapsed, 1),
      // macOS `ps` CPU time has centisecond resolution, so a 10s window is good
      // to ~0.1%; use --idle-seconds 60+ for sub-percent idle numbers.
      cpuPercent: round(((idleAfter.cpuSeconds - idleBefore.cpuSeconds) / idleElapsed) * 100, 2),
      rssMb: Math.round(idleAfter.rssKb / 1024),
      processes: idleAfter.processes,
      // Frames the screencast produced while nobody called a tool: 0 means the
      // idle cost is not frame encoding.
      streamFrames: streamAfterIdle && streamBeforeIdle ? Math.max(0, streamAfterIdle.frames - streamBeforeIdle.frames) : 0,
    }
  }
  console.log(
    JSON.stringify(
      {
        scenario: MIXED
          ? `headless mixed: ${actions} rounds (snapshot/${MIXED_KINDS.join('/')}/screenshot, ${
              GAP_SET ? `${GAP_MS}ms fixed gap` : '150-400ms cadence'
            })${SHOT_MODE === 'viewport' ? '' : ` (${SHOT_MODE} screenshot)`}`
          : `headless active: ${actions} ${SHOT_FORMAT} ${
              NOOP_CLICK
                ? 'snapshot/click(noop div)/screenshot (page never repaints)'
                : PRESS
                  ? 'snapshot/press(Escape,k)/screenshot (no editable focus, page never repaints)'
                  : READONLY_EVAL
                    ? 'snapshot/evaluate/screenshot (read-only evaluate, page never repaints)'
                    : STATIC
                    ? 'snapshot/screenshot (static page)'
                    : 'snapshot/type/screenshot/scroll'
            } rounds${SHOT_MODE === 'viewport' ? '' : ` (${SHOT_MODE} screenshot)`}`,
        elapsedSeconds: round(elapsed, 1),
        // The effective inter-round gap: the fixed `--gap-ms` value, or the
        // mixed scenario's realized cadence mean (0 for every other scenario).
        gapMs: MIXED && mixedStats.gap.samples ? round(mixedStats.gap.sum / mixedStats.gap.samples, 1) : GAP_MS,
        staticMode: STATIC,
        readonlyEval: READONLY_EVAL,
        noopClick: NOOP_CLICK,
        pressMode: PRESS,
        mixedMode: MIXED,
        shotMode: SHOT_MODE,
        ...(SHOT_CLIP ? { shotClip: SHOT_CLIP } : {}),
        actions,
        roundsPerSecond,
        processes: after.processes,
        rssMb,
        cpuPercent,
        cpuSeconds,
        cpuMsPerAction,
        perActionMs: { ...perActionMs, roundTotal: roundTotalMs },
        snapshot: {
          maxChars: SNAPSHOT_MAX_CHARS,
          calls: payloadStats.calls,
          bytesMean: payloadStats.calls ? Math.round(payloadStats.bytes / payloadStats.calls) : 0,
          bytesMax: payloadStats.maxBytes,
        },
        // Shortcut coverage: how many page-changing actions were proven
        // paint-free and kept the previous frame marker. The press scenario's
        // whole point is that this equals the round count.
        visualSkips,
        ...(PRESS ? { press: { keys: pressStats.keys } } : {}),
        ...(MIXED
          ? {
              mixed: {
                kinds: mixedStats.kinds,
                gapMode: GAP_SET ? 'fixed' : 'cadence-150-400',
                gapMs: {
                  mean: mixedStats.gap.samples ? round(mixedStats.gap.sum / mixedStats.gap.samples, 1) : 0,
                  min: mixedStats.gap.samples ? mixedStats.gap.min : 0,
                  max: mixedStats.gap.samples ? mixedStats.gap.max : 0,
                  samples: mixedStats.gap.samples,
                },
              },
            }
          : {}),
        ...(idle ? { idle } : {}),
        screenshot: {
          format: SHOT_FORMAT,
          ...(SHOT_FORMAT === 'jpeg' ? { quality: SHOT_QUALITY } : { optimizeForSpeed: SHOT_OPTIMIZE }),
        },
        screenshotStream: streamDiag,
        baseline: BASELINE,
        delta: {
          actionsPercent: percentDelta(actions, BASELINE.actions),
          roundsPerSecondPercent: percentDelta(roundsPerSecond, BASELINE.actions / DURATION),
          cpuPercent: percentDelta(cpuPercent, BASELINE.cpuPercent),
          rssPercent: percentDelta(rssMb, BASELINE.rssMb),
        },
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
