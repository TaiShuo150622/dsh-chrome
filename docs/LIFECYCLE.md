# 生命周期与资源表（A-02）

> 基线 0.2.21 / 3014180。每项必须有创建者、所有者、上限、正常释放、异常释放；新增资源先补此表。

| 资源 | 创建者 | 所有者 | 上限 | 正常释放 | 异常释放 | 观测 |
|---|---|---|---|---|---|---|
| context | BrowserContextManager.create | owner/session | `browser.maxContexts` | closeOwned/close | reaper、provider unload、启动失败 | contexts/tabs/limits |
| driver | createDriver | context | 每 context 1 | driver.close | context close/崩溃 | state/pid |
| Chrome process | HeadlessDriver.ensureStarted | driver | 每 driver 1 | Browser.close→SIGTERM→SIGKILL | startup failure、browser exit | chromePid/RSS |
| CDP websocket | Cdp.connect | driver | 1 | cdp.close | disconnect handler | connected |
| tab | attachTab | owner entry | `browser.maxTabs` | tabs.close/cleanupTab | target detach/browser exit | tabs/bySession |
| session | attachToTarget | driver | 每 tab 1 | cleanupTab | detach/browser exit | bySession |
| owner entry | ownerEntry | driver | 每 owner 1 | 最后 tab 关闭/context close | browser exit | owners |
| console buffer | attachTab | tab | 500 entries | cleanupTab | tab close/browser exit | consoleBuffers |
| capture | capture_start | tab/owner | 300/hard 1000；8MB | capture_stop + TTL/summary | tab close/context close | captures/captureBodyBytes |
| screenshot frame | HeadlessScreenshot | tab | 单帧字节/像素上限 | dropShotStream/stop | tab close/context close | shotFrameBytes |
| screencast stream | screencast_start | tab | 1/tab | stop/timer | tab close/context close | streams/frames |
| download | CDP event | driver | 数量/TTL | 关闭时清理摘要 | driver close | downloads/downloadByGuid |
| pending request | BridgeServer.call | bridge | 64；60s | response/timeout | disconnect/reload | pendingRequests |
| timer/listener | 各模块 | 所属资源 | 1 dispose | close/stop | 失败回滚 | timers |
| memory sample | MemoryMonitor | monitor | ring 600/2 天 | stop/rotate | provider unload | memory stats |

## 不变量

1. `tabs.size === bySession.size`（tab 生命周期内）。
2. 最后 tab 关闭且无 login/pending 时 `owners` 对应 entry 删除。
3. context 关闭后无该 context 的 Chrome 子进程；`chromePid` 不存活。
4. capture stop 后 entries/body 在 TTL 内释放；摘要保留。
5. 所有 map/timer/listener 在 driver.close 后归零。
6. 初始化失败不得留下 target/session/map 增量。
7. 监控采样不得包含页面正文/秘密。
8. 同一 owner 的写操作受 lease/owner 约束；跨 owner 只读返回 not found。

## 固定压测

`benchmarks/soak.mjs`（Observability 线）：1 context、4 tabs、每 tab goto+snapshot+screenshot、capture/screencast 各 start/stop 10 次、关闭、等待，重复 20 轮；记录 Node/Chrome RSS、对象计数、结束基线、retainedAfterRun。
