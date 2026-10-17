# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号在 P3 之前按扩展 manifest 递增。

## [Unreleased]

## [0.1.36] - 2026-10-17

### Added

- `chrome_snapshot {mode:"delta"}`：只返回与上次快照相比新增/变化的控件（ref 稳定后才有意义），附 `changedCount`/`sameCount`/`removedRefs`
- 动作后可附带新快照：`chrome_click/type/press/scroll/hover {snapshot:true}` → 结果增加 `page` 字段（对齐 Playwright MCP 每次动作回快照的交互）
- 扩展逻辑测试覆盖 delta 与 post-action snapshot

## [0.1.35] - 2026-10-17

### Added

- `chrome_click` / `chrome_type` / `chrome_hover` 支持 `selector` 作为 `ref` 的替代（对齐 Playwright MCP 的 ref/selector 双入口）
- `chrome_screenshot {ref}`：按元素包围盒截图
- `chrome_tabs op=focus`：显式把会话标签切到前台（人工接管/演示）
- `chrome_status` 增加 `diskVersion` / `autoReload`（磁盘扩展版本与自动更新状态）

## [0.1.34] - 2026-10-17

### Added

- `chrome_a11y`：CDP `Accessibility.getFullAXTree` 的可访问性节点（role/name/value，限 200/可调）
- `chrome_get_text {format:"markdown"}`：页面正文转 markdown（标题/链接/列表/代码/引用）
- **自动更新补强**：host 在每次 native 连接建立时上报磁盘扩展版本（`ext.state`）；SW 发现与运行版本不一致会自动 reload（覆盖"host 断开期间文件已更新"场景）
- 测试：host-reconnect 断言 `ext.state` 版本、extension-logic 断言版本不一致触发 reload

## [0.1.33] - 2026-10-17

### Changed

- host 扩展目录 watcher：800ms 去抖 + 3s 冷却 + manifest JSON 有效性检查（避免批量写/删除时连续 reload 把新 host 打断）

## [0.1.32] - 2026-10-17

### Changed（CPU/资源占用优化）

- 移除 `page.js` 内容脚本（15s 唤醒）与 offscreen 文档（15s 唤醒）——provider 心跳已负责保活 SW，崩溃恢复由 alarms 负责
- provider 心跳 10s → 20s；watchdog alarm 30s → 60s；扩展 stale 阈值 30s → 45s
- 预期减少空闲期 Chrome/扩展唤醒次数，具体数值见 docs/CPU.md

## [0.1.31] - 2026-10-17

### Added

- `chrome_screenshot {fullPage:true}`：按文档尺寸截全页（CDP `captureBeyondViewport` + clip）
- `chrome_screenshot {highlight:true}`：先给当前 ref 控件叠编号框再截图，完成后移除覆盖层
- `chrome_wait` 新增 `until:selector` 与 `until:url`（轮询页面/URL，TIMEOUT fail-closed）
- 扩展逻辑测试补 wait selector/url、fullPage/highlight 用例

## [0.1.30] - 2026-10-17

### Added

- **稳定 ref**：`chrome_snapshot` 保留元素已有 `data-dsh-ref`，只有新元素递增编号；输出对新元素标 `new:true`（借鉴 browser-use/Playwright MCP 的稳定 handle）
- `chrome_snapshot {boxes:true}`：返回每个控件的视口坐标 `[x,y,w,h]`
- `chrome_find` 分配 ref 时同样使用稳定编号

### Changed

- `chrome_snapshot` 描述与输出 schema 同步（`new`/`box` 字段）

## [0.1.29] - 2026-10-17

### Fixed

- **自动重连根因**：`ensurePort()` 的 `connecting` promise 被外层赋值覆盖，导致一次成功后永远不再 `connectNative`；改为 deferred 模式，并加 vm 回归测试。CfT 真机：kill host 后 10s 自动恢复

### Added

- 重连诊断写入 `chrome.storage.local.dshDiag`（worker 被回收后仍可查）

## [0.1.26] - 2026-10-17

### Fixed

- `chrome_tabs op=claim` 路由缺失（真机暴露）：provider 以 `tab.tabs` 的 op 发送，扩展只认 list/new/close

## [0.1.25] - 2026-10-17

### Added

- 独立 watchdog alarm（30s）：无端口时主动重连；`connectNative` 抛错也计入自愈
- `npm run status`：本地诊断 bridge/host/扩展版本/日志尾部

## [0.1.24] - 2026-10-17

### Added

- popup 一键 **Reload**（`chrome.runtime.reload()`），断开恢复不必进 chrome://extensions
- popup 显示 Self-heal 自动重载次数

## [0.1.23] - 2026-10-17

### Added

- `chrome_hover`：按 ref 悬停（触发菜单/提示），带虚拟光标
- `test/extension-manifest.mjs`：manifest 引用/扩展 ID/host 名结构测试
- 发布清单、issue/PR 模板、用法示例、README 演示截图

## [0.1.22] - 2026-10-17

### Added

- `chrome_find`：页内文本查找，返回 ref/坐标/高亮
- `chrome_get_text`：读取页面正文或指定 selector 的可见文本
- `chrome_select`：下拉/复选/单选设置
- `chrome_console`：MAIN world document_start 捕获 console 与未捕获错误（120 条环形缓冲）
- `chrome_network`：Performance Resource Timing 资源列表（URL/类型/耗时/传输字节）
- `chrome_upload`：给 file input 挂本地文件（走审批，先校验文件存在）
- `chrome_download`：列出最近 Chrome 下载
- `chrome_tabs op=claim`：认领当前活动标签进会话标签组
- `chrome_screenshot {clip}`：区域截图
- `chrome_click/type/press {dialog}`：自动处理 alert/confirm/prompt（安全默认：alert 接受，confirm/prompt 取消）
- 虚拟光标：click/type/press/scroll 时在页面上显示 DSH 蓝色光标，900ms 淡出
- 开发期自动重载：host 监听 `extension/`，变更后扩展自动 reload（`dev.json` 控制）
- `chrome_tabs op=new` 默认后台打开（不抢焦点）
- CI、`docs/INSTALL.md`、`docs/TOOLS.md`（自动生成）、扩展打包脚本

### Changed

- 页面动作固定走 CDP `Runtime.evaluate`（后台/折叠标签组上 executeScript 与 content-script 消息会挂起）
- native port 由 service worker 持有；host 常驻并自动重连 provider
- 端口连续失败时扩展自愈 reload（上限 5 次）

### Fixed

- `chrome_tabs list` 在关闭会话后因 `groupId: null` 违反输出 schema
- `chrome_scroll` 平滑动画导致返回 y=0
- 扩展错误页的 `Unchecked runtime.lastError`

## [0.1.0] - 2026-10-17

### Added

- 12 个 `chrome_*` 工具：status/goto/snapshot/screenshot/click/type/press/scroll/history/tabs/wait/close_session
- 每 DSH 会话独立后台标签组，owner 隔离，不抢焦点
- follow-dsh 审批（先读会话 sandbox 模式，`danger-full-access` 直接放行；低权限走 `ctx.approval`）
- 工具层测试（p0-bridge / p0-tools / p1-tools）
- P1 真机验收记录

## [0.0.1] - 2026-10-17

### Added

- P0 技术验证：MV3 扩展 + native messaging host + UNIX socket bridge + provider 插件
- 4 个工具（status/goto/snapshot/screenshot），截图经 native host 物化
- P0 记录与安装资产自动写入
