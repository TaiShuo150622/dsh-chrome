# 结构重构队列 3（工具域 + runtime + headless 动作）

> 基线：`068f865`（0.2.10）。规则同前：每次只做一项、全量 `npm test`、explicit paths commit、立即 push、勾选本项；本批不逐项 bump/release。
> 目标：继续把 `src/tools.js` 与 `src/headless.js` 按域拆小，同时不改变 schema/render/错误语义。

## 队列

- [ ] Q13 拆出 navigation 工具
  - 新建 `src/tools-navigation.js`，迁移 `chrome_goto`、`chrome_history`、`chrome_tabs`、`chrome_close_session`；
  - 工厂只注入实际依赖（bridge/call、guard、ownerOf、sessionLabel、URL 校验、renderText、outputSchema、leases）；
  - 保留 tab/owner/lease 语义；全量测试。
- [ ] Q14 拆出 capture 工具
  - 新建 `src/tools-capture.js`，迁移 `chrome_capture_start`、`chrome_capture_stop`、`chrome_capture_requests`；
  - 硬确认/approval/错误码语义不变；全量测试。
- [ ] Q15 拆出只读页面工具
  - 新建 `src/tools-read.js`，优先迁移 `chrome_snapshot`、`chrome_get_text`、`chrome_find`、`chrome_wait`、`chrome_html`、`chrome_console`、`chrome_network`；
  - schema/render/文本预算不变；全量测试。
- [ ] Q16 runtime 继续收拢
  - `src/runtime.js` 接管 update checker 的创建/start/stop（viewer/liveview 已在）；
  - `index.js` 只保留 effect 与注入；清理顺序不变；全量测试。
- [ ] Q17 headless 页面动作拆出
  - 新建 `src/headless-page-actions.js`，迁移 `snapshotPage`、`clickPage`、`typePage`、`findPage`、`selectPage`、`dragPage` 等纯页面脚本辅助（按实际依赖可调整范围）；
  - `HeadlessDriver` 保留 `pageAction` 与 dispatch，行为/输出不变；全量测试。

## 完成后

队列全勾选报告“队列完成”，不要 bump/release；Lead 统一测试、bump、更新 notes。
