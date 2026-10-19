# 工具参考

> 自动生成：`npm run docs:tools`。请改 `src/tools.js`，不要手改本文件。
> 工具数量：46

### `chrome_status`

Report the Chrome bridge state: whether the extension is connected, extension/host/protocol versions, install paths, and the last known tab for this DSH session. Call this first when browser tools fail.

无参数。

### `chrome_memory_stats`

Report a provider memory snapshot: Node rss/heapUsed/heapTotal/external/arrayBuffers in bytes, plus retained-object counts for browser contexts, drivers, captures, console buffers, downloads, screenshot streams and the bridge. Numbers only — never page content, URLs, console text or credentials — so repeated calls can be compared to locate a leak.

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
| `maxChars` | number | no | Maximum page-text characters to return (default 20000, up to 200000). Use chrome_get_text to read a long page. |
| `boxes` | boolean | no | Include each control viewport box [x,y,width,height] in CSS px. |
| `mode` | enum(full | delta) | no | delta returns only controls that changed since the previous snapshot in this page. |
| `frames` | enum(all | main) | no | all (default) includes iframe controls with f<frame>:<ref> handles; main keeps legacy main-frame-only output. |
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
| `frames` | enum(all | main) | no | all joins iframe text with [f<frame>] labels; main (default) keeps main-frame text only. |
| `tabId` | number | no | Optional tab id owned by this session. |

### `chrome_select`

Select an option in a <select>, set a checkbox/radio, or toggle one. Takes a ref from chrome_snapshot or chrome_find. Pass value for select/radio, checked for checkbox/radio.

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `ref` | number | no | Ref of the select/checkbox/radio control. |
| `selector` | string | no | CSS selector alternative to ref (used when ref is omitted). |
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

Export the current DSH session page to a PDF file with CDP Page.printToPDF and return the saved path. Useful for archiving or sharing a page as it renders. An explicit path must be absolute, stay inside the DSH PDF cache or this session working directory, name a file that does not exist yet, and requires an explicit confirmation showing the full path; the default goes to the PDF cache without prompting.

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `path` | string | no | Optional absolute output path for a new file inside the DSH PDF cache or the session working directory; an explicit path requires hard confirmation. Defaults to a new file in the PDF cache. |
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
| `frameRef` | string | no | Capture only an iframe element, e.g. "f83F9D728:1" (from chrome_snapshot frames). |
| `fullPage` | boolean | no | Capture the full scrollable document instead of the viewport. |
| `highlight` | boolean | no | Overlay labeled boxes for current snapshot refs in the capture. |
| `clip` | object | no | Optional viewport region to capture, in CSS pixels. |

### `chrome_hover`

Hover over the control with the given snapshot ref (useful to reveal menus, tooltips or hover-only actions). Take a fresh snapshot if refs may be stale. The virtual cursor is shown at the target.

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `ref` | number | no | Control number from the latest chrome_snapshot or chrome_find. |
| `selector` | string | no | CSS selector alternative to ref (used when ref is omitted). |
| `frameRef` | string | no | Iframe handle from chrome_snapshot frames, e.g. "f83F9D728:1". |
| `snapshot` | boolean | no | Attach a fresh page snapshot to the result (saves a separate chrome_snapshot roundtrip). |
| `tabId` | number | no | Optional tab id owned by this session. |

### `chrome_html`

Read the DOM/HTML of the current page or a selector. Credential-shaped attributes (value/csrf/token/password/secret/session/cookie/api-key) are masked before returning; mode "simplified" also strips scripts, styles, comments, inline event handlers and style attributes.

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `selector` | string | no | CSS selector to read (default: whole documentElement). |
| `mode` | enum(outer | simplified) | no | outer = raw outerHTML with masked secrets; simplified = also strip scripts/styles/handlers (default outer). |
| `maxChars` | number | no | Optional cap (500-200000, default 20000). |
| `tabId` | number | no | Optional tab id owned by this session. |

### `chrome_click`

Click the interactive control with the given snapshot ref number on the current DSH session page. Take a fresh snapshot if refs may be stale. Returns the clicked element kind and label.

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `ref` | number | no | Control number from the latest chrome_snapshot. |
| `selector` | string | no | CSS selector alternative to ref (used when ref is omitted). |
| `frameRef` | string | no | Iframe handle from chrome_snapshot frames, e.g. "f83F9D728:1" (takes precedence over ref). |
| `button` | enum(left | right | middle) | no | Mouse button (default left). |
| `clickCount` | number | no | Click count, 1-3 (default 1; 2 = double click). |
| `snapshot` | boolean | no | Attach a fresh page snapshot to the result (saves a separate chrome_snapshot roundtrip). |
| `dialog` | object | no | How to answer a JS dialog (confirm/prompt/beforeunload) triggered by this action. Default: dismiss. Set accept:true to accept; promptText fills a prompt. |
| `tabId` | number | no | Optional tab id owned by this session. |

### `chrome_selection`

Read the current page selection (or selected text inside a focused input/textarea) with its source URL and title, wrapped as untrusted page content. Password/payment/secret fields return SENSITIVE_SELECTION; no selection returns NO_SELECTION.

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `maxChars` | number | no | Optional cap (10-20000, default 4000). |
| `tabId` | number | no | Optional tab id owned by this session. |

### `chrome_config`

Read the provider config (~/.dsh/cache/dsh-chrome/config.json): allowEvaluate, confirmation timeouts and capture confirmation mode. Read-only; edit the file and reload the provider bundle to change it.

无参数。

### `chrome_policy`

Read the effective site policy for the current page (or an explicit origin) from ~/.dsh/cache/dsh-chrome/policy.json. Modes: allow (skip ordinary approval), ask (session approval), block (SITE_BLOCKED). Read-only: policy.json is edited by the human, never by tools.

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `origin` | string | no | Optional origin, e.g. https://example.com (default: current session tab). |
| `tabId` | number | no | Optional tab id owned by this session. |

### `chrome_audit`

Read the recent site-policy audit log (~/.dsh/cache/dsh-chrome/audit.jsonl): timestamp, session, tool, origin, action, decision and reason for every guarded browser write.

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `limit` | number | no | Max entries returned (default 20, max 100). |
| `origin` | string | no | Only entries for this origin. |

### `chrome_headless_login`

Open a visible, dedicated Chrome window at a human-interaction step (login, CAPTCHA, payment, OTP) using the headless profile: op="start" opens about:blank, op="show" pauses the current headless session and reopens its current page in a visible window, op="finish" closes the visible window, op="status" reports it. The next backend:"headless" call resumes the page after show/finish. With a context manager the window belongs to this session active headless context, so open one first (chrome_context {op:"create"} or any backend:"headless" call). Requires hard confirmation.

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `op` | enum(start | show | status | finish) | yes |  |
| `url` | string | no | start/show: http(s) URL (show defaults to the current headless page). |
| `contextId` | string | no | Optional owned context id; defaults to this session active context. |

### `chrome_context`

Manage isolated browser contexts for sandbox verification: op="create" makes a per-session headless context (default preset sandbox), op="use" switches the session active context, op="list" lists this session contexts, op="current" shows the active one, op="close" closes one. op="viewer" writes the viewer URL to a local handoff file and returns its path plus an opaque handle; the bearer URL is never returned. Contexts are isolated (separate profile); backend:"headless" calls route to the session active context.

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `op` | enum(create | use | list | current | close | viewer) | yes |  |
| `preset` | enum(sandbox | sandbox-persistent | debug | collab) | no |  |
| `profile` | string | no | Named profile label for sandbox-persistent/debug. |
| `contextId` | string | no | Context id for use/close. |

### `chrome_lease`

Manage in-memory tab leases for shared-visible/collab sessions: acquire read or write ownership of a tab, renew, release, list, inspect status, or take over as the user. Write leases are exclusive; read leases may be shared. Leases expire automatically after ttlMs. This is the I3 lease foundation only: acquiring a lease does not yet gate every chrome_* write action.

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `op` | enum(acquire | renew | release | list | status | takeover) | yes |  |
| `tabId` | number | no | Target tab id for acquire/status/takeover, or an optional list filter. |
| `mode` | enum(read | write) | no | Lease mode for acquire (default read); optional list filter. |
| `ttlMs` | number | no | Lease lifetime in milliseconds (default 60000, max 900000). |
| `leaseId` | string | no | Lease id for renew/release. Omit renew leaseId to heartbeat all leases owned by this session. |
| `owner` | string | no | Optional owner filter for list. Acquisition/renewal/release always use the calling session owner. |
| `by` | enum(user) | no | takeover only: must be "user". |

### `chrome_verify`

Run a repeatable browser verification on an isolated headless context: navigate, waitFor, click, type, then assert URL/title/text/element/console/network. Returns machine-readable checks plus artifacts (screenshot, console/network summary, JSON report). This is the sandbox-verification layer; it reuses the per-session context and does not open a visible window.

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `contextId` | string | no | Optional existing context id; defaults to this session active context. |
| `url` | string | no | Optional first navigation URL. |
| `steps` | array | yes | Ordered steps: navigate/waitFor/click/type/assert. |
| `options` | object | no |  |

### `chrome_pointer`

Show a persistent virtual pointer pinned to an element (ref/selector) or viewport coordinates, with an optional label; op="show"/"move" pins it, op="hide" hides it, op="auto" enables/disables automatic following of click/type/hover actions, pulse:true plays a click ripple. The pointer is an overlay (pointer-events:none) and appears in screenshots but not in page text snapshots.

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `op` | enum(show | move | hide | auto) | yes |  |
| `ref` | number | no | Pin to the element with this snapshot ref. |
| `selector` | string | no | Pin to this CSS selector instead of ref. |
| `x` | number | no | Viewport x (CSS px) when not using ref/selector. |
| `y` | number | no | Viewport y (CSS px) when not using ref/selector. |
| `label` | string | no | Label next to the pointer (default "DSH"; empty hides it). |
| `pulse` | boolean | no | Play a click ripple after moving. |
| `enabled` | boolean | no | op=auto: enable/disable automatic follow (default true). |
| `tabId` | number | no | Optional tab id owned by this session. |
| `frame` | boolean | no | Search all frames/iframes for the target (annotation inside an iframe). |

### `chrome_annotate`

Draw annotations over the current page: highlight text (text/ref/selector), box/circle an element, draw an arrow from one target to another, or add a text label/index bubble; op="list" returns current annotations, op="clear" removes them (all, or one by id), op="export" returns the JSON/report and op="restore" reloads the persisted set. Annotations auto-persist per tab URL in sessionStorage and survive reloads. Overlays appear in screenshots and are excluded from page text snapshots.

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `op` | enum(highlight | box | circle | arrow | label | list | clear | export | restore) | yes |  |
| `ref` | number | no | Target element ref (highlight/box/circle/arrow/label). |
| `selector` | string | no | Target CSS selector instead of ref. |
| `text` | string | no | Text to find/highlight when no ref/selector is given. |
| `fromRef` | number | no | Arrow start ref. |
| `fromSelector` | string | no | Arrow start selector. |
| `color` | string | no | CSS color (default cycles DSH palette). |
| `label` | string | no | Text label/bubble content. |
| `id` | string | no | clear: remove this annotation id only. |
| `index` | number | no | label: numeric badge shown in the bubble. |
| `tabId` | number | no | Optional tab id owned by this session. |
| `frame` | boolean | no | Search all frames/iframes for the target (annotate inside an iframe); returns frameId/frameUrl. |

### `chrome_screencast`

Continuous page view prototype: op="start" begins CDP Page.startScreencast (JPEG frames every Nth frame), the native host writes the latest frame to ~/.dsh/cache/dsh-chrome/screencast/latest.jpg, op="status" returns it as an image (only for the session that started an active stream), op="stop" ends the stream; op="viewer" writes the loopback live-view URL to a local handoff file and returns its path plus an opaque handle (the bearer URL is never returned); op="diag" returns the last extension diagnostics. Frames are not sent to the model unless status is called.

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `op` | enum(start | stop | status | diag | viewer) | yes |  |
| `format` | enum(jpeg | png) | no | start: frame format (default jpeg). |
| `quality` | number | no | start: JPEG quality 1-100 (default 60). |
| `everyNthFrame` | number | no | start: deliver every Nth frame, 1-10 (default 2). |
| `tabId` | number | no | Optional tab id owned by this session. |

### `chrome_shots`

List or read screenshot history saved by this provider (desktop ~/.dsh/cache/dsh-chrome/screenshots and headless ~/.dsh/cache/dsh-chrome/headless/screenshots). History is filesystem-backed, so it survives restarts. op="list" returns recent screenshots with size + PNG dimensions; op="read" returns one screenshot (path under either directory) as an image attachment. Shots recorded for another DSH session are hidden.

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `op` | enum(list | read) | yes |  |
| `limit` | number | no | list: max entries (default 20, max 100). |
| `path` | string | no | read: absolute path under the screenshots directory. |

### `chrome_resume`

Resume normal browser actions after a USER_SWITCHED pause. A pause is set when the user activates another tab while the DSH session tab was the active one; the next mutating action returns USER_SWITCHED until this tool (or chrome_tabs {op:"focus"}) clears it.

无参数。

### `chrome_pick`

Enter element-pick mode: an overlay appears; the user clicks one element and the tool returns {ref, selector, text, tag, box}. The returned ref can be used directly with chrome_click/chrome_type. Blocks until the pick completes, is canceled, or times out. Set cancel:true to abort an active pick.

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `timeoutMs` | number | no | Pick timeout, 500-120000 ms (default 60000). |
| `cancel` | boolean | no | Cancel the active pick instead of starting a new one. |
| `nowait` | boolean | no | Start pick mode and return immediately; use poll:true later to fetch the result. |
| `poll` | boolean | no | Return the current pick status; pending:true means the user has not clicked yet. |
| `tabId` | number | no | Optional tab id owned by this session. |

### `chrome_capture_start`

Start capturing HTTP requests for one DSH session tab through the DevTools Network domain. Records method/URL/status/mimeType/resourceType/timing; headers (Cookie, Authorization, Set-Cookie) are never captured. Requires explicit user confirmation every time; Chrome shows a debugging banner while capture is active (max 10 minutes).

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `tabId` | number | no | Optional tab id owned by this session. |
| `resourceTypes` | array | no | Resource types to record (default: xhr, fetch, document). |
| `maxEntries` | number | no | Max requests kept in the buffer (default 300, max 1000). |
| `storeBodies` | boolean | no | Record redacted request/response bodies (default false: metadata only). Pass true explicitly to store bodies; bodies may contain personal data. |

### `chrome_capture_stop`

Stop the active network capture, release the debugger pin and freeze the buffer. Captured entries stay readable through chrome_capture_requests; new requests are not recorded.

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `tabId` | number | no | Optional tab id owned by this session. |
| `captureId` | string | no | Optional capture id (defaults to the active capture). |

### `chrome_capture_requests`

Read captured HTTP metadata (method/URL/status/mimeType/resourceType/timing). Headers are never captured; secret-shaped query params are redacted. Works while active or after stop (frozen buffer); if the worker restarted the buffer is reported as lost.

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `tabId` | number | no | Optional tab id owned by this session. |
| `captureId` | string | no | Optional capture id (defaults to the active capture). |
| `limit` | number | no | Max entries returned (default 50, max 200). |
| `filter` | string | no | Case-insensitive filter over method + URL. |
| `resourceTypes` | array | no | Only these resource types. |
| `includeBodies` | boolean | no | Include truncated request/response bodies (default true). |
| `maxBodyChars` | number | no | Body display cap, 64-65536 (default 4096). |

### `chrome_frames`

List the frames of the current DSH session page (main frame plus iframes) via CDP Page.getFrameTree. Set probe:true to also read each frame URL/title/control count with a fixed read-only script in an isolated world (no arbitrary code injection).

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `probe` | boolean | no | Read url/title/control count in every frame. |
| `tabId` | number | no | Optional tab id owned by this session. |

### `chrome_click_at`

Click at CSS-pixel viewport coordinates (x, y) instead of a snapshot ref. Useful for canvas, maps, video controls and other painted UI that has no DOM control. Coordinates outside the viewport return OUT_OF_VIEWPORT.

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `x` | number | yes | Viewport x in CSS pixels. |
| `y` | number | yes | Viewport y in CSS pixels. |
| `button` | enum(left | right | middle) | no | Mouse button (default left). |
| `clickCount` | number | no | Click count, 1-3 (default 1; 2 = double click). |
| `snapshot` | boolean | no | Attach a fresh page snapshot to the result. |
| `dialog` | object | no |  |
| `tabId` | number | no | Optional tab id owned by this session. |

### `chrome_type`

Type text into the input/textarea with the given snapshot ref number (React/Vue-safe). Set replace to clear first, submit to submit the owning form. The page is not re-snapshotted automatically.

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `ref` | number | no | Control number from the latest chrome_snapshot. |
| `selector` | string | no | CSS selector alternative to ref (used when ref is omitted). |
| `frameRef` | string | no | Iframe handle from chrome_snapshot frames, e.g. "f749ABB6B:2" (takes precedence over ref). |
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

Attach local files to a file input on the session page (e.g. upload a screenshot or a document). The ref must point at an <input type=file> from the latest snapshot. Files must live under the session working directory (or DSH_CHROME_UPLOAD_ROOTS), and every call asks for a hard confirmation that lists the full paths and the target origin.

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `ref` | number | no | Ref of the file input element. |
| `selector` | string | no | CSS selector alternative to ref (used when ref is omitted). |
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
