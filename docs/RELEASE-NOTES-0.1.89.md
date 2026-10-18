# 发布说明 0.1.89（Windows host / 沙箱 QA / 安全收口）

> 2026-10-18 · 扩展 **0.1.89** / provider **0.1.89** / 工具面 40 / `npm test` **22 个测试文件**

## Windows

- Node SEA 方案：`host/host.mjs` 打成单文件 `dsh-chrome-host.exe`；`.github/workflows/windows-host.yml`
  在 `windows-latest` 构建、校验 fuse、上传 artifact；`install.js` 优先使用
  `host/bin/win32-<arch>/dsh-chrome-host.exe`，找不到回退 `.cmd`。
- 文档：`docs/WINDOWS-HOST.md`；路径表/注册表命令见 `docs/INSTALL-PLATFORM.md`。
- **未验证**：Windows 真机 PE 注入、Chrome 实际拉起 exe、注册表/SmartScreen/AV、路径含空格、arm64。

## 沙箱功能矩阵

- `test/sandbox-smoke.mjs`：41 个工具 × headless 真机 + desktop fake，79 checks；9 条已记录差异（snapshot delta/frames、find regex、hover 语义、scroll schema、frames probe、wait networkidle/change、selection/storage 标签、viewer 环境）。
- 修复 P1：headless `chrome_pdf`、错误码透传、`chrome_headless_login start` 不建 tab、`chrome_shots` 双目录（144e553）。

## 安全 Top 5（RISK-REVIEW）

- **policy 按目标对象**：guard 用目标 tab/URL；`browser.site`/`chrome_policy` 支持 tabId。
- **审批 fail-closed**：approval/agent/site 缺失 → `APPROVAL_DENIED` + denied 审计。
- **本机文件边界**：`chrome_upload` 硬确认 + cwd/`DSH_CHROME_UPLOAD_ROOTS` 白名单；provider/headless/extension 只允许 http(s)/about:blank。
- **部分跨会话隔离**：screencast 帧带 owner、截图 owner 表、claim 拒绝他人 tab、带 label 的组标题加 owner 短 id。
- 残留：页内导航后的读取、downloads/audit 全机、旧截图无 owner、capture/screencast 计时器不 detach、headless CDP 无超时等，见 `docs/SECURITY-FIXES.md` 与 `docs/RISK-REVIEW.md`。

## 测试

`npm test` 22 个测试文件全过；headless 时序测试在高外部负载下会 flake，`npm test` 用 4 次重试兜底（严格断言未放宽；时序阈值按 loadavg 缩放）。

## 公开仓库

仍未公开：见 `docs/PUBLIC-RELEASE-CHECKLIST.md`。剩余阻断项：Windows 真机验证、敏感信息清理、GitHub Actions（含 windows-host）真实跑通。

## 升级注意

- `chrome_upload` 默认只允许会话 cwd；需要上传其他目录时设 `DSH_CHROME_UPLOAD_ROOTS`。
- 组标题格式变化：`DSH · <label> · <owner 短 id>`。
- policy `ask` 模式优先于 danger-full-access；审批缺失不再放行。
