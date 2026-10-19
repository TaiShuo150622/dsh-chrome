# 发布说明 0.1.94（隔离浏览器上下文 I1 基础）

> 2026-10-19 · 扩展/provider **0.1.94** · 工具面 **43（+evaluate 44）** · `npm test` 28 个测试文件

## 新增

- **per-session headless context**：`backend:"headless"` 按 DSH 会话（agent id）自动创建独立 headless context，独立 profile/截图/下载目录；
- **`chrome_context`** 工具：create/list/current/use/close；
- **配置**：`~/.dsh/config.json`（兼容旧 cache 路径）+ 项目级 `.dsh-chrome/config.json`；preset/maxContexts/idleTimeout/viewport/verification 等字段；
- **生命周期**：并发上限、空闲回收、ephemeral profile 清理、named profile 单占用检查、provider 卸载关闭全部；
- **HeadlessDriver** 支持每个 context 独立 `profileDir/screenshotDir/downloadDir`。

## 当前范围

- 只实现 **headless 隔离**；`debug`（visible）在 I2，`collab`（shared + lease）在 I3，I1 直接拒绝 shared；
- 还没有 `chrome_verify` 断言 API；先用现有 snapshot/screenshot/console/network。

## 测试

- 新增 `test/browser-contexts.mjs`、`test/headless-contexts.mjs`；
- 真实 headless context（独立 profile）goto/snapshot/close 通过；
- `npm test` 28 个文件；公开仓库 CI 绿。
