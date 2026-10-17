# 用法示例（给模型/人看的典型任务序列）

> 原则：**先 `chrome_snapshot`（或 `chrome_find`）拿 ref，再动作**；ref 失效就重新快照。
> 所有动作默认在**本会话后台标签组**里，不抢焦点；关闭会话用 `chrome_close_session`。

## 1. 读一篇长文并总结

```text
chrome_goto {url}
chrome_get_text {maxChars: 40000}        # 正文；控件多时也可用 snapshot
chrome_find {query: "关键数字"}           # 需要定位具体段落时
chrome_close_session
```

适合：新闻/文档/README。比 `snapshot` 省 token（不返回控件树）。

## 2. 填表单并提交

```text
chrome_goto {url}
chrome_snapshot                            # 拿 input/select/button 的 ref
chrome_type {ref: 3, text: "DSH", replace: true}
chrome_select {ref: 5, value: "Beta"}      # 下拉；checkbox 用 checked
chrome_click {ref: 1}                      # 提交按钮
chrome_wait {until: "text", text: "提交成功", timeoutMs: 15000}
```

表单提交常弹 `confirm`：默认会被**取消**；要自动确认就传：

```text
chrome_click {ref: 1, dialog: {accept: true}}
```

## 3. 调试本地前端

```text
chrome_goto {url: "http://127.0.0.1:3000"}
chrome_console {level: "error"}            # 最近错误（document_start 起捕获）
chrome_network {filter: "/api/"}           # 资源加载列表（v1 无状态码）
chrome_screenshot                          # 视觉确认；动作后有虚拟光标
```

## 4. 多标签调研（同会话并行读）

```text
chrome_tabs {op: "new", url: "https://example.com/a"}
chrome_tabs {op: "new", url: "https://example.com/b"}
chrome_tabs {op: "list"}                   # 同一 DSH 标签组
chrome_get_text {tabId: <id>}              # 指定标签读正文
chrome_close_session
```

## 5. 上传文件

```text
chrome_goto {url: "https://example.com/upload"}
chrome_snapshot                            # 找到 <input type=file> 的 ref
chrome_upload {ref: 4, files: ["/Users/me/report.pdf"]}
chrome_click {ref: 5}                      # 提交按钮
chrome_wait {until: "text", text: "上传成功"}
```

`chrome_upload` 是硬敏感动作：需要审批；provider 会先校验本地文件存在。

## 6. 触发下载并拿到路径

```text
chrome_goto {url}
chrome_snapshot
chrome_click {ref: 7}                      # 下载按钮/链接
chrome_download {limit: 5}                 # 取 filename 字段作为保存路径
```

## 7. 接管你当前正在看的标签

```text
chrome_tabs {op: "claim"}                  # 认领活动标签进本会话组
chrome_snapshot                            # 之后正常操作
```

`claim` 只接受 http(s) 页面，且走审批。

## 8. 悬停触发菜单

```text
chrome_snapshot
chrome_hover {ref: 2}                      # 展开菜单/提示
chrome_snapshot                            # 菜单出现后重新快照拿新 ref
chrome_click {ref: 9}
```

## 常用排错

| 现象 | 处理 |
|---|---|
| `REF_STALE` | 页面变了，重新 `chrome_snapshot`（或 `find`） |
| 页面动作 `TIMEOUT` | 会重试一次；仍失败检查页面是否 http(s)、是否被 dialog 阻塞 |
| `PROTECTED_PAGE` | chrome://、扩展页等不允许 DOM 操作，只能导航（chrome:// 除外） |
| `Chrome extension is not connected` | 扩展断开：重载扩展 / 看 `~/.dsh/cache/dsh-chrome/host.log` |
