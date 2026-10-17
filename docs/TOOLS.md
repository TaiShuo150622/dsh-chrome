# 工具参考

> 自动生成：`npm run docs:tools`。请改 `src/tools.js`，不要手改本文件。
> 工具数量：19

### `chrome_status`

Report the Chrome bridge state: whether the extension is connected, extension/host/protocol versions, install paths, and the last known tab for this DSH session. Call this first when browser tools fail.

无参数。

### `chrome_goto`

Open an http(s) URL in this DSH session browser tab (created as a background tab in the session tab group if absent). Does not steal focus. Returns tab id, URL, title, and load state.

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `url` | string | yes | Absolute http:// or https:// URL to open. |

### `chrome_snapshot`

Return a text snapshot of the current DSH session page: title, URL, a numbered list of visible interactive controls (use the numbers as refs for click/type), and visible page text. Password and payment-card values are masked. Prefer this over screenshots for reading content.

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `maxChars` | number | no | Maximum page-text characters to return (default 100000). |
| `tabId` | number | no | Optional tab id owned by this session. |

### `chrome_find`

Find text inside the current DSH session page. Returns matching snippets with data-dsh-ref handles (when the match sits in a link/button/input) and viewport coordinates, so results can be clicked without a full snapshot.

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `query` | string | yes | Text to search for (case-insensitive). |
| `maxResults` | number | no | Optional cap, 1-50 (default 20). |
| `tabId` | number | no | Optional tab id owned by this session. |

### `chrome_get_text`

Read the visible text of the DSH session page (or one element via a CSS selector). Useful for long articles / lazy-loaded content where a full snapshot of controls is unnecessary.

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `selector` | string | no | Optional CSS selector; defaults to main/article/[role=main]/body. |
| `maxChars` | number | no | Max characters, 500-200000 (default 20000). |
| `tabId` | number | no | Optional tab id owned by this session. |

### `chrome_select`

Select an option in a <select>, set a checkbox/radio, or toggle one. Takes a ref from chrome_snapshot or chrome_find. Pass value for select/radio, checked for checkbox/radio.

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `ref` | number | yes | Ref of the select/checkbox/radio control. |
| `value` | string | no | Option value or visible label (for <select>). |
| `checked` | boolean | no | Desired checked state (for checkbox/radio); defaults to toggle. |
| `tabId` | number | no | Optional tab id owned by this session. |

### `chrome_console`

Read recent console output captured from the DSH session page (log/info/warn/error/debug plus uncaught errors). Captured at document_start by the extension, so logs emitted before the call are available. Optionally clear the buffer.

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `level` | enum(log | info | warn | error | debug) | no | Optional level filter. |
| `limit` | number | no | Max entries, 1-120 (default 50). |
| `clear` | boolean | no | Clear the buffer after reading. |
| `tabId` | number | no | Optional tab id owned by this session. |

### `chrome_network`

List resources loaded by the DSH session page (Resource Timing): URL, initiator type, duration and transfer size. Use to see what the page fetched; request status/headers are not available in this v1.

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `filter` | string | no | Optional substring filter on the URL. |
| `limit` | number | no | Max entries, 1-200 (default 50). |
| `tabId` | number | no | Optional tab id owned by this session. |

### `chrome_screenshot`

Capture a PNG screenshot of the current DSH session page (or tabId) and return it as an image in this conversation. The file is also saved on disk. Use when layout or visual state matters; use chrome_snapshot for text.

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `tabId` | number | no | Optional tab id owned by this session. |
| `clip` | object | no | Optional viewport region to capture, in CSS pixels. |

### `chrome_click`

Click the interactive control with the given snapshot ref number on the current DSH session page. Take a fresh snapshot if refs may be stale. Returns the clicked element kind and label.

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `ref` | number | yes | Control number from the latest chrome_snapshot. |
| `dialog` | object | no | How to answer a JS dialog (confirm/prompt/beforeunload) triggered by this action. Default: dismiss. Set accept:true to accept; promptText fills a prompt. |
| `tabId` | number | no | Optional tab id owned by this session. |

### `chrome_type`

Type text into the input/textarea with the given snapshot ref number (React/Vue-safe). Set replace to clear first, submit to submit the owning form. The page is not re-snapshotted automatically.

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `ref` | number | yes | Control number from the latest chrome_snapshot. |
| `text` | string | yes | Text to enter. |
| `replace` | boolean | no | Replace the existing value instead of appending. |
| `submit` | boolean | no | Submit the form after typing. |
| `dialog` | object | no | How to answer a JS dialog (confirm/prompt/beforeunload) triggered by this action. Default: dismiss. Set accept:true to accept; promptText fills a prompt. |
| `tabId` | number | no | Optional tab id owned by this session. |

### `chrome_press`

Dispatch a keyboard key (Enter, Tab, Escape, ArrowUp/Down/Left/Right, PageUp/PageDown, Home/End, or a single character) to the focused element on the current DSH session page.

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `key` | string | yes | Key to press, e.g. Enter or Escape. |
| `dialog` | object | no | How to answer a JS dialog (confirm/prompt/beforeunload) triggered by this action. Default: dismiss. Set accept:true to accept; promptText fills a prompt. |
| `tabId` | number | no | Optional tab id owned by this session. |

### `chrome_scroll`

Scroll the current DSH session page: direction up/down/top/bottom, optional pixel amount (default 600). Returns the resulting scroll position.

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `direction` | enum(up | down | top | bottom) | yes |  |
| `amount` | number | no | Pixels to scroll for up/down (default 600). |
| `tabId` | number | no | Optional tab id owned by this session. |

### `chrome_history`

Navigate backwards, forwards, or reload the current DSH session page. Waits for the load to complete and returns the resulting URL/title.

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `op` | enum(back | forward | reload) | yes |  |
| `tabId` | number | no | Optional tab id owned by this session. |

### `chrome_tabs`

Manage tabs owned by this DSH session: list owned tabs, open a new background tab in the session tab group, or close an owned tab. Never lists or controls tabs outside this session.

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `op` | enum(list | new | close | claim) | yes |  |
| `url` | string | no | URL for op=new (http/https; defaults to about:blank). |
| `tabId` | number | no | Tab id for op=close/claim; claim defaults to the active tab. |

### `chrome_upload`

Attach local files to a file input on the session page (e.g. upload a screenshot or a document). The ref must point at an <input type=file> from the latest snapshot. Requires approval and only accepts existing local files.

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `ref` | number | yes | Ref of the file input element. |
| `files` | array | yes | Absolute local file paths to attach. |
| `tabId` | number | no | Optional tab id owned by this session. |

### `chrome_download`

List recent Chrome downloads (filename, URL, state, bytes, start time). Use after triggering a download to find the saved file path.

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `limit` | number | no | Max entries, 1-100 (default 20). |

### `chrome_wait`

Wait for the current DSH session page: until=load (document complete), until=networkidle (load + short settle), or until=text with a text argument (polls page text until it appears). Fails with TIMEOUT instead of hanging.

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `until` | enum(load | networkidle | text) | yes |  |
| `text` | string | no | Required when until=text. |
| `timeoutMs` | number | no | Maximum wait in ms (default 30000, max 120000). |
| `tabId` | number | no | Optional tab id owned by this session. |

### `chrome_close_session`

Close every tab owned by this DSH session (and its tab group). Does not quit Chrome and never touches the user's other tabs.

无参数。
