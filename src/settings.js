/**
 * Settings MVP metadata shared by the file loader and the DSH Config schema.
 *
 * DSH reads a plugin's `Config` export and writes a profile-patch `config:`
 * block for it. The file loader (`src/config.js`) stays the compatibility
 * layer; this module only describes the small safe subset that DSH may
 * override, plus the paths a project-level file must never be able to change.
 *
 * Keep field defaults and ranges in one place: `DEFAULT_CONFIG` and
 * `src/config-schema.js` both derive from SETTING_SPECS.
 */

export const PLUGIN_ENTRY_ID = 'dsh-chrome'
export const PLUGIN_PACKAGE_NAME = 'dsh-desktop-chrome'

/**
 * Safe, user-editable settings exposed through the DSH plugin entry.
 * `volatile: true` means the running provider reads the value again after a
 * DSH settings edit; `false` means the provider must be reloaded.
 *
 * Deliberately absent: allowEvaluate, browser.shared.enabled and every other
 * safety invariant. They stay on the legacy file / user-level file and are
 * never exposed as a DSH form field (see docs/PLUGIN-SETTINGS.md).
 */
export const SETTING_SPECS = Object.freeze({
  'browser.preset': Object.freeze({
    type: 'enum',
    values: Object.freeze(['sandbox', 'sandbox-persistent', 'debug']),
    default: 'sandbox',
    volatile: true,
    description: '新 context 的默认隔离模式；debug 会打开独立可见窗口。collab 尚未实现，不在设置里提供。',
  }),
  'browser.maxContexts': Object.freeze({
    type: 'integer',
    min: 1,
    max: 16,
    step: 1,
    default: 4,
    volatile: true,
    description: '同时存在的浏览器 context 上限；只影响新建 context。',
  }),
  'browser.maxTabs': Object.freeze({
    type: 'integer',
    min: 1,
    max: 64,
    step: 1,
    default: 12,
    volatile: true,
    description: '每个 headless 浏览器内的 tab 上限（per context，跨 owner 共享）；超出返回 RESOURCE_LIMIT，关闭 tab 后释放。',
  }),
  'browser.idleTimeoutMs': Object.freeze({
    type: 'integer',
    min: 10_000,
    max: 3_600_000,
    step: 1,
    default: 300_000,
    volatile: true,
    description: '不可见 context 的空闲回收时间（毫秒）；可见窗口不参与回收。',
  }),
  'verification.artifactRetentionRuns': Object.freeze({
    type: 'integer',
    min: 1,
    max: 1000,
    step: 1,
    default: 50,
    volatile: true,
    description: 'chrome_verify 保留最近多少次验证产物。',
  }),
  'update.enabled': Object.freeze({
    type: 'boolean',
    default: false,
    volatile: false,
    description: '检查 GitHub Release；默认关闭。修改后需要重载 provider。',
  }),
  'update.autoInstall': Object.freeze({
    type: 'boolean',
    default: false,
    volatile: false,
    description: '发现新版本时：Windows 自动替换 host exe；macOS/Linux 下载插件+扩展到缓存（不热替换）。默认关闭，需要重载 provider。',
  }),
  'update.checkIntervalHours': Object.freeze({
    type: 'integer',
    min: 1,
    max: 168,
    step: 1,
    default: 24,
    volatile: false,
    description: '开启更新检查后的间隔小时数。',
  }),
})

/** Paths the DSH plugin config may override. Order is the form field order. */
export const PLUGIN_CONFIG_PATHS = Object.freeze(Object.keys(SETTING_SPECS))

/** Paths whose edit takes effect without reloading the provider. */
export const LIVE_PATHS = Object.freeze(PLUGIN_CONFIG_PATHS.filter((key) => SETTING_SPECS[key].volatile))

/**
 * Project-level `.dsh-chrome/config.json` may tighten/keep safe options but
 * must not widen security. These paths are ignored with a warning when they
 * appear there. User-level files keep working for backwards compatibility.
 */
export const PROJECT_FORBIDDEN = Object.freeze([
  'allowEvaluate',
  'evaluate',
  'browser.shared',
  'browser.headless.chromeExecutable',
  'update.autoInstall',
  'update.repository',
  'upload.extraRoots',
  'safety.allowedOrigins',
])

export function isProjectForbidden(path) {
  return PROJECT_FORBIDDEN.some((forbidden) => path === forbidden || path.startsWith(`${forbidden}.`))
}

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

function isOurEntry(entry) {
  const options = entry?.options ?? entry
  return (
    options?.id === PLUGIN_ENTRY_ID ||
    options?.name === PLUGIN_PACKAGE_NAME ||
    entry?.id === `include:${PLUGIN_ENTRY_ID}` ||
    entry?.name === PLUGIN_PACKAGE_NAME
  )
}

/**
 * Read the user's explicit DSH entry config (the profile-patch layer only).
 *
 * Do not use `entry.fiber.config`: DSH has already applied the Config defaults
 * there, and using it would make every schema default override the file
 * compatibility layer. Prefer `configEditor.configuration().override`, which
 * is the raw profile-patch value; fall back to the Loader's raw entry config
 * when the service is unavailable.
 *
 * @param {object} ctx Cordis plugin context.
 * @returns {{override: object|null, source: string, notes: string[]}}
 */
export function readPluginOverride(ctx) {
  const notes = []
  const get = typeof ctx?.get === 'function' ? ctx.get.bind(ctx) : null
  if (get) {
    try {
      const editor = get('configEditor')
      if (editor && typeof editor.configuration === 'function') {
        const rows = editor.configuration()
        if (Array.isArray(rows)) {
          const row = rows.find((candidate) => isOurEntry(candidate?.entry))
          if (row !== undefined) {
            if (isPlainObject(row.override)) {
              return { override: row.override, source: 'config-editor', notes }
            }
            if (row.override !== undefined) notes.push('ignored non-object DSH entry override')
            return { override: null, source: 'config-editor', notes }
          }
        }
      }
    } catch (error) {
      notes.push(`cannot read DSH entry config: ${error?.message || String(error)}`)
    }
  }

  const raw = ctx?.fiber?.entry?.options?.config
  if (isPlainObject(raw)) return { override: raw, source: 'entry-raw', notes }
  if (raw !== undefined) notes.push('ignored non-object DSH entry config')
  return { override: null, source: 'none', notes }
}

/**
 * Validate one explicit DSH setting before it is allowed to override a file
 * value. Invalid values are skipped (not coerced to their default), so a typo
 * in the profile patch cannot erase a valid lower-precedence value.
 *
 * @param {string} path One of PLUGIN_CONFIG_PATHS.
 * @param {unknown} value Raw user value.
 * @returns {{ok: true, value: unknown}|{ok: false, reason: string}}
 */
export function checkSettingValue(path, value) {
  const spec = SETTING_SPECS[path]
  if (!spec) return { ok: false, reason: 'unknown setting' }
  if (spec.type === 'boolean') {
    return typeof value === 'boolean' ? { ok: true, value } : { ok: false, reason: 'expected boolean' }
  }
  if (spec.type === 'enum') {
    return spec.values.includes(value)
      ? { ok: true, value }
      : { ok: false, reason: `expected one of ${spec.values.join(', ')}` }
  }
  if (spec.type === 'integer') {
    if (typeof value !== 'number' || !Number.isInteger(value)) return { ok: false, reason: 'expected integer' }
    if (value < spec.min || value > spec.max) return { ok: false, reason: `expected integer ${spec.min}..${spec.max}` }
    if (spec.step && (value - (spec.min ?? 0)) % spec.step !== 0) return { ok: false, reason: `expected multiple of ${spec.step}` }
    return { ok: true, value }
  }
  return { ok: false, reason: `unsupported setting type ${spec.type}` }
}
