# 结构重构队列 5（剩余 tools + headless dispatch）

> 基线：`c8aa1b7`（0.2.12）。规则同前：每次只做一项、全量 `npm test`、explicit paths commit、立即 push、勾选本项；本批不逐项 bump/release。
> schema/render/错误码/审批/lease 行为不能变；不改 extension 行为；不引入依赖。

## 队列

- [x] Q23 拆出 media 工具
  - 新建 `src/tools-media.js`，迁移 `chrome_screenshot`、`chrome_download`、`chrome_pdf`、`chrome_shots`、`chrome_frames`；
  - attachments/assets/bridge 依赖显式注入；全量测试。
- [ ] Q24 拆出 misc 工具
  - 新建 `src/tools-misc.js`，迁移 `chrome_evaluate`、`chrome_pick`、`chrome_resume`、`chrome_storage`、`chrome_selection`；
  - 保留 evaluate 硬确认、pick 可见窗口约束、storage 读写语义；全量测试。
- [ ] Q25 headless dispatch 动作表
  - 将 `HeadlessDriver.dispatch()` 中导航/输入类 handler（goto/history/click/clickAt/type/press/scroll/select/hover/drag/wait 等）抽到 `src/headless-actions.js` 的 handler 注册表（可先抽一层，保留 facade 与错误码）；
  - 不改变任何输出/截图/探针语义；全量测试。

## 完成后

队列全勾选报告“队列完成”，不要 bump/release；Lead 统一测试、bump、notes。
