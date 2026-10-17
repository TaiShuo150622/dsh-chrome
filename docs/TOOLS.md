# 工具参考

> 自动生成：`npm run docs:tools`。请改 `src/tools.js`，不要手改本文件。
> 工具数量：25

### `chrome_status`

Report the Chrome bridge state: whether the extension is connected, extension/host/protocol versions, install paths, and the last known tab for this DSH session. Call this first when browser tools fail.

无参数。

### `chrome_goto`

Open an http(s) URL in this DSH session browser tab (created as a background tab in the session tab group if absent). Does not steal focus. Returns tab id, URL, title, and load state.

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `url` | string | yes | Absolute http:// or https:// URL to open. |

### `chrome_snapshot`

Return a text snapshot of the current DSH session page: title, URL, a numbered list of visible interactive controls (use the numbers as refs for click/type), and visible page text. Refs are stable across snapshots until the page changes; newly seen controls are marked with new:true. Password and payment-card values are masked. Prefer this over screenshots for reading content.

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `maxChars` | number | no | Maximum page-text characters to return (default 100000). |
| `boxes` | boolean | no | Include each control viewport box [x,y,width,height] in CSS px. |
| `mode` | enum(full | delta) | no | delta returns only controls that changed since the previous snapshot in this page. |
| `tabId` | number | no | Optional tab id owned by this session. |

### `chrome_find`

Find text inside the current DSH session page. Returns matching snippets with data-dsh-ref handles (when the match sits in a link/button/input) and viewport coordinates, so results can be clicked without a full snapshot.

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `query` | string | no | Text or pattern to search for (case-insensitive). |
| `regex` | boolean | no | Treat query as a regular expression (case-insensitive). |
| `maxResults` | number | no | Optional cap, 1-50 (default 20). |
| `tabId` | number | no | Optional tab id owned by this session. |

### `chrome_get_text`

Read the visible text of the DSH session page (or one element via a CSS selector). Useful for long articles / lazy-loaded content where a full snapshot of controls is unnecessary.

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `selector` | string | no | Optional CSS selector; defaults to main/article/[role=main]/body. |
| `maxChars` | number | no | Max characters, 500-200000 (default 20000). |
| `format` | enum(text | markdown) | no | Output format (default text). |
| `tabId` | number | no | Optional tab id owned by this session. |

### `chrome_select`

Select an option in a <select>, set a checkbox/radio, or toggle one. Takes a ref from chrome_snapshot or chrome_find. Pass value for select/radio, checked for checkbox/radio.

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `ref` | number | yes | Ref of the select/checkbox/radio control. |
| `value` | string | no | Option value or visible label (for <select>). |
| `checked` | boolean | no | Desired checked state (for checkbox/radio); defaults to toggle. |
| `tabId` | number | no | Optional tab id owned by this session. |

### `chrome_drag`

Drag from one snapshot ref to another (pointer/mouse plus HTML5 drag events). Useful for sliders, sortable lists and kanban boards.

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `fromRef` | number | yes | Ref of the element to drag. |
| `toRef` | number | yes | Ref of the drop target. |
| `tabId` | number | no | Optional tab id owned by this session. |

### `chrome_emulate`

Override the viewport with CDP Emulation (responsive testing): set width/height/mobile, or reset to the real viewport. Layout and screenshots follow the override.

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `width` | number | no | Viewport width in CSS px (>=100). |
| `height` | number | no | Viewport height in CSS px (>=100). |
| `mobile` | boolean | no | Emulate a mobile device. |
| `reset` | boolean | no | Clear the viewport override. |
| `tabId` | number | no | Optional tab id owned by this session. |

### `chrome_storage`

Read or change the session page storage (localStorage / sessionStorage): get one key, several keys or all entries; set/remove/clear (mutations require approval). Values are JSON-encoded when not strings.

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `op` | enum(get | set | remove | clear) | yes |  |
| `scope` | enum(local | session) | no | Storage area (default local). |
| `key` | string | no | Key for get/set. |
| `value` | object | no | Value for set (string or JSON-serializable value). |
| `keys` | array | no | Keys for get/remove batches. |
| `tabId` | number | no | Optional tab id owned by this session. |

### `chrome_pdf`

Export the current DSH session page to a PDF file with CDP Page.printToPDF and return the saved path. Useful for archiving or sharing a page as it renders.

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `path` | string | no | Optional absolute output path; defaults to the DSH cache pdfs directory. |
| `tabId` | number | no | Optional tab id owned by this session. |

### `chrome_a11y`

Return the accessibility tree of the DSH session page (role/name/value nodes, filtered and truncated). Useful for understanding structure, dialogs and non-DOM UIs; use chrome_snapshot for clickable refs.

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `limit` | number | no | Max nodes, 1-400 (default 200). |
| `tabId` | number | no | Optional tab id owned by this session. |

### `chrome_console`

Read recent console output captured from the DSH session page (log/info/warn/error/debug plus uncaught errors). Captured at document_start by the extension, so logs emitted before the call are available. Optionally clear the buffer.

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `level` | enum(log | info | warn | error | debug) | no | Optional level filter. |
| `filter` | string | no | Optional substring filter on the log text. |
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
| `ref` | number | no | Capture only the element with this snapshot ref. |
| `fullPage` | boolean | no | Capture the full scrollable document instead of the viewport. |
| `highlight` | boolean | no | Overlay labeled boxes for current snapshot refs in the capture. |
| `clip` | object | no | Optional viewport region to capture, in CSS pixels. |

### `chrome_hover`

Hover over the control with the given snapshot ref (useful to reveal menus, tooltips or hover-only actions). Take a fresh snapshot if refs may be stale. The virtual cursor is shown at the target.

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `ref` | number | no | Control number from the latest chrome_snapshot or chrome_find. |
| `selector` | string | no | CSS selector alternative to ref (used when ref is omitted). |
| `snapshot` | boolean | no | Attach a fresh page snapshot to the result (saves a separate chrome_snapshot roundtrip). |
| `tabId` | number | no | Optional tab id owned by this session. |

### `chrome_click`

Click the interactive control with the given snapshot ref number on the current DSH session page. Take a fresh snapshot if refs may be stale. Returns the clicked element kind and label.

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `ref` | number | no | Control number from the latest chrome_snapshot. |
| `selector` | string | no | CSS selector alternative to ref (used when ref is omitted). |
| `button` | enum(left | right | middle) | no | Mouse button (default left). |
| `clickCount` | number | no | Click count, 1-3 (default 1; 2 = double click). |
| `snapshot` | boolean | no | Attach a fresh page snapshot to the result (saves a separate chrome_snapshot roundtrip). |
| `dialog` | object | no | How to answer a JS dialog (confirm/prompt/beforeunload) triggered by this action. Default: dismiss. Set accept:true to accept; promptText fills a prompt. |
| `tabId` | number | no | Optional tab id owned by this session. |

### `chrome_type`

Type text into the input/textarea with the given snapshot ref number (React/Vue-safe). Set replace to clear first, submit to submit the owning form. The page is not re-snapshotted automatically.

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `ref` | number | no | Control number from the latest chrome_snapshot. |
| `selector` | string | no | CSS selector alternative to ref (used when ref is omitted). |
| `text` | string | yes | Text to enter. |
| `replace` | boolean | no | Replace the existing value instead of appending. |
| `submit` | boolean | no | Submit the form after typing. |
| `snapshot` | boolean | no | Attach a fresh page snapshot to the result (saves a separate chrome_snapshot roundtrip). |
| `dialog` | object | no | How to answer a JS dialog (confirm/prompt/beforeunload) triggered by this action. Default: dismiss. Set accept:true to accept; promptText fills a prompt. |
| `tabId` | number | no | Optional tab id owned by this session. |

### `chrome_press`

Dispatch a keyboard key (Enter, Tab, Escape, ArrowUp/Down/Left/Right, PageUp/PageDown, Home/End, or a single character) to the focused element on the current DSH session page.

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `key` | string | yes | Key to press, e.g. Enter or Escape. |
| `snapshot` | boolean | no | Attach a fresh page snapshot to the result (saves a separate chrome_snapshot roundtrip). |
| `dialog` | object | no | How to answer a JS dialog (confirm/prompt/beforeunload) triggered by this action. Default: dismiss. Set accept:true to accept; promptText fills a prompt. |
| `tabId` | number | no | Optional tab id owned by this session. |

### `chrome_scroll`

Scroll the current DSH session page: direction up/down/top/bottom, optional pixel amount (default 600). Returns the resulting scroll position.

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `snapshot` | boolean | no | Attach a fresh page snapshot to the result (saves a separate chrome_snapshot roundtrip). |
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
| `op` | enum(list | new | close | claim | focus) | yes |  |
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

Wait for the current DSH session page: until=load (document complete), networkidle (load + short settle), text (page text contains it), selector (CSS selector exists), url (current URL contains it), or change (DOM controls changed since the previous snapshot). Fails with TIMEOUT instead of hanging.

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `until` | enum(load | networkidle | text | selector | url | change) | yes |  |
| `text` | string | no | Required when until=text. |
| `selector` | string | no | Required when until=selector (CSS selector). |
| `url` | string | no | Required when until=url (substring of the current URL). |
| `timeoutMs` | number | no | Maximum wait in ms (default 30000, max 120000). |
| `tabId` | number | no | Optional tab id owned by this session. |

### `chrome_close_session`

Close every tab owned by this DSH session (and its tab group). Does not quit Chrome and never touches the user's other tabs.

无参数。
