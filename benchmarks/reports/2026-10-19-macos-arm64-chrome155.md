# DSH Chrome memory soak — 2026-10-19T16:19:58.925Z

**Verdict: PASS** — 20/20 rounds clean, 0 invariant failure(s).

- scenario: `fixed-1context-4tabs-capture10-screencast10` (`a3a78c02a9a5`)
- driver: **headless** (/Applications/Google Chrome.app/Contents/MacOS/Google Chrome), browser Chrome/155.0.8059.80
- workload: 20 rounds × 4 tabs; per tab goto+snapshot+screenshot; capture start/stop 10× and screencast start/stop 10× per round; close tabs/context; settle 500ms
- host: darwin/arm64, Node v24.6.0, 8 CPU, 16.0 GiB RAM, pid 34355, load 11.5/32.1/34.3
- gc: available; duration 158.7s

## Summary

| metric | baseline | final (after close) | retained after run | peak |
|---|---:|---:|---:|---:|
| Node rss | 56.7 MiB | 75.9 MiB | +19.19 MiB | 87.0 MiB |
| Node heapUsed | 7.0 MiB | 10.6 MiB | +3.57 MiB | 19.5 MiB |
| Node heapTotal | 11.8 MiB | 28.5 MiB | +16.75 MiB | 31.5 MiB |
| Node external | 3.4 MiB | 3.6 MiB | +0.22 MiB | 10.2 MiB |
| Node arrayBuffers | 0.0 MiB | 0.1 MiB | +0.07 MiB | 6.7 MiB |
| Chrome subtree RSS | — | closed | — | 1944.1 MiB |
| Chrome processes | — | 0 | — | 15 |
| objects.tabs | 0 | 0 | 0 | 4 |
| objects.captures | 0 | 0 | 0 | 9 |
| objects.captureBodyBytes | 0 | 0 | 0 | 4.0 KiB |
| objects.downloadByGuid | 0 | 0 | 0 | 0 |
| objects.pending | 0 | 0 | 0 | 0 |

Peak/end values are per run. `retained after run` = final after-close baseline − initial baseline before round 1; Chrome is closed at the final baseline, so its comparable number is the peak.

## Per-round

| # | dur s | RSS peak | RSS end | heap peak | heap end | external peak | arrayBuf peak | Chrome peak | procs | tabs | captures | body peak | retained RSS | result |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 8.4 | 68.3 MiB | 67.8 MiB | 12.6 MiB | 8.8 MiB | 7.1 MiB | 3.6 MiB | 1583.6 MiB | 15 | 4 | 9 | 4.0 KiB | +11.09 MiB | PASS |
| 2 | 7.7 | 70.6 MiB | 67.3 MiB | 10.9 MiB | 9.0 MiB | 6.1 MiB | 2.6 MiB | 1775.9 MiB | 15 | 4 | 9 | 4.0 KiB | +10.63 MiB | PASS |
| 3 | 7.4 | 87.0 MiB | 63.7 MiB | 12.4 MiB | 9.3 MiB | 7.1 MiB | 3.6 MiB | 1800.1 MiB | 15 | 4 | 9 | 4.0 KiB | +7.00 MiB | PASS |
| 4 | 7.9 | 66.7 MiB | 66.0 MiB | 12.3 MiB | 9.4 MiB | 7.1 MiB | 3.6 MiB | 1707.6 MiB | 15 | 4 | 9 | 4.0 KiB | +9.34 MiB | PASS |
| 5 | 7.5 | 71.4 MiB | 66.9 MiB | 14.8 MiB | 9.5 MiB | 8.4 MiB | 4.9 MiB | 1581.9 MiB | 15 | 4 | 9 | 4.0 KiB | +10.20 MiB | PASS |
| 6 | 7.4 | 71.1 MiB | 67.0 MiB | 14.9 MiB | 9.6 MiB | 8.4 MiB | 4.9 MiB | 1621.3 MiB | 15 | 4 | 9 | 4.0 KiB | +10.25 MiB | PASS |
| 7 | 8.0 | 73.6 MiB | 69.2 MiB | 15.0 MiB | 9.7 MiB | 8.4 MiB | 4.9 MiB | 1857.2 MiB | 15 | 4 | 9 | 4.0 KiB | +12.52 MiB | PASS |
| 8 | 7.8 | 73.8 MiB | 69.5 MiB | 15.0 MiB | 9.7 MiB | 8.4 MiB | 4.9 MiB | 1811.7 MiB | 15 | 4 | 9 | 4.0 KiB | +12.81 MiB | PASS |
| 9 | 9.9 | 74.4 MiB | 69.7 MiB | 15.4 MiB | 10.1 MiB | 8.4 MiB | 4.9 MiB | 1657.9 MiB | 12 | 4 | 9 | 4.0 KiB | +13.02 MiB | PASS |
| 10 | 7.5 | 78.4 MiB | 78.1 MiB | 16.8 MiB | 10.2 MiB | 8.4 MiB | 4.9 MiB | 1808.9 MiB | 15 | 4 | 9 | 4.0 KiB | +21.42 MiB | PASS |
| 11 | 8.3 | 83.1 MiB | 80.7 MiB | 19.3 MiB | 10.3 MiB | 10.2 MiB | 6.6 MiB | 1898.7 MiB | 15 | 4 | 9 | 4.0 KiB | +23.98 MiB | PASS |
| 12 | 7.9 | 83.6 MiB | 80.8 MiB | 19.4 MiB | 10.3 MiB | 10.2 MiB | 6.6 MiB | 1850.3 MiB | 15 | 4 | 9 | 4.0 KiB | +24.09 MiB | PASS |
| 13 | 7.7 | 84.2 MiB | 80.2 MiB | 19.4 MiB | 10.3 MiB | 10.2 MiB | 6.7 MiB | 1844.2 MiB | 15 | 4 | 9 | 4.0 KiB | +23.50 MiB | PASS |
| 14 | 7.9 | 84.1 MiB | 81.4 MiB | 19.5 MiB | 10.4 MiB | 10.2 MiB | 6.6 MiB | 1944.1 MiB | 15 | 4 | 9 | 4.0 KiB | +24.73 MiB | PASS |
| 15 | 7.4 | 84.6 MiB | 82.6 MiB | 19.5 MiB | 10.4 MiB | 10.2 MiB | 6.6 MiB | 1885.9 MiB | 15 | 4 | 9 | 4.0 KiB | +25.92 MiB | PASS |
| 16 | 7.2 | 85.0 MiB | 81.8 MiB | 19.3 MiB | 10.4 MiB | 10.2 MiB | 6.7 MiB | 1796.7 MiB | 15 | 4 | 9 | 4.0 KiB | +25.11 MiB | PASS |
| 17 | 7.9 | 84.3 MiB | 82.2 MiB | 19.4 MiB | 10.5 MiB | 10.2 MiB | 6.7 MiB | 1904.6 MiB | 15 | 4 | 9 | 4.0 KiB | +25.52 MiB | PASS |
| 18 | 8.6 | 85.4 MiB | 81.5 MiB | 19.4 MiB | 10.5 MiB | 10.2 MiB | 6.6 MiB | 1828.0 MiB | 15 | 4 | 9 | 4.0 KiB | +24.75 MiB | PASS |
| 19 | 8.0 | 84.9 MiB | 76.2 MiB | 19.4 MiB | 10.5 MiB | 10.2 MiB | 6.7 MiB | 1919.8 MiB | 15 | 4 | 9 | 4.0 KiB | +19.47 MiB | PASS |
| 20 | 8.2 | 83.5 MiB | 75.9 MiB | 19.4 MiB | 10.6 MiB | 10.1 MiB | 6.6 MiB | 1603.1 MiB | 14 | 4 | 9 | 4.0 KiB | +19.19 MiB | PASS |

## Actions

| action | total | per round |
|---|---:|---:|
| captureReload | 200 | 10.0 |
| captureStart | 200 | 10.0 |
| captureStop | 200 | 10.0 |
| contextClose | 20 | 1.0 |
| contextCreate | 20 | 1.0 |
| goto | 80 | 4.0 |
| screencastStart | 200 | 10.0 |
| screencastStop | 200 | 10.0 |
| screenshot | 80 | 4.0 |
| snapshot | 80 | 4.0 |
| tabClose | 80 | 4.0 |
| tabNew | 80 | 4.0 |

## Invariant failures

No invariant failures.

## Compare with another run

Only compare reports with the same `scenario.id`, `driver`, and `schemaVersion`. Read, in order: (1) `summary.invariantFailures`, (2) `summary.peak.chromeRss` and `summary.peak.node.rss`, (3) `summary.retainedAfterRun`, (4) the per-round `RSS end` trend. A growing end baseline across rounds is a leak; a one-time step after round 1 is usually warm-up and is separated as `retainedAfterFirstRound`.

JSON is the source of truth: `benchmarks/reports/2026-10-19-macos-arm64-chrome155.json`.
