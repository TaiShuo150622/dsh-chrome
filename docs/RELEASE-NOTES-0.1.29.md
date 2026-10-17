# Release Notes 草稿 — 0.1.29（2026-10-17）

> 用于 GitHub Release 正文；发布前按 `docs/RELEASE.md` 检查清单核对。

## 亮点

- **20 个 `chrome_*` 工具**：读页面、点击/输入/按键/滚动/选择/悬停、标签组、截图（含区域）、console、network、上传、下载、claim 标签、dialog 处理。
- **虚拟光标**：点击/输入/按键/滚动时在页面上显示 DSH 蓝色光标，截图可见。
- **自动重连修复**：`ensurePort` 的 `connecting` 状态位不再永久卡死；native host 崩溃/被杀后约 10 秒自动恢复（Chrome for Testing 真机验证）。
- **开发期自动重载**：native host 监听 `extension/`，改动后扩展自动 reload，无需手动 ⟳。
- **9 条无 Chrome 回归测试**：bridge 协议/鉴权、host 跨 provider 重启重连、扩展逻辑（VM + mock chrome）、工具 schema、manifest 结构、工具层（P0/P1/P2）。

## 安装

见 [docs/INSTALL.md](docs/INSTALL.md)：启用 bundle → `chrome://extensions` 加载 `extension/` → 必要时重启 Chrome → popup 显示 Connected。

## 产物

- `dist/dsh-chrome-extension-0.1.29.zip`（`npm run package:extension`）
- 校验 sha256 后写入 Release 附件说明。

## 已知限制

- 仅 macOS；仅测试过 Chrome 155 与 Chrome for Testing 148。
- 真实桌面 Chrome 实例仍需手动加载一次扩展（之后断线可自动恢复）。
- 页面动作依赖 CDP，attach 期间 Chrome 可能提示「正在调试此浏览器」。
- `chrome_network` v1 无状态码/headers。
- P2 Gate 剩余：登录站点、并发会话、登录交还、连续 3 天真实使用。
