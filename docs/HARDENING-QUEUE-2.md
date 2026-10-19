# 加固队列 2（H4–H8：安全收尾 + close/crash）

> 基线：`a67a6b2`（0.2.22 + 团队合并）。规则：每项 `CI=1 npm test`、显式路径 commit、push、勾选；不升版本；不改工具面。
> 目标：完成 HARDENING-PLAN 中剩余的发布级安全/生命周期项。

## 队列

- [x] H4 跨会话读面收敛
  - `chrome_download` 只返回本会话启动后/当前窗口可见的下载，或显式 `includeHistory:true` + hardConfirm；默认不读全机历史。
  - `chrome_audit` 按 session/owner 过滤（若记录里有）；无 owner 的旧截图默认隐藏，提供显式排障开关并审计。
  - 补双会话测试；错误语义不变。
- [ ] H5 密码/OTP 字段硬确认
  - 扩展/headless 的 type/press/verify.type 识别 password/OTP/payment 字段；命中走 `hardConfirmAsk` 或 credential 模式，不自动明文输入。
  - `chrome_headless_login` 确认卡显示完整 URL/origin；`credentials.fill` 接收 target origin/scope，默认只允许 https（loopback 例外）。
  - 补测试：敏感字段确认/拒绝、不泄漏值、origin 不匹配失败。
- [ ] H6 chrome_verify 安全收口
  - steps 的 navigate/click/type 走 guard/audit；默认拒绝 loopback/link-local/私网（测试 allowlist 可放行）。
  - console/network artifact 脱敏；navigate 目标 URL 审批；补测试。
- [ ] H7 close 有界 + 取消
  - `HeadlessDriver.close` 用 bounded closePromise：Browser.close(2s) → SIGTERM(1s) → SIGKILL；CDP 永不回包也必须在预算内返回。
  - `BrowserContextManager.close/closeAll` 有界；provider unload 不无限挂起；启动失败清理有界。
  - 补假 CDP/假 child 的超时测试。
- [ ] H8 crashed 状态可见
  - `chrome_status`/`chrome_context` 显示 driver state（ready/crashed/closing/dead）、deathReason、chromePid。
  - `HeadlessContextRouter.connected` 基于 driver 状态；`chrome_context {op:"restart"}` 或显式 `CONTEXT_CRASHED` 后重建策略。
  - 补崩溃→status→restart 测试；不自动静默重启。

## 完成后

Lead 统一 CI=1、真实 soak、bump 0.2.23、Windows 0.2.22 host 包、release notes。
