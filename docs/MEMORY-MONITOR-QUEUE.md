# 内存监控队列（Codex 监控提议）

> 基线：`1fc0e91`（M1–M5 完成）。规则同内存队列：每项 `CI=1 npm test`（已知 bench 时序 flake 允许重试），显式路径 commit/push/勾选；不升版本。
> 目标：把“感觉 agent 调用后内存变高”变成可查询的数据；先快照，再持续采样，再加 Chrome 进程 RSS。

## 队列

- [x] M6 `chrome_memory_stats` 快照
  - 新增 `src/memory-stats.js`：`nodeMemory()`（rss/heapUsed/heapTotal/external/arrayBuffers）、`objectCounts()` 从 contexts/bridge 汇总。
  - `HeadlessDriver.memoryStats()`：chromePid、tabs、owners、bySession、consoleBuffers、captures、captureEntries、captureBodyBytes、downloads、downloadByGuid、shotStreams、idleTimer、visible。
  - `BrowserContextManager.memoryStats()` 聚合每个 context 的 driver stats；`BridgeServer.memoryStats()`（connected/pending/handlers）。
  - 新增工具 `chrome_memory_stats`（name 保持）；`chromeTools` 注入 `memoryStats`；index 传入。
  - 工具计数 45→46（+evaluate 47）；更新 p0/p1/p2/tool-schemas/sandbox 计数和覆盖。
  - 测试 `test/memory-stats.mjs`：fake contexts/bridge；无 context/bridge 时字段存在；计数正确。
- [x] M7 持续采样 ring/JSONL + alerts
  - 新增 `src/memory-monitor.js`：`MemoryMonitor` 每 N ms 采样；内存中最多 600 条；可选 JSONL 写 `~/.dsh/cache/dsh-chrome/memory.jsonl`（0600，轮转/最多 2 天；只写数值/计数，不含页面内容）；`start/stop/status/dump`。
  - `chrome_memory_stats {op:"start|stop|status|dump", intervalMs}`：start 需要显式调用；status 默认快照；dump 返回最近 ring 和 retained 计算。
  - alerts：单次 rss > baseline*1.2、captureBodyBytes>8MB、pending>64、tabs!=bySession、context 关闭后 chromePid 仍存在。
  - 测试 fake timer/fake fs；不影响正常工具路径。
- [x] M8 Chrome 进程树 RSS
  - 新增 `src/process-tree.js`：按 chromePid 递归读取子进程 RSS（mac/linux `ps`；Windows 返回 unsupported 或 PowerShell fallback），注入 exec 供测试。
  - `HeadlessDriver.memoryStats()` 增加 chromeRss/processCount（best-effort，失败 null，不阻塞工具）。
  - 测试 fake ps 输出、pid 关闭、Windows unsupported；`chrome_memory_stats` 返回 chrome 侧字段。

## 完成后

Lead 统一复测、bump patch、release notes、Windows 包；工具面仍按“先观察数据”不收缩。
