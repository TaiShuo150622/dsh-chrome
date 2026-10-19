// Main-world console capture for chrome_console.
//
// Runs at document_start before page scripts. Keeps a small ring buffer of
// console calls plus uncaught errors so the agent can read what a page logged
// without attaching a long-lived debugger session.
;(() => {
  if (window.__dshConsole) return

  const MAX_ENTRIES = 500
  const MAX_ENTRY_CHARS = 2000
  const entries = []

  const format = (value) => {
    if (typeof value === 'string') return value
    if (value instanceof Error) return `${value.name}: ${value.message}`
    try {
      return JSON.stringify(value)
    } catch {
      return String(value)
    }
  }

  const push = (level, args) => {
    try {
      entries.push({
        level,
        text: args.map(format).join(' ').slice(0, MAX_ENTRY_CHARS),
        time: Date.now(),
      })
      if (entries.length > MAX_ENTRIES) entries.shift()
    } catch {
      // capture must never break the page
    }
  }

  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    const original = console[level]
    if (typeof original !== 'function') continue
    console[level] = (...args) => {
      push(level, args)
      return original.apply(console, args)
    }
  }

  window.addEventListener(
    'error',
    (event) => push('error', [event.message, `${event.filename || ''}:${event.lineno || 0}`]),
    true,
  )
  window.addEventListener('unhandledrejection', (event) => push('error', ['Unhandled rejection', String(event.reason)]))

  Object.defineProperty(window, '__dshConsole', {
    value: {
      entries,
      clear() {
        entries.length = 0
      },
    },
    enumerable: false,
    configurable: true,
  })
})()
