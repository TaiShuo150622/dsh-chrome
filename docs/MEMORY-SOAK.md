# 固定内存压测（M9，Observability 线）

> 基线：`3014180` / 0.2.21。命令：`node benchmarks/soak.mjs`。
> 机器：darwin/arm64，8 CPU，16 GiB，Node v24.6.0，Chrome 155.0.8059.80。
> 采集时间 2026-10-19；当时 load 11.5/32.1/34.3（有其他会话在跑，见「噪声」）。
> 报告：`benchmarks/reports/2026-10-19-macos-arm64-chrome155.{json,md}`。

## 一句话

固定 20 轮（每轮 1 context、4 tabs、每 tab goto+snapshot+screenshot、capture/screencast 各 10 次启停、关闭并等待）全部通过：
**对象/进程不变量 0 失败，Chrome 子进程树峰值约 1.9 GiB；Node 堆在首轮后仍有约 +1.8 MiB 的缓慢增长，fake 对照只有 +0.4 MiB——这是下一步要查的候选点，不是已确认泄漏。**

## 基线数字

| 指标 | 首轮前 baseline | 20 轮后 after-close | retainedAfterRun | 峰值 |
|---|---:|---:|---:|---:|
| Node rss | 56.7 MiB | 75.9 MiB | **+19.2 MiB** | 87.0 MiB |
| Node heapUsed | 7.0 MiB | 10.6 MiB | **+3.6 MiB** | 19.5 MiB |
| Node heapTotal | 11.8 MiB | 28.5 MiB | +16.8 MiB | 31.5 MiB |
| Node external | 3.4 MiB | 3.6 MiB | +0.22 MiB | 10.2 MiB |
| Node arrayBuffers | 0.03 MiB | 0.09 MiB | +0.07 MiB | 6.7 MiB |
| Chrome subtree rss | —（未启动） | 已关闭 | — | **1944 MiB** |
| Chrome 进程数 | — | 0 | — | 15 |
| objects.tabs | 0 | 0 | 0 | 4 |
| objects.captures | 0 | 0 | 0 | 9（8 个 stopped 摘要 + 1 个 active） |
| objects.captureBodyBytes | 0 | 0 | 0 | 4.0 KiB |
| objects.pending / downloadByGuid | 0 | 0 | 0 | 0 |

`retainedAfterFirstRound`（排除首轮 V8 预热）更能看稳态：Node rss **+8.5 MiB**、heapUsed **+1.8 MiB**、external +0、arrayBuffers +0。
Chrome 峰值在 1583.6–1944.1 MiB 之间波动（20 轮无趋势）；每轮结束后 `chromePid` 消失、进程树归零，最长等待 225 ms（15 s 上限内）。

20 轮逐轮 `heapUsed end`（MiB）：
`8.82 8.98 9.30 9.38 9.50 9.58 9.67 9.73 10.12 10.17 10.26 10.31 10.35 10.38 10.40 10.44 10.46 10.50 10.53 10.56`
——增长在减速（最后 5 轮约 +0.1 MiB），更像 V8/模块缓存/报告对象，而不是每轮固定泄漏。

## 对照：fake driver 20 轮

同一 workload、同一报告路径、同一 `BrowserContextManager`，只把 driver 换成 `benchmarks/lib/fake-driver.mjs`（`--fake`）：

- Node heapUsed end：7.33 → 7.69 MiB（**+0.36 MiB / 19 轮**）；retainedAfterFirstRound +0.38 MiB；
- Node rss：首轮后反而下降；Chrome 数字是合成值，不可比。

结论：报告/harness 自身只解释约 0.4 MiB；真实 headless 路径多出的约 1.4 MiB 发生在 CDP/浏览器生命周期里。它是否收敛要用 40+ 轮或 heap snapshot 确认，当前数据不足以下“泄漏”结论，已作为候选点交给后续。

## 判读纪律

1. **只在同一 `scenario.id`、同一 `driver`、同一 `SchemaVersion` 之间比较。** `scenario.id` 包含轮数、tab 数、capture/screencast 次数、pageBytes、captureTraffic、gc。
2. 先看 `summary.invariantFailures`，再看 `peak.chromeRss` / `peak.node.*`，最后看 `retainedAfterRun` 和逐轮 `rssEnd`。
3. `retainedAfterRun` 含首轮预热；稳态看 `retainedAfterFirstRound`。
4. Chrome 在每轮 after-close 已关闭，所以 Chrome 的可比数是 **peak**，不是 retained。
5. `heapTotal` 是 V8 容量，增长不等于对象泄漏；对象泄漏先看 `heapUsed` 与 `external/arrayBuffers`。
6. 至少跑两次；机器 load 差一倍以上时不要横向比数字。报告已记录 `run.loadAtStart/loadAtEnd`。

## 不变量（任何一条失败即该轮 FAIL）

- `tabs === bySession`；有 tab 时 `owners > 0`；
- stopped capture 摘要 ≤ `CAPTURE_SUMMARY_LIMIT`，最多再加一个 active；
- `capture_stop` 后 `captureBodyBytes === 0`，且峰值 ≤ 8 MiB；
- `downloadByGuid === downloads`，bridge `pending === 0`；
- 关闭 tab 后 tabs/bySession/owners/body/shotStreams/consoleBuffers 归零；capture 摘要与 entries 允许在 TTL/上限内保留（有界检查）；
- 关闭 context 后 driver 全部 map/timer 归零、`chromePid === null`、manager contexts/pending 归零、Chrome 进程树在 `--exit-timeout-ms` 内消失；
- 动作计数等于固定 workload（少做一步不能伪装成好基线）。

`tests/soak/soak-logic.mjs` 用 fake 注入三类已知故障（tab 不释放、capture body 不释放/摘要超限、Chrome 不退），确认每种都会变成 FAIL 而不是假 PASS；`tests/soak/soak-real.mjs` 跑 1 轮真实 Chrome。

## 噪声与已知坑

- **Chrome 关闭尾巴可能 >5 s**：本机第一次 20 轮基线在 5 s 上限下出现 2 次假失败（实际 5.0/5.2 s 后退出）。默认上限改为 15 s；这仍能抓住真正不退出的进程。
- **load 高时 Node rss/heap 明显偏高**：首轮基线在 load 36–44 时 Node rss 到 98 MiB，安静时 76 MiB。报告记录 load；比较前先看它。
- **Windows** 没有 `ps`，Chrome rss/processCount 为 null（process-tree 的既定行为）。
- capture 摘要按 10 min TTL / 8 条上限保留；关闭 tab 后仍可能看到 7–8 条摘要和 entries，这是契约，不是泄漏；body 在 stop 时立即释放。
- `heapUsed` 包含 bench 自己的报告对象；已把 phase 快照压到最小字段，fake 对照用来量化这部分。
- 固定 20 轮不足以区分“缓慢收敛”和“低速泄漏”；需要更长跑/堆快照。

## 相关文件

- `benchmarks/soak.mjs` — CLI（默认固定 20 轮）
- `benchmarks/lib/run-soak.mjs` — workload、采样、不变量、strict
- `benchmarks/lib/report.mjs` — JSON/Markdown schema 与渲染
- `benchmarks/lib/fake-driver.mjs` — 无 Chrome 对照与故障注入
- `tests/soak/soak-logic.mjs`、`tests/soak/soak-real.mjs`
- `benchmarks/README.md` — 操作说明与字段解释
