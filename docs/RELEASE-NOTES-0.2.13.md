# 发布说明 0.2.13（media/misc 工具 + dispatch 动作表）

> 2026-10-19 · 扩展/provider **0.2.13** · `npm test` 38 个测试文件

本批由循环子智能体完成 Q23–Q25，每项全量测试后独立提交/推送；Lead 最终复跑全量测试并统一 bump。

## 结构

- `src/tools-media.js`：screenshot/download/pdf/shots/frames；
- `src/tools-misc.js`：evaluate/pick/resume/storage/selection；
- `src/headless-actions.js`：goto/history/click/clickAt/type/press/scroll/select/hover/drag/wait 的 handler 注册表；
- `src/tools.js` 从约 1270 行降到约 640 行；
- `src/headless.js` 从约 2810 行降到约 2490 行；
- schema/render/错误码/审批/lease/截图/探针语义未变。

## 测试

- 子智能体每项全量 `npm test` exit 0 后提交/push；
- Lead 最终全量 `npm test`：exit 0，38 个测试文件；
- 公开仓库已推送。
