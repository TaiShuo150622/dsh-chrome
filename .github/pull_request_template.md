## 做了什么

<!-- 一句话说明变更与动机 -->

## 检查

- [ ] `npm test` 全过（5 条：bridge / p0 / p1 / p2 / extension-manifest）
- [ ] 改过 `src/tools.js`：已 `npm run docs:tools` 并提交 `docs/TOOLS.md`
- [ ] 改过扩展行为：`extension/manifest.json` 版本 +1，`CHANGELOG.md` 已更新
- [ ] 新工具/新参数有 fake-extension 测试（断言参数到达扩展）
- [ ] 涉及真机行为：附上验证记录（截图/工具输出/host.log 片段）

## 风险与回滚

<!-- 改动了协议、权限、持久化 key、审批语义吗？如何回滚？ -->
