# 结构重构队列（给循环子智能体）

> 目标：把 `dsh-chrome` 的大模块拆小，**每次只做一项**，每项结束后跑全量测试并推公开仓库。
> 仓库：`/Users/taishuo/projects/dsh-chrome`（`main`）。不要改其他 checkout/worktree。
> 当前基线：0.2.9（本批不逐个升版本；整批结束后由 Lead 统一 bump）。

## 规则

1. 只做队列里**下一个未勾选**的项；不要同时改多项。
2. 保持运行时行为不变；schema/render/错误语义不能变。
3. 每项完成：
   - 跑 `npm test`（全量；不要只跑相关测试）；
   - 通过后用 explicit paths commit（不要 `git add -A`）；
   - `git push origin main`（网络失败重试 2 次；仍失败则报告 blocker）；
   - 勾选本文件对应项，和代码同一个 commit。
4. 测试失败：先修；修不好就回滚本次改动并报告 blocker（附失败命令/日志尾部）。
5. 不要改版本号、CHANGELOG、README 版本行；不要新增 release notes。
6. 不引入新依赖；不修改 `extension/` 行为；不发布 release。

## 队列

- [x] Q1 `src/tools-lease.js`（已完成，基线）
- [x] Q2 `src/tools-context.js`（已完成）
- [x] Q3 `src/tools-verify.js`（已完成）
- [x] Q4 抽出 headless PNG 编解码
  - 新建 `src/headless-png.js`，迁移 `src/headless.js` 中的 `PNG_CRC_TABLE`、`pngCrc32`、`pngChunk`、`paethPredictor`、`unfilterPngRows`、`pngFrameSize`、`jpegFrameSize`、`decodePngFrame`、`encodePngFrame`；
  - `headless.js` 改为 import；只导出 `headless.js` 实际用到的函数；
  - 不改帧格式/截图行为；全量测试。
- [ ] Q5 抽出 headless 启动参数
  - 新建 `src/headless-launch.js`：`buildLaunchArgs({visible, profileDir, windowSize, extraArgs})` + DevToolsActivePort 解析辅助函数（如有）；
  - `ensureStarted` 调用它；参数顺序/内容不变；
  - 新增/更新一个纯函数测试（不需要真 Chrome）；全量测试。
- [ ] Q6 抽出 headless 脱敏
  - 新建 `src/headless-redact.js`：`maskSecretsInText`、`redactUrl`、`redactJsonValue`、`redactBodyText`、`materializeCaptureBody` 及 capture 常量；
  - `headless.js` 改为 import；脱敏规则/预算不变；
  - 全量测试。
- [ ] Q7 抽出 `chrome_headless_login` 工具
  - 新建 `src/tools-login.js`：工厂注入 `bridge`、`hardConfirmAsk`、`evaluateConfirmTimeoutMs`、`renderText`、`outputSchema`（按实际依赖）；
  - `tools.js` 只组装；工具 schema/render/确认文案不变；
  - 全量测试。

## 完成后

- 队列全勾选后，报告“队列完成”，不要自行发版；Lead 统一跑测试、bump、更新 release notes。
