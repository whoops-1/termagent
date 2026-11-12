#!/usr/bin/env node
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { SessionStore } from '../dist/session/store.js'
import { compactMessages } from '../dist/agent/compaction.js'
import { estimateMessagesTokens, estimateTokens } from '../dist/context/budget.js'
import { aggregateProviderUsageEvents } from '../dist/providers/types.js'

const EXPLORATION_TOOLS = new Set(['repo_map', 'glob', 'grep', 'read_file', 'find_symbol', 'find_references', 'search_files'])
const SUMMARY_HEADINGS = [
  /^## Objective$/m,
  /^## Requirements$/m,
  /^## Decisions$/m,
  /^## Important Details$/m,
  /^## Work State$/m,
  /^### Completed$/m,
  /^### Active$/m,
  /^### Blocked$/m,
  /^## Todo$/m,
  /^## Next Move$/m,
  /^## Relevant Files$/m,
]

function number(value) {
  return Number.isFinite(Number(value)) ? Number(value) : undefined
}

function percentile(values, fraction) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)]
}

function stats(values) {
  const finite = values.filter(Number.isFinite)
  if (!finite.length) return { count: 0, min: null, mean: null, p50: null, p95: null, max: null }
  const sum = finite.reduce((total, value) => total + value, 0)
  return {
    count: finite.length,
    min: Math.min(...finite),
    mean: sum / finite.length,
    p50: percentile(finite, 0.5),
    p95: percentile(finite, 0.95),
    max: Math.max(...finite),
  }
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]))
}

function parseArguments(value) {
  if (value && typeof value === 'object') return value
  if (typeof value !== 'string') return {}
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return { unparsed: value }
  }
}

function messagePayload(event) {
  const data = event?.data
  if (!data || typeof data !== 'object') return undefined
  return data.message && typeof data.message === 'object' ? data.message : data
}

function nonEmpty(value) {
  if (Array.isArray(value)) return value.length > 0
  if (value && typeof value === 'object') return Object.keys(value).length > 0
  if (typeof value === 'string') return value.length > 0
  return Boolean(value)
}

function analyzeToolMessages(events) {
  const calls = new Map()
  const results = new Map()
  for (const event of events) {
    if (event.type !== 'message') continue
    const message = messagePayload(event)
    if (message?.role === 'assistant' && Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        const id = String(call?.id || '')
        if (!id) continue
        calls.set(id, {
          id,
          name: String(call?.function?.name || 'unknown'),
          args: parseArguments(call?.function?.arguments),
          sequence: number(event.sequence) ?? 0,
        })
      }
    } else if (message?.role === 'tool' && typeof message.tool_call_id === 'string') {
      results.set(message.tool_call_id, (results.get(message.tool_call_id) || 0) + 1)
    }
  }

  const unmatchedCalls = [...calls.values()].filter(call => !results.has(call.id)).map(call => call.id)
  const unmatchedResults = [...results.keys()].filter(id => !calls.has(id))
  const duplicateResults = [...results].filter(([, count]) => count > 1).map(([id]) => id)
  const byName = {}
  for (const call of calls.values()) byName[call.name] = (byName[call.name] || 0) + 1

  const compactionSequences = events.filter(event => event.type === 'compaction').map(event => number(event.sequence) ?? 0)
  const signatureGroups = new Map()
  for (const call of calls.values()) {
    if (!EXPLORATION_TOOLS.has(call.name)) continue
    const signature = `${call.name}:${JSON.stringify(stable(call.args))}`
    const epoch = compactionSequences.filter(sequence => sequence < call.sequence).length
    const group = signatureGroups.get(signature) || { name: call.name, count: 0, epochs: new Set(), calls: [] }
    group.count += 1
    group.epochs.add(epoch)
    group.calls.push(call.id)
    signatureGroups.set(signature, group)
  }
  const repeated = [...signatureGroups.values()].filter(group => group.count > 1)
  const repeatedAcrossCompactions = repeated.filter(group => group.epochs.size > 1)
  return {
    uniqueCalls: calls.size,
    resultMessages: [...results.values()].reduce((sum, count) => sum + count, 0),
    unmatchedCalls,
    unmatchedResults,
    duplicateResults,
    byName,
    exploration: {
      totalCalls: [...calls.values()].filter(call => EXPLORATION_TOOLS.has(call.name)).length,
      byName: Object.fromEntries([...calls.values()].filter(call => EXPLORATION_TOOLS.has(call.name)).reduce((map, call) => map.set(call.name, (map.get(call.name) || 0) + 1), new Map())),
      repeatedExactSignatures: repeated.reduce((sum, group) => sum + group.count - 1, 0),
      repeatedSignaturesAcrossCompactionEpochs: repeatedAcrossCompactions.length,
      repeatedCallsAcrossCompactionEpochs: repeatedAcrossCompactions.reduce((sum, group) => sum + group.count - 1, 0),
      examples: repeatedAcrossCompactions.slice(0, 12).map(group => ({ tool: group.name, calls: group.count, epochs: group.epochs.size, callIds: group.calls.slice(0, 5) })),
    },
  }
}

function analyzeLifecycle(events) {
  const calls = new Map()
  for (const event of events) {
    if (event.type !== 'tool.call') continue
    const data = event.data || {}
    const id = String(data.callId || '')
    if (!id) continue
    const current = calls.get(id) || { name: String(data.name || 'unknown'), states: [], startedAt: undefined, endedAt: undefined }
    if (data.state) current.states.push(String(data.state))
    current.startedAt ??= number(data.startedAt)
    current.endedAt = number(data.endedAt) ?? current.endedAt
    if (data.state === 'completed' || data.state === 'failed' || data.state === 'cancelled') current.endedAt ??= number(event.ts)
    calls.set(id, current)
  }
  const durations = [...calls.values()].flatMap(call => call.startedAt !== undefined && call.endedAt !== undefined ? [Math.max(0, call.endedAt - call.startedAt)] : [])
  const incomplete = [...calls.values()].filter(call => !['completed', 'failed', 'cancelled', 'error'].some(state => call.states.includes(state))).length
  return { uniqueCalls: calls.size, incompleteCalls: incomplete, lifecycleDurationMs: stats(durations) }
}

function analyzeCheckpoints(events) {
  const checkpoints = events.filter(event => event.type === 'context.checkpoint').map(event => event.data || {})
  const fields = ['readCoverage', 'exploration', 'evidenceLedger', 'toolOutputReferences', 'activeTaskIds', 'todo', 'loadedSkills', 'instructions', 'answeredQuestions', 'mutations', 'continuation']
  const stateCoverage = Object.fromEntries(fields.map(field => [field, {
    present: checkpoints.filter(checkpoint => checkpoint.machineState && Object.hasOwn(checkpoint.machineState, field)).length,
    nonEmpty: checkpoints.filter(checkpoint => nonEmpty(checkpoint.machineState?.[field])).length,
  }]))
  const full = checkpoints.filter(checkpoint => checkpoint.stage === 'full-compaction').length
  const compactEpochs = new Set(events.filter(event => event.type === 'compaction').map(event => `${event.data?.epoch ?? ''}:${event.data?.summaryRevision ?? ''}`))
  const checkpointEpochs = new Set(checkpoints.filter(checkpoint => checkpoint.stage === 'full-compaction').map(checkpoint => `${checkpoint.epoch ?? checkpoint.machineState?.epoch ?? ''}:${checkpoint.summaryRevision ?? checkpoint.machineState?.summaryRevision ?? ''}`))
  return {
    count: checkpoints.length,
    fullCompactionCheckpoints: full,
    baselineCheckpoints: checkpoints.filter(checkpoint => checkpoint.stage === 'baseline').length,
    microPruneCheckpoints: checkpoints.filter(checkpoint => checkpoint.stage === 'micro-prune').length,
    unmatchedCompactionEpochs: [...compactEpochs].filter(epoch => !checkpointEpochs.has(epoch)),
    unmatchedCheckpointEpochs: [...checkpointEpochs].filter(epoch => !compactEpochs.has(epoch)),
    stateCoverage,
    latest: checkpoints.at(-1) ? {
      stage: checkpoints.at(-1).stage,
      epoch: checkpoints.at(-1).epoch,
      summaryRevision: checkpoints.at(-1).summaryRevision,
      messageCount: Array.isArray(checkpoints.at(-1).messages) ? checkpoints.at(-1).messages.length : null,
      machineStateFields: Object.keys(checkpoints.at(-1).machineState || {}).sort(),
    } : null,
  }
}

function providerRoundKey(data) {
  if (typeof data?.turnId !== 'string' || !data.turnId) return undefined
  const round = typeof data.round === 'number'
    ? data.round
    : typeof data.round === 'string' && data.round.trim() !== ''
      ? Number(data.round)
      : Number.NaN
  return Number.isSafeInteger(round) && round >= 0 ? `${data.turnId}:${round}` : undefined
}

function analyzeProviderUsage(events) {
  const providerTurnEvents = events.filter(event => event.type === 'provider.turn')
  const providerRounds = new Set(providerTurnEvents.flatMap(event => {
    const key = providerRoundKey(event.data)
    return key ? [key] : []
  }))

  const dedicatedUsageEvents = events.filter(event => event.type === 'provider.usage')
  const dedicatedRounds = new Set(dedicatedUsageEvents.flatMap(event => {
    const key = providerRoundKey(event.data)
    return key ? [key] : []
  }))

  // Older session logs sometimes embedded usage directly in provider.turn events.
  // Retain compatibility, but do not count an embedded copy when the newer
  // dedicated provider.usage event exists for the same turn/round.
  const seenLegacyRounds = new Set()
  const legacyUsageEvents = providerTurnEvents.flatMap(event => {
    const data = event.data || {}
    const usage = data.usage && typeof data.usage === 'object' ? data.usage : data
    const hasUsage = ['inputTokens', 'promptTokens', 'input_tokens', 'prompt_tokens']
      .some(key => Object.hasOwn(usage, key))
    if (!hasUsage) return []
    const key = providerRoundKey(data)
    if (key && (dedicatedRounds.has(key) || seenLegacyRounds.has(key))) return []
    if (key) seenLegacyRounds.add(key)
    return [{ type: 'provider.usage', ts: event.ts, data: {
      ...usage,
      ...(data.turnId === undefined ? {} : { turnId: data.turnId }),
      ...(data.round === undefined ? {} : { round: data.round }),
      recordedAt: usage.recordedAt ?? event.ts,
    } }]
  })

  const aggregate = aggregateProviderUsageEvents([...dedicatedUsageEvents, ...legacyUsageEvents])
  return {
    providerRoundEvents: providerTurnEvents.length,
    providerRounds: providerRounds.size || aggregate.requests,
    eventsWithUsage: aggregate.requests,
    providerReportedRequests: aggregate.providerReportedRequests,
    estimatedRequests: aggregate.estimatedRequests,
    missingUsageRounds: Math.max(0, providerRounds.size - aggregate.requests),
    recordedUsageAvailable: aggregate.requests > 0,
    inputTokens: aggregate.inputTokens,
    nonCachedInputTokens: aggregate.nonCachedInputTokens,
    outputTokens: aggregate.outputTokens,
    totalTokens: aggregate.totalTokens,
    estimateInputTokens: aggregate.estimateInputTokens,
    cacheReadTokens: aggregate.cacheReadTokens,
    cacheWriteTokens: aggregate.cacheWriteTokens,
    reasoningTokens: aggregate.reasoningTokens,
    driftPercent: aggregate.driftPercent ?? null,
    routes: aggregate.routes,
  }
}

function analyzeCompactions(events) {
  const compactEvents = events.filter(event => event.type === 'compaction').map(event => event.data || {})
  const footprints = compactEvents.map(data => number(data.tokens)).filter(value => value !== undefined)
  const messageTokens = compactEvents.map(data => number(data.messageTokens)).filter(value => value !== undefined)
  const schemaTokens = compactEvents.map(data => number(data.schemaTokens)).filter(value => value !== undefined)
  const headroom = compactEvents.flatMap(data => {
    const used = number(data.tokens)
    const usable = number(data.budget?.usableTokens)
    return used === undefined || usable === undefined ? [] : [usable - used]
  })
  const ratios = compactEvents.flatMap(data => {
    const used = number(data.tokens)
    const usable = number(data.budget?.usableTokens)
    return used === undefined || !usable ? [] : [used / usable]
  })
  const summaryCoverage = compactEvents.map(data => {
    const summary = typeof data.summary === 'string' ? data.summary : ''
    return SUMMARY_HEADINGS.filter(pattern => pattern.test(summary)).length
  })
  const summaries = compactEvents.map(data => String(data.summary || ''))
  const duplicateSummaries = summaries.length - new Set(summaries).size
  const times = events.filter(event => event.type === 'compaction').map(event => number(event.ts)).filter(value => value !== undefined)
  const gaps = times.slice(1).map((value, index) => Math.max(0, value - times[index]))
  const contextLimits = compactEvents.map(data => number(data.budget?.maxContextTokens)).filter(value => value !== undefined)
  const providerUsage = analyzeProviderUsage(events)

  return {
    count: compactEvents.length,
    stages: compactEvents.reduce((result, data) => { const stage = String(data.stage || 'unspecified'); result[stage] = (result[stage] || 0) + 1; return result }, {}),
    contextWindowTokens: stats(contextLimits),
    footprintTokens: stats(footprints),
    messageTokens: stats(messageTokens),
    schemaTokens: stats(schemaTokens),
    postCompactionHeadroomTokens: stats(headroom),
    postCompactionUsableBudgetRatio: stats(ratios),
    removedMessages: stats(compactEvents.map(data => number(data.removed)).filter(value => value !== undefined)),
    compactionIntervalMs: stats(gaps),
    summaries: { total: summaries.length, exactDuplicates: duplicateSummaries, requiredHeadingCoverage: stats(summaryCoverage), requiredHeadingCount: SUMMARY_HEADINGS.length },
    providerUsage,
  }
}

export function analyzeSessionEvents(events, loaded) {
  const sequences = events.map(event => number(event.sequence)).filter(value => value !== undefined)
  const uniqueSequences = new Set(sequences)
  const gaps = sequences.slice(1).filter((sequence, index) => sequence !== sequences[index] + 1)
  const timestamps = events.map(event => number(event.ts)).filter(value => value !== undefined)
  const messages = Array.isArray(loaded?.messages) ? loaded.messages : []
  const turns = events.filter(event => event.type === 'turn')
  const committedTurns = turns.filter(event => event.data?.status === 'committed')
  const users = messages.filter(message => message.role === 'user').length
  const assistants = messages.filter(message => message.role === 'assistant').length
  const toolResults = messages.filter(message => message.role === 'tool').length
  const checkpoint = events.filter(event => event.type === 'context.checkpoint').at(-1)?.data
  const meta = loaded?.meta || events.find(event => event.type === 'meta')?.data || {}
  const notificationEvents = events.filter(event => event.type === 'task.notification')
  const consumedTaskIds = new Set(events.filter(event => event.type === 'task.notification.consumed').map(event => String(event.data?.taskId || '')))
  const latestCompaction = events.find(event => event.type === 'compaction')?.data
  let counterfactual = null
  if (messages.length && latestCompaction?.budget && latestCompaction?.schemaTokens !== undefined) {
    const usableTokens = number(latestCompaction.budget.usableTokens)
    const schemaTokens = number(latestCompaction.schemaTokens)
    if (usableTokens !== undefined && schemaTokens !== undefined) {
      const rawMessageBudget = Math.max(256, usableTokens - schemaTokens)
      const checkpointNoticeBudget = Math.min(48_000, Math.max(64, Math.floor(rawMessageBudget * 0.08)))
      const reductionMessageBudget = Math.max(64, rawMessageBudget - checkpointNoticeBudget)
      const recentTokens = Math.min(number(latestCompaction.budget.recentTokens) ?? 0, Math.max(96, Math.floor(reductionMessageBudget * 0.38)))
      const objective = [...messages].reverse().find(message => message.role === 'user')?.content || ''
      const compacted = compactMessages(messages, reductionMessageBudget, {
        maxOutputTokens: 0,
        threshold: 1,
        reserveTokens: 0,
        recentTokens,
      }, { activeObjective: String(objective) })
      const retainedToolCalls = compacted.messages.filter(message => message.role === 'assistant' && message.tool_calls?.length)
        .flatMap(message => message.tool_calls || [])
      const retainedToolResults = new Set(compacted.messages.filter(message => message.role === 'tool' && message.tool_call_id).map(message => message.tool_call_id))
      const summaryMessage = compacted.messages.find(message => message.role === 'system' && String(message.content || '').startsWith('Earlier conversation summary.'))
      const summaryText = String(summaryMessage?.content || '')
      counterfactual = {
        mode: 'single-pass current-compactor; historical message-only transcript',
        inputMessages: messages.length,
        inputMessageTokens: estimateMessagesTokens(messages),
        messageBudgetTokens: reductionMessageBudget,
        retainedMessages: compacted.messages.length,
        retainedMessageTokens: estimateMessagesTokens(compacted.messages),
        removedMessages: compacted.removed,
        fittedSummaryTokens: estimateTokens(summaryText),
        fittedSummaryHeadings: SUMMARY_HEADINGS.filter(pattern => pattern.test(summaryText)).length,
        retainedToolCalls: retainedToolCalls.length,
        retainedToolResults: retainedToolResults.size,
        unmatchedRetainedToolCalls: retainedToolCalls.filter(call => !retainedToolResults.has(call.id)).map(call => call.id),
        scopeNote: 'System prompt, current instruction files, provider framing, and exact historical tool schemas are not present in the durable transcript; the recorded schema-token estimate is reserved separately.',
      }
    }
  }

  return {
    source: {
      sessionId: String(meta.id || ''),
      model: String(meta.model || 'unknown'),
      workspace: String(meta.cwd || ''),
      eventCount: events.length,
      firstTimestamp: timestamps.length ? Math.min(...timestamps) : null,
      lastTimestamp: timestamps.length ? Math.max(...timestamps) : null,
      durationMs: timestamps.length ? Math.max(...timestamps) - Math.min(...timestamps) : null,
      sequence: { count: sequences.length, unique: uniqueSequences.size, gaps: gaps.length, duplicateCount: sequences.length - uniqueSequences.size },
    },
    transcript: {
      reconstructedMessages: messages.length,
      estimatedMessageTokens: estimateMessagesTokens(messages),
      users,
      assistants,
      toolResults,
      turnEvents: turns.length,
      committedTurns: committedTurns.length,
    },
    compactions: analyzeCompactions(events),
    checkpoints: analyzeCheckpoints(events),
    toolMessages: analyzeToolMessages(events),
    toolLifecycle: analyzeLifecycle(events),
    taskNotifications: {
      count: notificationEvents.length,
      consumedCount: consumedTaskIds.size,
      unconsumedTaskIds: notificationEvents.map(event => String(event.data?.taskId || '')).filter(id => id && !consumedTaskIds.has(id)),
      statuses: notificationEvents.reduce((result, event) => { const status = String(event.data?.status || 'unspecified'); result[status] = (result[status] || 0) + 1; return result }, {}),
    },
    currentCompactorCounterfactual: counterfactual,
    latestCheckpointId: checkpoint?.id || null,
  }
}

export async function analyzeSessionFile(filePath) {
  const absolute = path.resolve(filePath)
  const text = await fs.readFile(absolute, 'utf8')
  const events = []
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue
    try {
      events.push(JSON.parse(line))
    } catch (error) {
      throw new Error(`Invalid JSONL at ${absolute}:${index + 1}: ${error.message}`)
    }
  }
  if (!events.length || events[0].type !== 'meta' || typeof events[0].data?.id !== 'string') {
    throw new Error(`${absolute} is not a TermAgent session log with a leading meta event`)
  }
  const id = events[0].data.id
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('Session ID contains unsupported path characters')

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'termagent-14h-replay-'))
  try {
    await fs.symlink(absolute, path.join(root, `${id}.jsonl`))
    const store = new SessionStore(root)
    const loaded = await store.load(id)
    const result = analyzeSessionEvents(events, loaded)
    const latest = await store.latestContextCheckpoint(id)
    result.canonicalReplay = {
      sessionStoreProjectionLoaded: true,
      latestCheckpointResolved: Boolean(latest),
      latestCheckpointEpoch: number(latest?.epoch) ?? null,
      latestCheckpointStage: latest?.stage || null,
      latestCheckpointMessageCount: Array.isArray(latest?.messages) ? latest.messages.length : null,
    }
    return result
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}

function formatReport(results) {
  const lines = ['# Phase 14H session replay analysis', '', 'This is a deterministic offline replay of the durable event log through TermAgent’s existing `SessionStore` projection. It does not call a provider or execute historical tools.', '']
  for (const result of results) {
    const source = result.source
    const compact = result.compactions
    const calls = result.toolMessages
    lines.push(`## ${source.sessionId}`, '')
    lines.push(`- Model: ${source.model}`)
    lines.push(`- Events: ${source.eventCount}; duration: ${(source.durationMs / 60_000).toFixed(1)} minutes`)
    lines.push(`- Reconstructed messages: ${result.transcript.reconstructedMessages}; estimated message tokens: ${result.transcript.estimatedMessageTokens}`)
    lines.push(`- Turns: ${result.transcript.committedTurns} committed`)
    lines.push(`- Compactions: ${compact.count}; recorded window: ${compact.contextWindowTokens.min ?? 'n/a'} tokens`)
    lines.push(`- Post-compaction footprint: p50 ${Math.round(compact.footprintTokens.p50 ?? 0)} tokens; p95 ${Math.round(compact.footprintTokens.p95 ?? 0)} tokens`)
    lines.push(`- Provider usage: ${compact.providerUsage.eventsWithUsage}/${compact.providerUsage.providerRounds} rounds recorded (${compact.providerUsage.providerReportedRequests} provider-reported; ${compact.providerUsage.estimatedRequests} estimated)`)
    if (compact.providerUsage.recordedUsageAvailable) {
      const usage = compact.providerUsage
      const fmtTokens = value => Number(value || 0).toLocaleString()
      lines.push(`- Usage totals: input ${fmtTokens(usage.inputTokens)} (${fmtTokens(usage.nonCachedInputTokens)} uncached + ${fmtTokens(usage.cacheReadTokens)} cache read); output ${fmtTokens(usage.outputTokens)}; total ${fmtTokens(usage.totalTokens)}; message-estimate drift ${usage.driftPercent === null ? 'n/a' : `${usage.driftPercent > 0 ? '+' : ''}${usage.driftPercent}%`}`)
    }
    lines.push(`- Tool-call/result pairing: ${calls.uniqueCalls - calls.unmatchedCalls.length}/${calls.uniqueCalls} paired; ${calls.duplicateResults.length} duplicate result IDs`)
    lines.push(`- Exact repeated exploration calls: ${calls.exploration.repeatedExactSignatures}; repeated across compaction epochs: ${calls.exploration.repeatedCallsAcrossCompactionEpochs}`)
    lines.push(`- Checkpoints: ${result.checkpoints.count}; full-compaction checkpoints: ${result.checkpoints.fullCompactionCheckpoints}; unmatched compaction epochs: ${result.checkpoints.unmatchedCompactionEpochs.length}`)
    lines.push(`- Task notifications: ${result.taskNotifications.count}; unconsumed: ${result.taskNotifications.unconsumedTaskIds.length}`)
    if (result.currentCompactorCounterfactual) {
      const candidate = result.currentCompactorCounterfactual
      lines.push(`- Current compactor one-pass check: ${candidate.inputMessageTokens} → ${candidate.retainedMessageTokens} estimated message tokens; ${candidate.retainedMessages} messages retained; ${candidate.unmatchedRetainedToolCalls.length} orphaned retained calls`)
    }
    lines.push('')
  }
  lines.push('## Interpretation limits', '')
  lines.push('- Provider usage is read from durable `provider.usage` events, with compatibility for older usage fields embedded in `provider.turn` events. Cache and reasoning fields are breakdowns, not additional input/output tokens.')
  lines.push('- Two session traces are observations, not a controlled A/B comparison. A clean-equivalent replay requires the same prompts, tool responses, provider route, tool schemas, and workspace snapshot.')
  lines.push('- The harness reconstructs durable message/checkpoint state and measures repeated tool signatures. It does not fabricate provider responses or re-execute shell/file mutations.')
  return `${lines.join('\n')}\n`
}

async function main(args) {
  if (!args.length || args.includes('--help') || args.includes('-h')) {
    process.stdout.write('Usage: node tools/phase14h-session-replay.mjs <session.jsonl> [session2.jsonl ...] [--json]\n')
    return
  }
  const json = args.includes('--json')
  const files = args.filter(value => value !== '--json')
  const results = []
  for (const file of files) results.push(await analyzeSessionFile(file))
  process.stdout.write(json ? `${JSON.stringify(results, null, 2)}\n` : formatReport(results))
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => {
    process.stderr.write(`${error.stack || error.message}\n`)
    process.exitCode = 1
  })
}
