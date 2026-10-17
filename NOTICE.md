# NOTICE

本项目（`dsh-desktop-chrome`，MIT）包含的第三方材料与参考来源：

## 随源码分发的第三方代码

### `vendor/browser-use/`

- 包名：`@deepseek-ai/dsh-browser-use`
- 版权：Copyright (c) 2026 DeepSeek
- 许可证：MIT（完整文本见 `vendor/browser-use/LICENSE`）
- 用途：DSH 官方 browser-use provider 注册表类型与文档的本地副本，用于对齐官方 provider 形态。当前桌面端未内置该包，挂载方案见 README/ROADMAP 的 P1 技术债；该副本不作为运行时依赖。

## 参考的公开产品能力（未复制其代码）

以下产品的能力描述用于功能规划（详见 `docs/P2-PLAN.md`）：

- Claude in Chrome（Anthropic）— 帮助中心文档：权限模型、标签组、console/network、定时任务、视觉上下文等
- Codex（OpenAI）— 2026-04 更新报道：独立光标/后台操作/插件/心跳等
- 网页版 DSH browser provider 的公开包与文档（`dsh-builtin-browser` 等）— 用于形态与覆盖面参考

上述产品与文档的商标、版权归各自权利人所有；本项目未复制其源码。

## 运行时依赖

本项目不引入 npm 运行时依赖；运行时使用 Node.js / DSH Desktop 自带的 Electron-as-Node。
