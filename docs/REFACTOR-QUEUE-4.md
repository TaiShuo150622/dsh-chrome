# 结构重构队列 4（剩余工具域 + runtime + headless login）

> 基线：`09ad342`（0.2.11）。规则同前：每次只做一项、全量 `npm test`、explicit paths commit、立即 push、勾选本项；本批不逐项 bump/release。
> schema/render/错误码/审批行为不能变；不改 extension 行为；不引入依赖。

## 队列

- [x] Q18 拆出 input 工具
  - 新建 `src/tools-input.js`，迁移 `chrome_click`、`chrome_click_at`、`chrome_type`、`chrome_press`、`chrome_hover`、`chrome_scroll`、`chrome_select`、`chrome_drag`、`chrome_upload`；
  - 注入实际依赖；`mutating` 元数据/审批/lease 语义不变；全量测试。
- [x] Q19 拆出 status/config/policy/audit 工具
  - 新建 `src/tools-status.js`（或按域拆两个文件），迁移 `chrome_status`、`chrome_config`、`chrome_policy`、`chrome_audit`；
  - 保留 `update`/`assets`/`bridge` 注入；全量测试。
- [ ] Q20 拆出 screencast/overlay 工具
  - 新建 `src/tools-screencast.js`，迁移 `chrome_screencast`、`chrome_pointer`、`chrome_annotate`、`chrome_emulate`（按实际依赖调整）；
  - 不改变截图/光标/注释行为；全量测试。
- [ ] Q21 headless login 生命周期拆出
  - 新建 `src/headless-login.js`，迁移 `HeadlessDriver` 的 `loginStart/showVisible/loginFinish/loginStatus` 相关逻辑（必要时注入 CDP/launcher）；
  - `HeadlessDriver` 保留同名 facade，输出/行为不变；全量测试。
- [ ] Q22 runtime 接管 bridge/install/contexts 生命周期
  - 扩展 `src/runtime.js`：创建/启停 bridge、install assets、contexts cleanup 的编排（可分小步，不要求一次全搬）；
  - `index.js` 只剩 effect + 注入；清理顺序保持；全量测试。
