# 版本号规则

> 用户约定（2026-10-19）：当前为 `0.2.0`；之后没有特别大的变动，**只在第三位（patch）递增**；第二位（minor）变化必须先告知用户。

## 规则

| 位 | 何时变化 | 说明 |
|---|---|---|
| `major` | 破坏性/产品形态大改 | 很少用；需要用户明确同意 |
| `minor` | **重大功能/兼容性变化** | **必须先告诉用户**，例如新的平台支持、协议不兼容、重大架构切换 |
| `patch` | 普通功能、修复、文档、测试、优化 | 可以连续递增到成百上千（0.2.1、0.2.2 …），不需要逐个确认 |

## 当前

- `0.2.0`：lease 生命周期收尾；Windows 测试文档。
- 后续普通改动从 `0.2.1` 开始递增 patch。
- 需要升 minor 的例子：首次正式支持 Edge/Safari、sidecar 协议 breaking change、公开商店发布形态变化。

## 批量节奏

- 同一批拆分/重构/文档可以共用一个 patch 版本，**不要每提交一次就 bump**；
- 每完成一小步先跑相关测试；一批结束再跑全量 `npm test`，然后统一 bump、写 release notes、push；
- 0.2.6–0.2.9 是连续的工具拆分，后续同类拆分继续合并成一批，不再逐个升版本。

## 契约

- `package.json` 与 `extension/manifest.json` 的 `version` 必须一致；
- 每次 release 必须更新 `CHANGELOG.md` 和 `docs/RELEASE-NOTES-<version>.md`；
- `test/version-consistency.mjs` 在 CI 校验两者一致且为 semver。
