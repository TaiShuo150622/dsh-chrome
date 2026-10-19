/**
 * Input tools: chrome_click, chrome_click_at, chrome_type, chrome_press,
 * chrome_hover, chrome_scroll, chrome_select, chrome_drag and chrome_upload.
 * Extracted from tools.js (Q18) so pointer/keyboard/file input and the upload
 * path allowlist live in one small module. Approval, lease, hard-confirmation
 * and error-code semantics are unchanged.
 */
import fsp from 'node:fs/promises'
import path from 'node:path'

import { BridgeError } from './bridge.js'

export function createInputTools({
  call,
  guard,
  ownerOf,
  outputSchema,
  renderText,
  hardConfirmAsk,
  evaluateConfirmTimeoutMs,
  writeAudit,
  sessionCwd,
}) {
  // Upload path allowlist (R-04): a file may only leave the machine from the
  // session working directory, or from directories the user explicitly opted
  // into with DSH_CHROME_UPLOAD_ROOTS. Symlinks are resolved before the check
  // so a link inside the workspace cannot point at ~/.ssh.
  function uploadRoots(exec) {
    const roots = []
    const configured = String(process.env.DSH_CHROME_UPLOAD_ROOTS || '')
    for (const part of configured.split(path.delimiter)) {
      const trimmed = part.trim()
      if (trimmed) roots.push(path.resolve(trimmed))
    }
    const cwd = sessionCwd(exec)
    if (cwd) roots.push(path.resolve(cwd))
    return [...new Set(roots)]
  }

  async function assertUploadAllowed(exec, files, site) {
    const roots = []
    for (const root of uploadRoots(exec)) {
      try {
        roots.push(await fsp.realpath(root))
      } catch {
        // a configured root that does not exist cannot authorize anything
      }
    }
    if (roots.length === 0) {
      writeAudit(exec, 'chrome_upload', 'upload', site, 'denied', 'upload-no-allowed-root')
      throw new BridgeError(
        'INVALID_ARGUMENT',
        'uploads are restricted to the session working directory, but no allowed root is known; set DSH_CHROME_UPLOAD_ROOTS (path-delimiter separated) to opt in to other directories',
      )
    }
    for (const file of files) {
      let resolved
      try {
        resolved = await fsp.realpath(file)
      } catch {
        resolved = path.resolve(String(file))
      }
      const allowed = roots.some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`))
      if (!allowed) {
        writeAudit(exec, 'chrome_upload', 'upload', site, 'denied', 'upload-path-not-allowed')
        throw new BridgeError(
          'INVALID_ARGUMENT',
          `file is outside the allowed upload roots: ${file} (allowed: ${roots.join(', ')})`,
        )
      }
    }
  }

  // H5: the browser backend refuses to touch a password/OTP/payment field
  // (SENSITIVE_FIELD) until the provider has asked the human. The confirmation
  // never contains the text, key, field value or any page label, and approval
  // is one-shot: the retry carries `sensitiveApproved` for this call only.
  async function confirmSensitiveInput(exec, toolName, site, actionLabel) {
    await hardConfirmAsk(exec, toolName, {
      header: '向敏感字段输入（密码 / OTP / 支付）',
      question: `允许在 ${site?.origin || '当前页面'} 上向被识别为密码/OTP/支付字段的控件执行一次「${actionLabel}」吗？`,
      detail:
        '浏览器把目标字段识别为敏感字段。输入内容不会出现在工具结果里，也不会写入日志或审计；' +
        '允许只对本次调用生效，不会保存或自动填入任何凭据。',
      timeoutMs: evaluateConfirmTimeoutMs,
      site,
    })
  }

  const select = {
    name: 'chrome_select',
    mutating: true,
    description:
      'Select an option in a <select>, set a checkbox/radio, or toggle one. Takes a ref from chrome_snapshot or chrome_find. Pass value for select/radio, checked for checkbox/radio.',
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'number', description: 'Ref of the select/checkbox/radio control.' },
        selector: { type: 'string', description: 'CSS selector alternative to ref (used when ref is omitted).' },
        value: { type: 'string', description: 'Option value or visible label (for <select>).' },
        checked: { type: 'boolean', description: 'Desired checked state (for checkbox/radio); defaults to toggle.' },
        tabId: { type: 'number', description: 'Optional tab id owned by this session.' },
      },
      additionalProperties: false,
    },
    output: {
      schema: outputSchema({
        ok: { type: 'boolean' },
        tag: { type: 'string' },
        value: { type: 'string' },
      }),
      render: (_args, value) => [
        { type: 'text', text: `${value.tag} → ${value.value}` },
      ],
    },
    async execute(args, exec) {
      const value = await call(
        'tab.select',
        { ref: args?.ref, selector: args?.selector, value: args?.value, checked: args?.checked, tabId: args?.tabId, owner: ownerOf(exec) },
        30000,
      )
      if (!value) throw new BridgeError('INTERNAL', 'extension returned no select result')
      return value
    },
  }

  const drag = {
    name: 'chrome_drag',
    mutating: true,
    description:
      'Drag from one snapshot ref to another (pointer/mouse plus HTML5 drag events). Useful for sliders, sortable lists and kanban boards.',
    parameters: {
      type: 'object',
      properties: {
        fromRef: { type: 'number', description: 'Ref of the element to drag.' },
        toRef: { type: 'number', description: 'Ref of the drop target.' },
        tabId: { type: 'number', description: 'Optional tab id owned by this session.' },
      },
      required: ['fromRef', 'toRef'],
      additionalProperties: false,
    },
    output: {
      schema: outputSchema({
        ok: { type: 'boolean' },
        from: { type: 'number' },
        to: { type: 'number' },
        tabId: { type: 'number' },
      }),
      render: (_args, value) => renderText(`Dragged ref ${value.from} → ref ${value.to}`),
    },
    async execute(args, exec) {
      await guard(exec, 'chrome_drag', `drag ${args?.fromRef}->${args?.toRef}`, { tabId: args?.tabId })
      return call(
        'tab.drag',
        { fromRef: args?.fromRef, toRef: args?.toRef, tabId: args?.tabId, owner: ownerOf(exec) },
        30000,
      )
    },
  }

  const hover = {
    name: 'chrome_hover',
    mutating: true,
    description:
      'Hover over the control with the given snapshot ref (useful to reveal menus, tooltips or hover-only actions). Take a fresh snapshot if refs may be stale. The virtual cursor is shown at the target.',
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'number', description: 'Control number from the latest chrome_snapshot or chrome_find.' },
        selector: { type: 'string', description: 'CSS selector alternative to ref (used when ref is omitted).' },
        frameRef: { type: 'string', description: 'Iframe handle from chrome_snapshot frames, e.g. "f83F9D728:1".' },
        snapshot: {
          type: 'boolean',
          description: 'Attach a fresh page snapshot to the result (saves a separate chrome_snapshot roundtrip).',
        },
        tabId: { type: 'number', description: 'Optional tab id owned by this session.' },
      },
      additionalProperties: false,
    },
    output: {
      schema: outputSchema({
        ok: { type: 'boolean' },
        tag: { type: 'string' },
        label: { type: 'string' },
        tabId: { type: 'number' },
        page: { type: 'object', additionalProperties: true },
      }),
      render: (_args, value) => renderText(`Hovered ${value.tag || 'element'} ${JSON.stringify(value.label || '')}${value.page ? '\n[page snapshot attached]' : ''}`),
    },
    async execute(args, exec) {
      await guard(exec, 'chrome_hover', `hover ref ${args?.ref}`, { tabId: args?.tabId })
      return call('tab.hover', { ref: args?.ref, selector: args?.selector, frameRef: args?.frameRef, snapshot: Boolean(args?.snapshot), tabId: args?.tabId, owner: ownerOf(exec) })
    },
  }

  const click = {
    name: 'chrome_click',
    mutating: true,
    description:
      'Click the interactive control with the given snapshot ref number on the current DSH session page. Take a fresh snapshot if refs may be stale. Returns the clicked element kind and label.',
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'number', description: 'Control number from the latest chrome_snapshot.' },
        selector: { type: 'string', description: 'CSS selector alternative to ref (used when ref is omitted).' },
        frameRef: { type: 'string', description: 'Iframe handle from chrome_snapshot frames, e.g. "f83F9D728:1" (takes precedence over ref).' },
        button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button (default left).' },
        clickCount: { type: 'number', description: 'Click count, 1-3 (default 1; 2 = double click).' },
        snapshot: {
          type: 'boolean',
          description: 'Attach a fresh page snapshot to the result (saves a separate chrome_snapshot roundtrip).',
        },
        dialog: {
          type: 'object',
          description:
            'How to answer a JS dialog (confirm/prompt/beforeunload) triggered by this action. Default: dismiss. Set accept:true to accept; promptText fills a prompt.',
          properties: {
            accept: { type: 'boolean' },
            promptText: { type: 'string' },
          },
          additionalProperties: false,
        },
        tabId: { type: 'number', description: 'Optional tab id owned by this session.' },
      },
      additionalProperties: false,
    },
    output: {
      schema: outputSchema({
        ok: { type: 'boolean' },
        tag: { type: 'string' },
        label: { type: 'string' },
        tabId: { type: 'number' },
        dialogs: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string' },
              message: { type: 'string' },
              accepted: { type: 'boolean' },
            },
            additionalProperties: true,
          },
        },
        page: { type: 'object', additionalProperties: true },
      }),
      render: (_args, value) => renderText(`Clicked ${value.tag || 'element'} ${JSON.stringify(value.label || '')}${value.page ? '\n[page snapshot attached]' : ''}`),
    },
    async execute(args, exec) {
      await guard(exec, 'chrome_click', `click ref ${args?.ref}`, { tabId: args?.tabId })
      return call('tab.click', { ref: args?.ref, selector: args?.selector, frameRef: args?.frameRef, button: args?.button, clickCount: args?.clickCount, snapshot: Boolean(args?.snapshot), dialog: args?.dialog, tabId: args?.tabId, owner: ownerOf(exec) })
    },
  }

  const clickAt = {
    name: 'chrome_click_at',
    mutating: true,
    description:
      'Click at CSS-pixel viewport coordinates (x, y) instead of a snapshot ref. Useful for canvas, maps, video controls and other painted UI that has no DOM control. Coordinates outside the viewport return OUT_OF_VIEWPORT.',
    parameters: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'Viewport x in CSS pixels.' },
        y: { type: 'number', description: 'Viewport y in CSS pixels.' },
        button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button (default left).' },
        clickCount: { type: 'number', description: 'Click count, 1-3 (default 1; 2 = double click).' },
        snapshot: { type: 'boolean', description: 'Attach a fresh page snapshot to the result.' },
        dialog: { type: 'object', additionalProperties: true },
        tabId: { type: 'number', description: 'Optional tab id owned by this session.' },
      },
      required: ['x', 'y'],
      additionalProperties: false,
    },
    output: {
      schema: outputSchema({
        ok: { type: 'boolean' },
        x: { type: 'number' },
        y: { type: 'number' },
        tag: { type: 'string' },
        label: { type: 'string' },
        tabId: { type: 'number' },
        page: { type: 'object', additionalProperties: true },
      }),
      render: (_args, value) =>
        renderText(
          `Clicked at (${value.x}, ${value.y}) on <${value.tag || 'unknown'}> ${JSON.stringify(value.label || '')}${value.page ? '\n[page snapshot attached]' : ''}`,
        ),
    },
    async execute(args, exec) {
      await guard(exec, 'chrome_click_at', `click at ${args?.x},${args?.y}`, { tabId: args?.tabId })
      return call('tab.clickAt', {
        x: args?.x,
        y: args?.y,
        button: args?.button,
        clickCount: args?.clickCount,
        snapshot: Boolean(args?.snapshot),
        dialog: args?.dialog,
        tabId: args?.tabId,
        owner: ownerOf(exec),
      })
    },
  }

  const type = {
    name: 'chrome_type',
    mutating: true,
    description:
      'Type text into the input/textarea with the given snapshot ref number (React/Vue-safe). Set replace to clear first, submit to submit the owning form. The page is not re-snapshotted automatically.',
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'number', description: 'Control number from the latest chrome_snapshot.' },
        selector: { type: 'string', description: 'CSS selector alternative to ref (used when ref is omitted).' },
        frameRef: { type: 'string', description: 'Iframe handle from chrome_snapshot frames, e.g. "f749ABB6B:2" (takes precedence over ref).' },
        text: { type: 'string', description: 'Text to enter.' },
        replace: { type: 'boolean', description: 'Replace the existing value instead of appending.' },
        submit: { type: 'boolean', description: 'Submit the form after typing.' },
        snapshot: {
          type: 'boolean',
          description: 'Attach a fresh page snapshot to the result (saves a separate chrome_snapshot roundtrip).',
        },
        dialog: {
          type: 'object',
          description:
            'How to answer a JS dialog (confirm/prompt/beforeunload) triggered by this action. Default: dismiss. Set accept:true to accept; promptText fills a prompt.',
          properties: {
            accept: { type: 'boolean' },
            promptText: { type: 'string' },
          },
          additionalProperties: false,
        },
        tabId: { type: 'number', description: 'Optional tab id owned by this session.' },
      },
      required: ['text'],
      additionalProperties: false,
    },
    output: {
      schema: outputSchema({
        ok: { type: 'boolean' },
        submitted: { type: 'boolean' },
        tabId: { type: 'number' },
        dialogs: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string' },
              message: { type: 'string' },
              accepted: { type: 'boolean' },
            },
            additionalProperties: true,
          },
        },
        page: { type: 'object', additionalProperties: true },
      }),
      render: (_args, value) =>
        renderText(
          `Typed into field${value.submitted ? ' and submitted the form' : ''}${value.page ? '\n[page snapshot attached]' : ''}`,
        ),
    },
    async execute(args, exec) {
      const site = await guard(exec, 'chrome_type', `type into ref ${args?.ref}`, { tabId: args?.tabId })
      const typeOnce = (sensitiveApproved) =>
        call('tab.type', {
          ref: args?.ref,
          selector: args?.selector,
          frameRef: args?.frameRef,
          text: String(args?.text ?? ''),
          replace: Boolean(args?.replace),
          submit: Boolean(args?.submit),
          snapshot: Boolean(args?.snapshot),
          dialog: args?.dialog,
          tabId: args?.tabId,
          owner: ownerOf(exec),
          sensitiveApproved,
        })
      let result
      try {
        result = await typeOnce(false)
      } catch (error) {
        // The backend refuses before focus/value write. Ask the human, then
        // retry exactly once with the per-call approval flag. Any other error
        // (including a denied/timed-out confirmation) propagates unchanged.
        if (error?.code !== 'SENSITIVE_FIELD') throw error
        await confirmSensitiveInput(exec, 'chrome_type', site, '输入文本')
        result = await typeOnce(true)
      }
      // Typed text can be a password, OTP or card number, so the field value
      // must never reach the model. The driver/extension still return it for
      // their own probes; the tool contract deliberately does not.
      if (!result || typeof result !== 'object') return result
      const { value: _fieldValue, field: _fieldInfo, ...safe } = result
      return safe
    },
  }

  const press = {
    name: 'chrome_press',
    mutating: true,
    description:
      'Dispatch a keyboard key (Enter, Tab, Escape, ArrowUp/Down/Left/Right, PageUp/PageDown, Home/End, or a single character) to the focused element on the current DSH session page.',
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Key to press, e.g. Enter or Escape.' },
        snapshot: {
          type: 'boolean',
          description: 'Attach a fresh page snapshot to the result (saves a separate chrome_snapshot roundtrip).',
        },
        dialog: {
          type: 'object',
          description:
            'How to answer a JS dialog (confirm/prompt/beforeunload) triggered by this action. Default: dismiss. Set accept:true to accept; promptText fills a prompt.',
          properties: {
            accept: { type: 'boolean' },
            promptText: { type: 'string' },
          },
          additionalProperties: false,
        },
        tabId: { type: 'number', description: 'Optional tab id owned by this session.' },
      },
      required: ['key'],
      additionalProperties: false,
    },
    output: {
      schema: outputSchema({ ok: { type: 'boolean' }, key: { type: 'string' }, target: { type: 'string' },
        dialogs: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string' },
              message: { type: 'string' },
              accepted: { type: 'boolean' },
            },
            additionalProperties: true,
          },
        },
        page: { type: 'object', additionalProperties: true },
      }),
      render: (_args, value) => renderText(`Pressed ${value.key} on <${value.target}>${value.page ? '\n[page snapshot attached]' : ''}`),
    },
    async execute(args, exec) {
      const site = await guard(exec, 'chrome_press', `press ${args?.key}`, { tabId: args?.tabId })
      const pressOnce = (sensitiveApproved) =>
        call('tab.press', {
          key: String(args?.key ?? ''),
          snapshot: Boolean(args?.snapshot),
          dialog: args?.dialog,
          tabId: args?.tabId,
          owner: ownerOf(exec),
          sensitiveApproved,
        })
      let result
      try {
        result = await pressOnce(false)
      } catch (error) {
        if (error?.code !== 'SENSITIVE_FIELD') throw error
        await confirmSensitiveInput(exec, 'chrome_press', site, '按键')
        result = await pressOnce(true)
      }
      if (!result || typeof result !== 'object') return result
      const { field: _fieldInfo, ...safe } = result
      return safe
    },
  }

  const scroll = {
    name: 'chrome_scroll',
    mutating: true,
    description:
      'Scroll the current DSH session page: direction up/down/top/bottom, optional pixel amount (default 600). Returns the resulting scroll position.',
    parameters: {
      type: 'object',
      properties: {
        snapshot: {
          type: 'boolean',
          description: 'Attach a fresh page snapshot to the result (saves a separate chrome_snapshot roundtrip).',
        },
        direction: { type: 'string', enum: ['up', 'down', 'top', 'bottom'] },
        amount: { type: 'number', description: 'Pixels to scroll for up/down (default 600).' },
        tabId: { type: 'number', description: 'Optional tab id owned by this session.' },
      },
      required: ['direction'],
      additionalProperties: false,
    },
    output: {
      schema: outputSchema({
        ok: { type: 'boolean' },
        y: { type: 'number' },
        viewportHeight: { type: 'number' },
        documentHeight: { type: 'number' },
        page: { type: 'object', additionalProperties: true },
      }),
      render: (_args, value) =>
        renderText(`Scrolled to y=${value.y} (viewport ${value.viewportHeight}, document ${value.documentHeight})${value.page ? '\n[page snapshot attached]' : ''}`),
    },
    async execute(args, exec) {
      return call('tab.scroll', {
        direction: String(args?.direction ?? 'down'),
        amount: args?.amount,
        snapshot: Boolean(args?.snapshot),
        tabId: args?.tabId,
        owner: ownerOf(exec),
      })
    },
  }

  const upload = {
    name: 'chrome_upload',
    mutating: true,
    description:
      'Attach local files to a file input on the session page (e.g. upload a screenshot or a document). The ref must point at an <input type=file> from the latest snapshot. Files must live under the session working directory (or DSH_CHROME_UPLOAD_ROOTS), and every call asks for a hard confirmation that lists the full paths and the target origin.',
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'number', description: 'Ref of the file input element.' },
        selector: { type: 'string', description: 'CSS selector alternative to ref (used when ref is omitted).' },
        files: {
          type: 'array',
          items: { type: 'string' },
          description: 'Absolute local file paths to attach.',
        },
        tabId: { type: 'number', description: 'Optional tab id owned by this session.' },
      },
      required: ['files'],
      additionalProperties: false,
    },
    output: {
      schema: outputSchema({
        ok: { type: 'boolean' },
        ref: {},
        selector: {},
        files: { type: 'number' },
      }),
      render: (_args, value) =>
        renderText(`Attached ${value.files} file(s) to ${value.ref != null ? `ref ${value.ref}` : `selector ${value.selector}`}`),
    },
    async execute(args, exec) {
      const ref = Number(args?.ref)
      const selector = args?.selector ? String(args.selector) : ''
      if (!Number.isFinite(ref) && !selector) throw new BridgeError('INVALID_ARGUMENT', 'ref or selector is required')
      const files = Array.isArray(args?.files) ? args.files.map(String) : []
      if (files.length === 0) throw new BridgeError('INVALID_ARGUMENT', 'files must be a non-empty array')
      for (const file of files) {
        const stat = await fsp.stat(file).catch(() => null)
        if (!stat?.isFile()) throw new BridgeError('INVALID_ARGUMENT', `not a file: ${file}`)
      }
      // Ordinary site policy first (blocked sites never prompt), then the
      // path allowlist, then an unconditional per-call hard confirmation that
      // names the full paths and the target origin (R-04).
      const site = await guard(exec, 'chrome_upload', `upload ${files.length} file(s) to ref ${ref}`, {
        tabId: args?.tabId,
      })
      await assertUploadAllowed(exec, files, site)
      await hardConfirmAsk(exec, 'chrome_upload', {
        header: '上传本机文件',
        question: `允许把以下 ${files.length} 个本机文件交给页面 ${site?.origin || site?.url || '(unknown page)'} 吗？\n\n${files.map((file) => `• ${file}`).join('\n')}`,
        detail:
          '文件会通过 DOM.setFileInputFiles 附加到页面上的文件输入框；页面在 change 事件里可以立即读取并上传它们，操作不可撤销。',
        timeoutMs: evaluateConfirmTimeoutMs,
        site,
      })
      const value = await call(
        'tab.upload',
        { ref: Number.isFinite(ref) ? ref : undefined, selector, files, tabId: args?.tabId, owner: ownerOf(exec) },
        60000,
      )
      if (!value) throw new BridgeError('INTERNAL', 'extension returned no upload result')
      return value
    },
  }

  return { select, drag, hover, click, clickAt, type, press, scroll, upload }
}
