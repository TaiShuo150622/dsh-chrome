# 发布说明 0.2.1（版本规则/CI 校验）

> 2026-10-19 · 扩展/provider **0.2.1** · `npm test` 33 个测试文件

## 新增

- `docs/VERSIONING.md`：普通功能/修复只升第三位；第二位（minor）变化必须先告知用户；
- `test/version-consistency.mjs`：CI 校验 `package.json` 与 `extension/manifest.json` 版本一致且为 semver；
- 无运行时行为变化。
