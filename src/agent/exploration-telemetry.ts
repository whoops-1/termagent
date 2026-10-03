import { type ToolExecutionScope } from '../util/canonical.js'
import { explorationActionSignature, type ToolLoopAction } from './loop-guard.js'
import type { ExplorationObservation } from '../context/exploration.js'

export type ExplorationTerminationReason =
  | 'completed'
  | 'semantic-no-progress'
  | 'loop-guard'
  | 'tool-budget'
  | 'interrupted'
  | 'error'
  | 'workflow-blocked'
  | 'unknown'

export interface ExplorationTelemetrySnapshot {
  toolCalls: number
  usefulCalls: number
  repeatedCalls: number
  overlappingCalls: number
  newFiles: number
  newRanges: number
  reconstructedEvidence: number
  searchNovelty: number
  novelSearchResults: number
  newSymbols: number
  settledVerificationFacts: number
  rounds: number
  noProgressRounds: number
  terminationReason: ExplorationTerminationReason
}

export interface ExplorationTelemetryCallResult {
  toolName: string
  input: unknown
  scope?: ToolExecutionScope
  observation?: ExplorationObservation
  useful?: boolean
}
/**
 * Runtime-only exploration efficiency counters.
 *
 * This is deliberately derived state, not session truth. It is intended for
 * diagnostics, regression fixtures, and future adaptive routing rather than
 * for reconstructing a session after restart.
 */
export class ExplorationTelemetry {
  private readonly seenCalls = new Set<string>()
  private readonly discoveredFileSet = new Set<string>()
  private toolCalls = 0
  private usefulCalls = 0
  private repeatedCalls = 0
  private overlappingCalls = 0
  private newFiles = 0
  private newRanges = 0
  private reconstructedEvidence = 0
  private searchNovelty = 0
  private novelSearchResults = 0
  private readonly discoveredSymbolSet = new Set<string>()
  private newSymbols = 0
  private readonly settledVerificationFactSet = new Set<string>()
  private settledVerificationFacts = 0
  private rounds = 0
  private noProgressRounds = 0
  private terminationReason: ExplorationTerminationReason = 'unknown'

  recordCall(input: ExplorationTelemetryCallResult): void {
    this.toolCalls += 1
    const signature = explorationActionSignature({ toolName: input.toolName, input: input.input, scope: input.scope } satisfies ToolLoopAction)
    if (this.seenCalls.has(signature)) this.repeatedCalls += 1
    else this.seenCalls.add(signature)

    const observation = input.observation
    if (observation) {
      const evidence = observation.evidence
      const newFiles = evidence?.newFiles ?? observation.newFiles
      const newRanges = evidence?.newRanges ?? observation.newRanges
      if (evidence?.newFiles?.length) {
        for (const file of newFiles) this.discoveredFileSet.add(file)
      } else if (observation.newFiles.length) {
        for (const file of observation.newFiles) this.discoveredFileSet.add(file)
      }
      this.newFiles = this.discoveredFileSet.size
      this.newRanges += newRanges.length
      this.reconstructedEvidence += evidence?.reconstructedRanges?.length ?? 0
      if (input.toolName === 'read_file' && observation.overlap) this.overlappingCalls += 1
      if (observation.newSearch) this.searchNovelty += 1
      this.novelSearchResults += evidence?.novelSearchResults ?? 0
      for (const symbol of evidence?.newSymbols ?? []) {
        const key = `${symbol.path ?? ''}\0${symbol.line ?? ''}\0${symbol.kind ?? ''}\0${symbol.name}`
        this.discoveredSymbolSet.add(key)
      }
      this.newSymbols = this.discoveredSymbolSet.size
      for (const fact of evidence?.settledVerificationFacts ?? []) this.settledVerificationFactSet.add(fact)
      this.settledVerificationFacts = this.settledVerificationFactSet.size
      if (observation.meaningful) this.usefulCalls += 1
      else if (input.useful) this.usefulCalls += 1
      return
    }

    if (input.useful) this.usefulCalls += 1
  }

  recordRound(input: { meaningfulProgress: boolean }): void {
    this.rounds += 1
    if (!input.meaningfulProgress) this.noProgressRounds += 1
  }

  setTerminationReason(reason: ExplorationTerminationReason): void {
    this.terminationReason = reason
  }

  snapshot(): ExplorationTelemetrySnapshot {
    return {
      toolCalls: this.toolCalls,
      usefulCalls: this.usefulCalls,
      repeatedCalls: this.repeatedCalls,
      overlappingCalls: this.overlappingCalls,
      newFiles: this.newFiles,
      newRanges: this.newRanges,
      reconstructedEvidence: this.reconstructedEvidence,
      searchNovelty: this.searchNovelty,
      novelSearchResults: this.novelSearchResults,
      newSymbols: this.newSymbols,
      settledVerificationFacts: this.settledVerificationFacts,
      rounds: this.rounds,
      noProgressRounds: this.noProgressRounds,
      terminationReason: this.terminationReason,
    }
  }
}
