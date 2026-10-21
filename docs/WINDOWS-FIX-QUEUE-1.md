# Windows 真机反馈修复队列 1（P1–P3 + P6，目标 0.2.25）

> 基线：`b13745e`（0.2.24）。依据：Windows 真 Chrome 155 报告（0.2.23，PARTIAL/无 BLOCKER）。
> 规则：每项 `CI=1 npm test`、显式路径 commit、push、勾选；不升版本。

## 队列

- [x] W1（P1）桌面截图可靠性
  - `extension/background.js` 的 `screenshot()`：给 `Page.captureScreenshot` 加扩展侧 timeout（15–20s，稳定错误 `SCREENSHOT_TIMEOUT`）；`withDebugger` finally 必须释放 refs/detach，超时后该 tab 下一次重新 attach，不能连环卡死。
  - 截图前处理不可见 tab：优先 CDP `Page.bringToFront`；失败/非活动 tab 可 `makeTabVisibleForScreencast`（激活/展开 group/聚焦窗口）并在截图后恢复原 active tab；至少先重试一次。
  - 失败返回明确错误，不依赖 provider 60s 超时。
  - 补测试：fake CDP 不返回 -> 预算内 TIMEOUT、refs 归零、下一次可 attach；真实 Chrome 折叠 group/非活动 tab 连续截图（可条件跑）。
- [x] W2（P2）history back/forward 改 CDP
  - `history()` 不再用 `chrome.tabs.goBack/goForward`；用 `Page.getNavigationHistory` + `Page.navigateToHistoryEntry`；越界明确 `NO_HISTORY_ENTRY`；等待 load。
  - 保留 reload 现有行为；headless 不回归。
  - 补真实 Chrome 测试：example.com→iana.org→back/forward 各 3 次；新 tab 无 history 错误。
- [x] W3（P3）tab focus 更新 activeTabId
  - `onTabActivated()` 命中本会话 tab 时更新 `entry.activeTabId`、清 paused、保存；`focus` 同时直接写 `activeTabId`，必要时聚焦 window。
  - `tabs list` 的 `*` 跟随；后续 snapshot/screenshot 用新 active。
  - 补测试：双 tab focus 后 list/snapshot 切换；onTabActivated 不创建新 owner。
- [x] W4（P6）关闭 active context 自动回退
  - 关闭当前 active context 后，如果还有剩余 context，自动 `use` 一个（最近使用/最小 id 规则写清）；`current` 不再 `NO_ACTIVE_CONTEXT`；无剩余时仍明确报错。
  - 补测试：3 context 关闭 active -> 自动回退；关闭最后一个 -> NO_ACTIVE_CONTEXT；显式 use 优先。

## 完成后

Lead 统一 CI=1、Windows host 0.2.25、release notes、Windows 测试指南 0.2.25 与复测清单。
