# Windows 预览版 0.2.18（bridge 诊断 + headless Windows + 设置 MVP）

> 基于 0.2.18；请用这个包重测 0.1.99 报告里的阻断项。

## 修复/新增

- Windows bridge 命名管道（0.2.16），`bridge.json` 正常生成；
- `chrome_status.bridgeError` 现在真正记录 `BridgeServer.start()` 失败（0.2.18 修复“只转发不记录”）；
- headless 增加 Windows Chrome/Edge/Brave 候选；headless 引擎使用 `DSH_HEADLESS_ENGINE`；
- `DSH_CHROME_BROWSER` 只作为桌面 native host 安装目标，避免误伤 Chrome 安装；
- 插件设置 MVP（DSH Config schema，安全字段）；
- A0 侧边栏占位会随包出现，但**不控制浏览器**。

## 重测步骤

1. 0.2.18 tgz 覆盖 DSH 插件，重启 DSH；
2. 重新加载 0.2.18 extension zip，完全退出 Chrome 再打开；
3. 确认 `bridge.json` 存在、host.log 有 `bridge authenticated`；
4. 测 desktop `chrome_goto/snapshot/screenshot`；
5. 测 `backend:"headless"`；
6. 失败时把 `chrome_status`（含 bridgeError）和 host.log 末尾发回。
