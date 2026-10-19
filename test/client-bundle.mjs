/**
 * A0 spike guard for the DSH browser-side half.
 *
 * This test does three things:
 *  1. validates the package shape DSH's client-module host scanner requires
 *     (`dsh.client.platform`, `exports["./client"]`, packaged bundle);
 *  2. executes the loader bundle in a VM with a fake `window.__ModuleLoader__`
 *     and a fake Cordis client context, then asserts that it registers
 *     `kind: "dsh-chrome"`, the guide entry, and both right-sidebar slots;
 *  3. renders the body/title components with a tiny React stub and asserts the
 *     placeholder text and the absence of an iframe.
 *
 * It is deliberately a VM test, not a real DSH install: the worktree does not
 * own the live DSH profile. The integration evidence for the DSH host scanner
 * is recorded separately in docs/DSH-SIDEBAR-NATIVE.md.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const clientFile = path.join(root, 'client/index.js')
const source = fs.readFileSync(clientFile, 'utf8')

// --- 1. package/manifest shape -------------------------------------------------

assert.equal(pkg.private, true, 'the spike stays an unpublished provider package')
assert.equal(pkg.dsh?.client?.platform, 'web', 'DSH only loads client halves that declare platform "web"')
assert.ok(
  Array.isArray(pkg.dsh.client.inject) &&
    pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-sidebar-right'),
  'the client half must load after @deepseek-ai/dsh-client-ui-sidebar-right',
)
assert.equal(
  pkg.dsh.client.external,
  undefined,
  'the A0 bundle only uses react (a frozen platform module); it must not declare externals',
)
assert.equal(
  pkg.exports?.['./client'],
  './client/index.js',
  'the host scanner resolves exports["./client"] and serves that file',
)
assert.ok(pkg.files.includes('client/**/*.js'), 'the client bundle must be in the packed files list')
assert.ok(fs.statSync(clientFile).size > 1000, 'client/index.js must be a real bundle, not a stub')

// The bundle is served as a script and executed by __ModuleLoader__; it is not
// imported as ESM. It may only require shared platform modules.
assert.doesNotMatch(source, /^\s*(?:import|export)\s/m, 'client/index.js must not use ESM import/export')
assert.match(source, /window\.__ModuleLoader__\.load\(\{/, 'bundle must call the DSH loader entry point')
assert.match(source, /id:\s*'dsh-desktop-chrome'/, 'bundle id must be the package name')
assert.match(source, /kind:\s*TAB_KIND/, 'tab kind must be registered')
assert.match(source, /const TAB_KIND = 'dsh-chrome'/, 'tab kind must be "dsh-chrome"')
assert.doesNotMatch(source, /<iframe/i, 'the spike must not embed an iframe')
assert.doesNotMatch(source, /\b(?:innerHTML|outerHTML|insertAdjacentHTML)\b/, 'no HTML injection')
assert.doesNotMatch(source, /\beval\s*\(/, 'no eval')
const requires = [...source.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((match) => match[1])
assert.deepEqual(requires, ['react'], 'the A0 bundle may only require the shared react module')

// --- 2. execute the loader bundle in a VM -------------------------------------

const registrations = []
const sandbox = {
  window: {
    __ModuleLoader__: {
      load(registration) {
        registrations.push(registration)
      },
    },
  },
}
vm.runInNewContext(source, sandbox, { filename: 'client/index.js' })
assert.equal(registrations.length, 1, 'the bundle must register exactly one module')
const registration = registrations[0]
assert.equal(registration.id, pkg.name, 'browser module identity must be the package name')

const React = {
  Fragment: Symbol('react.fragment'),
  createElement(type, props, ...children) {
    return {
      type,
      props: {
        ...(props ?? {}),
        children: children.length <= 1 ? children[0] : children,
      },
    }
  },
}
const exports = registration.factory((specifier) => {
  if (specifier === 'react') return React
  throw new Error(`unexpected require("${specifier}") in the A0 client bundle`)
})
assert.equal(typeof exports.apply, 'function', 'the plugin must export apply')
assert.deepEqual(
  Array.from(exports.inject),
  ['slots', 'locale', 'sidebarRightTabs'],
  'the A0 service list',
)

// --- 3. fake Cordis client context -------------------------------------------

function createClientContext() {
  const effects = []
  const localeDictionaries = new Map()
  const tabs = []
  const slots = []
  const injectedSlots = []

  const ctx = {
    effect(fn, label) {
      const dispose = fn()
      let disposed = false
      const disposer = () => {
        if (disposed) return
        disposed = true
        if (typeof dispose === 'function') dispose()
      }
      effects.push({ label, dispose: disposer })
      return disposer
    },
    locale: {
      bind(namespace) {
        return (key) => {
          const dictionaries = localeDictionaries.get(namespace)
          return dictionaries?.en?.[key] ?? dictionaries?.zh?.[key] ?? key
        }
      },
      register(namespace, dictionaries) {
        localeDictionaries.set(namespace, dictionaries)
        return () => localeDictionaries.delete(namespace)
      },
    },
    sidebarRightTabs: {
      register(definition) {
        tabs.push(definition)
        return () => {
          const index = tabs.indexOf(definition)
          if (index !== -1) tabs.splice(index, 1)
        }
      },
    },
    slots: {
      inject(name, factory) {
        injectedSlots.push(name)
        const dispose = factory()
        let disposed = false
        return () => {
          if (disposed) return
          disposed = true
          if (typeof dispose === 'function') dispose()
        }
      },
      register(definition, component) {
        const entry = { definition, component }
        slots.push(entry)
        return () => {
          const index = slots.indexOf(entry)
          if (index !== -1) slots.splice(index, 1)
        }
      },
    },
    logger: {
      info() {},
      warn() {},
      error() {},
    },
  }

  return { ctx, effects, localeDictionaries, tabs, slots, injectedSlots }
}

const client = createClientContext()
exports.apply(client.ctx)

// Locale dictionaries exist for both supported languages.
const dictionaries = client.localeDictionaries.get('dshChrome')
assert.ok(dictionaries?.zh && dictionaries?.en, 'the dshChrome namespace must register zh and en')
for (const key of [
  'type.title',
  'guide.title',
  'guide.description',
  'body.title',
  'body.subtitle',
  'body.noFrame',
  'body.status',
]) {
  assert.equal(typeof dictionaries.zh[key], 'string', `zh.${key} must be a string`)
  assert.equal(typeof dictionaries.en[key], 'string', `en.${key} must be a string`)
}
assert.equal(dictionaries.en['body.title'], 'DSH Chrome sidebar spike')

// Tab type definition.
assert.equal(client.tabs.length, 1, 'one tab type must be registered')
const tab = client.tabs[0]
assert.equal(tab.id, 'dsh-desktop-chrome/native-browser', 'tab type id is the slot key')
assert.equal(tab.kind, 'dsh-chrome', 'tab kind is what openTab/guide use')
assert.equal(tab.priority, 'extension', 'third-party types live in the extension band')
assert.equal(tab.multiple, false, 'A/B use one panel per session')
assert.equal(tab.keepMounted, true, 'the body stays mounted across pane switches')
assert.equal(tab.title(), 'DSH Chrome', 'tab chip title')
assert.equal(tab.guide.length, 1, 'one guide entry opens the spike')
const guide = tab.guide[0]
assert.equal(guide.id, 'open')
assert.equal(guide.order, 40)
assert.equal(guide.title(), 'DSH Chrome')
assert.equal(typeof guide.description(), 'string')
const guideIcon = guide.icon()
assert.equal(guideIcon.type, 'svg', 'the guide entry must contribute an inline SVG icon')

// Body and title slots.
assert.deepEqual(client.injectedSlots, ['sidebar.right.pane.tab', 'sidebar.right.pane.tab.title'])
assert.equal(client.slots.length, 2, 'body and title slots must both be registered')
const bodySlot = client.slots.find((entry) => entry.definition.name === 'sidebar.right.pane.tab')
const titleSlot = client.slots.find((entry) => entry.definition.name === 'sidebar.right.pane.tab.title')
assert.ok(bodySlot, 'sidebar.right.pane.tab must be registered')
assert.ok(titleSlot, 'sidebar.right.pane.tab.title must be registered')
assert.equal(bodySlot.definition.key, tab.id, 'body slot key must equal the tab type id')
assert.equal(titleSlot.definition.key, tab.id, 'title slot key must equal the tab type id')
assert.equal(typeof bodySlot.definition.inject, 'function', 'the body gets the session id through inject')
assert.equal(
  bodySlot.definition.inject('sess-a0', {}).sessionId,
  'sess-a0',
  'inject passes the session id to the body',
)

// Render the placeholder body with the real prop shape (plus a fake t).
const t = (key) => dictionaries.en[key] ?? key
const bodyElement = bodySlot.component({
  ...bodySlot.definition.inject('sess-a0', {}),
  t,
  useTabInfo: () => ({ tab: { id: 'tab-1', visible: true } }),
})
assert.equal(bodyElement.type, 'div')
assert.equal(bodyElement.props['data-dsh-chrome-spike'], 'placeholder')

function collectText(node, out = []) {
  if (node == null || node === false) return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    for (const child of node) collectText(child, out)
    return out
  }
  if (typeof node === 'object' && node.props) collectText(node.props.children, out)
  return out
}
function findElement(node, type) {
  if (node == null || typeof node !== 'object') return undefined
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElement(child, type)
      if (found !== undefined) return found
    }
    return undefined
  }
  if (node.type === type) return node
  return findElement(node.props?.children, type)
}

const bodyText = collectText(bodyElement).join(' ')
assert.match(bodyText, /DSH Chrome sidebar spike/, 'the body must show the spike title')
assert.match(bodyText, /placeholder content only/, 'the body must say it is a placeholder')
assert.match(bodyText, /No iframe and no browser control/, 'the body must state the A0 boundary')
assert.match(bodyText, /Session: sess-a0/, 'the injected session id is displayed')
assert.equal(findElement(bodyElement, 'iframe'), undefined, 'the rendered body must not contain an iframe')

const titleElement = titleSlot.component({
  t,
  useTabInfo: () => ({ tab: { id: 'tab-1', visible: true } }),
})
assert.equal(titleElement.type, 'span')
assert.match(collectText(titleElement).join(' '), /DSH Chrome/, 'the title chip shows the type name')

// --- 4. cleanup: plugin unload removes every contribution ---------------------

for (const effect of client.effects.toReversed()) effect.dispose()
assert.deepEqual(client.tabs, [], 'tab type registration must be disposed')
assert.deepEqual(client.slots, [], 'slot registrations must be disposed')
assert.equal(client.localeDictionaries.size, 0, 'locale dictionaries must be disposed')

// Disposing twice is a no-op (Cordis effect disposers are idempotent).
for (const effect of client.effects.toReversed()) effect.dispose()

// A second activation in a fresh context must not throw or cache state.
const second = createClientContext()
exports.apply(second.ctx)
assert.equal(second.tabs.length, 1)
assert.equal(second.slots.length, 2)

console.log('CLIENT BUNDLE TEST: PASS')
