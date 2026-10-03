import { loadSkillCatalog, type SkillDescriptor, type SkillDetails } from './catalog.js'

export type DiscoverySignal = 'user_input' | 'assistant_turn' | 'write_pivot' | 'subagent_spawn' | 'explicit' | (string & {})

export type SkillSearchResult = SkillDescriptor & { relevance: number }

export const DEFAULT_SKILL_SEARCH_LIMIT = 8
export const DEFAULT_SKILL_SEARCH_THRESHOLD = 0.34
export const DEFAULT_SKILL_SEARCH_DELTA = 0.4

type DescriptorFields = ReturnType<typeof descriptorFields>
const descriptorFieldCache = new Map<string, DescriptorFields>()
const searchResultCache = new Map<string, SkillSearchResult[]>()
const MAX_SEARCH_CACHE_ENTRIES = 128

function cacheDescriptorFields(skill: SkillDescriptor): DescriptorFields {
  const key = `${skill.id}|${skill.name}|${skill.description}`
  const cached = descriptorFieldCache.get(key)
  if (cached) return cached
  const fields = descriptorFields(skill)
  descriptorFieldCache.set(key, fields)
  if (descriptorFieldCache.size > 2048) {
    const first = descriptorFieldCache.keys().next().value as string | undefined
    if (first) descriptorFieldCache.delete(first)
  }
  return fields
}

function cacheSearchResult(key: string, value: SkillSearchResult[]): SkillSearchResult[] {
  searchResultCache.delete(key)
  searchResultCache.set(key, value)
  while (searchResultCache.size > MAX_SEARCH_CACHE_ENTRIES) {
    const first = searchResultCache.keys().next().value as string | undefined
    if (!first) break
    searchResultCache.delete(first)
  }
  return value
}

export function clearSkillSearchCaches(): void {
  descriptorFieldCache.clear()
  searchResultCache.clear()
}

const STOPWORDS = new Set([
  'a','an','and','are','as','at','be','by','do','for','from','how','i','in','is','it','me','my','of','on','or','please','that','the','this','to','using','what','when','with','you','your'
])

const SYNONYMS: Record<string, string[]> = {
  pr: ['pull', 'request'],
  review: ['audit', 'inspect', 'check'],
  bug: ['debug', 'fix', 'issue', 'error'],
  tests: ['test', 'testing', 'verify', 'verification'],
  docs: ['documentation', 'document'],
  deploy: ['deployment', 'release'],
  database: ['db', 'sql', 'migration'],
  security: ['secure', 'audit', 'vulnerability'],
  react: ['jsx', 'frontend', 'component'],
  api: ['http', 'endpoint', 'backend'],
}

function normalizeToken(token: string): string {
  return token.trim().toLowerCase().replace(/[^a-z0-9@._:-]+/g, '')
}

export function tokenizeSkillQuery(query: string): string[] {
  const tokens = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map(normalizeToken)
    .filter(Boolean)
    .filter(token => !STOPWORDS.has(token))
  return [...new Set(tokens)]
}

function expandedTokens(tokens: string[]): Set<string> {
  const expanded = new Set(tokens)
  for (const token of tokens) {
    for (const synonym of SYNONYMS[token] || []) expanded.add(synonym)
  }
  return expanded
}

function descriptorFields(skill: SkillDescriptor): {
  id: string
  name: string
  description: string
  tokens: Set<string>
} {
  const raw = [skill.id, skill.name, skill.description].join(' ')
  return {
    id: skill.id.toLowerCase(),
    name: skill.name.toLowerCase(),
    description: skill.description.toLowerCase(),
    tokens: new Set(tokenizeSkillQuery(raw)),
  }
}

export function scoreSkill(skill: SkillDescriptor, query: string): number {
  const cleanedQuery = query.trim().toLowerCase()
  if (!cleanedQuery) return 0

  const fields = descriptorFields(skill)
  const queryTokens = tokenizeSkillQuery(query)
  if (queryTokens.length === 0) return 0
  const expanded = expandedTokens(queryTokens)

  let score = 0
  if (fields.id === cleanedQuery) score = Math.max(score, 1)
  if (fields.name === cleanedQuery) score = Math.max(score, 0.96)
  if (fields.id.includes(cleanedQuery)) score = Math.max(score, 0.78)
  if (fields.name.includes(cleanedQuery)) score = Math.max(score, 0.74)
  if (fields.description.includes(cleanedQuery)) score = Math.max(score, 0.66)

  let weighted = 0
  let matched = 0
  for (const token of queryTokens) {
    const aliases = new Set([token, ...(SYNONYMS[token] || [])])
    let tokenScore = 0
    for (const candidate of aliases) {
      if (fields.id.split(/[:@._-]+/).includes(candidate)) tokenScore = Math.max(tokenScore, 1)
      else if (fields.name.split(/[:@._-]+/).includes(candidate)) tokenScore = Math.max(tokenScore, 0.92)
      else if (fields.tokens.has(candidate)) tokenScore = Math.max(tokenScore, 0.72)
      else if (fields.description.includes(candidate)) tokenScore = Math.max(tokenScore, 0.52)
    }
    if (tokenScore > 0) matched++
    weighted += tokenScore
  }

  const coverage = matched / queryTokens.length
  const average = weighted / queryTokens.length
  score = Math.max(score, (coverage * 0.62) + (average * 0.38))

  if (queryTokens.length >= 2 && expanded.size > queryTokens.length) {
    let synonymMatches = 0
    for (const token of expanded) if (fields.tokens.has(token)) synonymMatches++
    score = Math.min(1, score + Math.min(0.14, synonymMatches * 0.025))
  }

  if (fields.id.startsWith(cleanedQuery)) score = Math.min(1, score + 0.08)
  return Number(Math.min(1, score).toFixed(4))
}

export function rankSkillDescriptors(
  skills: SkillDescriptor[],
  query: string,
  options: { limit?: number; threshold?: number; delta?: number } = {},
): SkillSearchResult[] {
  const limit = Math.max(1, Math.floor(options.limit ?? DEFAULT_SKILL_SEARCH_LIMIT))
  const threshold = Math.max(0, Math.min(1, options.threshold ?? DEFAULT_SKILL_SEARCH_THRESHOLD))
  const delta = Math.max(0, Math.min(1, options.delta ?? DEFAULT_SKILL_SEARCH_DELTA))
  const scored = skills
    .map(skill => ({ ...skill, relevance: scoreSkill(skill, query) }))
    .filter(skill => skill.securityStatus !== 'blocked' && skill.relevance >= threshold)
    .sort((a, b) => b.relevance - a.relevance || a.id.localeCompare(b.id))
  const top = scored[0]?.relevance
  if (top === undefined) return []
  return scored.filter(skill => skill.relevance >= Math.max(threshold, top - delta)).slice(0, limit)
}

export async function searchSkills(
  cwd: string,
  query: string,
  options: { limit?: number; threshold?: number; delta?: number } = {},
): Promise<SkillSearchResult[]> {
  const catalog = await loadSkillCatalog(cwd)
  const normalized = query.replace(/\s+/g, ' ').trim().toLowerCase()
  const limit = Math.max(1, Math.floor(options.limit ?? DEFAULT_SKILL_SEARCH_LIMIT))
  const threshold = Math.max(0, Math.min(1, options.threshold ?? DEFAULT_SKILL_SEARCH_THRESHOLD))
  const delta = Math.max(0, Math.min(1, options.delta ?? DEFAULT_SKILL_SEARCH_DELTA))
  const cacheKey = `${catalog.cwd}|${catalog.generation}|${normalized}|${limit}|${threshold}|${delta}`
  const cached = searchResultCache.get(cacheKey)
  if (cached) return cached
  return cacheSearchResult(cacheKey, rankSkillDescriptors(catalog.list(), normalized, { limit, threshold, delta }))
}

export async function discoverSkills(
  cwd: string,
  query: string,
  signal: DiscoverySignal,
  options: { limit?: number; threshold?: number; delta?: number } = {},
): Promise<{ signal: DiscoverySignal; query: string; results: SkillSearchResult[] }> {
  const results = await searchSkills(cwd, query, options)
  return { signal, query, results }
}

export function descriptorForDetails(details: SkillDetails): SkillDescriptor {
  const {
    path: _path,
    root: _root,
    size: _size,
    mtimeMs: _mtimeMs,
    sha256: _sha256,
    frontmatter: _frontmatter,
    warnings: _warnings,
    securityFindings: _securityFindings,
    ...descriptor
  } = details
  return descriptor
}

export function formatSkillSearchResults(results: SkillSearchResult[], maxChars = 5000): string {
  if (results.length === 0) return '(no matching skills found)'
  const lines = results.map(skill => {
    const source = skill.pluginId ? `plugin:${skill.pluginId}` : skill.source
    const desc = skill.description.replace(/\s+/g, ' ').slice(0, 220)
    return `- ${skill.id} [${skill.relevance.toFixed(2)}] ${desc} (${source})`
  })
  let out = ''
  for (const line of lines) {
    const next = out ? `${out}\n${line}` : line
    if (next.length > maxChars) break
    out = next
  }
  return out || '(no matching skills fit the descriptor budget)'
}
