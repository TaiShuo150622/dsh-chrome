# 加固队列 1（H1–H3）

> 基线：`42383b4`（0.2.21 + 加固计划）。规则：每次只做一项、全量 `npm test`、显式路径 commit、立即 push、勾选本项；不升版本、不写 release notes；不改工具面。
> 安全审查基线：当前 main（0.2.21）。

## 队列

- [x] H1 桌面 capture 脱敏与 headless 对齐
  - `extension/background.js` 的 capture 脱敏采用 headless 的规则：`pwd/otp/cvv/auth`、URL fragment、inline `password=...`；保留 headers 不采集。
  - `src/tools-capture.js`：`capture_start` 默认 `storeBodies:false`（显式 true 才存）；确认卡写明目标 origin/tab；文档同步。
  - 新增/扩展 `test/capture-redact.mjs` 或现有 capture 测试，用哨兵断言 desktop 路径不泄漏；全量测试。
- [x] H2 chrome_pdf 路径收敛
  - 默认写到 `$DSH_HOME/cache/dsh-chrome/pdfs/`；显式 path 限制在 cache 或会话 cwd，realpath 后拒绝 symlink/已存在文件；显式 path 走 hardConfirm 并显示完整路径；`chrome_pdf` 标记 mutating/lease。
  - 补路径逃逸/符号链接/策略文件覆盖测试；全量测试。
- [ ] H3 viewer/live-view bearer 收口
  - `chrome_context {op:"viewer"}` / `chrome_screencast viewer` 不再把带 token/access 的完整 URL 返回给模型/render；模型只拿 opaque handle 或本地打开提示（Host 侧/工具结果不含 secret）；`access` 加入 operation log secret 查询名。
  - viewer 写操作写 audit（或默认关闭写，只读）；明确 opt-in。
  - 更新 context-viewer/liveview 测试，断言 tool result/render/operations 中无 `token=`/`access=`；全量测试。

## 完成后

队列全勾选报告“队列完成”，不要 bump/release；Lead 统一复测、bump、notes。
