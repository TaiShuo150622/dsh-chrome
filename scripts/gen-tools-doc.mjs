#!/usr/bin/env node
/**
 * Generate docs/TOOLS.md from the provider tool definitions.
 *
 * The tool definitions in src/tools.js are the single source of truth; run
 * `npm run docs:tools` after changing them and commit the regenerated file.
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { chromeTools } from '../src/tools.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tools = chromeTools({
  bridge: {},
  attachments: () => null,
  assets: () => ({ extensionId: '', extensionDir: '', nativeManifestPath: '', instructionsPath: '' }),
  approval: () => null,
})

function typeOf(schema) {
  if (!schema) return '—'
  if (Array.isArray(schema.enum)) return `enum(${schema.enum.join(' | ')})`
  if (schema.type) return String(schema.type)
  return 'object'
}

function renderParameterTable(parameters) {
  const properties = parameters?.properties ?? {}
  const required = new Set(parameters?.required ?? [])
  const rows = Object.entries(properties).map(([name, schema]) => {
    const flags = required.has(name) ? 'yes' : 'no'
    return `| \`${name}\` | ${typeOf(schema)} | ${flags} | ${(schema.description || '').replace(/\|/g, '\\|')} |`
  })
  if (rows.length === 0) return '无参数。'
  return ['| 参数 | 类型 | 必填 | 说明 |', '|---|---|---|---|', ...rows].join('\n')
}

const sections = tools.map((tool) => {
  const lines = []
  lines.push(`### \`${tool.name}\``)
  lines.push('')
  lines.push(tool.description)
  lines.push('')
  lines.push(renderParameterTable(tool.parameters))
  lines.push('')
  return lines.join('\n')
})

const header = `# 工具参考

> 自动生成：\`npm run docs:tools\`。请改 \`src/tools.js\`，不要手改本文件。
> 工具数量：${tools.length}

`
const body = sections.join('\n')
await fsp.writeFile(path.join(root, 'docs', 'TOOLS.md'), header + body, 'utf8')
console.log(`docs/TOOLS.md written (${tools.length} tools)`)
