# Windows 真机反馈修复队列 2（P4/P5/P7，目标 0.2.26）

> 基线：`cb0b137`（0.2.25）。依据 Windows 真 Chrome 报告：P4 overlay 可被页面读写、P5 auto-reload 期间 host 双连接/桥抖动、P7 小问题。
> 规则：每项 `CI=1 npm test`、显式路径 commit、push、勾选；不升版本。

## 队列

- [x] V1（P4a）桌面 overlay 移到 ISOLATED world
  - `extension/manifest.json` 的 overlay content script 去掉 `world:"MAIN"`（默认 ISOLATED）；`chrome.scripting.executeScript` 注入/调用 overlay 时使用 `world:"ISOLATED"`。
  - `chrome_pointer`/annotate/frame overlay 调用不再用 main-world `Runtime.evaluate` 的 `window.__dshOverlay`；改走 isolated-world script/消息。
  - auto-follow helper 不再在 main world 里调 overlay；改为 isolated-world 注入/调用（或 content-script 消息）。
  - 验证：页面脚本探针读不到 `window.__dshOverlay`（undefined/不可调用）；pointer/annotate/list/clear/截图仍正常；frame 场景可用。
- [x] V2（P4b）headless overlay 隔离
  - `src/headless.js` 的 overlay 注入/调用改走 `Page.createIsolatedWorld` + `executionContextId`；页面脚本不可读写 overlay。
  - 保留 overlay 在截图/annotation 中可见；`tab.overlay` 行为不变。
  - 补真实 headless 测试：探针页 `window.__dshOverlay` 不可见；pointer 可见。
- [x] V3（P5）auto-reload bridge 去重/退避
  - bridge 连接 generation：新 host hello 到达时关闭旧 socket/fail 旧 pending；同一 bridge 只保留一个活动 host。
  - host 断线退避；extension 重载时先 release debugger/host，避免新旧 host 同时连。
  - 重载窗口内工具快速失败 `BRIDGE_RESTARTING`，不挂 45s。
  - 补 host/bridge 测试（双连接、旧响应丢弃、重载窗口）。
- [x] V4（P7）小项
  - `chrome_find` 对 NBSP/连续空格归一化；
  - `tabs new` 等导航完成再返回真实 URL；
  - `chrome_verify` 失败显示错误原因（不是 undefinedms/0 checks）；
  - `chrome_download` 返回绝对路径；
  - `chrome_context close` 回显 closed/stopped 状态。
  - 补对应测试。

## 完成后

Lead CI=1、macOS 真 Chrome 回归、Windows host 0.2.26、release notes、Windows guide 0.2.26（P4/P5/P7 复测项）。
