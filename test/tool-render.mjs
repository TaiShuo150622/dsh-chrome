/**
 * Render smoke test — every tool render() must accept a schema-shaped value and
 * return well-formed content blocks. Catches render crashes that would only
 * surface when a real tool call returns data.
 */
import { chromeTools } from '../src/tools.js'

let failures = 0
function check(name, condition, detail = '') {
  if (condition) console.log(`PASS ${name}${detail ? ` — ${detail}` : ''}`)
  else {
    failures += 1
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const tools = chromeTools({
  bridge: {},
  attachments: () => null,
  assets: () => ({
    extensionId: 'id',
    extensionDir: '/tmp/ext',
    nativeManifestPath: '/tmp/native.json',
    instructionsPath: '/tmp/INSTALL.md',
  }),
  approval: () => null,
})

function sample(schema) {
  if (!schema || typeof schema !== 'object') return null
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0]
  switch (schema.type) {
    case 'object': {
      const out = {}
      for (const [key, child] of Object.entries(schema.properties ?? {})) out[key] = sample(child)
      return out
    }
    case 'array':
      return schema.items ? [sample(schema.items)] : []
    case 'string':
      return 'x'
    case 'number':
    case 'integer':
      return 1
    case 'boolean':
      return true
    case 'null':
      return null
    default:
      return null
  }
}

for (const tool of tools) {
  const value = sample(tool.output.schema)
  let blocks = null
  let error = null
  try {
    blocks = tool.output.render({}, value)
  } catch (thrown) {
    error = thrown?.message || String(thrown)
  }
  check(
    `${tool.name}: render returns content blocks`,
    Array.isArray(blocks) && blocks.length > 0 && blocks.every((block) => typeof block?.type === 'string'),
    error || '',
  )
}

console.log(failures === 0 ? '\nTOOL RENDER TEST: PASS' : `\nTOOL RENDER TEST: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
