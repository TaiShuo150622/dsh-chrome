/**
 * chrome_headless_login tool: open a visible, dedicated Chrome window on the
 * headless profile for human-interaction steps (login/CAPTCHA/payment/OTP) and
 * later resume the page headlessly. Extracted from tools.js so the confirmation
 * wording, schema and driver handoff live in one small file.
 */
import { BridgeError } from './bridge.js'

export function createLoginTool({ bridge, contexts = null, ownerOf = null, hardConfirmAsk, evaluateConfirmTimeoutMs, outputSchema, renderText }) {
  // The provider passes a BackendRouter, whose `headless` route is a
  // HeadlessContextRouter without login methods (C4). The visible window
  // belongs to one owned browser context, so resolve that context's driver
  // when a context manager is wired; the legacy single-driver shape stays as
  // the fallback for embedded/test providers.
  function resolveDriver(args, exec) {
    if (contexts && typeof contexts.activeFor === 'function') {
      const owner = typeof ownerOf === 'function' ? ownerOf(exec) : 'default'
      const requestedId = args?.contextId != null ? String(args.contextId) : ''
      const owned = requestedId
        ? (typeof contexts.getOwned === 'function' ? contexts.getOwned(requestedId, owner) : contexts.get(requestedId))
        : contexts.activeFor(owner)
      if (!owned) {
        throw new BridgeError(
          requestedId ? 'CONTEXT_NOT_FOUND' : 'NO_ACTIVE_CONTEXT',
          requestedId
            ? `context ${requestedId} is not owned by this session`
            : 'no active headless context; open one with chrome_context {op:"create"} or a backend:"headless" call first',
        )
      }
      const driver = typeof contexts.driverForOwned === 'function'
        ? contexts.driverForOwned(owned.contextId, owner)
        : contexts.driverFor(owned.contextId)
      if (!driver || typeof driver.loginStart !== 'function') {
        throw new BridgeError('UNSUPPORTED_BACKEND', 'this browser context does not support an interactive login window')
      }
      return driver
    }
    const legacy = bridge?.headless
    if (legacy && typeof legacy.loginStart === 'function') return legacy
    throw new BridgeError('UNSUPPORTED_BACKEND', 'this provider has no headless driver (headless is unavailable)')
  }

  return {
    name: 'chrome_headless_login',
    description:
      'Open a visible, dedicated Chrome window at a human-interaction step (login, CAPTCHA, payment, OTP) using the headless profile: op="start" opens about:blank, op="show" pauses the current headless session and reopens its current page in a visible window, op="finish" closes the visible window, op="status" reports it. The next backend:"headless" call resumes the page after show/finish. With a context manager the window belongs to this session active headless context, so open one first (chrome_context {op:"create"} or any backend:"headless" call). Requires hard confirmation.',
    parameters: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['start', 'show', 'status', 'finish'] },
        url: { type: 'string', description: 'start/show: http(s) URL (show defaults to the current headless page).' },
        contextId: { type: 'string', description: 'Optional owned context id; defaults to this session active context.' },
      },
      required: ['op'],
      additionalProperties: false,
    },
    output: {
      schema: outputSchema({
        running: { type: 'boolean' },
        alreadyRunning: { type: 'boolean' },
        stopped: { type: 'boolean' },
        visible: { type: 'boolean' },
        pid: {},
        profile: { type: 'string' },
        resumeUrl: { type: 'string' },
        url: { type: 'string' },
      }),
      render: (args, value) => {
        if ((args?.op === 'start' || args?.op === 'show') && value.running) {
          return renderText(
            `Visible browser window opened (pid ${value.pid ?? '?'}) at ${value.url || value.resumeUrl || '(blank)'}; interact there, then call chrome_headless_login {op:"finish"}.\nprofile: ${value.profile}\nThe next backend:"headless" call resumes this page.`,
          )
        }
        if (args?.op === 'finish') {
          return renderText(value.stopped ? `Visible window closed; headless will resume at ${value.resumeUrl || '(blank)'}.` : 'No visible window was open.')
        }
        return renderText(`Visible window: ${value.running ? `open (pid ${value.pid ?? '?'}, ${value.visible ? 'visible' : 'headless'})` : 'closed'}\nprofile: ${value.profile}`)
      },
    },
    async execute(args, exec) {
      const driver = resolveDriver(args, exec)
      const op = String(args?.op || 'status')
      if (op === 'start') {
        await hardConfirmAsk(exec, 'chrome_headless_login', {
          header: '打开可见 Chrome 登录窗口（持久 profile）',
          question: '允许打开一个可见的专用 Chrome 窗口用于一次性登录吗？',
          detail:
            '登录窗口使用 headless 专用 profile（' +
            (driver.loginProfile || '~/.dsh/cache/dsh-chrome/headless/profile') +
            '），cookie/登录态会落在这个 profile 里，之后 backend:"headless" 会复用它；不影响你日常 Chrome。完成登录后务必调用 op:"finish" 关掉窗口。',
          timeoutMs: evaluateConfirmTimeoutMs,
          // Do not resolve browser.site here: a headless lookup would create an
          // about:blank tab and loginStart refuses while any tab is open.
          site: null,
        })
        return driver.loginStart({ url: args?.url })
      }
      if (op === 'show') {
        await hardConfirmAsk(exec, 'chrome_headless_login', {
          header: '把后台浏览器显示到屏幕（人工操作）',
          question: '允许暂停 headless 浏览器，并把当前页面在一个可见 Chrome 窗口中打开，供你手动操作吗？',
          detail: '用于登录/CAPTCHA/支付/OTP 等必须人工的步骤；操作完调用 op:"finish" 关闭可见窗口，下一次 backend:"headless" 调用会回到同一页面。',
          timeoutMs: evaluateConfirmTimeoutMs,
          site: null,
        })
        return driver.showVisible({ url: args?.url })
      }
      if (op === 'finish') return driver.loginFinish()
      return driver.loginStatus()
    },
  }
}
