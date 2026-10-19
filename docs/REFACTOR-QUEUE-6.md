# 结构重构队列 6（headless/viewer/update/tools 组装）

> 基线：`61d53be`（0.2.13）。规则同前：每次只做一项、全量 `npm test`、explicit paths commit、立即 push、勾选本项；本批不逐项 bump/release。
> schema/render/错误码/审批/lease/截图/探针语义不能变；不改 extension 行为；不引入依赖。

## 队列

- [ ] Q26 headless 截图/screencast 状态拆出
  - 新建 `src/headless-screenshot.js` 或等价模块，迁移 screenshot 缓存/帧处理/screencast 状态中相对自洽的部分；
  - HeadlessDriver 保留 facade；全量测试。
- [ ] Q27 headless 视觉探针拆出
  - 新建 `src/headless-visual-probe.js`，迁移 `visualProbeAction` 及相关辅助（按依赖调整）；
  - 不改变探针判定/缓存行为；全量测试。
- [ ] Q28 context-viewer 内部拆分
  - 拆为 `viewer-auth` / `viewer-input` / `viewer-html` 等（按实际依赖），`context-viewer.js` 只做注册/编排；
  - token/access/loopback/输入语义不变；更新 `test/context-viewer.mjs`；全量测试。
- [ ] Q29 update 内部拆分
  - 拆为 release-source / state / host-installer 等；`UpdateChecker` 只做编排；
  - release 解析/版本比较/SHA 校验/写盘行为不变；全量测试。
- [ ] Q30 tools.js 组装层收尾
  - 把剩余公共 helper（call/guard/approval/policy/owner/session 等）抽到 `src/tool-support.js`（或等价），`tools.js` 只做注册/装配；
  - 不改变工具顺序/schema/render/错误码；全量测试。

## 完成后

队列全勾选报告“队列完成”，不要 bump/release；Lead 统一测试、bump、notes。
