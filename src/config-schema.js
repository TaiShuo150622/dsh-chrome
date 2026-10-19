/**
 * DSH plugin Config schema for the settings MVP.
 *
 * DSH's Loader and settings service consume the native schemastery graph
 * protocol: `Config[Symbol.for('schemastery')] === true`, `type`, `meta`,
 * `dict`/`list`/`inner`, `toJSON()` and `simplify()`. `Config.listConfigs`
 * projects the same graph into JSON Schema 2020-12, and the generated settings
 * form edits only nodes marked `meta.volatile`.
 *
 * This module builds that narrow protocol locally instead of importing
 * `@deepseek-ai/schemastery`. The provider is normally loaded from a linked
 * source tree where DSH's own dependencies are not resolvable (see
 * `cordis.patch.yml`), and CI runs `npm test` without an install step. The
 * emitted graph and `toJSON()` are the exact shapes the real schemastery
 * reconstructs. `test/settings.mjs` asserts the reconstructable graph shape
 * without importing DSH; when this module landed, `toJSON()` was also rebuilt
 * offline with the installed DSH desktop runtime's bundled schemastery. Do not
 * add a second schema library here.
 *
 * Fail-soft is deliberate: validation never throws and never returns
 * `issues`. Invalid or unknown input is dropped/replaced with the schema
 * default and reported through the non-enumerable CONFIG_WARNINGS symbol,
 * which `index.js` logs. DSH must not refuse to mount the provider because a
 * profile patch has a typo.
 */
import { isDeepStrictEqual } from 'node:util'

import { SETTING_SPECS } from './settings.js'

const K_SCHEMA = Symbol.for('schemastery')
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')
export const CONFIG_WARNINGS = Symbol('dsh-chrome.config-warnings')

const SECRET_KEY = /(password|passwd|secret|token|api[-_]?key|credential|private[-_]?key)/i
let nextUid = 1

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const isNullable = (value) => value === undefined || value === null
const isVolatileValue = (value) => Boolean(value) && typeof value === 'object' && VOLATILE_WRITE in value

class Schema {
  constructor(type, options = {}) {
    this.type = type
    this.uid = nextUid++
    this.meta = { ...(options.meta || {}) }
    if (options.dict) this.dict = options.dict
    if (options.list) this.list = options.list
    if (options.inner) this.inner = options.inner
    if (Object.hasOwn(options, 'value')) this.value = options.value
    if (type === 'object' || type === 'dict') this.meta.default ??= {}
  }

  extra(key, value) {
    this.meta = { ...this.meta, [key]: value }
    return this
  }

  default(value) {
    return this.extra('default', value)
  }

  description(value) {
    return this.extra('description', value)
  }

  volatile() {
    if (this.meta.volatile) throw new TypeError('volatile schema is already wrapped')
    return this.extra('volatile', true)
  }

  min(value) {
    return this.extra('min', value)
  }

  max(value) {
    return this.extra('max', value)
  }

  step(value) {
    return this.extra('step', value)
  }

  get ['~standard']() {
    return Object.freeze({
      version: 1,
      vendor: 'schemastery',
      validate: (raw) => {
        const warnings = []
        const value = resolveNode(this, raw, [], warnings)
        if (isPlainObject(value)) {
          try {
            Object.defineProperty(value, CONFIG_WARNINGS, {
              value: warnings,
              enumerable: false,
              configurable: true,
            })
          } catch {
            // A frozen root would only lose the warning channel, not fail.
          }
        }
        return { value }
      },
    })
  }

  toJSON() {
    return serialize(this)
  }

  simplify(value) {
    return simplifyNode(this, value)
  }
}

Schema.prototype[K_SCHEMA] = true

function object(dict) {
  return new Schema('object', { dict })
}

function boolean() {
  return new Schema('boolean')
}

function natural() {
  return new Schema('number', { meta: { step: 1, min: 0 } })
}

function union(values) {
  return new Schema('union', {
    list: values.map((value) => new Schema('const', { value, meta: { required: true } })),
  })
}

function buildField(spec) {
  let node
  switch (spec.type) {
    case 'enum':
      node = union(spec.values)
      break
    case 'boolean':
      node = boolean()
      break
    case 'integer':
      node = natural().min(spec.min).max(spec.max).step(spec.step ?? 1)
      break
    default:
      throw new TypeError(`unsupported setting type: ${spec.type}`)
  }
  node.default(spec.default)
  if (spec.description) node.description(spec.description)
  if (spec.volatile) node.volatile()
  return node
}

function buildConfig() {
  const tree = {}
  for (const [dotted, spec] of Object.entries(SETTING_SPECS)) {
    const parts = dotted.split('.')
    let dict = tree
    for (const part of parts.slice(0, -1)) {
      dict[part] ??= {}
      dict = dict[part]
    }
    dict[parts.at(-1)] = buildField(spec)
  }
  const convert = (dict) =>
    Object.fromEntries(
      Object.entries(dict).map(([key, value]) => [key, value instanceof Schema ? value : object(convert(value))]),
    )
  return object(convert(tree))
}

/** Plugin Config export consumed by DSH. */
export const Config = buildConfig()

function formatPath(path) {
  return path.length ? path.join('.') : '(root)'
}

function warn(warnings, path, message) {
  warnings.push(`${formatPath(path)}: ${message}`)
}

/**
 * Resolve one Config node, wrapping only the nodes marked volatile. Returns the
 * schema default for missing/invalid input and records a warning for explicit
 * invalid input.
 */
function resolveNode(node, raw, path, warnings) {
  const resolved = resolve(node, raw, path, warnings)
  if (!node.meta.volatile || resolved === undefined) return resolved
  return createVolatile(resolved)
}

function resolve(node, raw, path, warnings) {
  const explicit = raw !== undefined
  let value = raw
  if (value === null) value = undefined

  if (node.type === 'object') {
    let source = value
    if (source === undefined) source = {}
    else if (!isPlainObject(source)) {
      warn(warnings, path, `expected object; using defaults`)
      source = {}
    }
    const result = {}
    for (const [key, child] of Object.entries(node.dict)) {
      const childPath = [...path, key]
      const present = isPlainObject(source) && Object.hasOwn(source, key)
      const resolved = resolveNode(child, present ? source[key] : undefined, childPath, warnings)
      if (resolved !== undefined) result[key] = resolved
    }
    for (const key of Object.keys(source)) {
      if (Object.hasOwn(node.dict, key)) continue
      if (SECRET_KEY.test(key)) warn(warnings, [...path, key], 'ignored secret-shaped key')
      else warn(warnings, [...path, key], 'ignored unknown key')
    }
    return result
  }

  if (node.type === 'union') {
    for (const child of node.list) if (child.type === 'const' && Object.is(value, child.value)) return value
    if (explicit && value !== undefined) {
      warn(warnings, path, `invalid value ${JSON.stringify(value)}; using ${JSON.stringify(node.meta.default)}`)
    }
    return node.meta.default
  }

  if (node.type === 'number') {
    const spec = node.meta
    const valid =
      typeof value === 'number' &&
      Number.isInteger(value) &&
      value >= (spec.min ?? -Infinity) &&
      value <= (spec.max ?? Infinity) &&
      (!spec.step || (value - (spec.min ?? 0)) % spec.step === 0)
    if (!valid) {
      if (explicit && value !== undefined) warn(warnings, path, `invalid value ${JSON.stringify(value)}; using ${spec.default}`)
      return spec.default
    }
    return value
  }

  if (node.type === 'boolean') {
    if (typeof value !== 'boolean') {
      if (explicit && value !== undefined) warn(warnings, path, `invalid value ${JSON.stringify(value)}; using ${node.meta.default}`)
      return node.meta.default
    }
    return value
  }

  if (node.type === 'const') return node.value
  return value
}

function snapshot(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(snapshot))
  if (isPlainObject(value)) {
    return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, child]) => [key, snapshot(child)])))
  }
  return value
}

function createVolatile(value) {
  let current = snapshot(value)
  return Object.freeze({
    get: () => current,
    [VOLATILE_WRITE]: (next) => {
      current = snapshot(next)
    },
  })
}

function serialize(root) {
  const refs = {}
  const visit = (node) => {
    if (refs[node.uid] !== undefined) return node.uid
    const data = {
      type: node.type,
      meta: JSON.parse(JSON.stringify(node.meta)),
    }
    if (node.dict) {
      data.dict = {}
      for (const [key, child] of Object.entries(node.dict)) data.dict[key] = visit(child)
    }
    if (node.list) data.list = node.list.map(visit)
    if (node.inner) data.inner = visit(node.inner)
    if (Object.hasOwn(node, 'value')) data.value = node.value
    refs[node.uid] = data
    return node.uid
  }
  const uid = visit(root)
  return { uid, refs }
}

function simplifyNode(node, value) {
  if (isVolatileValue(value)) value = value.get()
  if (isNullable(value)) return value
  if (isDeepStrictEqual(value, node.meta.default)) return null

  if (node.type === 'object' || node.type === 'dict') {
    const result = {}
    for (const [key, childValue] of Object.entries(value)) {
      const child = node.type === 'object' ? node.dict[key] : node.inner
      const item = child ? simplifyNode(child, childValue) : childValue
      if (node.type === 'dict' || (item !== null && item !== undefined)) result[key] = item
    }
    if (isDeepStrictEqual(result, node.meta.default)) return null
    return result
  }

  if (node.type === 'union') {
    for (const child of node.list) if (child.type === 'const' && Object.is(value, child.value)) return value
    return value
  }

  return value
}

/** Warnings recorded by the most recent validation of one plugin config. */
export function pluginConfigWarnings(value) {
  const warnings = value?.[CONFIG_WARNINGS]
  return Array.isArray(warnings) ? [...warnings] : []
}

/** Validate a raw plugin config (exported for tests and diagnostics). */
export function validatePluginConfig(raw) {
  return Config['~standard'].validate(raw)
}
