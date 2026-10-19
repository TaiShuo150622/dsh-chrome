# 发布说明 0.2.22（生命周期/监控/团队加固）

> 2026-10-19 · 扩展/provider **0.2.22** · `npm test` 60 个测试文件

本版按 `dsh-next-steps-agent-team-plan.md` 执行：主协调者锁定契约/生命周期表，Headless、Extension、Observability、Platform 四条线并行，Lead 合并/复测/发布。

## 生命周期与内存

- Tab 容量检查前置，达到上限不创建 Chrome target；attach/enable/visual tracker 失败回滚；
- 统一 cleanupTab/cleanupCapture/cleanupOwner/cleanupContext/cleanupBrowser；tab/session/owner/capture/download/console 清理；
- close 清 idle timer/downloadByGuid；浏览器异常退出清全部业务状态并标记 dead；visible 不被 driver idle 杀；
- 启动失败 kill child、清 cdp/chrome/startPromise；capture stop 释放 body/entries，保留摘要 TTL；截图帧上限；
- 用户可配置 `browser.maxTabs`（默认 12，1–64，volatile）与 `browser.maxContexts`；一个浏览器可多 tab；`chrome_status` 显示限额。

## 监控

- `chrome_memory_stats`：Node RSS/heap/external/arrayBuffers、对象计数、Chrome 进程树 RSS；
- 持续采样 ring/JSONL（0600、轮转、2 天）+ alerts（RSS 增长、capture body、pending、tabs/bySession 不一致、孤儿 PID）；
- 固定 soak：`npm run soak` / `npm run soak:real`；1 轮真实 macOS 结果：Node RSS peak 70.2MiB，Chrome peak 1.66GiB/12 proc，retained +13.48MiB，after-first-round 0，PASS。
- 20 轮真实基线（Observability 线）：20/20 PASS、0 不变量失败、158.7s；Chrome 峰值 1944MiB/15 进程，每轮关闭后进程树归零；Node heapUsed 排除首轮 +1.8MiB，fake 对照 +0.36MiB，列为候选点而非已确认泄漏。详见 `docs/MEMORY-SOAK.md`。

## 平台/协议

- hello/hello-ok 强制 protocol；不匹配 `PROTOCOL_VERSION_MISMATCH`；有界重试（3 次后低频轮询）；
- host 版本来自 package/构建注入，不再硬编码 0.0.1；bridge discovery 写失败回滚；
- 平台 smoke：macOS 安装→host→bridge→browser.status→tab.goto→退出清理 PASS；Windows/Linux 真机缺口见 PLATFORM-AUDIT。

## 测试

- 全量 `CI=1 npm test`：exit 0，60 个测试文件；
- 1 轮真实 soak PASS；
- 团队线：Headless 3 commits、Extension 1、Observability 1、Platform 1；Lead 合并后复测。

## 说明

- Chrome 峰值 1.66GiB 是 headless Chrome 12 进程的峰值，不是 Node 泄漏；单 context 的 Chrome 开销仍是主要内存来源。
- 真实 Chrome reload/provider-kill e2e、Windows/Linux 真机、200+ 轮长 soak 仍待后续。
