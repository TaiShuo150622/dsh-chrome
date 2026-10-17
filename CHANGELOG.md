# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号在 P3 之前按扩展 manifest 递增。

## [Unreleased]

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
