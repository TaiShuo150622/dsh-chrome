# Microsoft Edge 支持（Chromium）

> 状态：安装路径/注册表已支持；**Edge 真机尚未验证**。这是下一步平台包。

## 1. 结论

Edge 是 Chromium，扩展 API 与 Chrome 基本同源，理论上可以直接加载同一份 `extension/`：
- `tabs`、`scripting`、`debugger`、`nativeMessaging`、`tabGroups`、`sidePanel` 等 API 对齐；
- 扩展 ID 由 manifest 的 `key` 固定，因此 `allowed_origins` 与 Chrome 相同；
- native host manifest 注册表键是：
  ```text
  HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.deepseek.dsh.chrome
  ```
  （Chrome 是 `HKCU\Software\Google\Chrome\...`；`src/platform.js` 已包含 edge）。

## 2. 安装

1. 构建/下载 Windows 预览包（同一份 host exe/extension zip）；
2. Edge → `edge://extensions` → 开发者模式 → Load unpacked → 选 extension 目录；
3. 用 Edge 作为目标浏览器启动 provider：
   ```text
   DSH_CHROME_BROWSER=edge
   ```
   `ensureInstallAssets()` 会写 Edge 的 manifest/注册表命令；
4. 完全退出 Edge 再打开；popup 应显示 Connected。

## 3. 需要验证（Edge 真机）

- [ ] Edge 能通过注册表拉起 `dsh-chrome-host.exe`
- [ ] popup Connected；host.log `host started` / `bridge authenticated`
- [ ] 基础工具 goto/snapshot/click/type/screenshot/tabs/console/network
- [ ] debugger 附加、native messaging 长连接稳定
- [ ] 路径含空格/中文、非管理员、SmartScreen（未签名 exe）
- [ ] Edge 的 `sidePanel` 行为（如果使用侧边栏）
- [ ] headless backend：Edge 可执行文件探测（`src/headless.js` 候选需补 Edge）
- [ ] 与 Chrome 同时运行时不共享 native host/group

## 4. 发布

- Edge Add-ons 商店与 Chrome Web Store 可使用同一份扩展 zip（Edge 需要 manifest 兼容性检查）；
- host.exe 仍是 Windows native host，无需单独构建；
- 商店审核等待不影响本地开发者模式验证。

## 5. 当前代码

- `src/platform.js`：edge 路径/注册表/扩展页已存在；
- `src/install.js`：按 `DSH_CHROME_BROWSER=edge` 选择路径；
- 待补：headless backend 的 Edge 可执行文件探测、Edge 真机安装测试、商店打包。
