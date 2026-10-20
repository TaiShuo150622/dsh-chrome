# 发布说明 0.2.23（H4–H8 安全/生命周期收尾）

> 2026-10-19 · 扩展/provider **0.2.23** · `npm test` 61 个测试文件

## 安全

- **H4 跨会话读面**：`chrome_download` 默认只看本会话窗口/启动后或显式 `includeHistory` + hardConfirm；`chrome_audit` 按 session 过滤；无 owner 旧截图默认隐藏。
- **H5 密码/OTP**：`chrome_type`/`chrome_press`/`chrome_verify.type` 命中 password/OTP/payment 字段走 hardConfirm 或 credential；`chrome_headless_login` 确认卡显示 URL/origin；credentials 增加 target origin/scope，默认 https。
- **H6 chrome_verify**：navigate/click/type 走 guard/audit；默认拒绝 loopback/link-local/私网（测试 allowlist 例外）；console/network artifact 脱敏；重定向进私网会失败并离页。

## 生命周期

- **H7 close 有界**：`Browser.close` 2s → SIGTERM → 1s → SIGKILL；manager close/closeAll/启动失败回滚有界，provider unload 不会无限挂起。
- **H8 crashed 状态**：driver state（ready/crashed/closing/dead）、deathReason、chromePid 进入 `chrome_status`/`chrome_context`；crashed context 保留、不静默重启；`chrome_context {op:"restart"}` 显式重建。

## 测试

- `CI=1 npm test`：exit 0，61 个测试文件；
- 3 轮真实 headless soak：3/3 PASS、0 不变量失败、11.4s；Chrome peak 1745.5MiB/15 proc；Node rss peak 88.8MiB；
- 20 轮 soak 基线仍见 `docs/MEMORY-SOAK.md`（本次 3 轮仅做回归，长跑/40+ 轮仍待）。

## 仍待

- Windows/Linux 真机完整链路；
- 40+ 轮 soak / heap snapshot 判断 Node 缓慢增长；
- 原生 DSH 侧边栏、桌面多引擎、Safari、密码 helper/autofill 等后续功能。
