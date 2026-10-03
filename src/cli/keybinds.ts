import type { EditorShortcut } from './input.js'

export type EditorKeybindConfig = Partial<Record<EditorShortcut, string | string[]>>

export const DEFAULT_EDITOR_KEYBINDS: Record<EditorShortcut, string[]> = {
  agents: ['tab'],
  'agents-reverse': ['shift+tab'],
  variants: ['ctrl+t'],
  commands: ['ctrl+p'],
  history: ['ctrl+r'],
  editor: ['ctrl+g'],
  stash: ['ctrl+s'],
  sessions: [],
  thinking: ['ctrl+e'],
  details: ['ctrl+o'],
}

const SPECIAL: Record<string, string> = {
  tab: '\t',
  'shift+tab': '\x1b[Z',
  escape: '\x1b',
  enter: '\r',
  return: '\r',
  backspace: '\x7f',
}

function ctrlLetter(letter: string) {
  const upper = letter.toUpperCase()
  if (upper.length !== 1 || upper < 'A' || upper > 'Z') return null
  return String.fromCharCode(upper.charCodeAt(0) - 64)
}

export function parseKeybind(value: string): string | null {
  if (value.length === 1 && value.charCodeAt(0) < 0x20) return value
  const normalized = value.trim().toLowerCase()
  if (!normalized || normalized === 'none' || normalized === 'false') return null
  if (SPECIAL[normalized]) return SPECIAL[normalized]
  const ctrl = /^ctrl\+([a-z])$/.exec(normalized)
  if (ctrl) return ctrlLetter(ctrl[1]!)
  const alt = /^alt\+([a-z])$/.exec(normalized)
  if (alt) return `\x1b${alt[1]}`
  const f = /^f([1-9]|1[0-2])$/.exec(normalized)
  if (f) {
    const n = Number(f[1])
    const codes: Record<number, string> = { 1: '\x1bOP', 2: '\x1bOQ', 3: '\x1bOR', 4: '\x1bOS' }
    return codes[n] || `\x1b[${10 + n}~`
  }
  return value.length === 1 ? value : null
}

export function buildEditorKeybinds(config?: EditorKeybindConfig): Map<string, EditorShortcut> {
  const result = new Map<string, EditorShortcut>()
  const current = new Map<EditorShortcut, string[]>(Object.entries(DEFAULT_EDITOR_KEYBINDS).map(([k, v]) => [k as EditorShortcut, [...v]]))
  for (const [action, raw] of Object.entries(config || {}) as Array<[EditorShortcut, string | string[]]>) {
    const values = Array.isArray(raw) ? raw : [raw]
    const parsed = values.map(parseKeybind).filter((x): x is string => Boolean(x))
    current.set(action, parsed)
  }
  for (const [action, sequences] of current) {
    for (const raw of sequences) {
      const seq = parseKeybind(raw)
      if (seq) result.set(seq, action)
    }
  }
  return result
}
