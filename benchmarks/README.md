# Fixed memory soak (`benchmarks/soak.mjs`)

The reproducible workload behind `docs/LIFECYCLE.md` §固定压测 and the
observability queue's M9. It answers one question with numbers: **does a
create → use → close cycle leave anything behind?**

The harness drives the real headless backend (or a deterministic fake for the
report path), samples the same `chrome_memory_stats` snapshot the tool returns,
and writes a JSON + Markdown report whose shape is stable across runs.

## Fixed workload

Per round (default: 20 rounds):

| step | count | notes |
|---|---:|---|
| create context | 1 | `preset:"sandbox"`, one browser process |
| open tabs | 4 | `tab.tabs {op:"new"}` on `about:blank` |
| per tab: goto + snapshot + screenshot | 4 each | local deterministic HTTP page, no external network |
| capture start/stop | 10 | first tab; each cycle reloads the page so a real response body is captured, then samples the active body bytes before stop |
| screencast start/stop | 10 | first tab; a short frame settle before stop |
| close tabs | 4 | `tab.tabs {op:"close"}` |
| close context | 1 | waits for the Chrome process tree to disappear |
| settle + end baseline | — | `--settle-ms` (default 500ms), then GC + snapshot |

Every round reports:

- Node `rss` / `heapUsed` / `heapTotal` / `external` / `arrayBuffers` (bytes),
- Chrome process-tree RSS and process count (macOS/Linux `ps`; `null` where
  unsupported or unreadable — best effort, never blocks the workload),
- object counts `tabs` / `bySession` / `owners` / `captures` /
  `captureEntries` / `captureBodyBytes` / `pending` / `downloads` /
  `downloadByGuid` / `shotStreams` / `consoleBuffers` / `contexts` /
  `pendingContexts` / `idleTimers` / `visibleDrivers`,
- per-round **peak**, **after-close baseline**, and **retained** deltas,
- action counts and invariant failures.

The three memory numbers to compare:

| number | definition | what it catches |
|---|---|---|
| `peak` | max over all in-round samples | transient growth (screenshot frames, captured bodies, renderer spikes) |
| `endBaseline` | GC + settle after the context closed | per-round residue after a normal close |
| `retainedAfterRun` | final end baseline − baseline before round 1 | one-time warm-up + leaks that survive the whole run |
| `retainedAfterFirstRound` | final end baseline − round 1 end baseline | steady-state growth, with warm-up excluded |

Chrome is closed at every end baseline, so its retained value is not meaningful;
compare the **Chrome RSS peak** instead.

## Run

```sh
# full fixed workload (20 rounds); auto re-execs with --expose-gc
node benchmarks/soak.mjs

# shorter smoke run, explicit report directory
node benchmarks/soak.mjs --rounds 1 --out /tmp/soak

# no auto re-exec if you already run node --expose-gc
node --expose-gc benchmarks/soak.mjs
```

Reports default to `~/.dsh/cache/dsh-chrome/soak/soak-<timestamp>.{json,md}`.
Nothing is written into the repo unless `--out` points there. A real run exits
`1` when any round or invariant fails (use `--no-strict` to keep the report but
exit 0); it exits `2` when no browser is installed.

Other knobs: `--tabs`, `--captures`, `--screencasts`, `--page-bytes`,
`--capture-traffic reload|none`, `--settle-ms`, `--exit-timeout-ms` (default 15s; Chrome's shutdown tail can exceed 5s),
`--capture-settle-ms`, `--screencast-settle-ms`, `--home`, `--keep-home`,
`--json`, `--quiet`.

## Report fields worth reading

JSON (`schemaVersion: 1`) is the source of truth; Markdown is generated from
the same object.

- `scenario.id` — hash of the workload (rounds/tabs/cycles/page size/traffic/
  driver/GC mode). **Only compare runs with the same id, driver and
  schemaVersion.**
- `rounds[].peak`, `rounds[].endBaseline`, `rounds[].retained`,
  `rounds[].retainedVsPrevious` — per-round numbers and deltas.
- `rounds[].invariants.failures` — all failures with a stable `code`
  (`driver-tabs-after-close`, `chrome-process-exited`, …) and occurrence count.
- `summary.retainedAfterRun`, `summary.retainedAfterFirstRound`,
  `summary.perRound.*` — comparison inputs.
- `run.gcAvailable` / `run.gcUsed` — heap baselines are only comparable when GC
  ran; the CLI re-execs itself with `--expose-gc` unless `--no-gc` is given.

## Invariants

A round is `ok` only when every action completed and all checks passed:

- `tabs === bySession`; tabs > 0 implies `owners > 0`;
- stopped capture summaries ≤ `CAPTURE_SUMMARY_LIMIT`; at most one active
  capture sits on top (total ≤ limit + 1);
- `captureBodyBytes` is released immediately on `capture_stop` and never
  exceeds the 8MiB body budget;
- `downloadByGuid === downloads`; bridge `pending === 0`;
- after tabs close: tabs/bySession/owners/body/shot streams/console buffers are
  zero; capture **summaries and their entries may survive** until TTL/count
  eviction (bounded check, not zero);
- after context close: every driver map and timer is zero, `chromePid` is null,
  the manager has zero contexts and the Chrome process tree is gone within
  `--exit-timeout-ms` (default 15s; Chrome's shutdown tail can exceed 5s);
- action counts equal the fixed workload (a silently skipped step fails the
  round instead of producing a misleading baseline).

Failure is recorded, not thrown: a run finishes and shows *where* it leaked.
The CLI exits non-zero on strict mode.

## Fake driver (tests only)

`--fake` (and `tests/soak/`) uses `benchmarks/lib/fake-driver.mjs`, which
implements the same request surface and retention maps. It exercises the real
`BrowserContextManager`, the real memory aggregation and the real report path
without Chrome. Fake reports say `driver: "fake"` and are **not** comparable
with real numbers. `--fake-leak tabs|captures` injects a known bug so the
failure path is covered end to end.

```sh
node tests/soak/soak-logic.mjs      # no Chrome; workload, accounting, leaks, CLI
node tests/soak/soak-real.mjs       # one real round; skips in CI unless DSH_SOAK_STRICT=1
```

`npm test` does not include `tests/soak/` because `package.json` is an
integration file (CONTRACTS §7); run the two commands above explicitly.

## Baseline

See `docs/MEMORY-SOAK.md` for the recorded baseline (machine, Chrome version,
key numbers) and findings. Do not copy numbers from a different machine into a
regression comparison; re-run the same `scenario.id` locally.
