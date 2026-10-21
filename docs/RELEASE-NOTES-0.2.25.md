# 发布说明 0.2.25（Windows P1–P3/P6 修复）

> 2026-10-21 · 扩展/provider **0.2.25** · `npm test` 61 个测试文件

基于 Windows 真 Chrome 155 报告（0.2.23，PARTIAL/无 BLOCKER）。

## 修复

- **P1 桌面截图**：`Page.captureScreenshot` 扩展侧 15s 超时、总预算 30s/最多两次；`withDebugger` 超时后释放 refs/detach，下一次重新 attach；截图前 `Page.bringToFront`，非活动/折叠 group/最小化时走 `makeTabVisibleForScreencast` 并恢复原 active tab。超时不再连环卡死。
- **P2 history**：`chrome_history back/forward` 改用 CDP `Page.getNavigationHistory` + `Page.navigateToHistoryEntry`；越界明确 `NO_HISTORY_ENTRY`；reload 保持原行为。
- **P3 tab focus**：`onTabActivated`/`focus` 同步 `entry.activeTabId`；`tabs list` 的 `*`、后续 snapshot/screenshot 跟随新 active；不新建 owner。
- **P6 context**：关闭 active context 后自动回退到同 owner 最近使用（lastUsedAt 最大、同值最小 contextId）；关闭最后一个仍明确报错；`close` 返回 `activeContextId/fallback/hint`。

## 验证

- `CI=1 npm test`：exit 0，1655+ PASS；
- macOS 真 Chrome：example.com → iana.org back/forward 成功；双 tab focus 后 list/snapshot 跟随；非活动 tab 截图成功；
- 扩展逻辑测试覆盖截图悬挂、超时 refs 清理、折叠 group、history 越界、focus active、context 回退。

## 说明

- Windows 真机仍需按 `WINDOWS-TEST-GUIDE-0.2.25.md` 复测 P1–P3/P6；
- P4 overlay isolated world、P5 auto-reload bridge 抖动、P7 小项留待下一批。
