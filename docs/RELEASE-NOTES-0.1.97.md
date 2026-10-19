# 发布说明 0.1.97（visible-isolated I2）

> 2026-10-19 · 扩展/provider **0.1.97** · `npm test` 29 个测试文件

## 新增

- `HeadlessDriver` 支持 `visible:true`：启动真实 headed Chrome 窗口（仍走 CDP），不再强制 `--headless=new`；
- `chrome_context {op:"create", preset:"debug"}` 创建**独立 profile + 可见窗口**；
- visible context **不参与空闲回收**（窗口属于用户，必须显式 close）；
- 适合人工登录/CAPTCHA/演示/调试；仍是独立 profile，不共享用户日常 Chrome 或其他会话的 cookie。

## 范围

- I3 `collab`（shared + tab lease）仍未实现，会返回 `UNSUPPORTED_MODE`；
- visible 与 headless 之间的运行中状态迁移不做；需要时新建 context；
- 真机窗口行为（macOS/Windows/Linux）后续继续验证。
