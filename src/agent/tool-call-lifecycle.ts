import crypto from 'node:crypto'
import type { SessionStore } from '../session/store.js'
import type { ToolKind, ToolProvenance } from '../tools/types.js'

export type ToolCallLifecycleState = 'pending' | 'running' | 'completed' | 'error' | 'interrupted'
export type ToolCallLifecycleOutcome = 'success' | 'error' | 'permission_denied' | 'question_rejected' | 'interrupted' | 'provider_hosted'

export interface ToolCallLifecycleRecord {
  sessionId: string
  turnId: string
  callId: string
  name: string
  argumentsRaw: string
  parsedArguments?: unknown
  state: ToolCallLifecycleState
  outcome?: ToolCallLifecycleOutcome
  providerExecuted?: boolean
  providerMetadata?: unknown
  kind?: ToolKind
  provenance?: ToolProvenance
  metadata?: unknown
  outputReference?: string
  outputPath?: string
  startedAt?: number
  endedAt?: number
  error?: string
}

function stableHash(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 24)
}

export class DuplicateToolCallIdError extends Error {
  readonly callId: string
  constructor(callId: string) {
    super(`Provider returned duplicate tool call id: ${callId}`)
    this.name = 'DuplicateToolCallIdError'
    this.callId = callId
  }
}

export function normalizeToolCallId(providerId: string, turnId: string, index: number, call: { id?: unknown; function?: { name?: unknown; arguments?: unknown } }): string {
  const provided = typeof call.id === 'string' ? call.id.trim() : ''
  if (provided) return provided
  const name = typeof call.function?.name === 'string' ? call.function.name : 'tool'
  const args = typeof call.function?.arguments === 'string' ? call.function.arguments : ''
  return `call_${providerId}_${turnId.slice(0, 10)}_${index}_${stableHash(`${name}\0${args}`)}`
}

export function normalizeToolCalls(providerId: string, turnId: string, calls: any[]): any[] {
  const seen = new Set<string>()
  return calls.map((call, index) => {
    const id = normalizeToolCallId(providerId, turnId, index, call)
    if (seen.has(id)) throw new DuplicateToolCallIdError(id)
    seen.add(id)
    return { ...call, id }
  })
}

export function parseToolArguments(raw: unknown): { ok: true; value: any } | { ok: false; error: string } {
  if (typeof raw !== 'string' || !raw.trim()) return { ok: true, value: {} }
  try {
    return { ok: true, value: JSON.parse(raw) }
  } catch (error) {
    return { ok: false, error: `Invalid JSON tool arguments: ${error instanceof Error ? error.message : String(error)}` }
  }
}

export function classifyToolError(error: unknown, signal?: AbortSignal): { outcome: ToolCallLifecycleOutcome; state: ToolCallLifecycleState; message: string } {
  const message = error instanceof Error ? error.message : String(error)
  const lower = message.toLowerCase()
  if (/question (?:rejected|cancelled)|user (?:rejected|cancelled) the question|interactive questions are unavailable/i.test(lower)) return { outcome: 'question_rejected', state: 'error', message }
  if (/permission denied|permission cancelled|not allowed by the active/i.test(lower)) return { outcome: 'permission_denied', state: 'error', message }
  if (signal?.aborted || /\babort(?:ed|ing)?\b|cancel(?:led|ed)/i.test(lower)) return { outcome: 'interrupted', state: 'interrupted', message: message || 'Tool execution interrupted' }
  return { outcome: 'error', state: 'error', message }
}
export interface TextToolCallRecovery {
  text: string
  calls: Array<{ id?: string; type: 'function'; function: { name: string; arguments: string } }>
  recovered: boolean
}

function decodeXmlText(value: string): string {
  return value
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&')
}

function parseXmlParameterValue(raw: string): unknown {
  const value = raw.trim()
  if (!value) return ''
  try {
    const parsed = JSON.parse(value)
    if (typeof parsed !== 'string' || value.startsWith('\"') || value.startsWith('[') || value.startsWith('{') || /^(?:true|false|null|-?\d+(?:\.\d+)?)$/.test(value)) {
      return parsed
    }
  } catch {}
  return value
}

function parseXmlParameterBody(body: string): Record<string, unknown> | null {
  const object: Record<string, unknown> = {}
  let count = 0

  const jsonMatch = body.match(/<arguments\b[^>]*>([\s\S]*?)<\/arguments>/i)
  if (jsonMatch) {
    try {
      const value = JSON.parse(decodeXmlText(jsonMatch[1]!.trim()))
      if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
    } catch {}
  }

  const parameterPatterns = [
    /<parameter\b[^>]*\bname\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/parameter>/gi,
    /<parameter\s*=\s*([^>]+)>([\s\S]*?)<\/parameter>/gi,
  ]
  if (!body.trim()) return {}

  for (const pattern of parameterPatterns) {
    let match: RegExpExecArray | null
    while ((match = pattern.exec(body))) {
      const key = decodeXmlText(match[1]!.trim())
      if (!key) continue
      const raw = decodeXmlText(match[2]!.trim())
      object[key] = parseXmlParameterValue(raw)
      count += 1
    }
    if (count) return object
  }
  return count ? object : null
}

/**
 * Recover the XML-style tool-call dialect emitted as plain text by a small
 * class of OpenAI-compatible models. Native provider tool events remain the
 * canonical path; this is a narrow compatibility bridge, not a second tool
 * protocol.
 */
export function recoverTextToolCalls(text: string, availableToolNames: readonly string[]): TextToolCallRecovery {
  const allowed = new Set(availableToolNames)
  const blockPattern = /<tool_call\b[^>]*>([\s\S]*?)<\/tool_call>/gi
  const calls: Array<{ id?: string; type: 'function'; function: { name: string; arguments: string } }> = []
  const ranges: Array<[number, number]> = []

  let match: RegExpExecArray | null
  while ((match = blockPattern.exec(text))) {
    const prefix = text.slice(0, match.index)
    if (((prefix.match(/```/g) ?? []).length % 2) === 1) continue
    const body = match[1] ?? ''
    const functionMatch = body.match(/<function\s*=\s*([^>\s]+)\s*>([\s\S]*?)<\/function>/i) ?? body.match(/<function\s+name\s*=\s*[\"']([^\"']+)[\"']\s*>([\s\S]*?)<\/function>/i)
    if (!functionMatch) continue
    const name = decodeXmlText(functionMatch[1]!.trim())
    if (!name || !allowed.has(name)) continue
    const parsed = parseXmlParameterBody(functionMatch[2] ?? '')
    if (parsed === null) continue
    calls.push({ type: 'function', function: { name, arguments: JSON.stringify(parsed) } })
    ranges.push([match.index, match.index + match[0].length])
  }

  if (!calls.length) return { text, calls: [], recovered: false }
  let cleaned = ''
  let cursor = 0
  for (const [start, end] of ranges) {
    cleaned += text.slice(cursor, start)
    cursor = end
  }
  cleaned += text.slice(cursor)
  cleaned = cleaned.replace(/[ \t]*\n[ \t]*(?=\n)/g, '\n').trim()
  return { text: cleaned, calls, recovered: true }
}

/**
 * Streaming gate used by the UI callback. It withholds only a possible
 * XML-style tool-call block so the raw protocol markup never gets painted in
 * the transcript. Ordinary assistant text still streams immediately.
 */
export class TextToolCallStreamGate {
  private held = ''
  private readonly maxHeldChars = 64 * 1024

  push(delta: string): string {
    if (!delta) return ''

    if (this.held) {
      this.held += delta
      if (this.held.length > this.maxHeldChars) {
        const out = this.held
        this.held = ''
        return out
      }
      return ''
    }

    const marker = /(?:^|\n)([ \t]*<tool_call\b)/i.exec(delta)
    const partial = /(?:^|\n)[ \t]*<tool(?:_?call)?[A-Za-z_-]*$/i.test(delta)
    if (!marker && !partial) return delta
    if (!marker) {
      this.held = delta
      return ''
    }
    const markerStart = marker.index + marker[0].length - marker[1]!.length
    const before = delta.slice(0, markerStart)
    this.held = delta.slice(markerStart)
    return before
  }

  reset(): void {
    this.held = ''
  }

  finish(): string {
    const out = this.held
    this.held = ''
    return out
  }
}

export class ToolCallLifecycle {
  private readonly latest = new Map<string, ToolCallLifecycleRecord>()

  private key(record: Pick<ToolCallLifecycleRecord, 'sessionId'|'turnId'|'callId'>): string {
    return `${record.sessionId}\0${record.turnId}\0${record.callId}`
  }
  constructor(private readonly sessions: SessionStore) {}

  async pending(record: Omit<ToolCallLifecycleRecord, 'state'>): Promise<ToolCallLifecycleRecord> {
    const key = this.key(record)
    const existing = this.latest.get(key)
    if (existing && existing.state !== 'interrupted') {
      throw new Error(`Duplicate tool call lifecycle: ${record.sessionId}/${record.turnId}/${record.callId}`)
    }
    const next = { ...record, state: 'pending' as const }
    await this.sessions.append(record.sessionId, { type: 'tool.call', ts: Date.now(), data: next })
    this.latest.set(key, next)
    return next
  }

  async transition(callId: string, patch: Partial<ToolCallLifecycleRecord> & { state: ToolCallLifecycleState }): Promise<ToolCallLifecycleRecord> {
    const current = [...this.latest.values()].filter(record => record.callId === callId).at(-1)
    if (!current) throw new Error(`Unknown tool call lifecycle: ${callId}`)
    const allowed:Record<ToolCallLifecycleState,ToolCallLifecycleState[]>={pending:['running','completed','error','interrupted'],running:['completed','error','interrupted'],completed:[],error:[],interrupted:[]}
    if(!allowed[current.state].includes(patch.state)) throw new Error(`Invalid tool call lifecycle transition: ${current.state} -> ${patch.state} (${callId})`)
    const next: ToolCallLifecycleRecord = { ...current, ...patch, callId: current.callId, sessionId: current.sessionId, turnId: current.turnId, name: current.name, argumentsRaw: current.argumentsRaw }
    if (next.state === 'running' && !next.startedAt) next.startedAt = Date.now()
    if ((next.state === 'completed' || next.state === 'error' || next.state === 'interrupted') && !next.endedAt) next.endedAt = Date.now()
    await this.sessions.append(current.sessionId, { type: 'tool.call', ts: Date.now(), data: next })
    this.latest.set(this.key(next), next)
    return next
  }

  async recoverUnsettled(sessionId: string): Promise<string[]> {
    const loaded = await this.sessions.load(sessionId)
    const states = new Map<string, ToolCallLifecycleRecord>()
    for (const event of loaded.events) {
      if (event.type !== 'tool.call' || !event.data?.callId) continue
      const record = event.data as ToolCallLifecycleRecord
      states.set(this.key(record), record)
    }
    const recovered: string[] = []
    for (const record of states.values()) {
      const key = this.key(record)
      this.latest.set(key, record)
      if (record.state !== 'pending' && record.state !== 'running') continue
      const next = {
        ...record,
        state: 'interrupted' as const,
        outcome: 'interrupted' as const,
        error: 'Tool execution interrupted during recovery',
        endedAt: Date.now(),
      }
      await this.sessions.append(sessionId, { type: 'tool.call', ts: next.endedAt!, data: next })
      this.latest.set(key, next)
      recovered.push(record.callId)
    }
    return recovered
  }

  snapshot(): ToolCallLifecycleRecord[] {
    return [...this.latest.values()]
  }
}
