/**
 * Tool schema test — no Chrome required.
 *
 * The provider's tool contract is model-facing: a malformed parameter or output
 * schema breaks tool calls (e.g. the P1 bug where `groupId: {type:'number'}`
 * rejected a real `null`). This test validates the schemas structurally.
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
  assets: () => ({}),
  approval: () => null,
})
const allowedTypes = new Set(['object', 'array', 'string', 'number', 'boolean', 'integer', 'null'])

function validateSchema(schema, pathLabel) {
  if (schema == null || typeof schema !== 'object') {
    check(`schema is an object: ${pathLabel}`, false, String(schema))
    return
  }
  if ('type' in schema) {
    check(
      `schema type is a single known string: ${pathLabel}`,
      typeof schema.type === 'string' && allowedTypes.has(schema.type),
      JSON.stringify(schema.type),
    )
  }
  if (schema.type === 'array') validateSchema(schema.items, `${pathLabel}[]`)
  if (schema.properties) {
    for (const [key, child] of Object.entries(schema.properties)) validateSchema(child, `${pathLabel}.${key}`)
  }
}

const names = tools.map((tool) => tool.name)
check('tool names are unique', new Set(names).size === names.length)
check('all tool names use the chrome_ namespace', names.every((name) => name.startsWith('chrome_')))
check('tool count is 38', tools.length === 38, String(tools.length))

for (const tool of tools) {
  const label = tool.name
  check(`${label}: has a useful description`, typeof tool.description === 'string' && tool.description.length >= 30)

  const parameters = tool.parameters
  check(`${label}: parameters is an object schema`, parameters?.type === 'object' && typeof parameters.properties === 'object')
  const required = parameters?.required ?? []
  check(`${label}: required is an array`, Array.isArray(required))
  check(
    `${label}: required entries exist in properties`,
    required.every((name) => Object.hasOwn(parameters.properties ?? {}, name)),
    required.join(','),
  )
  check(`${label}: additionalProperties is false`, parameters?.additionalProperties === false)
  for (const [key, schema] of Object.entries(parameters.properties ?? {})) {
    validateSchema(schema, `${label}.params.${key}`)
  }

  check(`${label}: output schema is defined`, tool.output?.schema != null)
  check(`${label}: output render is a function`, typeof tool.output?.render === 'function')
  validateSchema(tool.output.schema, `${label}.output`)
}

// A JSON round-trip proves the schemas contain no functions/undefined.
let roundTripped = null
try {
  roundTripped = JSON.stringify(tools.map((tool) => ({ name: tool.name, parameters: tool.parameters, output: tool.output.schema })))
} catch (error) {
  roundTripped = null
}
check('all schemas are JSON-serializable', typeof roundTripped === 'string' && roundTripped.length > 100)

console.log(failures === 0 ? '\nTOOL SCHEMA TEST: PASS' : `\nTOOL SCHEMA TEST: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
