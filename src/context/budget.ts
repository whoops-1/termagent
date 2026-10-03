import type { ChatMessage } from '../session/store.js'

export interface ContextBudgetOptions {
  maxContextTokens: number
  maxOutputTokens?: number
  threshold?: number
  reserveTokens?: number
  recentTokens?: number
}

export interface ContextBudget {
  maxContextTokens: number
  maxOutputTokens: number
  threshold: number
  reserveTokens: number
  recentTokens: number
  usableTokens: number
  compactTargetTokens: number
  toolSchemaTokens: number
  skillDescriptorTokens: number
  explicitSkillTokens: number
}

export interface ContextSectionBudget {
  instructions: number
  repository: number
  skillDescriptors: number
  explicitSkill: number
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

export function normalizeThreshold(value: number | undefined, fallback = 0.82): number {
  const numeric = typeof value === 'number' ? value : Number.NaN
  if (!Number.isFinite(numeric)) return fallback
  if (numeric <= 0) return fallback
  if (numeric > 1) return clamp(numeric / 100, 0.1, 1)
  return clamp(numeric, 0.1, 1)
}

function estimateTextTokens(text: string): number {
  let ascii = 0
  let latin = 0
  let dense = 0
  let emoji = 0
  for (const ch of text) {
    const cp = ch.codePointAt(0) || 0
    if (cp <= 0x7f) ascii++
    else if (
      (cp >= 0x0900 && cp <= 0x097f) ||
      (cp >= 0x0980 && cp <= 0x0dff) ||
      (cp >= 0x0600 && cp <= 0x06ff) ||
      (cp >= 0x4e00 && cp <= 0x9fff) ||
      (cp >= 0xac00 && cp <= 0xd7af) ||
      (cp >= 0x3040 && cp <= 0x30ff)
    ) dense++
    else if (cp >= 0x1f000 && cp <= 0x1faff) emoji++
    else latin++
  }
  return Math.ceil(ascii / 4 + latin / 3 + dense / 1.8 + emoji / 1.3)
}

export function estimateTokens(value: unknown): number {
  if (value == null) return 0
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return estimateTextTokens(text)
}

export function truncateToTokenBudget(text: string, maxTokens: number): string {
  if (!text || maxTokens <= 0) return ''
  if (estimateTokens(text) <= maxTokens) return text
  const marker = '\n[truncated to fit context budget]'
  const markerTokens = estimateTokens(marker)

  // The old implementation budgeted only for the source text and appended the
  // truncation marker afterwards. That could make an already-budgeted request
  // exceed the context limit by a handful of tokens, especially when the
  // remaining budget was tiny. Reserve the marker before finding the prefix.
  if (markerTokens >= maxTokens) {
    let lo = 0
    let hi = text.length
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2)
      if (estimateTokens(text.slice(0, mid)) <= maxTokens) lo = mid
      else hi = mid - 1
    }
    return text.slice(0, Math.max(1, lo)).trimEnd()
  }

  const bodyBudget = maxTokens - markerTokens
  let lo = 0
  let hi = text.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (estimateTokens(text.slice(0, mid)) <= bodyBudget) lo = mid
    else hi = mid - 1
  }
  const cut = text.slice(0, Math.max(1, lo)).trimEnd()
  return `${cut}${marker}`
}
export function truncateAroundTokenBudget(text: string, maxTokens: number): string {
  if (!text || maxTokens <= 0) return ''
  if (estimateTokens(text) <= maxTokens) return text

  const marker = '\n[truncated to fit context budget; middle omitted]\n'
  const markerTokens = estimateTokens(marker)
  if (markerTokens >= maxTokens) return truncateToTokenBudget(marker.trim(), maxTokens)

  const bodyBudget = maxTokens - markerTokens
  const headBudget = Math.max(1, Math.floor(bodyBudget * 0.68))
  const tailBudget = Math.max(1, bodyBudget - headBudget)

  const fitPrefix = (value: string, budget: number): string => {
    let lo = 0
    let hi = value.length
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2)
      if (estimateTokens(value.slice(0, mid)) <= budget) lo = mid
      else hi = mid - 1
    }
    return value.slice(0, lo).trimEnd()
  }

  const fitSuffix = (value: string, budget: number): string => {
    let lo = 0
    let hi = value.length
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2)
      if (estimateTokens(value.slice(value.length - mid)) <= budget) lo = mid
      else hi = mid - 1
    }
    return value.slice(Math.max(0, value.length - lo)).trimStart()
  }

  const head = fitPrefix(text, headBudget)
  const tail = fitSuffix(text, tailBudget)
  return `${head}${marker}${tail}`
}

export function estimateMessageTokens(message: ChatMessage): number {
  let tokens = 6 + estimateTokens(message.content || '')
  if (message.reasoning) tokens += estimateTokens(message.reasoning)
  if (message.tool_calls) tokens += estimateTokens(message.tool_calls) + 4
  if (message.tool_call_id) tokens += estimateTokens(message.tool_call_id) + 2
  if (message.name) tokens += estimateTokens(message.name) + 2
  return tokens
}

export function estimateMessagesTokens(messages: readonly ChatMessage[]): number {
  return messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0)
}
export interface ContextAccounting {
  toolDefinitions: number
  toolCalls: number
  toolResults: number
  summaries: number
  skills: number
  systemNotices: number
  other: number
  total: number
}

function messageCategoryTokens(messages: readonly ChatMessage[], predicate: (message: ChatMessage) => boolean): number {
  return messages.reduce((sum, message) => sum + (predicate(message) ? estimateMessageTokens(message) : 0), 0)
}

/**
 * Break down the same estimated request footprint used by the context budget
 * into the major sources that can consume model context. This mirrors
 * TermAgent's explicit tool-output budgeting without introducing a second
 * incompatible token estimator.
 */
export function accountContext(
  messages: readonly ChatMessage[],
  tools: readonly Record<string, unknown>[] = [],
): ContextAccounting {
  const systemMessages = messages.filter(message => message.role === 'system')
  const toolResults = messageCategoryTokens(messages, message => message.role === 'tool')
  const toolCalls = messageCategoryTokens(messages, message => message.role === 'assistant' && Boolean(message.tool_calls?.length))
  const summaries = systemMessages
    .filter(message => typeof message.content === 'string' && /Earlier conversation summary|## (?:Objective|Important Details|Work State|Todo|Next Move|Relevant Files)/i.test(message.content || ''))
    .reduce((sum, message) => sum + estimateMessageTokens(message), 0)
  const skills = systemMessages
    .filter(message => summaries === 0 && typeof message.content === 'string' && /## Skills|skill discovery|explicit skill/i.test(message.content || ''))
    .reduce((sum, message) => sum + estimateMessageTokens(message), 0)
  const systemTotal = messageCategoryTokens(systemMessages, () => true)
  const systemNotices = Math.max(0, systemTotal - summaries - skills)
  const toolDefinitions = estimateToolSchemasTokens(tools)
  const other = Math.max(0, estimateMessagesTokens(messages) - toolResults - toolCalls - messageCategoryTokens(systemMessages, () => true))
  const total = estimateMessagesTokens(messages) + toolDefinitions
  return { toolDefinitions, toolCalls, toolResults, summaries, skills, systemNotices, other, total }
}
export function estimateToolSchemasTokens(
  tools: readonly Record<string, unknown>[],
): number {
  return estimateTokens(tools)
}

export function createContextBudget(options: ContextBudgetOptions): ContextBudget {
  const maxContextTokens = Math.max(256, Math.floor(options.maxContextTokens || 12000))
  const maxOutputTokens = options.maxOutputTokens === undefined ? 2048 : Math.max(0, Math.floor(options.maxOutputTokens))
  const threshold = normalizeThreshold(options.threshold)
  const reserveTokens = options.reserveTokens === undefined ? Math.max(512, Math.ceil(maxContextTokens * 0.08)) : Math.max(0, Math.floor(options.reserveTokens))
  const recentTokens = options.recentTokens === undefined ? Math.min(8000, Math.max(2000, Math.floor(maxContextTokens * 0.28))) : Math.max(0, Math.floor(options.recentTokens))
  const thresholdLimit = Math.floor(maxContextTokens * threshold)
  const usableTokens = Math.max(1, thresholdLimit - Math.max(maxOutputTokens, reserveTokens))
  const compactTargetTokens = Math.max(1, Math.floor(Math.min(usableTokens * 0.68, maxContextTokens * 0.55)))
  const toolSchemaTokens = Math.max(256, Math.floor(usableTokens * 0.32))
  const skillDescriptorTokens = Math.max(96, Math.floor(usableTokens * 0.08))
  const explicitSkillTokens = Math.max(256, Math.floor(usableTokens * 0.18))
  return {
    maxContextTokens,
    maxOutputTokens,
    threshold,
    reserveTokens,
    recentTokens,
    usableTokens,
    compactTargetTokens,
    toolSchemaTokens,
    skillDescriptorTokens,
    explicitSkillTokens,
  }
}

export function allocateContextSections(
  availableTokens: number,
  options: { explicitSkill?: boolean } = {},
): ContextSectionBudget {
  const total = Math.max(1, Math.floor(availableTokens))
  const weights = options.explicitSkill
    ? { instructions: 0.42, repository: 0.28, skillDescriptors: 0.08, explicitSkill: 0.22 }
    : { instructions: 0.48, repository: 0.42, skillDescriptors: 0.10, explicitSkill: 0 }

  const minimums = options.explicitSkill
    ? { instructions: 16, repository: 16, skillDescriptors: 16, explicitSkill: 32 }
    : { instructions: 16, repository: 16, skillDescriptors: 16, explicitSkill: 0 }
  const minSum = minimums.instructions + minimums.repository + minimums.skillDescriptors + minimums.explicitSkill
  if (total <= minSum) {
    let remainder = total
    const result = {
      instructions: Math.min(minimums.instructions, remainder),
      repository: 0,
      skillDescriptors: 0,
      explicitSkill: 0,
    }
    remainder -= result.instructions
    if (remainder > 0) {
      result.repository = Math.min(minimums.repository, remainder)
      remainder -= result.repository
    }
    if (remainder > 0) {
      result.skillDescriptors = Math.min(minimums.skillDescriptors, remainder)
      remainder -= result.skillDescriptors
    }
    if (remainder > 0 && options.explicitSkill) result.explicitSkill = remainder
    return result
  }

  const weighted = {
    instructions: Math.floor(total * weights.instructions),
    repository: Math.floor(total * weights.repository),
    skillDescriptors: Math.floor(total * weights.skillDescriptors),
    explicitSkill: options.explicitSkill ? Math.floor(total * weights.explicitSkill) : 0,
  }
  weighted.instructions = Math.max(minimums.instructions, weighted.instructions)
  weighted.repository = Math.max(minimums.repository, weighted.repository)
  weighted.skillDescriptors = Math.max(minimums.skillDescriptors, weighted.skillDescriptors)
  weighted.explicitSkill = Math.max(minimums.explicitSkill, weighted.explicitSkill)

  let used = weighted.instructions + weighted.repository + weighted.skillDescriptors + weighted.explicitSkill
  if (used > total) {
    for (const key of ['explicitSkill', 'repository', 'instructions', 'skillDescriptors'] as const) {
      while (used > total && weighted[key] > minimums[key]) {
        weighted[key]--
        used--
      }
    }
  }
  if (used < total) weighted.repository += total - used
  return weighted
}

export function fitsBudget(messages: readonly ChatMessage[], budget: ContextBudget): boolean {
  return estimateMessagesTokens(messages) <= budget.usableTokens
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function compactSchemaValue(value: any, targetTokens: number, depth = 0): any {
  if (targetTokens <= 0) return undefined
  if (typeof value === 'string') {
    return truncateToTokenBudget(value, Math.max(8, targetTokens))
  }
  if (Array.isArray(value)) {
    if (estimateTokens(value) <= targetTokens) return value
    const out: any[] = []
    for (const item of value) {
      if (out.length >= 16) break
      const candidate = compactSchemaValue(item, Math.max(8, Math.floor(targetTokens / Math.max(1, Math.min(value.length, 16)))), depth + 1)
      if (candidate !== undefined) out.push(candidate)
      if (estimateTokens(out) >= targetTokens) break
    }
    return out
  }
  if (!value || typeof value !== 'object') return value

  const out: Record<string, any> = { ...value }
  for (const key of ['description', 'title'] as const) {
    if (typeof out[key] === 'string') out[key] = truncateToTokenBudget(out[key], key === 'description' ? 90 : 24)
  }
  for (const key of ['examples'] as const) delete out[key]
  if (Array.isArray(out.enum) && out.enum.length > 16) out.enum = out.enum.slice(0, 16)
  if (Array.isArray(out.oneOf) && out.oneOf.length > 12) out.oneOf = out.oneOf.slice(0, 12)
  if (Array.isArray(out.anyOf) && out.anyOf.length > 12) out.anyOf = out.anyOf.slice(0, 12)
  if (Array.isArray(out.allOf) && out.allOf.length > 12) out.allOf = out.allOf.slice(0, 12)

  if (out.properties && typeof out.properties === 'object' && !Array.isArray(out.properties)) {
    const required = new Set(Array.isArray(out.required) ? out.required.map(String) : [])
    const keys = Object.keys(out.properties)
    const ordered = [...keys.filter(k => required.has(k)), ...keys.filter(k => !required.has(k))]
    const properties: Record<string, any> = {}
    const perProperty = Math.max(12, Math.floor(Math.max(32, targetTokens * 0.7) / Math.max(1, Math.min(ordered.length, 20))))
    for (const key of ordered.slice(0, 20)) {
      const property = compactSchemaValue(out.properties[key], perProperty, depth + 1)
      if (property !== undefined) properties[key] = property
    }
    out.properties = properties
    if (out.required) out.required = out.required.filter((key: string) => Object.hasOwn(properties, key))
  }

  if (depth < 4) {
    for (const key of ['items', 'additionalProperties', 'not', 'if', 'then', 'else', 'contains'] as const) {
      if (out[key] && typeof out[key] === 'object') out[key] = compactSchemaValue(out[key], Math.max(16, Math.floor(targetTokens * 0.3)), depth + 1)
    }
  }

  if (estimateTokens(out) <= targetTokens) return out

  if (out.properties && typeof out.properties === 'object') {
    const required = new Set(Array.isArray(out.required) ? out.required.map(String) : [])
    const keys = Object.keys(out.properties)
    for (let i = keys.length - 1; i >= 0 && estimateTokens(out) > targetTokens; i--) {
      const key = keys[i]!
      if (!required.has(key)) delete out.properties[key]
    }
    if (out.required) out.required = out.required.filter((key: string) => Object.hasOwn(out.properties, key))
  }

  if (estimateTokens(out) <= targetTokens) return out
  if (out.properties) return { type: 'object', properties: out.properties, ...(out.required?.length ? { required: out.required } : {}) }
  return { type: out.type || 'string' }
}

export type BoundToolSchemas = {
  tools: any[]
  originalTokens: number
  estimatedTokens: number
  dropped: string[]
}

const CORE_TOOL_PRIORITY = new Map([
  ['read_file', 100], ['write_file', 100], ['edit_file', 100], ['grep', 98], ['glob', 96], ['bash', 94],
  ['git', 92], ['repo_map', 90], ['search_skills', 88], ['use_skill', 88], ['todo', 86], ['verify_project', 86],
  ['workflow_phase', 84], ['question', 82],
])

export function boundToolSchemas(
  input: readonly any[],
  maxTokens: number,
): BoundToolSchemas {
  const limit = Math.max(128, Math.floor(maxTokens))
  const originalTokens = estimateToolSchemasTokens(input)
  if (originalTokens <= limit) {
    return { tools: input.map(cloneJson), originalTokens, estimatedTokens: originalTokens, dropped: [] }
  }

  // Preserve the existing safety behavior for catastrophically oversized
  // single-tool definitions. A schema that dwarfs the entire context budget
  // should be rejected rather than reduced until it no longer describes the
  // tool faithfully. Smaller overages are bounded below.
  const grossSingleToolLimit = Math.max(4096, limit * 8)
  const grossOversized = input.find(tool => estimateTokens(tool) > grossSingleToolLimit)
  if (grossOversized) {
    return {
      tools: [],
      originalTokens,
      estimatedTokens: 0,
      dropped: input.map(tool => String(tool?.function?.name || 'unknown')),
    }
  }

  const perTool = Math.max(64, Math.floor(limit / Math.max(1, input.length)))
  const candidates = input.map((tool, index) => {
    const fn = tool?.function && typeof tool.function === 'object' ? tool.function : {}
    const name = typeof fn.name === 'string' ? fn.name : `tool-${index}`
    const compact = cloneJson(tool)
    if (compact?.function?.description) compact.function.description = truncateToTokenBudget(String(compact.function.description), 100)
    if (compact?.function?.parameters) compact.function.parameters = compactSchemaValue(compact.function.parameters, perTool)
    return { tool: compact, name, priority: CORE_TOOL_PRIORITY.get(name) || 20 }
  })

  candidates.sort((a, b) => b.priority - a.priority || a.name.localeCompare(b.name))
  const selected: Record<string, unknown>[] = []
  const dropped: string[] = []
  let used = 0
  for (const candidate of candidates) {
    const cost = estimateTokens(candidate.tool)
    if (used + cost <= limit || selected.length === 0) {
      if (cost <= limit - used || selected.length === 0) {
        const fitted = cost <= limit - used ? candidate.tool : compactSchemaValue(candidate.tool, Math.max(64, limit), 0)
        const fittedCost = estimateTokens(fitted)
        if (used + fittedCost <= limit) {
          selected.push(fitted)
          used += fittedCost
          continue
        }
      }
    }
    dropped.push(candidate.name)
  }

  selected.sort((a, b) => String((a as any).function?.name || '').localeCompare(String((b as any).function?.name || '')))
  return { tools: selected, originalTokens, estimatedTokens: estimateToolSchemasTokens(selected), dropped }
}
