# 发布说明 0.2.19（跨平台自动更新）

> 2026-10-19 · 扩展/provider **0.2.19** · `npm test` 44 个测试文件

## 自动更新

`update.autoInstall` 现在按平台处理：

- **Windows**：下载 `dsh-chrome-host-win32-x64.exe`，校验 SHA-256 后替换 `~/.dsh/cache/dsh-chrome/host/dsh-chrome-host.exe`；
- **macOS/Linux**：下载 release 的 `dsh-desktop-chrome-<version>.tgz` 和 `dsh-chrome-extension-<version>.zip` 到 `~/.dsh/cache/dsh-chrome/downloads/update-<version>/`，记录到 `update.json`；**不热替换**正在运行的插件/扩展，下次安装/重启显式使用；
- 没有对应 SHA 资产时只下载不校验（会记录 staged；有 SHA 则校验）；
- DSH 插件本体仍建议通过 DSH 插件管理器更新；Chrome 未打包扩展不能自更新。

## 插件设置

- DSH Config schema 已在运行中的 DSH 验证：`Config.listConfigs` 返回 `status: "schema"`；自动设置页只投影 4 个 volatile 字段（`browser.preset/maxContexts/idleTimeoutMs`、`verification.artifactRetentionRuns`）；
- `update.*` 仍是非 volatile，改动需重载 provider；不会把 `autoInstall` 暴露到表单默认值里。

## 测试

- Lead 全量 `npm test`：exit 0，44 个测试文件；
- 新增 macOS/Linux staging 测试（fake release assets / SHA）。
