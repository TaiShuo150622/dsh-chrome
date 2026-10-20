# 发布说明 0.2.24（光标自定义）

> 2026-10-20 · 扩展/provider **0.2.24** · `npm test` 61 个测试文件

## 新功能

- Chrome 扩展 popup 增加 **Cursor**：
  - 内置 `Whale (DSH)` / `Arrow` / `Dot` / `Crosshair`；
  - 上传本地 PNG/JPEG/WebP，≤256 KB；
  - Reset 回默认鲸鱼；
  - 设置存 `chrome.storage.local.dshCursor`，自动跟随和手动 pointer 都生效。
- `chrome_pointer` 新增可选 `preset`（whale/arrow/dot/crosshair）和 `size`（16–64 px）；手动调用可覆盖 popup 外观。
- 自定义图片只接受本地 data URL，不请求远程 URL、不允许 SVG、overlay 再次校验；不影响 overlay 不拦截交互的语义。

## 已知限制

- headless 后端只支持内置 preset，没有 popup 上传图片；
- 自定义图片只存在于本地浏览器存储，不进入 DSH 配置/日志；
- 页面刷新后，下一次 auto-follow/pointer 操作自动恢复外观。

## 验证

- `test/overlay.mjs`：preset、自定义 PNG、远程 URL 拒绝、隐藏；
- 真实 Chrome：`chrome_pointer preset:"dot"` 显示成功；
- `CI=1 npm test`：exit 0。
