import type { ToolDefinition } from '../tools/types.js'

type ParsedCall = {
  type: 'function'
  function: { name: string; arguments: string }
}

export type TextToolCallParserResult = {
  text: string
  calls: ParsedCall[]
}

type Tag = {
  start: number
  end: number
  name: string
  closing: boolean
  selfClosing: boolean
  raw: string
}

type ParsedCallBlock = {
  calls: ParsedCall[]
  end: number
  closed: boolean
  structural: boolean
}

const CALL_TAGS = new Set(['function', 'call', 'tool', 'invoke'])
const PARAM_TAGS = new Set(['parameter', 'param', 'argument', 'arg'])
const RESERVED_TAGS = new Set([...CALL_TAGS, 'tool_call', ...PARAM_TAGS, 'arguments', 'name', 'tool_name'])
const MAX_BUFFER_CHARS = 512 * 1024
const MAX_SCAN_CHARS = 1024 * 1024
const MAX_TAG_NAME = 128
const MAX_TOOL_NAME = 256
const MAX_PARAMETER_NAME = 256
const PARTIAL_OPENERS = ['<tool_call', '<function', '<function=', '<call', '<tool', '<invoke'] as const
const PARTIAL_PARAMETER_OPENERS = ['<parameter', '<param', '<argument', '<arg'] as const

function isWhitespace(ch: string): boolean {
  return ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t' || ch === '\f'
}

function skipWhitespace(text: string, index: number): number {
  let i = index
  while (i < text.length && isWhitespace(text[i]!)) i++
  return i
}

function isNameChar(ch: string): boolean {
  return /[A-Za-z0-9_.:-]/.test(ch)
}

function decodeXmlText(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (whole, hex: string) => {
      try { return String.fromCodePoint(Number.parseInt(hex, 16)) } catch { return whole }
    })
    .replace(/&#([0-9]+);/g, (whole, dec: string) => {
      try { return String.fromCodePoint(Number.parseInt(dec, 10)) } catch { return whole }
    })
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&')
}

function parseAttribute(raw: string, name: string): string | null {
  const pattern = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i')
  const match = pattern.exec(raw)
  return match ? decodeXmlText(match[1] ?? match[2] ?? match[3] ?? '') : null
}

function findTagEnd(text: string, start: number): number {
  let quote = ''
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!
    if (quote) {
      if (ch === quote) quote = ''
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === '>') return i
  }
  return -1
}

function readTag(text: string, start: number): Tag | null {
  if (text[start] !== '<') return null
  const gt = findTagEnd(text, start + 1)
  if (gt === -1) return null
  let i = skipWhitespace(text, start + 1)
  let closing = false
  if (text[i] === '/') {
    closing = true
    i = skipWhitespace(text, i + 1)
  }
  const nameStart = i
  while (i < gt && isNameChar(text[i]!)) i++
  if (i === nameStart || i - nameStart > MAX_TAG_NAME) return null
  const name = text.slice(nameStart, i).toLowerCase()
  const raw = text.slice(start, gt + 1)
  return { start, end: gt + 1, name, closing, selfClosing: /\/\s*>$/.test(raw), raw }
}

function callNameFromTag(tag: Tag): string | null {
  if (tag.closing || !CALL_TAGS.has(tag.name)) return null
  const inner = tag.raw.slice(1, -1)
  const equals = inner.indexOf('=')
  if (equals >= 0 && inner.slice(0, equals).trim().toLowerCase() === tag.name) {
    const raw = inner.slice(equals + 1).trim().replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, '$1$2')
    return decodeXmlText(raw).trim().slice(0, MAX_TOOL_NAME) || null
  }
  const name = parseAttribute(inner.slice(tag.name.length), 'name')
  if (name) return name.trim().slice(0, MAX_TOOL_NAME) || null
  const toolName = parseAttribute(inner.slice(tag.name.length), 'tool_name')
  return toolName ? toolName.trim().slice(0, MAX_TOOL_NAME) || null : null
}

function parameterNameFromTag(tag: Tag): string | null {
  if (tag.closing || !PARAM_TAGS.has(tag.name)) return null
  const inner = tag.raw.slice(1, -1)
  const equals = inner.indexOf('=')
  if (equals >= 0 && inner.slice(0, equals).trim().toLowerCase() === tag.name) {
    const raw = inner.slice(equals + 1).trim().replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, '$1$2')
    return decodeXmlText(raw).trim().slice(0, MAX_PARAMETER_NAME) || null
  }
  const name = parseAttribute(inner.slice(tag.name.length), 'name')
  return name ? name.trim().slice(0, MAX_PARAMETER_NAME) || null : null
}

function coerceValue(raw: string): unknown {
  const value = decodeXmlText(raw).trim()
  if (!value) return ''
  try { return JSON.parse(value) } catch { return value }
}

function mergeArgument(args: Record<string, unknown>, name: string, value: unknown): void {
  if (!(name in args)) {
    args[name] = value
    return
  }
  const previous = args[name]
  args[name] = Array.isArray(previous) ? [...previous, value] : [previous, value]
}

function schemaKeys(tool: ToolDefinition | undefined): Map<string, string> | null {
  const schema = tool?.inputSchema ?? tool?.schema
  const properties = schema && typeof schema === 'object' ? schema.properties : undefined
  if (!properties || typeof properties !== 'object') return null
  const result = new Map<string, string>()
  for (const key of Object.keys(properties as Record<string, unknown>)) {
    if (!RESERVED_TAGS.has(key.toLowerCase())) result.set(key.toLowerCase(), key)
  }
  return result.size ? result : null
}

function closingTag(text: string, from: number, name: string): Tag | null {
  let index = from
  while (index < text.length && index < MAX_SCAN_CHARS) {
    const lt = text.indexOf('<', index)
    if (lt === -1) return null
    const tag = readTag(text, lt)
    if (!tag) {
      index = lt + 1
      continue
    }
    if (tag.closing && tag.name === name) return tag
    index = tag.end
  }
  return null
}

function nextBoundary(text: string, from: number, schema: Map<string, string> | null): number {
  let index = from
  while (index < text.length && index < MAX_SCAN_CHARS) {
    const lt = text.indexOf('<', index)
    if (lt === -1) return text.length
    const tag = readTag(text, lt)
    if (!tag) {
      index = lt + 1
      continue
    }
    if (!tag.closing && (PARAM_TAGS.has(tag.name) || CALL_TAGS.has(tag.name) || tag.name === 'tool_call' || (schema?.has(tag.name) ?? false))) return lt
    if (tag.closing && (PARAM_TAGS.has(tag.name) || CALL_TAGS.has(tag.name) || tag.name === 'tool_call')) return lt
    index = tag.end
  }
  return text.length
}

function parseArguments(body: string, tool: ToolDefinition | undefined): Record<string, unknown> | null {
  const args: Record<string, unknown> = {}
  const schema = schemaKeys(tool)
  let found = false
  let index = 0

  while (index < body.length && index < MAX_SCAN_CHARS) {
    const lt = body.indexOf('<', index)
    if (lt === -1) break
    const tag = readTag(body, lt)
    if (!tag) {
      index = lt + 1
      continue
    }
    if (tag.closing || tag.selfClosing) {
      index = tag.end
      continue
    }

    if (tag.name === 'arguments') {
      const close = closingTag(body, tag.end, 'arguments')
      const raw = body.slice(tag.end, close?.start ?? body.length)
      try {
        const parsed = JSON.parse(decodeXmlText(raw).trim())
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
        Object.assign(args, parsed as Record<string, unknown>)
        found = true
      } catch {
        return null
      }
      index = close?.end ?? body.length
      continue
    }

    let key = PARAM_TAGS.has(tag.name) ? parameterNameFromTag(tag) : null
    if (!key && schema?.has(tag.name)) key = schema.get(tag.name) ?? null
    if (!key) {
      index = tag.end
      continue
    }

    const close = closingTag(body, tag.end, tag.name)
    const valueEnd = close?.start ?? nextBoundary(body, tag.end, schema)
    mergeArgument(args, key, coerceValue(body.slice(tag.end, valueEnd)))
    found = true
    index = close?.end ?? valueEnd
  }

  return found || !body.trim() ? args : null
}

function buildToolMaps(tools: readonly ToolDefinition[]) {
  const byName = new Map<string, ToolDefinition>()
  const byLower = new Map<string, ToolDefinition>()
  for (const tool of tools) {
    byName.set(tool.name, tool)
    if (!byLower.has(tool.name.toLowerCase())) byLower.set(tool.name.toLowerCase(), tool)
  }
  return { byName, byLower }
}

function resolveToolName(raw: string | null, byName: Map<string, ToolDefinition>, byLower: Map<string, ToolDefinition>): string | null {
  const name = raw?.trim()
  if (!name) return null
  const exact = byName.get(name)
  if (exact) return exact.name
  const insensitive = byLower.get(name.toLowerCase())
  if (insensitive) return insensitive.name
  // Compatibility alias for models that describe TermAgent's shell tool as "shell".
  if (name.toLowerCase() === 'shell') return byLower.get('bash')?.name ?? null
  return null
}

function parseFunctionSegment(
  text: string,
  start: number,
  boundaryEnd: number,
  byName: Map<string, ToolDefinition>,
  byLower: Map<string, ToolDefinition>,
  allowImplicitEnd: boolean,
): { call?: ParsedCall; end: number; structural: boolean } {
  const open = readTag(text, start)
  if (!open || open.closing || !CALL_TAGS.has(open.name)) return { end: start + 1, structural: false }
  const rawName = callNameFromTag(open)
  const close = open.selfClosing ? null : closingTag(text, open.end, open.name)
  if (!close && !allowImplicitEnd && !open.selfClosing) return { end: boundaryEnd, structural: true }
  const bodyEnd = close?.start ?? boundaryEnd
  const resolvedName = resolveToolName(rawName, byName, byLower)
  const args = parseArguments(text.slice(open.end, bodyEnd), resolvedName ? byName.get(resolvedName) : undefined)
  const end = close?.end ?? bodyEnd
  if (!resolvedName || args === null) return { end, structural: true }
  return { end, structural: true, call: { type: 'function', function: { name: resolvedName, arguments: JSON.stringify(args) } } }
}

function extractBalancedJson(text: string, start: number): string | null {
  if (text[start] !== '{') return null
  let depth = 0
  let quote = false
  let escaped = false
  for (let i = start; i < text.length && i - start < MAX_SCAN_CHARS; i++) {
    const ch = text[i]!
    if (quote) {
      if (escaped) {
        escaped = false
      } else if (ch === '\\') {
        escaped = true
      } else if (ch === '"') {
        quote = false
      }
      continue
    }
    if (ch === '"') {
      quote = true
      continue
    }
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return text.slice(start, i + 1)
      if (depth < 0) return null
    }
  }
  return null
}

function parseJsonWrappedCall(
  body: string,
  byName: Map<string, ToolDefinition>,
  byLower: Map<string, ToolDefinition>,
): ParsedCall | null {
  const start = body.indexOf('{')
  if (start === -1) return null
  const raw = extractBalancedJson(body, start)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const record = parsed as Record<string, unknown>
    const rawName = typeof record.name === 'string' ? record.name : typeof record.tool_name === 'string' ? record.tool_name : null
    const resolvedName = resolveToolName(rawName, byName, byLower)
    if (!resolvedName) return null
    const rawArgs = record.arguments ?? record.input ?? {}
    let args: Record<string, unknown>
    if (typeof rawArgs === 'string') {
      const parsedArgs = JSON.parse(rawArgs) as unknown
      if (!parsedArgs || typeof parsedArgs !== 'object' || Array.isArray(parsedArgs)) return null
      args = parsedArgs as Record<string, unknown>
    } else if (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)) {
      args = rawArgs as Record<string, unknown>
    } else {
      return null
    }
    return { type: 'function', function: { name: resolvedName, arguments: JSON.stringify(args) } }
  } catch {
    return null
  }
}

function parseWrapper(
  text: string,
  start: number,
  byName: Map<string, ToolDefinition>,
  byLower: Map<string, ToolDefinition>,
  allowImplicitEnd: boolean,
): ParsedCallBlock {
  const open = readTag(text, start)
  if (!open || open.closing || open.name !== 'tool_call') return { calls: [], end: start, closed: false, structural: false }

  const close = closingTag(text, open.end, 'tool_call')
  const contentEnd = close?.start ?? text.length
  const calls: ParsedCall[] = []
  let index = open.end
  let lastConsumed = open.end
  while (index < contentEnd) {
    const lt = text.indexOf('<', index)
    if (lt === -1 || lt >= contentEnd) break
    const tag = readTag(text, lt)
    if (!tag) {
      index = lt + 1
      continue
    }
    if (!tag.closing && CALL_TAGS.has(tag.name)) {
      const result = parseFunctionSegment(text, lt, contentEnd, byName, byLower, allowImplicitEnd)
      if (result.call) calls.push(result.call)
      index = Math.max(result.end, tag.end)
      if (result.call) lastConsumed = index
    } else {
      index = tag.end
    }
  }

  if (calls.length === 0) {
    const jsonCall = parseJsonWrappedCall(text.slice(open.end, contentEnd), byName, byLower)
    if (jsonCall) calls.push(jsonCall)
  }

  const end = close?.end ?? (calls.length ? lastConsumed : contentEnd)
  return { calls, end, closed: Boolean(close), structural: true }
}

function hasPartialSuffix(text: string, prefixes: readonly string[]): number {
  const lower = text.toLowerCase()
  let longest = 0
  for (const prefix of prefixes) {
    // The whole remaining text can be an incomplete opener. This is the
    // common `<tool_call` / `<function` split where the next chunk supplies
    // the final `>` or the tool name.
    if (lower.length > 0 && lower.length <= prefix.length && prefix.startsWith(lower)) {
      longest = Math.max(longest, lower.length)
      continue
    }

    // Otherwise only hold a suffix which starts at a fresh `<`, never a
    // suffix that merely overlaps the end of ordinary prose.
    const max = Math.min(prefix.length - 1, lower.length)
    for (let len = max; len > 0; len--) {
      const candidate = prefix.slice(0, len)
      if (lower.endsWith(candidate) && lower.slice(lower.length - len).startsWith('<')) {
        longest = Math.max(longest, len)
        break
      }
    }
  }
  return longest
}

function partialFunctionCandidate(text: string, byLower: Map<string, ToolDefinition>): number {
  const match = /<\s*function\s*=\s*([A-Za-z_][\w.-]*)$/i.exec(text)
  if (!match) return 0
  const name = match[1]!.toLowerCase()
  const possible = [...byLower.keys()].some(tool => tool.startsWith(name)) || (name === 'bash' || name === 'shell')
  if (!possible) return 0
  return text.length - match.index!
}

function looksLikeProtocolBlock(text: string): boolean {
  return /<\s*(?:function|call|tool|invoke|parameter|param|argument|arg|arguments)\b/i.test(text)
    || /\"(?:name|tool_name)\"\s*:\s*\"[^\"]+\"/i.test(text)
    || /\"(?:arguments|input)\"\s*:/i.test(text)
}

function firstTagIsToolCall(text: string): boolean {
  const first = readTag(text, 0)
  return Boolean(first && !first.closing && first.name === 'tool_call')
}

function openerAt(text: string, byName: Map<string, ToolDefinition>, byLower: Map<string, ToolDefinition>, initiallyFenced = false): number {
  let fenced = initiallyFenced
  let cursor = 0
  while (cursor <= text.length) {
    const fenceIndex = text.indexOf('```', cursor)
    const segmentEnd = fenceIndex === -1 ? text.length : fenceIndex
    if (!fenced) {
      const segment = text.slice(cursor, segmentEnd)
      let best = -1
      const wrapper = /<\s*tool_call\b/i.exec(segment)
      if (wrapper) {
        const tag = readTag(segment, wrapper.index)
        if (tag && !tag.closing) best = wrapper.index
      }
      const callRe = /<\s*(function|call|tool|invoke)\b/gi
      for (const match of segment.matchAll(callRe)) {
        const index = match.index ?? -1
        if (index < 0) continue
        const tag = readTag(segment, index)
        if (!tag || tag.closing) continue
        const name = callNameFromTag(tag)
        if (name && resolveToolName(name, byName, byLower)) best = best === -1 ? index : Math.min(best, index)
      }
      if (best >= 0) return cursor + best
    }
    if (fenceIndex === -1) break
    fenced = !fenced
    cursor = fenceIndex + 3
  }
  return -1
}

function toggleFence(state: boolean, text: string): { state: boolean; text: string } {
  let fenced = state
  let result = ''
  let cursor = 0
  while (cursor < text.length) {
    const lineEnd = text.indexOf('\n', cursor)
    const end = lineEnd === -1 ? text.length : lineEnd + 1
    const line = text.slice(cursor, end)
    let pos = 0
    while ((pos = line.indexOf('```', pos)) !== -1) {
      fenced = !fenced
      pos += 3
    }
    result += line
    cursor = end
  }
  return { state: fenced, text: result }
}

export class XmlToolCallStreamParser {
  private pendingText = ''
  private markup = ''
  private inMarkup = false
  private fenced = false
  private readonly byName: Map<string, ToolDefinition>
  private readonly byLower: Map<string, ToolDefinition>

  constructor(tools: readonly ToolDefinition[]) {
    const maps = buildToolMaps(tools)
    this.byName = maps.byName
    this.byLower = maps.byLower
  }

  reset(): void {
    this.pendingText = ''
    this.markup = ''
    this.inMarkup = false
    this.fenced = false
  }

  private parseAvailableMarkup(byName: Map<string, ToolDefinition>, byLower: Map<string, ToolDefinition>): { calls: ParsedCall[]; tail: string; complete: boolean } {
    const firstTag = readTag(this.markup, 0)
    if (firstTag && !firstTag.closing && firstTag.name === 'tool_call') {
      // A wrapped call is one protocol frame. Do not finalize an inner
      // `<function=...>` before `</tool_call>` arrives, otherwise the wrapper's
      // closing tag becomes ordinary assistant text. The complete wrapper is
      // reconciled atomically, mirroring upstream stream framing.
      const wrapper = parseWrapper(this.markup, 0, byName, byLower, false)
      if (wrapper.closed && wrapper.calls.length) {
        return { calls: wrapper.calls, tail: this.markup.slice(wrapper.end), complete: true }
      }
      return { calls: [], tail: '', complete: false }
    }

    const implicit = /<\s*(function|call|tool|invoke)\b/i.exec(this.markup)
    if (implicit) {
      const start = implicit.index ?? 0
      const result = parseFunctionSegment(this.markup, start, this.markup.length, byName, byLower, false)
      if (result.call && result.end > start) return { calls: [result.call], tail: this.markup.slice(result.end), complete: true }
    }
    return { calls: [], tail: '', complete: false }
  }

  feed(delta: string): TextToolCallParserResult {
    if (!delta) return { text: '', calls: [] }
    const { byName, byLower } = { byName: this.byName, byLower: this.byLower }
    let input = this.pendingText + delta
    this.pendingText = ''
    let text = ''
    const calls: ParsedCall[] = []

    while (input || (this.inMarkup && this.markup.length > 0)) {
      if (this.inMarkup) {
        if (input) {
          this.markup += input
          input = ''
        }
        if (this.markup.length > MAX_BUFFER_CHARS) {
          // Oversized protocol data is suppressed rather than re-injected into assistant text.
          this.markup = ''
          this.inMarkup = false
          break
        }
        const parsed = this.parseAvailableMarkup(byName, byLower)
        if (parsed.complete) {
          calls.push(...parsed.calls)
          this.markup = ''
          this.inMarkup = false
          input = parsed.tail
          continue
        }
        break
      }

      if (this.fenced) {
        const close = input.indexOf('```')
        if (close === -1) {
          text += input
          input = ''
          break
        }
        text += input.slice(0, close + 3)
        this.fenced = false
        input = input.slice(close + 3)
        continue
      }

      const opener = openerAt(input, byName, byLower, this.fenced)
      if (opener >= 0) {
        const prefix = input.slice(0, opener)
        const toggled = toggleFence(this.fenced, prefix)
        this.fenced = toggled.state
        text += toggled.text
        this.markup = input.slice(opener)
        this.inMarkup = true
        input = ''
        continue
      }

      // Hold only a trailing partial protocol prefix. This is what prevents
      // `<tool`, `<tool_`, `<tool_call`, `<function=rea`, etc. from being
      // painted when the next provider chunk will complete the opener.
      const hold = Math.max(
        hasPartialSuffix(input, PARTIAL_OPENERS),
        hasPartialSuffix(input, PARTIAL_PARAMETER_OPENERS),
        partialFunctionCandidate(input, byLower),
      )
      if (hold > 0) {
        const safe = input.slice(0, input.length - hold)
        if (safe) {
          const toggled = toggleFence(this.fenced, safe)
          this.fenced = toggled.state
          text += toggled.text
        }
        this.pendingText = input.slice(input.length - hold)
        input = ''
        break
      }

      const toggled = toggleFence(this.fenced, input)
      this.fenced = toggled.state
      text += toggled.text
      input = ''
    }

    return { text, calls }
  }

  finish(): TextToolCallParserResult {
    const { byName, byLower } = { byName: this.byName, byLower: this.byLower }
    let pending = this.inMarkup ? this.markup : ''
    if (this.pendingText) pending += this.pendingText
    this.markup = ''
    this.pendingText = ''
    this.inMarkup = false
    let text = ''
    const calls: ParsedCall[] = []

    while (pending) {
      if (this.fenced) {
        text += pending
        break
      }
      const opener = openerAt(pending, byName, byLower, this.fenced)
      if (opener < 0) {
        text += pending
        break
      }
      const prefix = pending.slice(0, opener)
      const toggled = toggleFence(this.fenced, prefix)
      this.fenced = toggled.state
      text += toggled.text
      const candidate = pending.slice(opener)

      const wrapper = parseWrapper(candidate, 0, byName, byLower, true)
      if (wrapper.calls.length) {
        calls.push(...wrapper.calls)
        pending = candidate.slice(wrapper.end)
        continue
      }

      let recovered = false
      for (const match of candidate.matchAll(/<\s*(function|call|tool|invoke)\b/gi)) {
        const start = match.index ?? -1
        if (start < 0) continue
        const result = parseFunctionSegment(candidate, start, candidate.length, byName, byLower, true)
        if (!result.call) continue
        text += candidate.slice(0, start)
        calls.push(result.call)
        pending = candidate.slice(result.end)
        recovered = true
        break
      }
      if (recovered) continue

      // A wrapper containing recognizable tool-protocol structure is still
      // internal markup even when the tool is unknown or the XML is malformed.
      // Suppress it at the protocol boundary rather than letting it leak into
      // assistant prose. A bare `<tool_call>` mention without an inner protocol
      // shape remains ordinary documentation text.
      if (firstTagIsToolCall(candidate) && looksLikeProtocolBlock(candidate)) {
        const first = readTag(candidate, 0)
        const close = first ? closingTag(candidate, first.end, 'tool_call') : null
        pending = close ? candidate.slice(close.end) : ''
        continue
      }

      text += candidate
      break
    }

    this.fenced = false
    return { text, calls }
  }
}

export function recoverTextToolCalls(text: string, tools: readonly ToolDefinition[]): TextToolCallParserResult & { recovered: boolean } {
  const parser = new XmlToolCallStreamParser(tools)
  const first = parser.feed(text)
  const last = parser.finish()
  const calls = [...first.calls, ...last.calls]
  return { text: first.text + last.text, calls, recovered: calls.length > 0 }
}
