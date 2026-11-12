#!/usr/bin/env node
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { compactMessages } from '../dist/agent/compaction.js'
import { accountContext, createContextBudget, estimateMessagesTokens, estimateToolSchemasTokens } from '../dist/context/budget.js'

function stable(value) {
  if (Array.isArray(value)) return value.map(stable)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]))
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex')
}

function validateWorkload(workload) {
  if (!workload || workload.version !== 1) throw new Error('Workload must use version: 1')
  if (typeof workload.id !== 'string' || !workload.id.trim()) throw new Error('Workload id is required')
  if (!workload.route || typeof workload.route.provider !== 'string' || typeof workload.route.model !== 'string') {
    throw new Error('Workload route must include provider and model')
  }
  if (!Number.isFinite(Number(workload.route.contextWindow)) || Number(workload.route.contextWindow) < 256) {
    throw new Error('route.contextWindow must be a number >= 256')
  }
  if (!Array.isArray(workload.initialMessages) || !Array.isArray(workload.requests) || workload.requests.length === 0) {
    throw new Error('Workload must include initialMessages and at least one request')
  }
  if (!Array.isArray(workload.tools)) throw new Error('Workload tools must be an array')
  for (const [index, request] of workload.requests.entries()) {
    if (!request || !Array.isArray(request.append)) throw new Error(`requests[${index}].append must be an array`)
    if (request.additionalRequestTokens !== undefined && (!Number.isFinite(Number(request.additionalRequestTokens)) || Number(request.additionalRequestTokens) < 0)) {
      throw new Error(`requests[${index}].additionalRequestTokens must be a non-negative number`)
    }
  }
}

function requestFootprint(messages, tools, extraTokens) {
  const accounting = accountContext(messages, tools)
  return {
    messageTokens: estimateMessagesTokens(messages),
    schemaTokens: accounting.toolDefinitions,
    multimodalTokens: accounting.multimodal,
    additionalRequestTokens: extraTokens,
    estimatedRequestTokens: accounting.total + extraTokens,
  }
}

function toolPairIntegrity(messages) {
  const calls = new Set()
  const results = new Set()
  for (const message of messages) {
    if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) if (call?.id) calls.add(String(call.id))
    }
    if (message.role === 'tool' && message.tool_call_id) results.add(String(message.tool_call_id))
  }
  return {
    calls: calls.size,
    results: results.size,
    unmatchedCalls: [...calls].filter(id => !results.has(id)),
    unmatchedResults: [...results].filter(id => !calls.has(id)),
  }
}

function runPolicy(workload, policy) {
  const route = workload.route
  const budget = createContextBudget({
    maxContextTokens: Number(route.contextWindow),
    maxOutputTokens: Number(route.maxOutputTokens ?? 0),
    threshold: Number(route.threshold ?? 0.82),
    reserveTokens: Number(route.reserveTokens ?? 0),
    recentTokens: Number(route.recentTokens ?? 0),
  })
  let messages = structuredClone(workload.initialMessages)
  const timeline = []
  let compactions = 0
  let overflowRequests = 0
  let blockedCompactions = 0
  let totalRemovedMessages = 0
  const actualRequestSizes = []

  for (const [index, request] of workload.requests.entries()) {
    messages.push(...structuredClone(request.append))
    const extra = Math.max(0, Math.floor(Number(request.additionalRequestTokens ?? workload.additionalRequestTokens ?? 0)))
    const before = requestFootprint(messages, workload.tools, extra)
    const legacyEstimate = before.messageTokens + before.schemaTokens
    const triggerEstimate = policy === 'legacy-message-schema-only' ? legacyEstimate : before.estimatedRequestTokens
    let compacted = false
    let removed = 0
    let after = before
    let compactReason = 'below-threshold'

    if (triggerEstimate > budget.usableTokens) {
      const messageBudget = policy === 'legacy-message-schema-only'
        ? budget.usableTokens - before.schemaTokens
        : budget.usableTokens - before.schemaTokens - before.multimodalTokens - extra
      if (messageBudget < 64) {
        blockedCompactions++
        compactReason = 'insufficient-message-budget'
      } else {
        const compactedResult = compactMessages(messages, messageBudget, {
          maxOutputTokens: 0,
          threshold: 1,
          reserveTokens: 0,
          recentTokens: Math.min(Number(route.recentTokens ?? 1_800) || 1_800, Math.floor(messageBudget * 0.42)),
        }, {
          activeObjective: String(request.objective || workload.objective || ''),
          todo: workload.todo || [],
        })
        messages = compactedResult.messages
        removed = compactedResult.removed
        totalRemovedMessages += removed
        after = requestFootprint(messages, workload.tools, extra)
        compacted = true
        compactions++
        compactReason = 'estimated-request-footprint-exceeded-budget'
      }
    }

    const overflow = after.estimatedRequestTokens > budget.usableTokens
    if (overflow) overflowRequests++
    actualRequestSizes.push(after.estimatedRequestTokens)
    const integrity = toolPairIntegrity(messages)
    timeline.push({
      requestId: String(request.id ?? `request-${index + 1}`),
      label: String(request.label ?? ''),
      triggerEstimate,
      legacyMessageSchemaEstimate: legacyEstimate,
      before,
      compacted,
      compactReason,
      removedMessages: removed,
      after,
      overflow,
      retainedToolCalls: integrity,
    })
  }

  return {
    policy,
    usableTokens: budget.usableTokens,
    compactions: compactions,
    overflowRequests,
    blockedCompactions,
    totalRemovedMessages,
    peakActualRequestTokens: Math.max(0, ...actualRequestSizes),
    meanActualRequestTokens: actualRequestSizes.length ? actualRequestSizes.reduce((sum, value) => sum + value, 0) / actualRequestSizes.length : 0,
    finalMessageCount: messages.length,
    finalMessageTokens: estimateMessagesTokens(messages),
    finalToolPairIntegrity: toolPairIntegrity(messages),
    timeline,
  }
}

export function runControlledReplay(workload) {
  validateWorkload(workload)
  const manifest = {
    id: workload.id,
    workspaceSnapshot: workload.workspaceSnapshot ?? null,
    objective: workload.objective ?? null,
    todo: workload.todo ?? [],
    route: workload.route,
    tools: workload.tools,
    initialMessages: workload.initialMessages,
    requests: workload.requests,
    additionalRequestTokens: workload.additionalRequestTokens ?? 0,
  }
  const workloadSha256 = digest(manifest)
  const policies = [
    runPolicy(workload, 'legacy-message-schema-only'),
    runPolicy(workload, 'request-footprint-aware'),
  ]
  return {
    version: 1,
    workload: {
      id: workload.id,
      workspaceSnapshot: workload.workspaceSnapshot ?? null,
      provider: workload.route.provider,
      model: workload.route.model,
      requestCount: workload.requests.length,
      initialMessageCount: workload.initialMessages.length,
      toolSchemaCount: workload.tools.length,
      sha256: workloadSha256,
    },
    equivalence: {
      identicalInputs: true,
      identicalProviderRoute: true,
      identicalToolSchemas: true,
      identicalOrderedRequests: true,
      providerExecuted: false,
      recordedToolOutcomesUsed: true,
      note: 'Both policies consume the same canonical workload data: ordered messages and tool results, schemas, route, workspace snapshot identifier, and request overhead. No provider call or tool is executed.',
    },
    comparison: {
      legacy: policies[0],
      current: policies[1],
      delta: {
        compactions: policies[1].compactions - policies[0].compactions,
        overflowRequests: policies[1].overflowRequests - policies[0].overflowRequests,
        peakActualRequestTokens: policies[1].peakActualRequestTokens - policies[0].peakActualRequestTokens,
      },
    },
  }
}

export function formatControlledReplay(result) {
  const { workload, comparison, equivalence } = result
  const lines = [
    '# Phase 14H controlled compaction replay',
    '',
    `- Workload: ${workload.id}`,
    `- SHA-256: ${workload.sha256}`,
    `- Route: ${workload.provider}/${workload.model}`,
    `- Ordered requests: ${workload.requestCount}`,
    `- Equivalent inputs: ${equivalence.identicalInputs ? 'yes' : 'no'}`,
    `- Provider executed: ${equivalence.providerExecuted ? 'yes' : 'no'}`,
    '',
    '| Metric | Legacy message/schema trigger | Request-footprint-aware |',
    '|---|---:|---:|',
    `| Compactions | ${comparison.legacy.compactions} | ${comparison.current.compactions} |`,
    `| Requests still over estimated budget | ${comparison.legacy.overflowRequests} | ${comparison.current.overflowRequests} |`,
    `| Peak actual request estimate | ${Math.round(comparison.legacy.peakActualRequestTokens)} | ${Math.round(comparison.current.peakActualRequestTokens)} |`,
    `| Mean actual request estimate | ${Math.round(comparison.legacy.meanActualRequestTokens)} | ${Math.round(comparison.current.meanActualRequestTokens)} |`,
    `| Removed messages | ${comparison.legacy.totalRemovedMessages} | ${comparison.current.totalRemovedMessages} |`,
    '',
    '## Interpretation limits',
    '',
    '- This is deterministic policy replay over recorded inputs, not a provider-backed A/B experiment.',
    '- Token values are TermAgent estimates. The replay does not establish tokenizer accuracy or provider framing costs.',
    '- A production clean-equivalent replay still needs provider usage, identical request schemas/route, and a pinned workspace snapshot from real sessions.',
    '',
  ]
  return `${lines.join('\n')}\n`
}

async function main(args) {
  if (!args.length || args.includes('--help') || args.includes('-h')) {
    process.stdout.write('Usage: node tools/phase14h-controlled-replay.mjs <workload.json> [--json] [--out <report.md>]\n')
    return
  }
  const json = args.includes('--json')
  const outIndex = args.indexOf('--out')
  const outPath = outIndex >= 0 ? args[outIndex + 1] : undefined
  const input = args.find(value => !value.startsWith('--') && value !== outPath)
  if (!input) throw new Error('A workload JSON path is required')
  const workload = JSON.parse(await fs.readFile(path.resolve(input), 'utf8'))
  const result = runControlledReplay(workload)
  const output = json ? `${JSON.stringify(result, null, 2)}\n` : formatControlledReplay(result)
  if (outPath) await fs.writeFile(path.resolve(outPath), formatControlledReplay(result), 'utf8')
  process.stdout.write(output)
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => {
    process.stderr.write(`${error.stack || error.message}\n`)
    process.exitCode = 1
  })
}
