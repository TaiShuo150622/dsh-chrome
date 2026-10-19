# 发布说明 0.2.12（剩余工具域/runtime/login 拆分）

> 2026-10-19 · 扩展/provider **0.2.12** · `npm test` 38 个测试文件

本批由循环子智能体逐项完成 Q18–Q22，每项全量测试后独立提交/推送；Lead 最终复跑全量测试并统一 bump。

## 结构

- `src/tools-input.js`：click/click_at/type/press/hover/scroll/select/drag/upload；
- `src/tools-status.js`：status/config/policy/audit；
- `src/tools-screencast.js`：screencast/pointer/annotate/emulate；
- `src/headless-login.js`：loginStart/showVisible/loginFinish/loginStatus 生命周期，`HeadlessDriver` 保留同名 facade；
- `src/runtime.js`：bridge 创建/启停、install assets、contexts cleanup 编排；
- `src/tools.js` 约 1270 行，`src/headless.js` 约 2810 行（较大模块已明显变小）；
- 工具 schema/render/错误码/审批/lease 行为保持不变。

## 测试

- 子智能体每项全量 `npm test` exit 0 后提交/push；
- Lead 最终全量 `npm test`：exit 0，38 个测试文件；
- 公开仓库 CI 触发。
