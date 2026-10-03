import crypto from 'node:crypto'
import { canonicalToolCallIdentity, type ToolExecutionScope } from '../util/canonical.js'

export interface ToolLoopGuardOptions {
  repeatThreshold?: number
  writeOnlyRoundThreshold?: number
  semanticRepeatThreshold?: number
  semanticNudgeThreshold?: number
  semanticConstrainThreshold?: number
  readOnlyRoundThreshold?: number
}

export type SemanticIntervention = 'nudge' | 'constrain' | 'stop'

export interface ToolLoopAction {
  toolName: string
  input: unknown
  scope?: ToolExecutionScope
}

export interface ToolLoopCheck {
  blocked: boolean
  stop?: boolean
  count: number
  reason?: string
  kind?: 'repeat'|'readonly'|'semantic'|'write'|'blocked'
  intervention?: SemanticIntervention
}

function signature(toolName: string, input: unknown, scope?: ToolExecutionScope) {
  const canonical = canonicalToolCallIdentity(toolName, input, scope)
  return crypto.createHash('sha256').update(canonical).digest('hex')
}

function semanticActionInput(toolName: string, input: unknown): unknown {
  const source = input && typeof input === 'object' && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {}
  if (toolName === 'read_file') {
    return {
      path: source.path ?? source.filePath ?? source.file,
      ...(Number.isSafeInteger(Number(source.startLine)) ? { startLine: Number(source.startLine) } : {}),
      ...(Number.isSafeInteger(Number(source.endLine)) ? { endLine: Number(source.endLine) } : {}),
    }
  }
  if (toolName === 'grep') {
    return {
      pattern: source.pattern ?? source.query,
      ...(source.path !== undefined ? { path: source.path } : {}),
      ...(source.include !== undefined ? { include: source.include } : {}),
      ...(source.exclude !== undefined ? { exclude: source.exclude } : {}),
    }
  }
  if (toolName === 'glob') {
    return {
      pattern: source.pattern,
      ...(source.path !== undefined ? { path: source.path } : {}),
    }
  }
  if (toolName === 'repo_map') {
    return {
      ...(Array.isArray(source.focusFiles) ? { focusFiles: source.focusFiles } : {}),
      ...(Array.isArray(source.focusSymbols) ? { focusSymbols: source.focusSymbols } : {}),
    }
  }
  return input
}

export function explorationActionSignature(action: ToolLoopAction): string {
  const semanticInput = semanticActionInput(action.toolName, action.input)
  const canonical = canonicalToolCallIdentity(action.toolName, semanticInput, action.scope)
  return crypto.createHash('sha256').update(canonical).digest('hex')
}

const MAX_SEMANTIC_INTERVENTION_THRESHOLD = 12

export class ToolLoopGuard {
  private lastSignature: string | undefined
  private repeatedCount = 0
  private writeOnlyRounds = 0
  private lastRoundFingerprint: string | undefined
  private semanticRepeatCount = 0
  private readOnlyRounds = 0
  private blocked = false
  private constrainedActions = new Set<string>()

  private readonly repeatThreshold: number
  private readonly writeOnlyRoundThreshold: number
  private readonly semanticRepeatThreshold: number
  private readonly semanticNudgeThreshold: number
  private readonly semanticConstrainThreshold: number
  private readonly readOnlyRoundThreshold: number

  constructor(options: ToolLoopGuardOptions = {}) {
    this.repeatThreshold = Math.max(2, Number.isSafeInteger(options.repeatThreshold) ? Number(options.repeatThreshold) : 3)
    this.writeOnlyRoundThreshold = Math.max(
      2,
      Number.isSafeInteger(options.writeOnlyRoundThreshold) ? Number(options.writeOnlyRoundThreshold) : 3,
    )
    this.semanticRepeatThreshold = Math.min(
      MAX_SEMANTIC_INTERVENTION_THRESHOLD,
      Math.max(2, Number.isSafeInteger(options.semanticRepeatThreshold) ? Number(options.semanticRepeatThreshold) : 3),
    )
    this.semanticNudgeThreshold = Math.min(
      this.semanticRepeatThreshold,
      Math.max(1, Number.isSafeInteger(options.semanticNudgeThreshold) ? Number(options.semanticNudgeThreshold) : 1),
    )
    this.semanticConstrainThreshold = Math.min(
      this.semanticRepeatThreshold,
      Math.max(this.semanticNudgeThreshold, Number.isSafeInteger(options.semanticConstrainThreshold) ? Number(options.semanticConstrainThreshold) : 2),
    )
    this.readOnlyRoundThreshold = Math.max(2, Number.isSafeInteger(options.readOnlyRoundThreshold) ? Number(options.readOnlyRoundThreshold) : 32)
  }

  check(toolName: string, input: unknown, scope?: ToolExecutionScope): ToolLoopCheck {
    if (this.blocked) return { blocked: true, count: this.repeatedCount, reason: 'tool loop safety stop is active', kind: 'blocked' }

    const current = signature(toolName, input, scope)
    const semanticCurrent = explorationActionSignature({ toolName, input, scope })
    if (this.constrainedActions.has(semanticCurrent)) {
      return {
        blocked: true,
        stop: false,
        count: this.semanticRepeatCount,
        kind: 'semantic',
        intervention: 'constrain',
        reason: `the ${toolName} action was blocked because it repeated an exploration action that produced no new evidence; change tool, query/path, or read range`,
      }
    }
    if (current === this.lastSignature) {
      this.repeatedCount += 1
    } else {
      this.lastSignature = current
      this.repeatedCount = 1
    }

    if (this.repeatedCount >= this.repeatThreshold) {
      this.blocked = true
      return {
        blocked: true,
        stop: true,
        count: this.repeatedCount,
        reason: `the same ${toolName} call was requested ${this.repeatedCount} times with identical input`,
        kind: 'repeat',
      }
    }

    return { blocked: false, count: this.repeatedCount }
  }

  allowRepeat(): void {
    this.blocked = false
    this.repeatedCount = 0
    this.lastSignature = undefined
  }

  observeRound(input: { writeOnly: boolean }): ToolLoopCheck {
    if (this.blocked) return { blocked: true, count: this.repeatedCount, reason: 'tool loop safety stop is active' }

    if (input.writeOnly) this.writeOnlyRounds += 1
    else this.writeOnlyRounds = 0

    if (this.writeOnlyRounds >= this.writeOnlyRoundThreshold) {
      this.blocked = true
      return {
        blocked: true,
        stop: true,
        count: this.writeOnlyRounds,
        reason: `the agent made ${this.writeOnlyRounds} consecutive write-only rounds without inspecting or verifying the result`,
      }
    }

    return { blocked: false, count: this.writeOnlyRounds }
  }
  observeReadOnlyRound(readOnly: boolean): ToolLoopCheck {
    if (this.blocked) return { blocked: true, count: this.readOnlyRounds, reason: 'tool loop safety stop is active' }

    if (readOnly) this.readOnlyRounds += 1
    else this.readOnlyRounds = 0

    if (this.readOnlyRounds >= this.readOnlyRoundThreshold) {
      this.blocked = true
      return {
        blocked: true,
        stop: true,
        count: this.readOnlyRounds,
        reason: `the agent made ${this.readOnlyRounds} consecutive read-only rounds without changing files or advancing task state`,
      }
    }

    return { blocked: false, count: this.readOnlyRounds }
  }

  observeNoProgressRound(fingerprint: string, meaningfulProgress: boolean, actions: readonly ToolLoopAction[] = []): ToolLoopCheck {
    if (this.blocked) return { blocked: true, stop: true, count: this.semanticRepeatCount, reason: 'tool loop safety stop is active' }
    if (meaningfulProgress) {
      this.lastRoundFingerprint = undefined
      this.semanticRepeatCount = 0
      this.constrainedActions.clear()
      return { blocked: false, count: 0 }
    }
    if (fingerprint && fingerprint === this.lastRoundFingerprint) this.semanticRepeatCount += 1
    else {
      this.lastRoundFingerprint = fingerprint
      this.semanticRepeatCount = 1
    }
    if (this.semanticRepeatCount >= this.semanticRepeatThreshold) {
      this.blocked = true
      return {
        blocked: true,
        stop: true,
        count: this.semanticRepeatCount,
        reason: `the agent repeated the same no-progress execution state ${this.semanticRepeatCount} times`,
        kind: 'semantic',
        intervention: 'stop',
      }
    }
    if (this.semanticRepeatCount >= this.semanticConstrainThreshold) {
      this.constrainedActions = new Set(actions.map(explorationActionSignature))
      return {
        blocked: false,
        count: this.semanticRepeatCount,
        kind: 'semantic',
        intervention: 'constrain',
        reason: `the agent made ${this.semanticRepeatCount} consecutive exploration rounds without new semantic evidence`,
      }
    }
    if (this.semanticRepeatCount >= this.semanticNudgeThreshold) {
      return {
        blocked: false,
        count: this.semanticRepeatCount,
        kind: 'semantic',
        intervention: 'nudge',
        reason: `the agent made ${this.semanticRepeatCount} consecutive exploration rounds without new semantic evidence`,
      }
    }
    return { blocked: false, count: this.semanticRepeatCount, kind: 'semantic' }
  }

  isBlocked() {
    return this.blocked
  }
}
