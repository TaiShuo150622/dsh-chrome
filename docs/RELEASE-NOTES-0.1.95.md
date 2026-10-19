# 发布说明 0.1.95（chrome_verify 验证编排）

> 2026-10-19 · 扩展/provider **0.1.95** · 工具面 **44（+evaluate 45）** · `npm test` 29 个测试文件

## 新增

- **`chrome_verify`**：在隔离 headless context 上运行可重复验证：
  - `navigate` / `waitFor` / `click` / `type` / `assert`
  - assert 类型：URL、标题、页面文本、元素存在/可见/文本、console error 数、网络失败数
  - 每次运行保存 JSON report + 截图到 context 的 `artifacts/`；失败可诊断
- `chrome_context` + per-session context（0.1.94）配合使用；`chrome_verify` 默认使用当前会话 active context，必要时自动创建 sandbox context。

## 范围/限制

- 首期**不支持任意 JS 断言**（元素检查用固定 querySelector 表达式）；
- `chrome_verify` 只跑 headless 隔离 context；visible/shared 后续；
- 网络检查基于 Performance API，跨域/缓存请求可能不全。

## 测试

- 新增 `test/chrome-verify.mjs`（fake driver：成功/失败、artifacts、console/network 检查）；
- `npm test` 29 个文件；CI 绿。
