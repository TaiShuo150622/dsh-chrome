# dsh-chrome

**DSH 桌面端（DeepSeek Harness Desktop）的 Chrome 操控插件**：让模型直接操作你当前已登录的 Google Chrome —— 读页面、点击、填表、开后台标签、截图看图、按会话隔离，危险动作先问你。

> 状态：**设计稿完成，M0 技术验证未开工**（2026-10-17）
> 当前目录只有设计文档与仓库骨架，**没有可运行代码**。

## 是什么

- 目标形态：**Chrome MV3 扩展 + Chrome 原生消息（native messaging）+ DSH 桌面 provider 插件**。
- 与 Claude in Chrome / Codex 的浏览器能力对齐：真实浏览器、保留登录态、标签组、截图视觉、控制台、上传下载、审批与人工接管。
- 与网页版 `dsh-browser` 的区别：桌面 app 本身就是聊天面，**不做 Chrome 侧边栏聊天**；连接走原生消息而不是回环 WebSocket + 端口探测。
- 按 DSH 官方 browser-use provider 规范设计：挂载 `@deepseek-ai/dsh-browser-use` 注册表并注册唯一 provider，工具自带命名空间，未来可向官方生态上游。

## 已拍板的决策（2026-10-17）

| 决策点 | 选择 | 理由 |
|---|---|---|
| 建法 | **自研新插件** | 代码可控；形态按 Claude/Codex 设计；借鉴现有 MIT 项目但不 fork |
| 连接通道 | **Chrome 原生消息** | 同 Claude/Codex；无端口、无 token、Chrome 按需拉起 host |
| 首版范围 | **核心可用 12 工具** | 先跑通读取/操作/标签/截图/审批，再补调试与数据能力 |
| 交付形态 | **先本地，后开源；按官方规范** | 先自用验证，再公开；包结构、provider 语义、文档与测试向官方看齐 |

## 文档

- [设计文档：架构、协议、工具契约、安全模型、里程碑](docs/DESIGN.md)
- [M0 技术验证清单：先证明哪几件事](docs/M0.md)

## 能力分档

| 档位 | 内容 |
|---|---|
| **V1（MVP，12 工具）** | 状态握手、标签页管理、导航/历史、文本快照 + 编号 ref、点击、输入、按键、滚动、等待、截图（可回传视觉）、按会话关闭 |
| **V2** | 控制台日志、网络请求、受限 JS eval、文件上传、下载记录、a11y 树、弹窗处理、认领用户当前标签、元素拾取 |
| **V3** | GIF 录制、shortcuts、多浏览器（Edge/Brave）、DSH 设置页、Windows/Linux host、Chrome for Testing e2e、商店上架材料 |

明确不做：反检测/隐身、绕过 Chrome 受保护页面与付费墙、自动过 CAPTCHA、headless 替代真实浏览器、V3 之前的 Chrome 侧聊天面板。

## 目录（计划）

```
dsh-chrome/
├─ src/                 # Host 插件（TS）：tools / bridge / session / install
├─ host/                # Chrome 原生消息 host（launcher + host.mjs）
├─ extension/           # Chrome MV3 扩展（background / content / popup）
├─ scripts/             # 开发安装、自检、e2e
├─ test/                # 单元 + 集成测试
├─ locale/ icon.svg     # 插件展示元数据
├─ cordis.patch.yml     # bundle 组合层
├─ package.json         # 包名 dsh-desktop-chrome（npm 名当前空闲）
└─ docs/
```

## License

MIT（见 [LICENSE](LICENSE)）。借鉴的开源项目会在 `NOTICE`/文档中注明出处。
