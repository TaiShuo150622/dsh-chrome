# 浏览器支持与部署路线（Chrome / Edge / Safari）

> 2026-10-19 · 公开版路线说明；当前只承诺 **Chrome（Chromium）**，Edge 是下一目标，Safari 单列。

## 1. 现状

- Chrome（Windows/macOS/Linux）：扩展 + native host + provider，已支持。
- 隔离浏览器上下文 I1：per-session headless context、独立 profile、`chrome_context`、配置；visible/shared 后续。
- 部署：仓库 public、Release 提供 extension zip / host exe / DSH 插件 tgz；DSH「添加插件」支持 GitHub 地址或本地目录。

## 2. Edge

Edge 是 Chromium：
- 扩展 API（tabs/scripting/debugger/nativeMessaging/sidePanel）基本同源，现有扩展预期可加载；
- native messaging 注册表路径、扩展 ID/manifest 需要 Edge 对应值；
- `src/platform.js` 已有 edge 路径表，`install.js` 需要 Edge 真机验证；
- 发布：Edge Add-ons 商店 + 同一 host.exe；
- 工作量：主要是安装/注册表/商店打包和真机验证，**约 3–5 人日**（不含商店审核）。

## 3. Safari

Safari 不是 Chromium，不能直接复用 Chrome 扩展：
- Safari Web Extension 需要 Xcode 工程 + Apple 签名/App Store；
- 没有 `chrome.debugger`、`chrome.tabs` 同等 API；浏览器控制能力受限；
- 需要单独的 Safari 扩展 + 可能的 native helper；
- 仅 macOS/iOS，分发必须走 App Store；
- 建议先做**可行性 spike**（Safari Web Extension 能做什么、不能做什么），再决定是否投入；**6–12 人日起步**，不放进近期。

## 4. 部署容易

短期：
- DSH 插件：GitHub 地址或本地目录（tgz 已含 Windows host.exe）；
- 扩展：Release zip + 手动 Load unpacked；
- native host：provider 自动写 manifest/注册表；Windows 用预构建 exe，无需 Node。

中期：
- Chrome Web Store / Edge Add-ons 上架扩展；
- host.exe 签名（Windows Authenticode）、macOS notarization；
- 一键安装器（MSI/pkg）或 provider 自动下载并校验 host 二进制；
- 自动更新：extension 由商店更新，host 由 provider/installer 更新；
- 配置：`~/.dsh/config.json` / 项目级，DSH 设置页可选。

## 5. 路线

| 阶段 | 内容 | 状态 |
|---|---|---|
| I1 | per-session headless context + config + `chrome_context` | ✅ 进行中/已落地 |
| I1.5 | artifacts 清单 + `chrome_verify` 最小断言 | 下一步 |
| I2 | isolated-visible（人工登录/CAPTCHA） | 后续 |
| I3 | shared-visible + tab lease | 后续 |
| E-Edge | Edge 安装/注册表/真机验证/商店 | 下一个平台 |
| E-Store | Chrome/Edge 商店 + host 签名/自动更新 | 发布前 |
| S-Safari | Safari Web Extension 可行性 spike | 未来，单独评估 |
