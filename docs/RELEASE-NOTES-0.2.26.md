# 发布说明 0.2.26（P4/P5/P7）

> 2026-10-21 · 扩展/provider **0.2.26** · `npm test` 61 个测试文件

## 修复

- **P4 overlay 隔离**
  - 桌面：overlay content script 从 MAIN world 移到 ISOLATED；`chrome_pointer`/annotate/frame 通过 `chrome.scripting.executeScript({world:'ISOLATED'})` 调用；auto-follow 改为 DOM 事件桥。页面脚本读不到/调不到 `window.__dshOverlay`。
  - headless：`Page.createIsolatedWorld` + `executionContextId` 注入/调用 overlay；页面 MAIN world 看不到 `__dshOverlay`，伪造同名对象不会被调用。
  - pointer/annotate/list/clear/export/restore/frame/截图/auto-follow 仍正常。
- **P5 auto-reload 桥**
  - bridge 按连接 generation 管理：新 host hello 才替换旧连接，旧 socket 关闭、旧 pending 以 `BRIDGE_RESTARTING` 快速失败，旧 generation 响应 id 丢弃；
  - extension `prepareForReload` 先发 `dsh.restarting`、detach debugger、断开 native port；host 退避 50→100→200→400ms 封顶；
  - 重载窗口内工具不再挂 45s。
- **P7 小项**
  - `chrome_find` 桌面/headless 归一化 NBSP 与连续空格；
  - `tabs new`/`tab.goto` 等待导航完成再返回真实 URL；
  - `chrome_verify` 失败显示 error，不再 `undefinedms, 0 checks`；
  - `chrome_download` 返回绝对 filename/path；
  - `chrome_context close` 回显 closed/stopped/state。

## 验证

- `CI=1 npm test`：exit 0；`OVERLAY TEST`、`BRIDGE GENERATION TEST`、`HOST BACKOFF TEST`、`EXTENSION LOGIC`、`CHROME VERIFY`、`BROWSER CONTEXTS` 全 PASS；
- macOS 真 Chrome：overlay pointer 仍正常显示/隐藏；
- Windows 真机复测项：见 `WINDOWS-TEST-GUIDE-0.2.26.md`。
