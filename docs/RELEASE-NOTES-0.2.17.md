# 发布说明 0.2.17（多引擎/凭据/侧边栏 A0）

> 2026-10-19 · 扩展/provider **0.2.17** · `npm test` 43 个测试文件

## 新增

- **多引擎 headless 候选**：`browser.engine` / `browser.headless.chromeExecutable` / `DSH_CHROME_BROWSER`；支持 Chrome/Chromium/Edge/Brave 的 mac/linux/win 候选，显式指定不存在时明确报错；
- **密码 P1 基础**：`src/credentials.js`，opaque credentialId、macOS Keychain adapter、Windows/Linux NOT_SUPPORTED、fake exec 测试；**未接 autofill/UI**；
- **DSH 原生侧边栏 A0**：`client/` bundle 骨架与 `kind:"dsh-chrome"` 注册，**未安装、未验证真机**。

## 测试

- Lead 全量 `npm test`：exit 0，43 个测试文件；
- 新增 `test/headless-browsers.mjs`、`test/credentials.mjs`、`test/client-bundle.mjs`。
