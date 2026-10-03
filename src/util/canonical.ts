export interface ToolExecutionScope {
  cwd: string
  scopePaths?: readonly string[]
}

type JsonLike = null | boolean | number | string | JsonLike[] | { [key: string]: JsonLike }

type CanonicalValue = JsonLike | undefined

function canonicalize(value: unknown, inArray = false): CanonicalValue {
  if (value === undefined) return inArray ? null : undefined
  if (value === null) return null
  if (typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return Object.is(value, -0) ? 0 : value
    return null
  }

  if (Array.isArray(value)) return value.map(item => canonicalize(item, true) as JsonLike)

  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    const result: Record<string, JsonLike> = {}
    for (const key of Object.keys(record).sort()) {
      const child = record[key]
      if (child === undefined) continue
      result[key] = canonicalize(child) as JsonLike
    }
    return result
  }

  return String(value)
}

export function canonicalJson(value: unknown): string {
  const normalized = canonicalize(value)
  return JSON.stringify(normalized) ?? ''
}

function canonicalScope(scope?: ToolExecutionScope): ToolExecutionScope | undefined {
  if (!scope) return undefined

  const normalized: ToolExecutionScope = {
    cwd: scope.cwd,
  }
  const paths = [...(scope.scopePaths ?? [])].map(String).sort()
  if (paths.length) normalized.scopePaths = paths
  return normalized
}

export function canonicalToolCallIdentity(
  toolName: string,
  input: unknown,
  scope?: ToolExecutionScope,
): string {
  const normalizedInput = typeof input === 'string' ? input : input ?? {}
  return canonicalJson({
    tool: toolName,
    input: normalizedInput,
    scope: canonicalScope(scope),
  })
}
