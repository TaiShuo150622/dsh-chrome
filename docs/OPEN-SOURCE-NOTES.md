# 开源浏览器 Agent 方案调研（2026-10-17）

> 目的：参考开源实现，决定 P2/P3 值得吸收的能力与自动更新思路。只借鉴设计，不复制代码。

## 1. browser-use

来源：<https://github.com/browser-use/browser-use>（通过其文档页
<https://raw.githubusercontent.com/sandgardenhq/dh-library/refs/heads/main/content/en/browser-use/03-how-the-agent-sees-the-page.md> 阅读）

要点：

- **Enhanced DOM tree**：并行拉 DOMSnapshot + Accessibility.getFullAXTree + JS 探针，合并成带可见性/交互信息的树，iframe 拼进同一棵树。
- **索引 = CDP `backend_node_id`**（不是 1..N 计数器）：动作层用同一 handle 解析回真实节点，页面未变时 handle 稳定；serializer 用同一个 id 做 selector map。
- **变更标记**：与上一步 selector map 比较，标出新增元素，模型不用重扫全页。
- **缓存失效**：导航/焦点变化/滚动会清空 selector map。
- **Markdown 提取**：`markdown_extractor` 把内容抽成 markdown（阅读路径，与动作路径分开）。
- **截图高亮**：先拍干净截图，再按 selector map 叠高亮，文本与视觉指向同一批 handle。

## 2. Playwright MCP

来源：<https://playwright.dev/mcp/snapshots>

要点：

- **快照 = 可访问性树（accessibility snapshot）**，不是截图；每个节点带 ref（如 `e5`），ref 在页面变化前稳定。
- `browser_snapshot` 支持 `target`（子树）、`depth`、`boxes`（返回 `[box=x,y,w,h]`）。
- `browser_find` 按文本/regex 搜当前快照，只返回命中子树与上下文，适合大页面。
- ref 过期错误明确："Ref <ref> not found ... try capturing new snapshot"。
- 交互工具同时接受 ref 或 selector；快照可与截图组合（vision mode）。

## 3. Stagehand（Browserbase）

来源：<https://github.com/browserbase/stagehand>、<https://docs.stagehand.dev/v4/first-steps/quickstart>

要点：

- **act / extract / observe** 三层抽象：动作、结构化提取、动作候选观察。
- 缓存与速度/成本优化是文档里的独立主题（重复动作可复用）。
- 多标签、审批式表单提交（approve form submission）等 cookbook。
- 定位是框架（Playwright 之上），不是浏览器扩展；但 observe/extract 的产品化值得借鉴。

## 4. nanobrowser

来源：<https://github.com/nanobrowser/nanobrowser>（GitHub 页面拉取超时，仅依据搜索结果描述）

- 开源 Chrome 扩展、多 agent 工作流、自带 LLM key、定位 OpenAI Operator 的替代。
- 参考价值：扩展形态 + 多 agent 编排；我们暂不引入多 agent。

## 5. 对我们可落地的清单（按优先级）

| 能力 | 来源 | 我们的计划 |
|---|---|---|
| **稳定 ref**（元素有 ref 就复用，不每次重排） | browser-use / Playwright MCP | ✅ 已实现（0.1.30）：保留已有 ref，新元素递增并标 `new` |
| 快照 `boxes`（返回坐标） | Playwright MCP | ✅ 已实现（0.1.30）：`chrome_snapshot {boxes:true}` |
| 全页截图 / 高亮 ref 截图 | browser-use | ✅ 已实现（0.1.31）：`fullPage` / `highlight` |
| `chrome_wait` 支持 selector/url | Playwright MCP waiting 工具 | ✅ 已实现（0.1.31）：`until: selector\|url` |
| 可访问性树工具 | Playwright MCP / browser-use | P2/P3：`chrome_a11y`（CDP `Accessibility.getFullAXTree`，带 ref） |
| Markdown 阅读 | browser-use | P3：`chrome_get_text {format:"markdown"}` |
| 自动更新（开发期） | 自研 | 已有：host 监听 extension/ → ext.changed → reload；P2 补"连接时版本核对"（host 报磁盘版本，SW 发现不一致自动 reload） |
| 动作观察/缓存（observe） | Stagehand | P3 评估（需要模型侧配合，工具层只提供候选动作列表） |

## 6. 自动更新的现实约束

- 未打包（Load unpacked）扩展没有 Chrome 商店的自动更新机制；我们的 `dev.json` + host watcher 是开发期等价物。
- 正式分发若走 Chrome Web Store / CRX + `update_url`，更新由 Chrome 负责；插件只需版本握手 + 提示重载。
- provider 侧更新由 DSH bundle 管理（重载 bundle）；host 常驻会自动重连，扩展不需要动。
