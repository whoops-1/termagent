#!/usr/bin/env node
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { accountContext, estimateMessagesTokens } from '../dist/context/budget.js'

function stable(value) {
  if (Array.isArray(value)) return value.map(stable)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]))
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex')
}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function percentile(values, fraction) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)]
}

function distribution(values) {
  const rows = values.filter(Number.isFinite)
  if (!rows.length) return { count: 0, mean: null, p50: null, p95: null, max: null }
  return {
    count: rows.length,
    mean: rows.reduce((sum, value) => sum + value, 0) / rows.length,
    p50: percentile(rows, 0.5),
    p95: percentile(rows, 0.95),
    max: Math.max(...rows),
  }
}

function validateTrace(trace, source = '<memory>') {
  if (!trace || trace.schemaVersion !== 1 || trace.kind !== 'termagent.provider-request-trace') {
    throw new Error(`${source}: unsupported or invalid TermAgent provider trace format`)
  }
  if (!trace.route || typeof trace.route.provider !== 'string' || typeof trace.route.model !== 'string') {
    throw new Error(`${source}: missing provider route`)
  }
  if (!trace.request || !Array.isArray(trace.request.messages) || !Array.isArray(trace.request.tools)) {
    throw new Error(`${source}: missing captured provider request messages/tools`)
  }
  if (typeof trace.request.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(trace.request.sha256)) {
    throw new Error(`${source}: missing request SHA-256`)
  }
  const actualDigest = digest({ messages: trace.request.messages, tools: trace.request.tools })
  if (actualDigest !== trace.request.sha256) throw new Error(`${source}: request payload SHA-256 mismatch`)
  return trace
}

export function analyzeProviderTraces(traces, options = {}) {
  const rows = traces.map((trace, index) => {
    validateTrace(trace, `trace[${index}]`)
    const accounting = accountContext(trace.request.messages, trace.request.tools)
    const messageEstimate = estimateMessagesTokens(trace.request.messages)
    const providerUsage = trace.measurement?.providerUsage
    if (!providerUsage || typeof providerUsage !== 'object') {
      return {
        traceId: trace.traceId || `trace-${index + 1}`,
        provider: trace.route.provider,
        model: trace.route.model,
        requestSha256: trace.request.sha256,
        providerReported: false,
        estimatedMessageTokens: messageEstimate,
        estimatedRequestTokens: accounting.total,
      }
    }

    const inputTokens = finite(providerUsage.inputTokens)
    const outputTokens = finite(providerUsage.outputTokens)
    if (inputTokens === undefined || outputTokens === undefined || inputTokens < 0 || outputTokens < 0) {
      throw new Error(`trace[${index}]: provider usage is missing valid input/output token counts`)
    }
    const separateCache = providerUsage.cacheTokensExcludedFromInput === true
      ? (finite(providerUsage.cacheReadTokens) || 0) + (finite(providerUsage.cacheWriteTokens) || 0)
      : 0
    const observedInputTokens = inputTokens + separateCache
    const observedContextTokens = finite(providerUsage.contextTokens) ?? observedInputTokens
    const messageDriftPercent = ((observedContextTokens - messageEstimate) / Math.max(1, observedContextTokens)) * 100
    const requestDriftPercent = ((observedContextTokens - accounting.total) / Math.max(1, observedContextTokens)) * 100
    const nativeCount = finite(trace.measurement?.providerNativeCount?.inputTokens)
    const budget = finite(trace.route.usableTokens)

    return {
      traceId: trace.traceId || `trace-${index + 1}`,
      provider: trace.route.provider,
      model: trace.route.model,
      requestSha256: trace.request.sha256,
      providerReported: true,
      estimatedMessageTokens: messageEstimate,
      estimatedRequestTokens: accounting.total,
      observedInputTokens,
      observedContextTokens,
      observedOutputTokens: outputTokens,
      messageDriftTokens: messageEstimate - observedContextTokens,
      requestDriftTokens: accounting.total - observedContextTokens,
      messageDriftPercent,
      requestDriftPercent,
      providerNativeCount: nativeCount ?? null,
      providerNativeCountDriftTokens: nativeCount === undefined ? null : nativeCount - observedContextTokens,
      usableTokens: budget ?? null,
      providerCountOverBudget: budget === undefined ? null : observedContextTokens > budget,
      nativeCountOverBudget: budget === undefined || nativeCount === undefined ? null : nativeCount > budget,
      requestComponents: accounting,
    }
  })

  const measured = rows.filter(row => row.providerReported)
  const providers = new Map()
  for (const row of measured) {
    const key = `${row.provider}/${row.model}`
    const group = providers.get(key) || { provider: row.provider, model: row.model, requests: 0, observedContextTokens: 0, estimatedRequestTokens: 0, drift: [] }
    group.requests++
    group.observedContextTokens += row.observedContextTokens
    group.estimatedRequestTokens += row.estimatedRequestTokens
    group.drift.push(row.requestDriftPercent)
    providers.set(key, group)
  }

  return {
    schemaVersion: 1,
    kind: 'termagent.provider-trace-analysis',
    captureCount: rows.length,
    providerReportedCount: measured.length,
    missingUsageCount: rows.length - measured.length,
    providerUsageAvailable: measured.length > 0,
    exactPayloadsVerified: true,
    cleanEquivalentCompactionAB: false,
    note: 'This replays the captured exact request payloads through TermAgent\'s current estimator and compares them with actual provider-reported usage. It does not execute providers/tools or claim a clean-equivalent old-vs-new compaction A/B; that requires a chronological trace with pre-compaction conversation states and recorded tool outcomes.',
    distributions: {
      estimatedMessageTokens: distribution(measured.map(row => row.estimatedMessageTokens)),
      estimatedRequestTokens: distribution(measured.map(row => row.estimatedRequestTokens)),
      observedContextTokens: distribution(measured.map(row => row.observedContextTokens)),
      requestDriftPercent: distribution(measured.map(row => row.requestDriftPercent)),
      absoluteRequestDriftPercent: distribution(measured.map(row => Math.abs(row.requestDriftPercent))),
      providerNativeCountDriftTokens: distribution(measured.map(row => row.providerNativeCountDriftTokens).filter(Number.isFinite)),
    },
    routes: [...providers.values()].sort((a, b) => b.requests - a.requests || a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model)).map(group => ({
      provider: group.provider,
      model: group.model,
      requests: group.requests,
      observedContextTokens: group.observedContextTokens,
      estimatedRequestTokens: group.estimatedRequestTokens,
      weightedDriftPercent: group.observedContextTokens > 0
        ? ((group.observedContextTokens - group.estimatedRequestTokens) / group.observedContextTokens) * 100
        : null,
    })),
    runtimeCalibration: Array.isArray(options.sessionEvents)
      ? analyzeRuntimeCalibration(traces, options.sessionEvents, { mode: 'decay', decayFactor: 0.75 })
      : { available: false, reason: 'Pass --session-log to replay the in-session adaptive calibration path.' },
    calibrationComparisons: Array.isArray(options.sessionEvents)
      ? [
          analyzeRuntimeCalibration(traces, options.sessionEvents, { mode: 'carry' }),
          analyzeRuntimeCalibration(traces, options.sessionEvents, { mode: 'reset' }),
          ...[0.25, 0.5, 0.75].map(decayFactor => analyzeRuntimeCalibration(traces, options.sessionEvents, { mode: 'decay', decayFactor })),
        ]
      : [],
    samples: rows,
  }
}

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex')
}

function usageEstimate(report, schemaTokens) {
  const full = finite(report.estimateRequestTokens)
  if (full !== undefined && full > 0) return full
  const messages = finite(report.estimateInputTokens)
  return messages === undefined ? undefined : messages + schemaTokens
}

function measuredTokens(report) {
  const context = finite(report.contextTokens)
  const input = finite(report.inputTokens)
  return context ?? input
}

function ratioSample(measured, estimated) {
  if (!Number.isFinite(measured) || measured <= 0 || !Number.isFinite(estimated) || estimated <= 0) return undefined
  return Math.max(1, Math.min(4, measured / estimated))
}

function routeKey(route) {
  return `${route.provider}\u0000${route.model}\u0000${route.contextWindow}`
}

/**
 * Replay the exact route-scoped calibration logic used in Agent.run(). This is
 * a shadow calculation: every prediction is made before consuming that
 * capture's provider usage, and session events supply only prior measurements,
 * turn-start boundaries, and completed compaction boundaries.
 */
export function analyzeRuntimeCalibration(traces, sessionEvents, policy = { mode: 'decay', decayFactor: 0.75 }) {
  const calibrationPolicy = typeof policy === 'string' ? { mode: policy } : policy
  const policyMode = ['carry', 'reset', 'decay'].includes(calibrationPolicy.mode) ? calibrationPolicy.mode : 'reset'
  const decayFactor = Number.isFinite(calibrationPolicy.decayFactor) ? Math.max(0, Math.min(1, calibrationPolicy.decayFactor)) : 0.5
  if (!Array.isArray(sessionEvents) || !sessionEvents.length) {
    return { available: false, reason: 'No session event log was supplied.' }
  }

  const meta = sessionEvents.find(event => event?.type === 'meta')?.data
  const expectedSessionHash = typeof meta?.id === 'string' ? sha256(meta.id) : undefined
  const traceSessionHashes = [...new Set(traces.map(trace => trace.sessionIdHash).filter(value => typeof value === 'string'))]
  const sessionIdentityMatched = Boolean(expectedSessionHash && traceSessionHashes.length === 1 && traceSessionHashes[0] === expectedSessionHash)
  if (!sessionIdentityMatched) {
    return {
      available: false,
      reason: 'The session log identity does not match this trace set; calibration replay was not attempted.',
      sessionIdentityMatched: false,
      traceSessionCount: traceSessionHashes.length,
    }
  }

  const starts = new Map()
  const usageByTurnRound = new Map()
  const completedCompactions = []
  const sessionUsage = []
  for (let index = 0; index < sessionEvents.length; index++) {
    const event = sessionEvents[index]
    const data = event?.data
    if (!event || !data || typeof data !== 'object') continue
    if (event.type === 'turn' && data.status === 'started' && typeof data.id === 'string') {
      starts.set(sha256(data.id), { index, timestamp: finite(event.ts) ?? finite(data.started) ?? 0 })
    }
    if (event.type === 'compaction' && data.stage !== 'started') {
      completedCompactions.push({ index, timestamp: finite(event.ts) ?? 0 })
    }
    if (event.type === 'provider.usage') {
      const turnHash = typeof data.turnId === 'string' ? sha256(data.turnId) : undefined
      const round = finite(data.round)
      if (turnHash && round !== undefined) {
        const key = `${turnHash}:${round}`
        usageByTurnRound.set(key, event)
      }
      sessionUsage.push({ index, event })
    }
  }

  const grouped = new Map()
  for (const trace of [...traces].sort((a, b) => a.capturedAt - b.capturedAt)) {
    const key = trace.turnIdHash
    if (!grouped.has(key)) grouped.set(key, [])
    grouped.get(key).push(trace)
  }

  const samples = []
  let matchedTurns = 0
  let matchedUsageEvents = 0
  let mismatchedUsageEvents = 0
  let compactionBoundaries = 0
  let skippedTurns = 0
  let turnsSeededFromPersistedUsage = 0

  const orderedTurns = [...grouped.entries()].map(([turnHash, rows]) => ({
    turnHash,
    rows,
    start: starts.get(turnHash),
  })).sort((a, b) => (a.start?.index ?? Number.MAX_SAFE_INTEGER) - (b.start?.index ?? Number.MAX_SAFE_INTEGER))

  for (const turn of orderedTurns) {
    if (!turn.start) {
      skippedTurns++
      continue
    }
    matchedTurns++
    const turnRows = turn.rows.sort((a, b) => a.capturedAt - b.capturedAt)
    const firstRoute = turnRows[0]?.route
    const schemaTokens = finite(turnRows[0]?.measurement?.requestComponents?.toolDefinitions) ?? 0
    let activeRoute = firstRoute ? routeKey(firstRoute) : ''

    // Agent.run() reconstructs its initial calibration from durable usage
    // reports after the latest completed compaction at turn entry.
    let latestCompactionIndex = -1
    for (const compact of completedCompactions) {
      if (compact.index < turn.start.index) latestCompactionIndex = Math.max(latestCompactionIndex, compact.index)
    }
    const priorReports = sessionUsage
      .filter(item => item.index > latestCompactionIndex && item.index < turn.start.index)
      .map(item => item.event.data)
      .filter(report => report?.estimated !== true && firstRoute
        && report.provider === firstRoute.provider
        && report.model === firstRoute.model
        && report.contextWindow === firstRoute.contextWindow)
    const recentRatios = priorReports
      .slice(-5)
      .map(report => ratioSample(measuredTokens(report), usageEstimate(report, schemaTokens)))
      .filter(Number.isFinite)
      .sort((a, b) => a - b)
    let providerTokenRatio = recentRatios.length
      ? recentRatios[Math.floor(recentRatios.length / 2)]
      : 1
    let epochPriorActive = false
    if (recentRatios.length) turnsSeededFromPersistedUsage++
    const latestMeasured = priorReports.at(-1)
    let baseline = latestMeasured
      ? {
          measuredTokens: measuredTokens(latestMeasured),
          estimatedRequestTokens: usageEstimate(latestMeasured, schemaTokens),
          provider: latestMeasured.provider,
          model: latestMeasured.model,
          contextWindow: latestMeasured.contextWindow,
        }
      : undefined

    let previousCaptureAt = turn.start.timestamp
    for (const trace of turnRows) {
      const compactBeforeNextRequest = completedCompactions.some(compact =>
        compact.timestamp > previousCaptureAt && compact.timestamp < trace.capturedAt,
      )
      if (compactBeforeNextRequest) {
        // Compare alternative epoch transitions offline. Runtime uses a
        // bounded decayed prior for the first request in the new epoch.
        const previousRatio = providerTokenRatio
        baseline = undefined
        if (policyMode === 'reset') {
          recentRatios.length = 0
          providerTokenRatio = 1
          epochPriorActive = false
        } else if (policyMode === 'decay') {
          recentRatios.length = 0
          providerTokenRatio = 1 + (previousRatio - 1) * decayFactor
          epochPriorActive = Math.abs(providerTokenRatio - 1) > 1e-9
        }
        compactionBoundaries++
      }

      const currentRoute = routeKey(trace.route)
      if (activeRoute !== currentRoute) {
        activeRoute = currentRoute
        providerTokenRatio = 1
        recentRatios.length = 0
        baseline = undefined
        epochPriorActive = false
      }

      const raw = finite(trace.measurement?.estimatedRequestTokens)
      const observed = finite(trace.measurement?.observedContextTokens)
        ?? finite(trace.measurement?.observedInputTokens)
      if (raw === undefined || observed === undefined || observed <= 0) {
        previousCaptureAt = trace.capturedAt
        continue
      }

      const routeMatches = baseline
        && baseline.provider === trace.route.provider
        && baseline.model === trace.route.model
        && baseline.contextWindow === trace.route.contextWindow
      const local = raw
      const ratioAdjusted = Math.ceil(raw * providerTokenRatio)
      const baselineAdjusted = routeMatches
        ? Math.max(0, baseline.measuredTokens + (raw - baseline.estimatedRequestTokens))
        : 0
      const nativeCount = finite(trace.measurement?.providerNativeCount?.inputTokens)
      const nativeAdjusted = Math.max(0, nativeCount ?? 0)
      const effective = Math.max(local, ratioAdjusted, baselineAdjusted, nativeAdjusted)
      const calibrationSource = nativeCount !== undefined
        ? 'native-count'
        : routeMatches && recentRatios.length > 0
          ? 'measured-baseline+rolling-route-ratio'
          : routeMatches
            ? 'measured-baseline'
            : recentRatios.length > 0
              ? 'rolling-route-ratio'
              : epochPriorActive
                ? 'compaction-epoch-prior'
                : 'cold-start-estimate'
      const budget = finite(trace.route.usableTokens)
      const usageEvent = usageByTurnRound.get(`${turn.turnHash}:${trace.round}`)
      const traceUsage = trace.measurement?.providerUsage
      const exactUsageMatch = Boolean(usageEvent
        && usageEvent.ts === trace.capturedAt
        && usageEvent.data?.provider === trace.route.provider
        && usageEvent.data?.model === trace.route.model
        && usageEvent.data?.contextWindow === trace.route.contextWindow
        && finite(usageEvent.data?.inputTokens) === finite(traceUsage?.inputTokens)
        && finite(usageEvent.data?.outputTokens) === finite(traceUsage?.outputTokens)
        && finite(usageEvent.data?.estimateRequestTokens) === raw)
      if (exactUsageMatch) matchedUsageEvents++
      else mismatchedUsageEvents++

      samples.push({
        traceId: trace.traceId,
        turnIdHash: turn.turnHash,
        round: trace.round,
        capturedAt: trace.capturedAt,
        rawEstimatedRequestTokens: raw,
        adaptiveEstimatedRequestTokens: effective,
        observedContextTokens: observed,
        providerTokenRatio,
        calibrationSource,
        baselineAdjustedTokens: baselineAdjusted,
        ratioAdjustedTokens: ratioAdjusted,
        nativeCountTokens: nativeCount ?? null,
        usableTokens: budget ?? null,
        rawEstimateOverBudget: budget === undefined ? null : raw > budget,
        adaptiveEstimateOverBudget: budget === undefined ? null : effective > budget,
        providerObservedOverBudget: budget === undefined ? null : observed > budget,
        adaptiveMissedBudgetCrossing: budget === undefined ? null : observed > budget && effective <= budget,
        signedErrorPercent: ((effective - observed) / observed) * 100,
        absoluteErrorPercent: (Math.abs(effective - observed) / observed) * 100,
        exactUsageMatch,
      })

      const nextRatio = ratioSample(observed, raw)
      if (nextRatio !== undefined) {
        // Mirrors Agent.run(): retain the last four sample slots, append the
        // latest request ratio, then take the upper-middle of the sorted copy.
        recentRatios.splice(0, recentRatios.length, ...[...recentRatios.slice(-4), nextRatio])
        const sorted = [...recentRatios].sort((a, b) => a - b)
        providerTokenRatio = sorted[Math.floor(sorted.length / 2)] || 1
        epochPriorActive = false
        baseline = {
          measuredTokens: observed,
          estimatedRequestTokens: raw,
          provider: trace.route.provider,
          model: trace.route.model,
          contextWindow: trace.route.contextWindow,
        }
      }
      previousCaptureAt = trace.capturedAt
    }
  }

  const actual = samples.map(sample => sample.observedContextTokens)
  const adaptive = samples.map(sample => sample.adaptiveEstimatedRequestTokens)
  const errors = samples.map(sample => sample.signedErrorPercent)
  const absoluteErrors = samples.map(sample => sample.absoluteErrorPercent)
  const totalActual = actual.reduce((sum, value) => sum + value, 0)
  const totalAdaptive = adaptive.reduce((sum, value) => sum + value, 0)
  return {
    available: true,
    calibrationPolicy: policyMode,
    calibrationDecayFactor: policyMode === 'decay' ? decayFactor : null,
    sessionIdentityMatched: true,
    matchedTurns,
    skippedTurns,
    matchedUsageEvents,
    mismatchedUsageEvents,
    compactionCount: completedCompactions.length,
    compactionBoundaries,
    turnsSeededFromPersistedUsage,
    coldStartRequestCount: samples.filter(sample => sample.calibrationSource === 'cold-start-estimate').length,
    compactionEpochPriorRequestCount: samples.filter(sample => sample.calibrationSource === 'compaction-epoch-prior').length,
    baselineBackedRequestCount: samples.filter(sample => sample.calibrationSource.includes('measured-baseline')).length,
    ratioCalibratedRequestCount: samples.filter(sample => sample.calibrationSource.includes('rolling-route-ratio')).length,
    nativeCountRequestCount: samples.filter(sample => sample.calibrationSource === 'native-count').length,
    captureCount: samples.length,
    aggregateSignedErrorPercent: totalActual > 0 ? ((totalAdaptive - totalActual) / totalActual) * 100 : null,
    signedErrorPercent: distribution(errors),
    absoluteErrorPercent: distribution(absoluteErrors),
    underPredictions: samples.filter(sample => sample.adaptiveEstimatedRequestTokens < sample.observedContextTokens).length,
    overPredictions: samples.filter(sample => sample.adaptiveEstimatedRequestTokens > sample.observedContextTokens).length,
    rawEstimateOverBudgetCount: samples.filter(sample => sample.rawEstimateOverBudget === true).length,
    adaptiveEstimateOverBudgetCount: samples.filter(sample => sample.adaptiveEstimateOverBudget === true).length,
    providerObservedOverBudgetCount: samples.filter(sample => sample.providerObservedOverBudget === true).length,
    adaptiveMissedBudgetCrossingCount: samples.filter(sample => sample.adaptiveMissedBudgetCrossing === true).length,
    missedBudgetCrossings: samples.filter(sample => sample.adaptiveMissedBudgetCrossing === true).map(sample => ({ traceId: sample.traceId, round: sample.round, predictedTokens: sample.adaptiveEstimatedRequestTokens, observedTokens: sample.observedContextTokens, usableTokens: sample.usableTokens, missedByTokens: sample.observedContextTokens - sample.usableTokens })),
    maxAbsoluteErrorSample: samples.reduce((max, sample) => !max || sample.absoluteErrorPercent > max.absoluteErrorPercent ? sample : max, null),
    samples,
    note: 'Shadow replay of Agent.run() route-scoped calibration. Predictions use only earlier provider usage, the session log compaction boundaries, and the exact route; the current capture usage is applied only after its prediction. This measures estimator behavior, not a provider-backed compaction A/B.',
  }
}

export async function loadSessionEventLog(inputPath) {
  const resolved = path.resolve(inputPath)
  const contents = await fs.readFile(resolved, 'utf8')
  const events = []
  for (const [index, line] of contents.split(/\r?\n/).entries()) {
    if (!line.trim()) continue
    let event
    try {
      event = JSON.parse(line)
    } catch (error) {
      throw new Error(`${resolved}:${index + 1}: invalid JSONL event (${error instanceof Error ? error.message : String(error)})`)
    }
    if (!event || typeof event !== 'object' || typeof event.type !== 'string') {
      throw new Error(`${resolved}:${index + 1}: invalid session event shape`)
    }
    events.push(event)
  }
  if (!events.length) throw new Error(`No session events found in ${resolved}`)
  return events
}

export async function loadProviderTraces(inputPath) {
  const resolved = path.resolve(inputPath)
  const stat = await fs.stat(resolved)
  let files
  if (stat.isDirectory()) {
    files = (await fs.readdir(resolved, { withFileTypes: true }))
      .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
      .map(entry => path.join(resolved, entry.name))
      .sort()
  } else {
    files = [resolved]
  }
  if (!files.length) throw new Error(`No .json provider traces found in ${resolved}`)

  const traces = []
  for (const file of files) {
    const value = JSON.parse(await fs.readFile(file, 'utf8'))
    traces.push(validateTrace(value, file))
  }
  return traces
}

export function formatProviderTraceAnalysis(result) {
  const lines = [
    '# Phase 14H provider trace analysis',
    '',
    `- Captures: ${result.captureCount}`,
    `- Provider-reported usage: ${result.providerReportedCount}`,
    `- Captures without provider usage: ${result.missingUsageCount}`,
    `- Exact request payload hashes: ${result.exactPayloadsVerified ? 'verified' : 'not verified'}`,
    `- Clean-equivalent compaction A/B: ${result.cleanEquivalentCompactionAB ? 'yes' : 'no'}`,
    '',
    '| Metric | Mean | p50 | p95 | Max |',
    '|---|---:|---:|---:|---:|',
  ]
  for (const [label, value] of [
    ['Estimated message tokens', result.distributions.estimatedMessageTokens],
    ['Estimated full request tokens', result.distributions.estimatedRequestTokens],
    ['Provider-observed context tokens', result.distributions.observedContextTokens],
    ['Signed request drift (%)', result.distributions.requestDriftPercent],
    ['Absolute request drift (%)', result.distributions.absoluteRequestDriftPercent],
    ['Native count drift (tokens)', result.distributions.providerNativeCountDriftTokens],
  ]) {
    lines.push(`| ${label} | ${fmt(value.mean)} | ${fmt(value.p50)} | ${fmt(value.p95)} | ${fmt(value.max)} |`)
  }
  lines.push('', '## Provider routes', '')
  if (!result.routes.length) lines.push('No provider-reported usage was present in the captures.')
  else {
    lines.push('| Route | Requests | Observed context tokens | Estimated request tokens | Weighted drift |', '|---|---:|---:|---:|---:|')
    for (const route of result.routes) lines.push(`| ${route.provider}/${route.model} | ${route.requests} | ${route.observedContextTokens} | ${route.estimatedRequestTokens} | ${fmt(route.weightedDriftPercent)}% |`)
  }
  const calibration = result.runtimeCalibration
  lines.push('', '## Runtime adaptive-estimator replay', '')
  if (!calibration?.available) {
    lines.push(calibration?.reason || 'No session-log-backed calibration replay was performed.')
  } else {
    lines.push(`- Matched session turns: ${calibration.matchedTurns}; skipped trace turns: ${calibration.skippedTurns}`)
    lines.push(`- Provider-usage event matches: ${calibration.matchedUsageEvents}/${calibration.captureCount}; mismatches: ${calibration.mismatchedUsageEvents}`)
    lines.push(`- Completed compactions in session: ${calibration.compactionCount}; in-turn baseline resets replayed: ${calibration.compactionBoundaries}`)
    lines.push(`- Turns seeded from persisted provider usage: ${calibration.turnsSeededFromPersistedUsage}/${calibration.matchedTurns}; cold-start requests: ${calibration.coldStartRequestCount}; compaction-epoch prior requests: ${calibration.compactionEpochPriorRequestCount}; measured-baseline-backed requests: ${calibration.baselineBackedRequestCount}; rolling-ratio requests: ${calibration.ratioCalibratedRequestCount}; native-count requests: ${calibration.nativeCountRequestCount}`)
    lines.push(`- Aggregate signed prediction error: ${fmt(calibration.aggregateSignedErrorPercent)}% (positive means overestimation)`)
    lines.push(`- Per-request absolute error: mean ${fmt(calibration.absoluteErrorPercent.mean)}%; p50 ${fmt(calibration.absoluteErrorPercent.p50)}%; p95 ${fmt(calibration.absoluteErrorPercent.p95)}%; max ${fmt(calibration.absoluteErrorPercent.max)}%`)
    lines.push(`- Underpredictions: ${calibration.underPredictions}; overpredictions: ${calibration.overPredictions}`)
    lines.push(`- Raw estimates over budget: ${calibration.rawEstimateOverBudgetCount}; adaptive estimates over budget: ${calibration.adaptiveEstimateOverBudgetCount}; provider-observed over budget: ${calibration.providerObservedOverBudgetCount}`)
    lines.push(`- Adaptive estimate missed provider budget crossings: ${calibration.adaptiveMissedBudgetCrossingCount}`)
    for (const miss of calibration.missedBudgetCrossings) lines.push(`- Budget crossing miss: ${miss.traceId} round ${miss.round}; predicted ${miss.predictedTokens}, observed ${miss.observedTokens}, usable ${miss.usableTokens} (over budget by ${miss.missedByTokens})`)
    if (calibration.maxAbsoluteErrorSample) {
      const sample = calibration.maxAbsoluteErrorSample
      lines.push(`- Largest absolute error: ${fmt(sample.absoluteErrorPercent)}% on ${sample.traceId} (adaptive ${sample.adaptiveEstimatedRequestTokens}, observed ${sample.observedContextTokens})`)
    }
    lines.push('', calibration.note)
    if (result.calibrationComparisons?.length) {
      lines.push('', '## Offline compaction-epoch policy comparison', '', '| Policy | Mean absolute error | P95 absolute error | Max error | Missed budget crossings | Cold-start requests |', '|---|---:|---:|---:|---:|---:|')
      for (const row of result.calibrationComparisons) {
        const label = row.calibrationPolicy === 'decay' ? `decay(${row.calibrationDecayFactor})` : row.calibrationPolicy
        lines.push(`| ${label} | ${fmt(row.absoluteErrorPercent.mean)}% | ${fmt(row.absoluteErrorPercent.p95)}% | ${fmt(row.absoluteErrorPercent.max)}% | ${row.adaptiveMissedBudgetCrossingCount} | ${row.coldStartRequestCount} | ${row.compactionEpochPriorRequestCount} |`)
      }
      lines.push('', 'Counterfactual replay only: all policies use the same chronological provider measurements, and each capture is applied only after its own prediction. The primary runtime replay uses decay(0.75); the other rows are alternatives. This comparison does not establish task-quality or compaction-outcome superiority.')
    }
  }
  lines.push('', result.note, '')
  return lines.join('\n')
}

function fmt(value) {
  return value === null || value === undefined || !Number.isFinite(value) ? 'n/a' : String(Math.round(value * 10) / 10)
}

async function main(args) {
  const json = args.includes('--json')
  const inputIndex = args.findIndex(value => !value.startsWith('--'))
  const input = inputIndex >= 0 ? args[inputIndex] : undefined
  if (!input) throw new Error('Usage: node tools/phase14h-provider-trace-replay.mjs <trace-file-or-directory> [--session-log <session.jsonl>] [--json]')

  let sessionEvents
  const sessionFlag = args.indexOf('--session-log')
  if (sessionFlag >= 0) {
    const sessionPath = args[sessionFlag + 1]
    if (!sessionPath || sessionPath.startsWith('--')) throw new Error('--session-log requires a JSONL file path')
    sessionEvents = await loadSessionEventLog(sessionPath)
  }

  const traces = await loadProviderTraces(input)
  const result = analyzeProviderTraces(traces, { sessionEvents })
  process.stdout.write(json ? `${JSON.stringify(result, null, 2)}\n` : `${formatProviderTraceAnalysis(result)}\n`)
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).catch(error => {
    process.stderr.write(`provider trace replay failed: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
