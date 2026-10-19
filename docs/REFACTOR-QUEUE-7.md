# 安全 / 多沙盒硬化队列 7

> 基线：`a4bd2f3`（0.2.14 + 密码设计终稿）。规则同前：每次只做一项、全量 `npm test`、explicit paths commit、立即 push、勾选本项；本批不逐项 bump/release。
> 不改 extension 行为；不引入依赖；错误码/审批/lease/截图行为不能无故变化。

## 队列

- [x] Q31 `chrome_type` 不再把字段值返回给模型
  - `src/tools-input.js` 的 type 工具：result 去掉 `value`，render 不显示输入值，输出 schema 去掉 value；测试同步（p1/sandbox 等）；
  - driver/extension 仍可保留内部 value，但工具面不得返回；全量测试。
- [ ] Q32 headless 选区 + viewer type 回包脱敏
  - `src/headless-page-actions.js` 的 `currentSelection` 对 password/hidden/支付/OTP 等敏感字段返回 `SENSITIVE_SELECTION`；
  - `src/viewer-input.js` / `viewer-html.js` 的 type 回包/状态栏不再显示 value，只显示 typed/submitted；
  - 更新 context-viewer/headless 相关测试；全量测试。
- [ ] Q33 capture / verify 脱敏补齐
  - `src/headless-redact.js` 的 secret key/URL fragment/inline `password=...` 补齐 `pwd`/`otp`/`cvv` 等；
  - `chrome_verify` 的 `steps[].text` 不再明文进入 operation log（工具级 nested redaction）；
  - 新增/更新测试（含哨兵值不落盘）；全量测试。
- [ ] Q34 多 context 并发硬化
  - `BrowserContextManager.create` 增加 pending 预留，`maxContexts` 并发不超限；
  - 同一 owner 并发 create 只保留一个 active；
  - named profile 并发创建原子拒绝（PROFILE_IN_USE）；
  - 修复 `chrome_headless_login` 在当前 provider 接线下不可用（bridge.headless 缺失时接 HeadlessContextRouter 或明确 UNSUPPORTED）；
  - 加并发/接线下测试；全量测试。

## 完成后

队列全勾选报告“队列完成”，不要 bump/release；Lead 统一测试、bump、notes。
