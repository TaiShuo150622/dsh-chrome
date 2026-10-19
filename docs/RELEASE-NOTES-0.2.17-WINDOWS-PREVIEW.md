# Windows 预览版 0.2.17（bridge + headless 修复）

> 基于 0.2.17；请重测 0.1.99 报告中的阻断项。

## 修复

- Windows bridge 改用命名管道（0.2.16）：`\\.\pipe\dsh-chrome-<home hash>-<pid>`，`bridge.json` 正常生成；
- `chrome_status` 暴露 `bridgeError`；
- headless 增加 Windows Chrome/Edge/Brave 候选与 `browser.engine`/`browser.headless.chromeExecutable`（0.2.17）；
- 默认未指定 engine 时仍按 Chrome/Chromium 探针顺序。

## 请重测

1. 用 0.2.17 tgz 覆盖 DSH 插件，重启 DSH；
2. 重新加载 0.2.17 extension zip，完全退出 Chrome 再打开；
3. 检查 `bridge.json`、`host.log` 的 `bridge authenticated`；
4. 测 desktop `chrome_goto/snapshot/screenshot`；
5. 测 `backend:"headless"`（Windows 下应能找到 Chrome/Edge）。
