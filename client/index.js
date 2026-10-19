/**
 * dsh-desktop-chrome — DSH browser-side half (A0 spike).
 *
 * This file is the bundle DSH serves for `dsh.client`; it is intentionally a
 * loader script, not an ES module. The Host scans this package's manifest,
 * serves this file under `/plugins/<package>/client.js`, and the browser
 * executes it once at plugin activation. Only then is `factory` registered;
 * module side effects (including this factory body) run when DSH materializes
 * the plugin.
 *
 * A0 scope: prove that a third-party client plugin can register a right-side
 * sidebar tab (`kind: "dsh-chrome"`) and render a minimal placeholder. It does
 * NOT embed an iframe, talk to the Host, fetch frames, or control a browser.
 * Keep the factory body free of DOM access so the bundle can be VM-tested.
 *
 * The bundle only requires `react`, which is part of DSH's frozen shared module
 * table (`PLATFORM_MODULES` in the DSH Web frontend). Do not add a non-baseline
 * import here without also declaring it in `dsh.client.external`.
 */
window.__ModuleLoader__.load({
  id: 'dsh-desktop-chrome',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    // Tab type identity. The id is the key for the body/title slots and must be
    // unique across every registration; the kind is what `openTab` and the
    // guide use.
    const TAB_ID = 'dsh-desktop-chrome/native-browser'
    const TAB_KIND = 'dsh-chrome'
    const LOCALE_NS = 'dshChrome'

    const zh = {
      'type.title': 'DSH Chrome',
      'guide.title': 'DSH Chrome',
      'guide.description': '隔离浏览器的原生右栏面板（A0 占位）',
      'body.title': 'DSH Chrome sidebar spike',
      'body.subtitle': '原生右栏 tab 已注册；当前只显示占位内容。',
      'body.noFrame': '不嵌 iframe，也不控制浏览器。',
      'body.status': 'A0 · 未连接浏览器 context',
      'body.session': '会话',
    }

    const en = {
      'type.title': 'DSH Chrome',
      'guide.title': 'DSH Chrome',
      'guide.description': 'Native right-side panel for an isolated browser (A0 placeholder)',
      'body.title': 'DSH Chrome sidebar spike',
      'body.subtitle': 'The native right-side tab is registered; this is placeholder content only.',
      'body.noFrame': 'No iframe and no browser control are wired yet.',
      'body.status': 'A0 · no browser context attached',
      'body.session': 'Session',
    }

    /** Inline 16px glyph; the guide and the tab title both use it. */
    function DshChromeIcon() {
      return h(
        'svg',
        {
          width: 16,
          height: 16,
          viewBox: '0 0 16 16',
          fill: 'none',
          'aria-hidden': 'true',
          style: { flex: 'none' },
        },
        h('rect', {
          x: 1.5,
          y: 2.5,
          width: 13,
          height: 11,
          rx: 2,
          stroke: 'currentColor',
          strokeWidth: 1.2,
        }),
        h('path', { d: 'M1.5 5.5h13', stroke: 'currentColor', strokeWidth: 1.2 }),
        h('circle', { cx: 3.8, cy: 4, r: 0.55, fill: 'currentColor' }),
        h('circle', { cx: 5.6, cy: 4, r: 0.55, fill: 'currentColor' }),
      )
    }

    const styles = {
      root: {
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: 0,
        color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-bg-base)',
        font: 'var(--dsw-font-xs-13)',
      },
      header: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 8,
        flex: 'none',
        padding: '10px 12px',
        borderBottom: '0.5px solid var(--dsw-alias-border-l3)',
      },
      heading: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        minWidth: 0,
        fontWeight: 500,
      },
      badge: {
        flex: 'none',
        padding: '1px 6px',
        borderRadius: 999,
        color: 'var(--dsw-alias-label-tertiary)',
        background: 'var(--dsw-alias-bg-layer-2)',
        font: 'var(--dsw-font-xxxs-11)',
      },
      body: {
        flex: 'auto',
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        padding: 24,
        textAlign: 'center',
      },
      lead: {
        margin: 0,
        color: 'var(--dsw-alias-label-secondary)',
      },
      note: {
        margin: 0,
        color: 'var(--dsw-alias-label-tertiary)',
        font: 'var(--dsw-font-xxs-12)',
      },
      meta: {
        margin: 0,
        color: 'var(--dsw-alias-label-quaternary)',
        font: 'var(--dsw-font-xxxs-11)',
      },
      footer: {
        flex: 'none',
        padding: '4px 12px',
        borderTop: '0.5px solid var(--dsw-alias-border-l3)',
        color: 'var(--dsw-alias-label-quaternary)',
        font: 'var(--dsw-font-xxxs-11)',
      },
      title: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        minWidth: 0,
      },
      titleLabel: {
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
    }

    /**
     * Tab body for the spike. It deliberately has no hooks and no DOM access:
     * the slot runtime supplies `t` (from the `locale` field on the slot
     * registration) and `sessionId` (from `inject`). Everything else is static
     * placeholder content.
     */
    function NativePanelBody(props) {
      const t = typeof props.t === 'function' ? props.t : (key) => key
      const sessionId = typeof props.sessionId === 'string' ? props.sessionId : ''
      const shortSession = sessionId.length > 12 ? `${sessionId.slice(0, 8)}…` : sessionId
      return h(
        'div',
        {
          className: 'dshc-spike',
          style: styles.root,
          'data-dsh-chrome-spike': 'placeholder',
        },
        h(
          'div',
          { style: styles.header },
          h(
            'span',
            { style: styles.heading },
            h(DshChromeIcon),
            h('span', null, t('body.title')),
          ),
          h('span', { style: styles.badge }, 'A0'),
        ),
        h(
          'div',
          { style: styles.body },
          h(
            'span',
            { style: { color: 'var(--dsw-alias-label-tertiary)' } },
            h(DshChromeIcon),
          ),
          h('p', { style: styles.lead }, t('body.subtitle')),
          h('p', { style: styles.note }, t('body.noFrame')),
          sessionId === ''
            ? null
            : h('p', { style: styles.meta }, `${t('body.session')}: ${shortSession}`),
        ),
        h('div', { style: styles.footer }, t('body.status')),
      )
    }

    /** Tab chip (title slot). The sidebar keeps the tab record's DOM markers. */
    function NativePanelTitle(props) {
      const t = typeof props.t === 'function' ? props.t : (key) => key
      return h(
        'span',
        { style: styles.title },
        h(DshChromeIcon),
        h('span', { style: styles.titleLabel }, t('type.title')),
      )
    }

    // The client Loader waits for these services before calling `apply`. A0
    // only needs the tab registry, locale, and slots; A must add `connection`
    // (and `sidebarRight` if the body starts using the navigation controller).
    const inject = ['slots', 'locale', 'sidebarRightTabs']

    /**
     * Register the tab type, its guide entry, and its body/title slots.
     * Every registration is owned by a `ctx.effect`, so disabling the plugin
     * removes the tab type and slot cells without leaving stale entries.
     */
    function apply(ctx) {
      const t = ctx.locale.bind(LOCALE_NS)

      ctx.effect(
        () => ctx.locale.register(LOCALE_NS, { zh, en }),
        'dsh-chrome: native sidebar dictionaries',
      )

      ctx.effect(
        () =>
          ctx.sidebarRightTabs.register({
            id: TAB_ID,
            kind: TAB_KIND,
            // Third-party tab types default to the `extension` band; naming it
            // here documents that this is not a builtin replacement.
            priority: 'extension',
            // A/B: one panel per session; C flips this to true.
            multiple: false,
            // Keep the visited body while switching tabs/panes; the real body
            // must stop polling when `tab.visible` becomes false.
            keepMounted: true,
            title: () => t('type.title'),
            guide: [
              {
                id: 'open',
                order: 40,
                title: () => t('guide.title'),
                description: () => t('guide.description'),
                icon: DshChromeIcon,
              },
            ],
          }),
        'dsh-chrome: native sidebar tab type',
      )

      // `slots.inject` defers registration until the sidebar's slot exists, so
      // load order relative to `@deepseek-ai/dsh-client-ui-sidebar-right` is not
      // a startup race. The key must equal the tab definition id.
      ctx.effect(
        () =>
          ctx.slots.inject(
            'sidebar.right.pane.tab',
            () =>
              ctx.slots.register(
                {
                  name: 'sidebar.right.pane.tab',
                  key: TAB_ID,
                  locale: LOCALE_NS,
                  inject: (sessionId) => ({ sessionId }),
                },
                NativePanelBody,
              ),
          ),
        'dsh-chrome: native sidebar body',
      )

      ctx.effect(
        () =>
          ctx.slots.inject(
            'sidebar.right.pane.tab.title',
            () =>
              ctx.slots.register(
                {
                  name: 'sidebar.right.pane.tab.title',
                  key: TAB_ID,
                  locale: LOCALE_NS,
                },
                NativePanelTitle,
              ),
          ),
        'dsh-chrome: native sidebar title',
      )
    }

    const exports = {}
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    exports.apply = apply
    exports.inject = inject
    return exports
  },
})
