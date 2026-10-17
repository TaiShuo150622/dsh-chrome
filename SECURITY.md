# Security Policy

完整安全模型（本机边界、权限、动作风险控制、明确不做）见 **[docs/SECURITY.md](docs/SECURITY.md)**。

## 报告漏洞

本项目当前为本地个人使用阶段，**没有公开的漏洞赏金流程**。如果你发现安全问题：

- 请**不要**在公开 issue 里贴可复现的攻击细节；
- 通过仓库维护者的私有联系方式报告（GitHub Security Advisory 或邮件），附版本（扩展 manifest 版本 + DSH 版本）、复现步骤、影响面；
- 在修复发布前请勿公开。

## 支持范围

| 版本 | 支持 |
|---|---|
| 最新扩展版本（`extension/manifest.json`） | 是 |
| 更早版本 | 建议先升级；不承诺回补安全修复 |

## 已知边界（非漏洞）

- 页面内容/截图会进入模型上下文，这是功能语义；
- `debugger` 权限用于点击/输入/截图/dialog，动作结束即 detach；
- `danger-full-access` 会话下普通浏览器动作不弹卡（`follow-dsh` 语义），需要更严格时请切 `balanced`/`strict`；
- 仅支持 macOS。
