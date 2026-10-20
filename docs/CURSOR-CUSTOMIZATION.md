# 操作光标自定义（0.2.24）

页面里的操作光标现在可以换外观；其他行为不变（仍是 `pointer-events:none` 的页面 overlay，不拦截点击，不进入页面文本快照）。

## 使用

Chrome 扩展 popup → **Cursor**：

- **Whale (DSH)**：默认鲸鱼品牌图形；
- **Arrow**：经典箭头；
- **Dot**：圆点；
- **Crosshair**：准星；
- **上传图片**：本地 PNG/JPEG/WebP，≤256 KB；自动作为当前光标，选任意 preset 会移除自定义图；
- **Reset**：回到鲸鱼默认。

设置保存在 `chrome.storage.local` 的 `dshCursor`，对自动跟随、`chrome_pointer` 手动显示都生效；刷新页面后下一次操作自动恢复。

## 工具参数

`chrome_pointer` 新增可选：

```json
{ "op": "show", "selector": "body", "preset": "dot", "size": 40, "label": "DSH · demo" }
```

- `preset`: `whale | arrow | dot | crosshair`
- `size`: 16–64 CSS px（默认 30）

工具传入的 preset 优先于 popup 设置；如果 popup 里保存了自定义图片，图片优先于 preset。headless 后端只支持 preset/内置图形，不支持 popup 上传（没有扩展 UI）。

## 安全边界

- **只接受本地图片**：popup 的 FileReader 读取后存 data URL；不接受远程 URL，不会因光标图片发起网络请求；
- 允许的 MIME 只有 `image/png`、`image/jpeg`、`image/webp`；不接受 SVG（避免脚本/外部引用）；
- 单文件 ≤256 KB；overlay 再次校验 data URL 和大小；
- 图片只存在于本地 `chrome.storage.local` 和页面 overlay，不上传、不写日志；
- 自定义图片仍走同一个 overlay DOM，`data-dsh-overlay`/`aria-hidden`、pointer-events:none 不变。

## 测试

- `node test/overlay.mjs`：preset、自定义 PNG、远程 URL 拒绝、隐藏；
- 真实 Chrome：`chrome_pointer preset:"dot"` 显示成功；
- 全量 `CI=1 npm test` 通过。
