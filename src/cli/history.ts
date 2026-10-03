import type { ChatMessage } from '../session/store.js'

export type HistoryMatch = {
  index: number
  role: ChatMessage['role']
  text: string
}

function textOf(message: ChatMessage): string {
  if (typeof message.content === 'string') return message.content
  if (typeof message.reasoning === 'string') return message.reasoning
  if (Array.isArray(message.tool_calls)) return message.tool_calls.map(c => c.function.name).join(' ')
  return ''
}

export function searchHistory(messages: ChatMessage[], query = '', limit = 50): HistoryMatch[] {
  const q = query.trim().toLocaleLowerCase()
  const out: HistoryMatch[] = []
  for (let i = messages.length - 1; i >= 0 && out.length < Math.max(1, limit); i--) {
    const message = messages[i]!
    const text = textOf(message)
    if (!text) continue
    if (!q || text.toLocaleLowerCase().includes(q)) out.push({ index: i, role: message.role, text })
  }
  return out
}

export function formatHistory(matches: HistoryMatch[], maxChars = 180): string {
  return matches.map((m, i) => {
    const clean = m.text.replace(/\s+/g, ' ').trim()
    const preview = clean.length > maxChars ? `${clean.slice(0, Math.max(1, maxChars - 1))}…` : clean
    return `${i + 1}. [${m.role}] ${preview}`
  }).join('\n') || 'No matching history.'
}

export function userPromptHistory(messages: ChatMessage[]): string[] {
  return messages.filter(m => m.role === 'user' && typeof m.content === 'string' && m.content.trim())
    .map(m => m.content as string)
}
