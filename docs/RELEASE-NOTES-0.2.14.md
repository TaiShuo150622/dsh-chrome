# 发布说明 0.2.14（拆分收尾 + 四份设计稿）

> 2026-10-19 · 扩展/provider **0.2.14** · `npm test` 38 个测试文件

## 结构（队列 6，Q26–Q30）

- headless 截图帧缓存/screencast → `headless-screenshot.js`；
- 视觉探针 → `headless-visual-probe.js`；
- viewer → `viewer-auth/driver/input/html.js`，`context-viewer.js` 约 260 行；
- update → `update-release/state/host.js`；
- tools 公共 helper → `tool-support.js`，`tools.js` 约 270 行；
- `headless.js` 约 1440 行。

## 安全

- `chrome_type` 的 `text` 不再明文写入 `operations.jsonl`（operation log 对该工具记 `«redacted»`）；
- 其余密码/凭据问题仍按设计稿处理，未声称已实现。

## 设计稿（并行完成）

- [DSH 原生侧边栏](DSH-SIDEBAR-NATIVE.md)
- [多浏览器沙盒](MULTI-BROWSER-SANDBOX.md)
- [插件设置](PLUGIN-SETTINGS.md)
- [密码管理](PASSWORD-MANAGEMENT.md)

这些是设计/现状稿，不代表已实现。

## 测试

- 子智能体每项全量 `npm test` 通过后提交/push；
- Lead 最终全量 `npm test`：exit 0，38 个测试文件。
