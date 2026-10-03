export type ExplorationThoroughness = 'quick' | 'medium' | 'very-thorough'

export type ExplorationStrategy = {
  thoroughness: ExplorationThoroughness
  primaryTools: string[]
  rationale: string
}

export type ExplorationGuidanceState = {
  discoveredFiles?: number
  coveredRanges?: number
  searchObservations?: number
  symbols?: number
  verificationFacts?: number
  progressRevision?: number
  noProgressRounds?: number
  lastProgress?: string
}

const EXPLORATION_TOOLS = new Set(['repo_map', 'glob', 'grep', 'read_file'])

function normalizedPrompt(prompt: string): string {
  return prompt.trim().replace(/\s+/g, ' ')
}

export function inferExplorationThoroughness(prompt: string): ExplorationThoroughness {
  const text = normalizedPrompt(prompt).toLowerCase()
  if (/\b(quick|quickly|brief|short|minimal|just find|just locate)\b/.test(text)) return 'quick'
  if (/\b(very thorough|thoroughly|comprehensive|exhaustive|entire codebase|all usages|every reference|deep dive)\b/.test(text)) {
    return 'very-thorough'
  }
  return 'medium'
}

function hasAny(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some(pattern => pattern.test(text))
}

export function chooseExplorationStrategy(input: { prompt: string; availableTools?: readonly string[] }): ExplorationStrategy {
  const text = normalizedPrompt(input.prompt).toLowerCase()
  const available = new Set((input.availableTools ?? [...EXPLORATION_TOOLS]).filter(name => EXPLORATION_TOOLS.has(name)))
  const can = (name: string) => available.has(name)
  const thoroughness = inferExplorationThoroughness(text)

  if (hasAny(text, [/\b(src|lib|app|tests?|components?|packages?)\b.*\*\*/, /\bfiles? by (pattern|extension)\b/, /\bfile pattern\b/, /\bfind\b.*\bfiles?\b/])) {
    return {
      thoroughness,
      primaryTools: [can('glob') ? 'glob' : '', can('read_file') ? 'read_file' : ''].filter(Boolean),
      rationale: 'The request is file-pattern oriented, so discover candidate paths before reading known files.',
    }
  }

  if (hasAny(text, [/\b(symbol|function|class|method|identifier|reference|references|usage|usages|where is|where are)\b/])) {
    return {
      thoroughness,
      primaryTools: [can('grep') ? 'grep' : '', can('read_file') ? 'read_file' : ''].filter(Boolean),
      rationale: 'The request is content/symbol oriented, so search for evidence before reading the smallest relevant ranges.',
    }
  }

  if (hasAny(text, [/\b(architecture|structure|layout|how .* connect|how .* works|flow|entry point|dependency graph)\b/])) {
    return {
      thoroughness,
      primaryTools: [can('repo_map') ? 'repo_map' : '', can('grep') ? 'grep' : '', can('read_file') ? 'read_file' : ''].filter(Boolean),
      rationale: 'The request is structural, so a bounded repository map can establish context before targeted search and reads.',
    }
  }

  if (hasAny(text, [/\b(?:src\/|lib\/|app\/|tests?\/|packages?\/)[\w./-]+\b/, /\b(read|inspect|open|look at)\s+[`'\"]?[^ ]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|py|go|rs|java|c|cpp)\b/i])) {
    return {
      thoroughness,
      primaryTools: [can('read_file') ? 'read_file' : '', can('grep') ? 'grep' : ''].filter(Boolean),
      rationale: 'The request already names likely file locations, so inspect those directly and search only as needed for connections.',
    }
  }

  return {
    thoroughness,
    primaryTools: [can('repo_map') ? 'repo_map' : '', can('glob') ? 'glob' : '', can('grep') ? 'grep' : '', can('read_file') ? 'read_file' : ''].filter(Boolean),
    rationale: 'The request is broad or ambiguous, so establish just enough structure to choose targeted discovery tools.',
  }
}

function thoroughnessGuidance(level: ExplorationThoroughness): string {
  if (level === 'quick') {
    return 'Quick: prioritize the smallest evidence set that answers the request. Stop once the answer is supported.'
  }
  if (level === 'very-thorough') {
    return 'Very thorough: cover multiple naming conventions and relevant locations, reconcile independent evidence, and continue into related files when the evidence shows they matter.'
  }
  return 'Medium: locate the relevant area, inspect the key implementations and connections, and expand only when evidence indicates another location matters.'
}

export function renderExplorationGuidance(input: {
  prompt: string
  availableTools?: readonly string[]
  state?: ExplorationGuidanceState
}): string {
  const strategy = chooseExplorationStrategy(input)
  const toolOrder = strategy.primaryTools.length ? strategy.primaryTools.join(' → ') : 'the available read-only tools'
  const hasTaskTool = (input.availableTools ?? []).some(name => ['task', 'background_agent', 'parallel_agents'].includes(name))
  const state = input.state ?? {}
  const evidenceSummary = [
    state.discoveredFiles !== undefined ? `${state.discoveredFiles} discovered file(s)` : '',
    state.coveredRanges !== undefined ? `${state.coveredRanges} tracked read range(s)` : '',
    state.searchObservations !== undefined ? `${state.searchObservations} search observation(s)` : '',
    state.symbols !== undefined ? `${state.symbols} symbol(s)` : '',
    state.verificationFacts !== undefined ? `${state.verificationFacts} settled verification fact(s)` : '',
  ].filter(Boolean).join(', ') || 'no durable exploration evidence recorded yet'
  const noProgress = state.noProgressRounds !== undefined && Number.isSafeInteger(state.noProgressRounds) ? Math.max(0, state.noProgressRounds) : 0
  const progressRevision = state.progressRevision !== undefined && Number.isSafeInteger(state.progressRevision) ? Math.max(0, state.progressRevision) : undefined
  const adaptiveNudge = noProgress > 0
    ? `No-progress streak: ${noProgress} round(s) without new semantic evidence${progressRevision !== undefined ? ` (progress revision ${progressRevision})` : ''}. Change the search strategy, query, path, tool, or uncovered range before attempting another equivalent inspection.`
    : `Current evidence: ${evidenceSummary}${progressRevision !== undefined ? `; progress revision ${progressRevision}` : ''}. Continue only where the next action is expected to add evidence.`
  const lastProgress = input.state?.lastProgress?.trim()
  return [
    'EXPLORATION GUIDANCE:',
    `Suggested routing for this request: ${toolOrder}. ${strategy.rationale}`,
    thoroughnessGuidance(strategy.thoroughness),
    `Current evidence state: ${evidenceSummary}.`,
    adaptiveNudge,
    lastProgress ? `Latest evidence note: ${lastProgress}` : '',
    'This routing is adaptive guidance, not a mandatory repo_map → glob → grep → read ceremony. Skip tools that add no value and switch strategy when evidence stops being novel.',
    'Use repo_map when repository structure, symbols, or entry-point relationships are unclear; use glob for file-pattern discovery; use grep for content or symbol search; use read_file only when a concrete path or range is known.',
    'Prefer the smallest useful contiguous read. When a read overlaps already covered lines, continue from the uncovered range instead of rereading the covered evidence.',
    'Batch independent read/search calls in the same provider response when they are safe and do not depend on one another. Preserve the intended evidence order in your reasoning; do not serialize unrelated inspection merely to follow a fixed sequence.',
    hasTaskTool
      ? 'For broad exploration with independent sub-questions, use a specialized task/background/parallel agent only when it materially improves context efficiency. Give each delegated task a distinct focus or bounded scope, and do not repeat the same searches yourself.'
      : 'Use specialized subagents only when the active tool set exposes them and the broad exploration naturally splits into independent, bounded questions. Do not duplicate delegated work.',
    'For truncated search results, follow the reported continuation/offset. For repeated no-progress actions, change query, path, tool, or read range rather than varying cosmetic arguments.',
    'Remain strictly read-only in Explore mode. Do not create, modify, delete, move, copy, or execute commands that mutate system state.',
    'Return absolute file paths in the final report when possible, explain the evidence chain briefly, and distinguish verified findings from assumptions.',
  ].filter(Boolean).join('\n')
}
