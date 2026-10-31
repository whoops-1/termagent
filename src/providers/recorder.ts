import { promises as fs } from 'node:fs'
import { blankCapabilities, type Provider, type ProviderCapabilities, type StreamEvent } from './types.js'
import type { ChatMessage } from '../session/store.js'
import type { ToolRegistry } from '../tools/registry.js'

export interface RecordedStream {
  events: StreamEvent[]
  error?: string
}

export async function recordProviderStream(
  provider: Provider,
  messages: ChatMessage[],
  tools: ReturnType<ToolRegistry['schemas']>,
  signal: AbortSignal,
): Promise<RecordedStream> {
  const events: StreamEvent[] = []
  try {
    for await (const event of provider.stream(messages, tools, signal)) events.push(event)
  } catch (error) {
    return { events, error: error instanceof Error ? error.message : String(error) }
  }
  return { events }
}

export async function writeFixture(file: string, recorded: RecordedStream): Promise<void> {
  const lines: string[] = []
  for (const event of recorded.events) lines.push(JSON.stringify({ event }))
  if (recorded.error) lines.push(JSON.stringify({ error: recorded.error }))
  await fs.mkdir(file.split('/').slice(0, -1).join('/') || '.', { recursive: true })
  await fs.writeFile(file, lines.join('\n') + '\n', 'utf8')
}

export async function readFixture(file: string): Promise<RecordedStream> {
  const text = await fs.readFile(file, 'utf8')
  const events: StreamEvent[] = []
  let error: string | undefined
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    const parsed = JSON.parse(line)
    if (parsed?.event) events.push(parsed.event as StreamEvent)
    else if (typeof parsed?.error === 'string') error = parsed.error
  }
  return { events, error }
}

export function createReplayProvider(recorded: RecordedStream): Provider {
  const capabilities: ProviderCapabilities = {
    streaming: true,
    toolCalls: true,
    supportsToolCallIds: true,
    reasoning: true,
    structuredOutput: false,
  }
  return {
    id: 'replay',
    model: 'replay',
    config: { model: 'replay', baseUrl: '' },
    capabilities,
    async *stream(_messages: ChatMessage[], _tools: ReturnType<ToolRegistry['schemas']>, signal: AbortSignal): AsyncGenerator<StreamEvent> {
      for (const event of recorded.events) {
        if (signal.aborted) throw new Error('Provider turn interrupted')
        yield event
      }
      if (recorded.error) throw new Error(recorded.error)
    },
  }
}

export { blankCapabilities }
