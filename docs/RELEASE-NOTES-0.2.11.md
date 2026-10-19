# 发布说明 0.2.11（工具域/runtime/headless 动作拆分）

> 2026-10-19 · 扩展/provider **0.2.11** · `npm test` 38 个测试文件

本批由循环子智能体逐项拆分（Q13–Q17），每项全量测试后提交/推送；Lead 最终复跑全量测试并统一 bump。

## 结构

- `src/tools-navigation.js`：goto/history/tabs/close_session；
- `src/tools-capture.js`：capture start/stop/requests（硬确认/预算语义不变）；
- `src/tools-read.js`：snapshot/get_text/find/wait/html/console/network；
- `src/runtime.js`：update checker 创建/start/stop 也收拢进 runtime；
- `src/headless-page-actions.js`：snapshotPage/clickPage/typePage/findPage/selectPage/dragPage 等页面脚本辅助；
- `src/tools.js` 从约 3000 行降到约 2300 行；`src/headless.js` 从约 3200 行降到约 2860 行。

## 测试

- 每项由子智能体全量 `npm test` 通过后独立 commit/push；
- Lead 最终全量 `npm test`：**exit 0**，38 个测试文件；
- 工具数/顺序、schema/render/错误码未变。
