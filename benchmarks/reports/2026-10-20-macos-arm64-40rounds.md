# DSH Chrome memory soak — 2026-10-20T01:19:35.282Z

**Verdict: PASS** — 40/40 rounds clean, 0 invariant failure(s).

- scenario: `fixed-1context-4tabs-capture10-screencast10` (`cb19db7f2080`)
- driver: **headless** (/Applications/Google Chrome.app/Contents/MacOS/Google Chrome)
- workload: 40 rounds × 4 tabs; per tab goto+snapshot+screenshot; capture start/stop 10× and screencast start/stop 10× per round; close tabs/context; settle 500ms
- host: darwin/arm64, Node v24.6.0, 8 CPU, 16.0 GiB RAM, pid 13216, load 3.6/5.9/10.2
- gc: available; duration 288.1s

## Summary

| metric | baseline | final (after close) | retained after run | peak |
|---|---:|---:|---:|---:|
| Node rss | 56.7 MiB | 45.8 MiB | -10.94 MiB | 88.2 MiB |
| Node heapUsed | 7.0 MiB | 11.2 MiB | +4.13 MiB | 22.5 MiB |
| Node heapTotal | 12.0 MiB | 17.3 MiB | +5.25 MiB | 44.5 MiB |
| Node external | 3.4 MiB | 3.6 MiB | +0.22 MiB | 10.2 MiB |
| Node arrayBuffers | 0.0 MiB | 0.1 MiB | +0.07 MiB | 6.7 MiB |
| Chrome subtree RSS | — | closed | — | 1889.5 MiB |
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
| 1 | 8.8 | 69.6 MiB | 67.6 MiB | 13.1 MiB | 8.9 MiB | 7.1 MiB | 3.6 MiB | 1629.5 MiB | 15 | 4 | 9 | 4.0 KiB | +10.86 MiB | PASS |
| 2 | 9.1 | 67.6 MiB | 63.8 MiB | 11.3 MiB | 9.1 MiB | 6.1 MiB | 2.5 MiB | 1700.4 MiB | 15 | 4 | 9 | 4.0 KiB | +7.13 MiB | PASS |
| 3 | 7.5 | 86.5 MiB | 86.6 MiB | 12.8 MiB | 9.4 MiB | 7.4 MiB | 3.9 MiB | 1856.9 MiB | 15 | 4 | 9 | 4.0 KiB | +29.91 MiB | PASS |
| 4 | 7.9 | 88.2 MiB | 67.2 MiB | 13.0 MiB | 9.5 MiB | 8.4 MiB | 3.3 MiB | 1862.2 MiB | 15 | 4 | 9 | 4.0 KiB | +10.50 MiB | PASS |
| 5 | 7.4 | 71.8 MiB | 66.3 MiB | 13.5 MiB | 9.6 MiB | 7.1 MiB | 3.6 MiB | 1776.3 MiB | 15 | 4 | 9 | 4.0 KiB | +9.56 MiB | PASS |
| 6 | 7.2 | 69.0 MiB | 67.6 MiB | 11.6 MiB | 9.7 MiB | 6.1 MiB | 2.5 MiB | 1673.4 MiB | 15 | 4 | 9 | 4.0 KiB | +10.89 MiB | PASS |
| 7 | 7.1 | 68.8 MiB | 67.7 MiB | 11.9 MiB | 9.8 MiB | 6.0 MiB | 2.5 MiB | 1660.3 MiB | 14 | 4 | 9 | 4.0 KiB | +11.02 MiB | PASS |
| 8 | 7.0 | 68.3 MiB | 65.5 MiB | 12.1 MiB | 9.8 MiB | 6.1 MiB | 2.5 MiB | 1856.2 MiB | 15 | 4 | 9 | 4.0 KiB | +8.75 MiB | PASS |
| 9 | 7.7 | 68.3 MiB | 69.4 MiB | 13.4 MiB | 10.2 MiB | 7.4 MiB | 3.9 MiB | 1690.5 MiB | 15 | 4 | 9 | 4.0 KiB | +12.72 MiB | PASS |
| 10 | 7.4 | 74.6 MiB | 68.5 MiB | 15.8 MiB | 10.3 MiB | 8.4 MiB | 4.9 MiB | 1719.4 MiB | 15 | 4 | 9 | 4.0 KiB | +11.81 MiB | PASS |
| 11 | 7.3 | 73.8 MiB | 72.9 MiB | 15.8 MiB | 10.4 MiB | 8.4 MiB | 4.9 MiB | 1755.3 MiB | 15 | 4 | 9 | 4.0 KiB | +16.14 MiB | PASS |
| 12 | 6.9 | 75.1 MiB | 71.5 MiB | 15.9 MiB | 10.4 MiB | 8.4 MiB | 4.9 MiB | 1815.7 MiB | 15 | 4 | 9 | 4.0 KiB | +14.78 MiB | PASS |
| 13 | 7.1 | 74.0 MiB | 72.8 MiB | 15.9 MiB | 10.5 MiB | 8.4 MiB | 4.9 MiB | 1662.4 MiB | 15 | 4 | 9 | 4.0 KiB | +16.09 MiB | PASS |
| 14 | 6.9 | 79.7 MiB | 80.2 MiB | 18.0 MiB | 10.5 MiB | 8.4 MiB | 4.9 MiB | 1744.7 MiB | 15 | 4 | 9 | 4.0 KiB | +23.50 MiB | PASS |
| 15 | 7.1 | 84.5 MiB | 82.5 MiB | 18.9 MiB | 10.5 MiB | 10.1 MiB | 6.6 MiB | 1783.5 MiB | 14 | 4 | 9 | 4.0 KiB | +25.81 MiB | PASS |
| 16 | 6.9 | 84.7 MiB | 82.6 MiB | 20.0 MiB | 10.5 MiB | 10.2 MiB | 6.7 MiB | 1660.8 MiB | 14 | 4 | 9 | 4.0 KiB | +25.92 MiB | PASS |
| 17 | 7.0 | 85.5 MiB | 82.3 MiB | 20.0 MiB | 10.6 MiB | 10.2 MiB | 6.7 MiB | 1773.0 MiB | 15 | 4 | 9 | 4.0 KiB | +25.56 MiB | PASS |
| 18 | 6.8 | 85.0 MiB | 82.3 MiB | 18.9 MiB | 10.6 MiB | 10.2 MiB | 6.6 MiB | 1861.1 MiB | 15 | 4 | 9 | 4.0 KiB | +25.59 MiB | PASS |
| 19 | 7.1 | 84.8 MiB | 81.6 MiB | 20.0 MiB | 10.6 MiB | 10.2 MiB | 6.7 MiB | 1747.7 MiB | 15 | 4 | 9 | 4.0 KiB | +24.89 MiB | PASS |
| 20 | 6.9 | 83.8 MiB | 81.0 MiB | 20.1 MiB | 10.7 MiB | 10.2 MiB | 6.7 MiB | 1646.3 MiB | 14 | 4 | 9 | 4.0 KiB | +24.25 MiB | PASS |
| 21 | 7.0 | 84.0 MiB | 80.7 MiB | 20.1 MiB | 10.7 MiB | 10.2 MiB | 6.7 MiB | 1744.5 MiB | 15 | 4 | 9 | 4.0 KiB | +24.00 MiB | PASS |
| 22 | 6.8 | 83.0 MiB | 77.6 MiB | 20.1 MiB | 10.7 MiB | 10.2 MiB | 6.7 MiB | 1662.8 MiB | 15 | 4 | 9 | 4.0 KiB | +20.88 MiB | PASS |
| 23 | 7.1 | 84.1 MiB | 82.3 MiB | 20.2 MiB | 10.7 MiB | 10.2 MiB | 6.7 MiB | 1777.9 MiB | 15 | 4 | 9 | 4.0 KiB | +25.58 MiB | PASS |
| 24 | 7.4 | 82.3 MiB | 77.3 MiB | 20.2 MiB | 10.8 MiB | 10.2 MiB | 6.7 MiB | 1608.2 MiB | 15 | 4 | 9 | 4.0 KiB | +20.63 MiB | PASS |
| 25 | 6.9 | 83.4 MiB | 76.9 MiB | 20.1 MiB | 10.8 MiB | 10.2 MiB | 6.7 MiB | 1714.3 MiB | 15 | 4 | 9 | 4.0 KiB | +20.19 MiB | PASS |
| 26 | 7.1 | 84.5 MiB | 86.2 MiB | 22.5 MiB | 10.8 MiB | 10.2 MiB | 6.7 MiB | 1650.9 MiB | 15 | 4 | 9 | 4.0 KiB | +29.50 MiB | PASS |
| 27 | 6.8 | 87.9 MiB | 79.5 MiB | 13.0 MiB | 10.8 MiB | 6.1 MiB | 2.5 MiB | 1795.9 MiB | 15 | 4 | 9 | 4.0 KiB | +22.83 MiB | PASS |
| 28 | 7.2 | 80.8 MiB | 77.0 MiB | 14.0 MiB | 10.9 MiB | 7.4 MiB | 3.8 MiB | 1711.8 MiB | 15 | 4 | 9 | 4.0 KiB | +20.27 MiB | PASS |
| 29 | 6.9 | 77.0 MiB | 68.8 MiB | 13.1 MiB | 10.9 MiB | 6.1 MiB | 2.6 MiB | 1736.4 MiB | 15 | 4 | 9 | 4.0 KiB | +12.09 MiB | PASS |
| 30 | 7.8 | 70.9 MiB | 48.4 MiB | 14.8 MiB | 10.9 MiB | 7.4 MiB | 3.9 MiB | 1643.8 MiB | 15 | 4 | 9 | 4.0 KiB | -8.28 MiB | PASS |
| 31 | 7.3 | 53.7 MiB | 53.0 MiB | 16.3 MiB | 10.9 MiB | 8.4 MiB | 4.9 MiB | 1756.9 MiB | 15 | 4 | 9 | 4.0 KiB | -3.72 MiB | PASS |
| 32 | 6.9 | 55.0 MiB | 53.0 MiB | 16.4 MiB | 11.0 MiB | 8.4 MiB | 4.9 MiB | 1889.5 MiB | 15 | 4 | 9 | 4.0 KiB | -3.67 MiB | PASS |
| 33 | 7.1 | 55.5 MiB | 51.1 MiB | 16.3 MiB | 11.0 MiB | 8.4 MiB | 4.9 MiB | 1788.7 MiB | 15 | 4 | 9 | 4.0 KiB | -5.59 MiB | PASS |
| 34 | 6.8 | 52.1 MiB | 51.7 MiB | 13.2 MiB | 11.0 MiB | 6.1 MiB | 2.5 MiB | 1873.9 MiB | 15 | 4 | 9 | 4.0 KiB | -5.03 MiB | PASS |
| 35 | 7.1 | 53.5 MiB | 52.4 MiB | 14.3 MiB | 11.0 MiB | 7.4 MiB | 3.8 MiB | 1762.7 MiB | 15 | 4 | 9 | 4.0 KiB | -4.36 MiB | PASS |
| 36 | 6.8 | 55.3 MiB | 52.6 MiB | 16.5 MiB | 11.1 MiB | 8.4 MiB | 4.9 MiB | 1712.7 MiB | 15 | 4 | 9 | 4.0 KiB | -4.09 MiB | PASS |
| 37 | 7.0 | 53.5 MiB | 51.0 MiB | 13.3 MiB | 11.1 MiB | 6.0 MiB | 2.5 MiB | 1821.2 MiB | 15 | 4 | 9 | 4.0 KiB | -5.75 MiB | PASS |
| 38 | 6.9 | 51.5 MiB | 47.0 MiB | 13.1 MiB | 11.1 MiB | 6.1 MiB | 2.6 MiB | 1611.9 MiB | 15 | 4 | 9 | 4.0 KiB | -9.75 MiB | PASS |
| 39 | 7.2 | 49.2 MiB | 47.0 MiB | 13.4 MiB | 11.1 MiB | 6.0 MiB | 2.5 MiB | 1788.9 MiB | 15 | 4 | 9 | 4.0 KiB | -9.69 MiB | PASS |
| 40 | 6.9 | 47.7 MiB | 45.8 MiB | 13.4 MiB | 11.2 MiB | 6.1 MiB | 2.5 MiB | 1603.7 MiB | 15 | 4 | 9 | 4.0 KiB | -10.94 MiB | PASS |

## Actions

| action | total | per round |
|---|---:|---:|
| captureReload | 400 | 10.0 |
| captureStart | 400 | 10.0 |
| captureStop | 400 | 10.0 |
| contextClose | 40 | 1.0 |
| contextCreate | 40 | 1.0 |
| goto | 160 | 4.0 |
| screencastStart | 400 | 10.0 |
| screencastStop | 400 | 10.0 |
| screenshot | 160 | 4.0 |
| snapshot | 160 | 4.0 |
| tabClose | 160 | 4.0 |
| tabNew | 160 | 4.0 |

## Invariant failures

No invariant failures.

## Compare with another run

Only compare reports with the same `scenario.id`, `driver`, and `schemaVersion`. Read, in order: (1) `summary.invariantFailures`, (2) `summary.peak.chromeRss` and `summary.peak.node.rss`, (3) `summary.retainedAfterRun`, (4) the per-round `RSS end` trend. A growing end baseline across rounds is a leak; a one-time step after round 1 is usually warm-up and is separated as `retainedAfterFirstRound`.

JSON is the source of truth: `/tmp/soak-40/soak-2026-10-20-01-19-35-282.json`.
