/**
 * JSON + Markdown report rendering for the fixed memory soak.
 *
 * The JSON is the machine-readable source of truth; the Markdown is the
 * human-comparable view. Both derive from the same report object, so a number
 * cannot drift between them. Keep the schema version bumped when a field is
 * renamed or removed: `scenario.id` already pins the workload, and comparing
 * runs across schema versions is not supported.
 */
import fs from 'node:fs'
import path from 'node:path'

export const SCHEMA_VERSION = 1

export const NODE_FIELDS = Object.freeze(['rss', 'heapUsed', 'heapTotal', 'external', 'arrayBuffers'])

export const OBJECT_FIELDS = Object.freeze([
  'tabs',
  'bySession',
  'owners',
  'captures',
  'captureEntries',
  'captureBodyBytes',
  'pending',
  'downloads',
  'downloadByGuid',
  'shotStreams',
  'consoleBuffers',
  'contexts',
  'pendingContexts',
  'idleTimers',
  'visibleDrivers',
])

const MiB = 1024 * 1024

export function fmtBytes(value) {
  if (!Number.isFinite(value)) return '—'
  return `${(value / MiB).toFixed(1)} MiB`
}

export function fmtBytesShort(value) {
  if (!Number.isFinite(value)) return '—'
  if (Math.abs(value) < 1024) return `${Math.round(value)} B`
  if (Math.abs(value) < MiB) return `${(value / 1024).toFixed(1)} KiB`
  return `${(value / MiB).toFixed(1)} MiB`
}

export function fmtDelta(value) {
  if (!Number.isFinite(value)) return '—'
  const sign = value > 0 ? '+' : ''
  return `${sign}${(value / MiB).toFixed(2)} MiB`
}

export function fmtCount(value) {
  return Number.isFinite(value) ? String(Math.round(value)) : '—'
}

export function deltaNode(after, before) {
  const delta = {}
  for (const field of NODE_FIELDS) delta[field] = (after?.[field] ?? 0) - (before?.[field] ?? 0)
  return delta
}

export function deltaObjects(after, before) {
  const delta = {}
  for (const field of OBJECT_FIELDS) delta[field] = (after?.[field] ?? 0) - (before?.[field] ?? 0)
  return delta
}

function series(values) {
  const finite = values.filter((value) => Number.isFinite(value))
  if (finite.length === 0) return { samples: 0, first: null, last: null, min: null, max: null, mean: null, median: null }
  const sorted = [...finite].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  const median = sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
  return {
    samples: finite.length,
    first: finite[0],
    last: finite[finite.length - 1],
    min: sorted[0],
    max: sorted[sorted.length - 1],
    mean: Math.round(finite.reduce((sum, value) => sum + value, 0) / finite.length),
    median: Math.round(median),
  }
}

/** Build the summary block from the finished rounds. */
export function summarize({ baseline, rounds, peak, config, startedAt, endedAt, durationMs }) {
  const final = rounds.at(-1)?.endBaseline ?? baseline
  const firstRoundEnd = rounds[0]?.endBaseline ?? baseline
  const nodeSeries = {}
  for (const field of NODE_FIELDS) nodeSeries[field] = series(rounds.map((round) => round.endBaseline?.node?.[field]))
  const chromePeakSeries = series(rounds.map((round) => round.peak?.chromeRss))
  const failures = rounds.flatMap((round) => (round.invariants?.failures || []).map((failure) => ({ round: round.round, ...failure })))
  return {
    startedAt,
    endedAt,
    durationMs,
    config,
    rounds: rounds.length,
    failedRounds: rounds.filter((round) => !round.ok).length,
    baseline,
    final,
    peak,
    retainedAfterRun: {
      node: deltaNode(final.node, baseline.node),
      objects: deltaObjects(final.objects, baseline.objects),
      // Chrome is closed at the end baseline; the comparable Chrome number is
      // the per-run peak, not an after-close zero.
      chromeRss: null,
    },
    retainedAfterFirstRound: {
      node: deltaNode(final.node, firstRoundEnd.node),
      objects: deltaObjects(final.objects, firstRoundEnd.objects),
    },
    endBaseline: { node: nodeSeries, chromeRssPeak: chromePeakSeries },
    perRound: {
      rssPeak: rounds.map((round) => round.peak?.node?.rss ?? null),
      rssEnd: rounds.map((round) => round.endBaseline?.node?.rss ?? null),
      heapUsedPeak: rounds.map((round) => round.peak?.node?.heapUsed ?? null),
      heapUsedEnd: rounds.map((round) => round.endBaseline?.node?.heapUsed ?? null),
      externalPeak: rounds.map((round) => round.peak?.node?.external ?? null),
      arrayBuffersPeak: rounds.map((round) => round.peak?.node?.arrayBuffers ?? null),
      chromeRssPeak: rounds.map((round) => round.peak?.chromeRss ?? null),
      processCountPeak: rounds.map((round) => round.peak?.processCount ?? null),
      tabsPeak: rounds.map((round) => round.peak?.objects?.tabs ?? null),
      capturesPeak: rounds.map((round) => round.peak?.objects?.captures ?? null),
      captureBodyPeak: rounds.map((round) => round.peak?.objects?.captureBodyBytes ?? null),
    },
    invariantFailures: failures,
    leakSignals: [...new Set(failures.map((failure) => failure.code))],
  }
}

function verdict(report) {
  if (report.summary.failedRounds === 0 && report.summary.invariantFailures.length === 0) return 'PASS'
  return 'FAIL'
}

function summaryTable(report) {
  const { baseline, final, retainedAfterRun, peak } = report.summary
  const rows = []
  for (const field of NODE_FIELDS) {
    rows.push([
      `Node ${field}`,
      fmtBytes(baseline.node?.[field]),
      fmtBytes(final.node?.[field]),
      fmtDelta(retainedAfterRun.node?.[field]),
      fmtBytes(peak.node?.[field]),
    ])
  }
  rows.push([
    'Chrome subtree RSS',
    '—',
    'closed',
    '—',
    fmtBytes(peak.chromeRss),
  ])
  rows.push([
    'Chrome processes',
    '—',
    '0',
    '—',
    fmtCount(peak.processCount),
  ])
  for (const field of ['tabs', 'captures', 'captureBodyBytes', 'downloadByGuid', 'pending']) {
    rows.push([
      `objects.${field}`,
      fmtCount(baseline.objects?.[field]),
      fmtCount(final.objects?.[field]),
      fmtCount(retainedAfterRun.objects?.[field]),
      field === 'captureBodyBytes' ? fmtBytesShort(peak.objects?.[field]) : fmtCount(peak.objects?.[field]),
    ])
  }
  return [
    '| metric | baseline | final (after close) | retained after run | peak |',
    '|---|---:|---:|---:|---:|',
    ...rows.map((row) => `| ${row.join(' | ')} |`),
  ].join('\n')
}

function roundsTable(report) {
  const header = [
    '#',
    'dur s',
    'RSS peak',
    'RSS end',
    'heap peak',
    'heap end',
    'external peak',
    'arrayBuf peak',
    'Chrome peak',
    'procs',
    'tabs',
    'captures',
    'body peak',
    'retained RSS',
    'result',
  ]
  const lines = [
    `| ${header.join(' | ')} |`,
    `|${header.map(() => '---:').join('|')}|`,
  ]
  for (const round of report.rounds) {
    const retained = round.retained?.node?.rss
    const failures = round.invariants?.failures?.length || 0
    lines.push(
      `| ${[
        round.round,
        (round.durationMs / 1000).toFixed(1),
        fmtBytes(round.peak?.node?.rss),
        fmtBytes(round.endBaseline?.node?.rss),
        fmtBytes(round.peak?.node?.heapUsed),
        fmtBytes(round.endBaseline?.node?.heapUsed),
        fmtBytes(round.peak?.node?.external),
        fmtBytes(round.peak?.node?.arrayBuffers),
        fmtBytes(round.peak?.chromeRss),
        fmtCount(round.peak?.processCount),
        fmtCount(round.peak?.objects?.tabs),
        fmtCount(round.peak?.objects?.captures),
        fmtBytesShort(round.peak?.objects?.captureBodyBytes),
        fmtDelta(retained),
        round.ok ? 'PASS' : `FAIL(${failures || 1})`,
      ].join(' | ')} |`,
    )
  }
  return lines.join('\n')
}

function actionsTable(report) {
  const totals = {}
  for (const round of report.rounds) {
    for (const [name, count] of Object.entries(round.actions || {})) totals[name] = (totals[name] || 0) + count
  }
  const entries = Object.entries(totals).sort(([left], [right]) => left.localeCompare(right))
  return [
    '| action | total | per round |',
    '|---|---:|---:|',
    ...entries.map(([name, count]) => `| ${name} | ${count} | ${(count / Math.max(1, report.rounds.length)).toFixed(1)} |`),
  ].join('\n')
}

function failuresSection(report) {
  const failures = report.summary.invariantFailures
  if (failures.length === 0) return 'No invariant failures.'
  const lines = [
    '| round | code | detail | occurrences |',
    '|---:|---|---|---:|',
  ]
  for (const failure of failures) {
    lines.push(`| ${failure.round} | ${failure.code} | ${String(failure.message || '').replace(/\|/g, '\\|')} | ${failure.occurrences || 1} |`)
  }
  return lines.join('\n')
}

/**
 * Render one report as Markdown. Stable section order keeps `diff -u` between
 * two runs readable: verdict, summary, rounds, actions, failures, scenario.
 */
export function renderMarkdown(report) {
  const { scenario, run, config, summary } = report
  const lines = [
    `# DSH Chrome memory soak — ${run.startedAt}`,
    '',
    `**Verdict: ${verdict(report)}** — ${summary.rounds - summary.failedRounds}/${summary.rounds} rounds clean, ${summary.invariantFailures.length} invariant failure(s).`,
    '',
    `- scenario: \`${scenario.name}\` (\`${scenario.id}\`)`,
    `- driver: **${scenario.driver}**${run.executable ? ` (${run.executable})` : ''}${run.browserVersion ? `, browser ${run.browserVersion}` : ''}`,
    `- workload: ${config.rounds} rounds × ${config.tabsPerRound} tabs; per tab goto+snapshot+screenshot; capture start/stop ${config.captureCyclesPerRound}× and screencast start/stop ${config.screencastCyclesPerRound}× per round; close tabs/context; settle ${config.settleMs}ms`,
    `- host: ${run.platform}/${run.arch}, Node ${run.node}, ${run.cpuCount} CPU, ${(run.totalMemBytes / 1024 ** 3).toFixed(1)} GiB RAM, pid ${run.pid}${Array.isArray(run.loadAtStart) ? `, load ${run.loadAtStart.map((value) => value.toFixed(1)).join('/')}` : ''}`,
    `- gc: ${run.gcAvailable ? 'available' : 'NOT available (run CLI with --expose-gc for comparable heap baselines)'}; duration ${(run.durationMs / 1000).toFixed(1)}s`,
    '',
    '## Summary',
    '',
    summaryTable(report),
    '',
    `Peak/end values are per run. \`retained after run\` = final after-close baseline − initial baseline before round 1; Chrome is closed at the final baseline, so its comparable number is the peak.`,
    '',
    '## Per-round',
    '',
    roundsTable(report),
    '',
    '## Actions',
    '',
    actionsTable(report),
    '',
    '## Invariant failures',
    '',
    failuresSection(report),
    '',
    '## Compare with another run',
    '',
    'Only compare reports with the same `scenario.id`, `driver`, and `schemaVersion`. Read, in order: (1) `summary.invariantFailures`, (2) `summary.peak.chromeRss` and `summary.peak.node.rss`, (3) `summary.retainedAfterRun`, (4) the per-round `RSS end` trend. A growing end baseline across rounds is a leak; a one-time step after round 1 is usually warm-up and is separated as `retainedAfterFirstRound`.',
    '',
    'JSON is the source of truth: `' + (report.artifacts?.json || '(not written)') + '`.',
    '',
  ]
  return lines.join('\n')
}

/** Write `<run>/soak-<timestamp>.json` and `.md`; returns the two paths. */
export function writeReport(report, outDir) {
  const dir = path.resolve(outDir)
  fs.mkdirSync(dir, { recursive: true })
  // Keep milliseconds: two CLI runs in the same second (a clean run followed
  // by an injected-leak run) must not overwrite each other's reports.
  const stamp = String(report.run.startedAt || new Date().toISOString())
    .replace(/[:.]/g, '-')
    .replace('T', '-')
    .replace(/Z$/, '')
    .slice(0, 23)
  const base = `soak-${stamp}`
  const jsonPath = path.join(dir, `${base}.json`)
  const markdownPath = path.join(dir, `${base}.md`)
  report.artifacts = { json: jsonPath, markdown: markdownPath }
  const markdown = renderMarkdown(report)
  fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`)
  fs.writeFileSync(markdownPath, markdown)
  return { jsonPath, markdownPath }
}

/** Short human summary for the CLI (the full report is in the files). */
export function formatSummary(report) {
  const summary = report.summary
  const lines = [
    `SOAK ${verdict(report)} — ${summary.rounds - summary.failedRounds}/${summary.rounds} rounds clean, ${summary.invariantFailures.length} invariant failure(s), ${(report.run.durationMs / 1000).toFixed(1)}s`,
    `scenario ${report.scenario.id} (${report.scenario.name}), driver ${report.scenario.driver}`,
    `peak: node rss ${fmtBytes(summary.peak.node?.rss)} heap ${fmtBytes(summary.peak.node?.heapUsed)} external ${fmtBytes(summary.peak.node?.external)} arrayBuffers ${fmtBytes(summary.peak.node?.arrayBuffers)}; chrome rss ${fmtBytes(summary.peak.chromeRss)} in ${fmtCount(summary.peak.processCount)} proc`,
    `retained after run: rss ${fmtDelta(summary.retainedAfterRun.node?.rss)} heap ${fmtDelta(summary.retainedAfterRun.node?.heapUsed)} external ${fmtDelta(summary.retainedAfterRun.node?.external)} arrayBuffers ${fmtDelta(summary.retainedAfterRun.node?.arrayBuffers)}; after first round: rss ${fmtDelta(summary.retainedAfterFirstRound.node?.rss)}`,
  ]
  if (summary.leakSignals.length > 0) lines.push(`leak signals: ${summary.leakSignals.join(', ')}`)
  if (report.artifacts?.json) lines.push(`json: ${report.artifacts.json}`)
  if (report.artifacts?.markdown) lines.push(`markdown: ${report.artifacts.markdown}`)
  return lines.join('\n')
}
