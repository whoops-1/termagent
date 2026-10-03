import type { JSONSchema } from './types.js'

export class ToolValidationError extends Error {
  readonly phase: 'input' | 'output'
  readonly path: string
  readonly code: string

  constructor(phase: 'input' | 'output', path: string, code: string, message: string) {
    super(message)
    this.name = 'ToolValidationError'
    this.phase = phase
    this.path = path
    this.code = code
  }
}

type ValidationContext = { phase: 'input' | 'output' }

function label(path: string): string {
  return path || '$'
}

function fail(ctx: ValidationContext, path: string, code: string, message: string): never {
  throw new ToolValidationError(ctx.phase, path, code, `${ctx.phase} validation failed at ${label(path)}: ${message}`)
}

function typeMatches(value: unknown, type: unknown): boolean {
  if (typeof type !== 'string') return true
  switch (type) {
    case 'object': return value !== null && typeof value === 'object' && !Array.isArray(value)
    case 'array': return Array.isArray(value)
    case 'string': return typeof value === 'string'
    case 'number': return typeof value === 'number' && Number.isFinite(value)
    case 'integer': return typeof value === 'number' && Number.isInteger(value)
    case 'boolean': return typeof value === 'boolean'
    case 'null': return value === null
    default: return true
  }
}

function validate(value: unknown, schema: JSONSchema | undefined, path: string, ctx: ValidationContext, seen = new Set<object>()): void {
  if (!schema || typeof schema !== 'object') return

  if (seen.has(schema)) return
  seen.add(schema)

  if (schema.$ref && typeof schema.$ref === 'string') {
    const local = /^#\/$defs\/([^/]+)$/.exec(schema.$ref)
    if (local && schema.$defs && typeof schema.$defs === 'object' && local[1] && local[1] in schema.$defs) {
      validate(value, schema.$defs[local[1]], path, ctx, seen)
      return
    }
  }

  if (schema.const !== undefined && !Object.is(value, schema.const)) {
    fail(ctx, path, 'const', `must equal ${JSON.stringify(schema.const)}`)
  }

  if (Array.isArray(schema.enum) && !schema.enum.some((item: unknown) => Object.is(item, value))) {
    fail(ctx, path, 'enum', `must be one of ${schema.enum.map((item: unknown) => JSON.stringify(item)).join(', ')}`)
  }

  if (schema.anyOf && Array.isArray(schema.anyOf)) {
    const errors: unknown[] = []
    let accepted = false
    for (const branch of schema.anyOf) {
      try { validate(value, branch, path, ctx, new Set(seen)); accepted = true; break } catch (error) { errors.push(error) }
    }
    if (!accepted) fail(ctx, path, 'anyOf', `must satisfy at least one allowed schema (${errors.length} branches rejected)`)
  }

  if (schema.oneOf && Array.isArray(schema.oneOf)) {
    let matches = 0
    for (const branch of schema.oneOf) {
      try { validate(value, branch, path, ctx, new Set(seen)); matches++ } catch {}
    }
    if (matches !== 1) fail(ctx, path, 'oneOf', `must satisfy exactly one allowed schema (matched ${matches})`)
  }

  if (schema.allOf && Array.isArray(schema.allOf)) {
    for (const branch of schema.allOf) validate(value, branch, path, ctx, new Set(seen))
  }

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type]
    if (!types.some((type: unknown) => typeMatches(value, type))) {
      fail(ctx, path, 'type', `must be ${types.join(' or ')}`)
    }
  }

  if (value === null || value === undefined) return

  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) fail(ctx, path, 'minLength', `must contain at least ${schema.minLength} characters`)
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) fail(ctx, path, 'maxLength', `must contain at most ${schema.maxLength} characters`)
    if (typeof schema.pattern === 'string') {
      try {
        if (!new RegExp(schema.pattern).test(value)) fail(ctx, path, 'pattern', `must match ${schema.pattern}`)
      } catch { fail(ctx, path, 'pattern', 'declared pattern is invalid') }
    }
    if (typeof schema.format === 'string') {
      if (schema.format === 'email' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) fail(ctx, path, 'format', 'must be a valid email address')
      if (schema.format === 'uri' && !/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value)) fail(ctx, path, 'format', 'must be a valid URI')
    }
    return
  }

  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) fail(ctx, path, 'minimum', `must be >= ${schema.minimum}`)
    if (typeof schema.maximum === 'number' && value > schema.maximum) fail(ctx, path, 'maximum', `must be <= ${schema.maximum}`)
    if (typeof schema.exclusiveMinimum === 'number' && value <= schema.exclusiveMinimum) fail(ctx, path, 'exclusiveMinimum', `must be > ${schema.exclusiveMinimum}`)
    if (typeof schema.exclusiveMaximum === 'number' && value >= schema.exclusiveMaximum) fail(ctx, path, 'exclusiveMaximum', `must be < ${schema.exclusiveMaximum}`)
    if (typeof schema.multipleOf === 'number' && schema.multipleOf !== 0 && Math.abs(value / schema.multipleOf - Math.round(value / schema.multipleOf)) > 1e-10) fail(ctx, path, 'multipleOf', `must be a multiple of ${schema.multipleOf}`)
    return
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) fail(ctx, path, 'minItems', `must contain at least ${schema.minItems} items`)
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) fail(ctx, path, 'maxItems', `must contain at most ${schema.maxItems} items`)
    if (schema.uniqueItems) {
      for (let i = 0; i < value.length; i++) {
        for (let j = i + 1; j < value.length; j++) if (JSON.stringify(value[i]) === JSON.stringify(value[j])) fail(ctx, `${path}[${i}]`, 'uniqueItems', 'must contain unique items')
      }
    }
    if (schema.items && typeof schema.items === 'object' && !Array.isArray(schema.items)) {
      for (let i = 0; i < value.length; i++) validate(value[i], schema.items, `${path}[${i}]`, ctx, new Set(seen))
    } else if (Array.isArray(schema.items)) {
      for (let i = 0; i < Math.min(value.length, schema.items.length); i++) validate(value[i], schema.items[i], `${path}[${i}]`, ctx, new Set(seen))
    }
    return
  }

  if (typeof value === 'object') {
    const objectValue = value as Record<string, unknown>
    const properties = schema.properties && typeof schema.properties === 'object' ? schema.properties as Record<string, JSONSchema> : {}
    const required = Array.isArray(schema.required) ? schema.required : []
    for (const key of required) {
      if (typeof key === 'string' && !(key in objectValue)) fail(ctx, path ? `${path}.${key}` : key, 'required', 'is required')
    }
    for (const [key, propertySchema] of Object.entries(properties)) {
      if (key in objectValue) validate(objectValue[key], propertySchema, path ? `${path}.${key}` : key, ctx, new Set(seen))
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(objectValue)) if (!(key in properties)) fail(ctx, path ? `${path}.${key}` : key, 'additionalProperties', 'is not allowed')
    } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
      for (const key of Object.keys(objectValue)) if (!(key in properties)) validate(objectValue[key], schema.additionalProperties, path ? `${path}.${key}` : key, ctx, new Set(seen))
    }

    if (typeof schema.minProperties === 'number' && Object.keys(objectValue).length < schema.minProperties) fail(ctx, path, 'minProperties', `must contain at least ${schema.minProperties} properties`)
    if (typeof schema.maxProperties === 'number' && Object.keys(objectValue).length > schema.maxProperties) fail(ctx, path, 'maxProperties', `must contain at most ${schema.maxProperties} properties`)
    return
  }
}

export function validateToolInput(value: unknown, schema: JSONSchema): unknown {
  validate(value, schema, '', { phase: 'input' })
  return value
}

export function validateToolOutput(value: unknown, schema: JSONSchema | undefined): unknown {
  if (schema) validate(value, schema, '', { phase: 'output' })
  return value
}
