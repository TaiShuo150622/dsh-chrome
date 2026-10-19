# 加固计划（Codex 审查 + 四角度评审后）

> 基线：0.2.21。原则：**先修信任底座，再扩功能**；工具面暂不收缩，先用 operation log 记录真实使用数据再决定 core/packs。
> 每项：小步、全量 `npm test`、显式路径提交、立即 push；未验证不写成已交付。

## 已完成（Codex 结构审查 P0/P1 中已闭环）

- [x] context owner-aware API（getOwned/closeOwned/driverForOwned）；`chrome_context close` 与 `chrome_verify` 不再跨 owner；
- [x] `chrome_verify` 明确 headless-only，不再注入通用 backend；
- [x] `mutating` 元数据成为运行时唯一来源（已删 `WRITE_TOOLS` 回退）；
- [x] tools/headless/viewer/update 大文件拆分；`tools.js` 约 268 行、`headless.js` 约 1456 行；
- [x] `BridgeServer.start()` 失败记录 `lastError`，`chrome_status.bridgeError` 已通；bridge 失败测试；
- [x] Windows 命名管道 + Windows headless 候选；Windows CI 加 p0-bridge；
- [x] headless 引擎环境变量拆分 `DSH_HEADLESS_ENGINE`；
- [x] A0 侧边栏占位与发布文案对齐（占位会加载，不控制浏览器）；
- [x] 设置 MVP 已在真实 DSH 返回 `Config status:"schema"`，4 个 volatile 字段。

## P0：发布/安全硬阻断（先做）

- [ ] H1 桌面 capture 脱敏与 headless 对齐（pwd/otp/cvv/auth、URL fragment、inline secret）；补桌面 parity 哨兵测试；`capture_start` 默认 `storeBodies:false`（或确认卡显式勾选）。
- [ ] H2 `chrome_pdf` 路径限制：限制在 cache/pdfs 或会话 cwd；realpath 后拒绝符号链接/已有文件；显式 path 硬确认；标记 `mutating`。
- [ ] H3 viewer/live-view bearer URL 不进模型/DSH 日志：模型只拿 handle/一次性 URL；viewer 写操作写 audit；`access` 加入 secret 查询参数；默认关闭 viewer 或明确 opt-in。
- [ ] H4 跨会话全机读面：`chrome_download` 按会话/窗口过滤或显式确认；`chrome_audit` 按 session 过滤；无 owner 截图默认隐藏。
- [ ] H5 密码/OTP 字段硬确认：`chrome_type`/`chrome_press`/`chrome_verify.type` 识别 password/OTP/payment 字段并 hardConfirm 或 credential 模式；登录确认卡显示 URL/origin；credentials fill 加 target origin/scope，默认 https。
- [ ] H6 `chrome_verify` 的 navigate/click/type 走 guard/audit；默认拒绝 loopback/私网（测试 allowlist）；console/network artifact 脱敏。

## P1：可靠性/生命周期

- [ ] H7 headless CDP 端到端 deadline + 取消 + 有界 close；启动失败 kill child；crashed 状态。
- [ ] H8 context 状态机（starting/ready/crashed/closing/stopped）；exit 清 tab/session；visible 不被 driver idle 杀；close 期间 profile 预留。
- [ ] H9 bridge generation/epoch；旧 socket pending fail；host 只转发 pending id；operation log 加 session/callId；chrome_status 真实取数（pluginUpdate/loginOpen 等死字段）。
- [ ] H10 Windows host 更新改 stage+pending：运行中不替换；provider 启动前比较版本并原子换入；保留旧 exe；HOST_VERSION 来自 package；补 Windows 更新测试/CI 触发。
- [ ] H11 测试门禁：test:unit / test:browser 拆分、timeout、flake 标记、CI timeout；视觉探针 e2e 降为 bounded；`DSH_REQUIRE_HEADLESS=1`。

## P2：产品/UX（信任底座后）

- [ ] H12 `chrome_handoff`：claim/pause/resume/status；合并 pick/headless_login 的交互；密码/OTP 只回完成/URL/title。
- [ ] H13 runbook：把一次成功存为语义步骤（非坐标），`chrome_run` 跑/列/停；失败停住给 snapshot+diff；写入默认确认。
- [ ] H14 多标签研究：`chrome_tabs op:"read"`，总预算/去重/artifact；不新增工具。
- [ ] H15 不可逆动作识别：submit/pay/delete/publish/send/password/payment；hardConfirm/handoff；审计；不可永久关闭。
- [ ] H16 任务回执/续跑：本地 run manifest；结束回执（站点/动作/审批/下载/最终 URL）；显式 resume，不自动重放写。
- [ ] H17 首装/诊断/暂停：popup 状态页 + 一键诊断；popup Pause 总开关 + USER_PAUSED；版本卡；Recent actions。
- [ ] H18 配置/Profile：profile id 路径逃逸校验；假配置删除或接线（viewport/maxArtifactBytes）；chrome_config 显示 effective/sources/warnings；settings 暴露 visual.cursor/update。

## 暂缓/不做（除非有触发条件）

- 工具面 45→core+packs：先观察 `npm run usage` 数据；
- 原生 DSH 侧边栏 B/C、桌面多引擎、Safari、collab/shared context、密码 UI/Keychain 接线；
- 继续拆 headless.js/background.js（除非 bug 逼出纯函数）；
- Computer Use 独立插件（超远未来）。

## 工具使用观察

- 新增 `npm run usage`：聚合 `~/.dsh/cache/dsh-chrome/operations.jsonl` 的 tool/ok/error/duration；
- 至少积累 1–2 周真实数据后再决定默认工具面；不要凭感觉砍。
