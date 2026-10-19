# 发布说明 0.2.0（lease 生命周期收尾）

> 2026-10-19 · 扩展/provider **0.2.0**

## 新增/修正

- `chrome_goto` / `chrome_history` 导航成功后自动 `releaseTab`，避免旧 tab 的写 lease 悬挂；
- `chrome_tabs {op:"close"}` 关闭 tab 后自动释放该 tab lease；
- `chrome_close_session` 关闭会话 tab 后释放该 owner 的全部 lease；
- Windows 测试说明书：[WINDOWS-TEST-0.1.99.md](WINDOWS-TEST-0.1.99.md) / [HTML](windows-test-0.1.99.html)（自包含，可用于右侧展示）。

## 仍待

- `collab` shared context 仍未创建；`browser.shared.enabled=true` 时使用共享桌面 Chrome + 写租约门控；
- lease 没有自动心跳定时器；长动作靠调用期间持有；
- Edge 真机/商店、Safari spike 后置。
