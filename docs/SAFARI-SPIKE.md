# Safari 可行性 Spike（结论：不属于近期）

> 2026-10-19 · 只做可行性判断，不承诺实现日期

## 1. 约束

Safari 不是 Chromium：
- 不能直接加载 Chrome MV3 扩展；需要 **Safari Web Extension**（Xcode 工程 + Apple 签名）；
- 没有 Chrome 的 `chrome.debugger`/CDP 同级能力；页面控制主要靠 content script + `browser.scripting`/`tabs`，能力受限；
- 分发必须走 Mac App Store / iOS App Store，需要开发者账号和审核；
- macOS 与 iOS 的 Safari 扩展 API/权限不同，窗口/标签/自动化语义也不同；
- 若需要 native host，需要额外的 macOS 容器/Safari App Extension 与 native messaging 设计。

## 2. 可行的最小能力

Safari Web Extension 可以：
- 读取当前 tab 的 URL/title；
- 注入 content script，读 DOM/点击/输入（同源限制、用户授权）；
- 与 native app/helper 通过 native messaging（需额外 App Extension/容器配置）。

不能直接复用：
- `chrome.debugger` 的 CDP 控制；
- 我们的 `chrome_*` headless driver；
- Chrome native messaging 安装器。

## 3. 结论

- Safari 是**独立产品线**，不是 Chrome 插件的“打包一下”；
- 建议先做 2–3 人日 spike：用 Safari Web Extension 注入 content script，验证读取/点击/输入 + 用户授权流程；
- 若只做“读页面 + 基础点击”，可能可行；若要完整 `chrome_*` 工具/截图/网络/多 context，成本高、且 App Store 审核限制大；
- 近期优先 Edge（Chromium）和 Chrome Web Store；Safari 放未来单独评估。

## 4. 若要做，最小里程碑

1. Xcode Safari Web Extension + 本地开发签名；
2. content script 读取/点击/输入；
3. native helper 通信（可选）；
4. App Store 审核材料/隐私声明；
5. 只承诺 Safari 专属能力，不承诺与 Chrome 工具面一致。
