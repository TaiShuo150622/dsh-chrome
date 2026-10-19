# 结构重构队列 2（Codex 审查后）

> 依据：Codex 2026-10-18 审查（P0/P1）与 `docs/CODE-REVIEW-SELF.md`。
> 仓库：`/Users/taishuo/projects/dsh-chrome`，当前基线 `b1ea1bb`，版本仍 0.2.9。
> 规则同 `docs/REFACTOR-QUEUE.md`：每次只做一项，全量 `npm test`，通过后 explicit paths commit + push，勾选本项；本批不逐项 bump，不发布 release，不改 extension 行为，不引入依赖。

## 已完成（Codex P0 部分）

- [x] owner-aware `getOwned` / `closeOwned` / `driverForOwned`；`chrome_context close`、`chrome_verify` 使用 owner-aware 获取；
- [x] `chrome_verify` 从通用 backend wrapper 中豁免（headless-only，不再假装支持 `backend`）。

## 队列

- [x] Q8 viewer 的 context 访问加上 per-context capability
  - `context-viewer.urlFor(contextId)` 生成每次运行随机的 access capability，并绑定 contextId；
  - `view` / `frame` / `input` 同时校验全局 token + access；viewer HTML 的 frame/input URL 带上 access；
  - 不改变 loopback/token 语义；更新 `test/context-viewer.mjs`；
  - 全量测试。
- [x] Q9 工具 metadata 单一来源
  - 运行时 `isWriteTool` 只读工具对象 `mutating`，移除 `WRITE_TOOLS` 名字回退；
  - `test/tool-metadata.mjs` 不再正则扫描 `src/tools.js`，改为从实际工具定义/抽出模块校验；
  - 给有状态但不是 mutating 的工具（capture/screencast/context）补显式说明或 metadata；
  - 全量测试。
- [ ] Q10 index runtime 化（小步）
  - 新建 `src/runtime.js`，先只收拢「contextViewer + liveview」注册和 dispose（不一次性搬 bridge/tools）；
  - `index.js` 的 webServer effect 改为调用 runtime；清理顺序不变；
  - 全量测试。
- [ ] Q11 抽出 ArtifactStore
  - 新建 `src/artifact-store.js`：`createArtifactRun`、prune、artifact 路径/复制；
  - `BrowserContextManager` 不再管理 verify artifacts；`tools-verify` 注入 artifact store（或 contexts.artifacts 适配层）；
  - 保留现有路径/保留策略；全量测试。
- [ ] Q12 headless console/network 事件拆出
  - 把 console/network Buffer 与 CDP 事件映射抽到 `src/headless-events.js`；
  - HeadlessDriver 只保留状态字段与 dispatch 调用；
  - 不改输出/截断语义；全量测试。

## 完成后

队列全勾选后报告“队列完成”，不要 bump、不要 release；Lead 统一测试、bump、更新 notes。
