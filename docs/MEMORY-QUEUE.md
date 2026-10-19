# 内存/生命周期加固队列（来自 memory-reduction + Codex 新提议）

> 基线：`1e9a452`（0.2.21 + H1–H3）。规则：每次只做一项；每项 `CI=1 npm test`（已知 headless 视觉探针时序 flake，严格 `npm test` 可另行记录）；显式路径 commit、push、勾选本项；不升版本。
> 目标：一个浏览器可开多个页面；最大 Tab 数和并发浏览器数由用户配置；tab/capture/screenshot/host 状态和 agent run 严格绑定。

## 队列

- [x] M1 attachTab 事务化 + 容量检查前置
  - `MAX_TABS` 检查放到 `Target.createTarget` 之前；使用可配置 `maxTabs`（默认 12，env/config 可覆盖）。
  - `createTarget`/`attachToTarget`/`Page.enable`/`Runtime.enable`/visual tracker 任一步失败：close target、detach session、删除已写入的 maps，rethrow；不增加 `nextTabId` 或提交注册。
  - 注册所有 maps 放在初始化成功后一次性提交（或事务化 commit）。
  - 补 fake CDP 测试：超限不 create；attach/enable 失败无残留；成功可多 tab 同浏览器。
- [x] M2 tab/session/owner 统一清理
  - `cleanupTab(tab)` 统一处理：dropShotStream、bySession、consoleBuffers、captureByTab/captures、owner.tabs、tabs、activeTab；`tabs op=close`、`close_session`、context close、target detach、browser exit 全部调用。
  - 最后一个 tab 关闭后删除 owner（无 login/pending）；downloadByGuid 与 downloads 清理/上限；close 清理 idle timer。
  - 补测试：关闭 tab 后各 Map 归零；owner 不泄漏；target detach 走同一清理；浏览器异常退出全部清理。
- [x] M3 启动失败/截图/capture 生命周期
  - `ensureStarted` 任一步失败 kill child、清 `chrome/cdp/startPromise`，不留孤儿 Chrome；已存在 context 启动失败进入 crashed 或关闭。
  - `capture_stop` 后保留摘要并设置 TTL/数量上限；`chrome_capture_requests` 读取后释放原始 entries/body；默认 body 不存（H1 已做）。
  - 截图单帧增加字节/像素硬上限，超过不放入 `shot.last`；screencast 关闭时清理。
- [x] M4 用户可配置：maxTabs / maxContexts / 同一浏览器多页
  - 新增 canonical config `browser.maxTabs`（默认 12，范围 1–64），传给 HeadlessDriver；`browser.maxContexts` 已有。
  - DSH Config schema/settings 加入 `browser.maxTabs`（volatile），`chrome_status`/context view 显示 maxTabs、当前 tabs、maxContexts、contexts。
  - 文档 + 测试：一个 headless 浏览器内创建多个 tab、达到 maxTabs 报 RESOURCE_LIMIT、关闭后释放；两个 context 并发受 maxContexts 限制。
- [x] M5 host pending / console / timers（P1，若时间允许）
  - host pending 单请求超时 + 最大 pending 数（如 64），超限拒绝；console-hook entries 硬上限（500）+ 单条截断；统一 dispose 定时器/监听器。
  - 补测试；不改变协议。

## 完成后

队列全勾选报告；Lead 统一 `CI=1 npm test`、bump patch、release notes、Windows 包。
