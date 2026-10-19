# 发布说明 0.2.15（隐私/多沙盒硬化）

> 2026-10-19 · 扩展/provider **0.2.15** · `npm test` 39 个测试文件

本批由循环子智能体完成 Q31–Q34，每项全量测试后独立 commit/push；Lead 最终复跑全量测试并统一 bump。

## 隐私

- `chrome_type` 结果不再返回字段值，render 不再显示输入内容；
- headless `chrome_selection` 对 password/hidden/支付/OTP 等敏感字段返回 `SENSITIVE_SELECTION`；
- viewer 的 type 回包/状态栏只显示 typed/submitted，不回显文本；
- capture 脱敏补齐 `pwd`/`otp`/`cvv`/`auth`、URL fragment、inline `password=...`；
- `chrome_verify` 的 `steps[].text` 不再明文进入 operation log；
- 新增 `test/headless-redact.mjs` 与哨兵泄漏断言。

## 多 context 硬化

- `create` 增加 pending 预留，`maxContexts` 并发不超限；
- 同一 owner 并发 create 复用同一个进行中 context；
- named profile 并发创建原子拒绝 `PROFILE_IN_USE`；
- 失败时回滚 ephemeral profile/槽位/预留；
- `chrome_headless_login` 接到当前 active context 的 driver；无 active → `NO_ACTIVE_CONTEXT`，driver 不支持 → `UNSUPPORTED_BACKEND`；
- 新增 16 并发 / 同 owner 去重 / profile 互斥 / 失败回滚测试。

## 说明

- 仍不是完整的密码管理器：没有 Keychain/autofill/helper；设计见 `docs/PASSWORD-MANAGEMENT.md`；
- 设计稿中的多引擎、原生 DSH 侧边栏、设置 UI 仍未实现。
