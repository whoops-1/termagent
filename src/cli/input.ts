import process from 'node:process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { layoutTextInput, promptTextWidth, widthOf } from './tui/text-input.js'
import { buildEditorKeybinds, type EditorKeybindConfig } from './keybinds.js'

export type PromptResult = { type: 'submit'; value: string } | { type: 'cancel' } | { type: 'exit' }

type CompletionAnchor = { start: number; end: number }
const COMPLETION_VIEWPORT = 8

export type EditorShortcut = 'agents' | 'agents-reverse' | 'variants' | 'commands' | 'history' | 'editor' | 'stash' | 'sessions' | 'thinking' | 'details'
export type CompletionKind = 'command' | 'agent' | 'file' | 'palette' | 'history' | 'theme' | 'effect' | 'banner'
export type CompletionItemStatus = 'default' | 'active' | 'success' | 'warning' | 'error' | 'disabled'
export type CompletionItem = {
  id: string
  label: string
  value: string
  detail?: string
  badge?: string
  status?: CompletionItemStatus
  disabled?: boolean
  key?: string
  swatches?: string[]
}
export type CompletionState = { kind: CompletionKind; items: string[]; rows: CompletionItem[]; index: number; query: string }

export type PromptMouseEvent = {
  button: number
  column: number
  row: number
  action: 'press' | 'release' | 'motion'
  protocol: 'sgr' | 'x10'
}

type PaletteAction = (value:string)=>void|Promise<void>
type EditorOptions = {
  prompt?: string
  secondaryPrompt?: string
  history?: string[]
  completions?: (value: string, cursor: number) => Promise<Array<string | CompletionItem>> | Array<string | CompletionItem>
  onChange?: (value: string, cursor: number) => void
  getColumns?: () => number
  onShortcut?: (name: EditorShortcut) => void | Promise<void>
  keybinds?: EditorKeybindConfig
  onCompletion?: (state: CompletionState | null, reason?: 'open' | 'update' | 'commit' | 'cancel') => void
  onScroll?: (delta: number) => void
  onMouse?: (event: PromptMouseEvent) => void | Promise<void>
  isModalActive?: () => boolean
  isOverlayActive?: () => boolean
  onOverlayKey?: (key: string) => void | Promise<void>
  onInterrupt?: () => boolean | void | Promise<boolean | void>
  onReadStateChange?: (active: boolean) => void
}

const CSI = '\x1b['

function clamp(n: number, min: number, max: number) { return Math.max(min, Math.min(max, n)) }
function chars(s: string) { return Array.from(s) }
function isPrintable(code: number) { return code >= 0x20 && code !== 0x7f }

type RenderState = { lines: string[]; cursorRow: number; cursorCol: number }

export function parsePromptMouseSequence(seq: string): PromptMouseEvent | null {
  const sgr = /^\x1b\[<(\d+);(\d+);(\d+)([mM])$/.exec(seq)
  if (sgr) {
    return {
      button: Number(sgr[1]),
      column: Math.max(0, Number(sgr[2]) - 1),
      row: Math.max(0, Number(sgr[3]) - 1),
      action: sgr[4] === 'm' ? 'release' : 'press',
      protocol: 'sgr',
    }
  }
  if (seq.startsWith('\x1b[M') && seq.length === 6) {
    const button = (seq.charCodeAt(3) || 32) - 32
    return {
      button,
      column: Math.max(0, (seq.charCodeAt(4) || 32) - 33),
      row: Math.max(0, (seq.charCodeAt(5) || 32) - 33),
      action: 'press',
      protocol: 'x10',
    }
  }
  return null
}

export class PromptEditor {
  private buffer = ''
  private cursor = 0
  private history: string[]
  private historyIndex = -1
  private savedBeforeHistory = ''
  private prompt: string
  private secondaryPrompt: string
  private renderedRows = 0
  private completionItems: string[] = []
  private completionRows: CompletionItem[] = []
  private completionIndex = -1
  private completionAnchor: CompletionAnchor | null = null
  private completionKind: CompletionKind = 'command'
  private completionQuery = ''
  private paletteItems: string[] = []
  private paletteRows: CompletionItem[] = []
  private paletteQuery = ''
  private paletteAction?: PaletteAction
  private completionRequest = 0
  private raw = false
  private pasteMode = false
  private escapeBuffer = ''
  private ctrlCArmed = false
  private preferredColumn = 0
  private escapeTimer: ReturnType<typeof setTimeout> | undefined
  private editUndo: Array<{ value: string; cursor: number }> = []
  private editRedo: Array<{ value: string; cursor: number }> = []
  private vimMode = false
  private vimNormal = false
  private vimPendingD = false
  private readonly keybindMap: Map<string, EditorShortcut>

  value() { return this.buffer }
  snapshot() { return { value: this.buffer, cursor: this.cursor, vimMode: this.vimMode, vimNormal: this.vimNormal } }
  setValue(value: string, cursor = Array.from(value).length) {
    this.editUndo = []
    this.editRedo = []
    this.buffer = value
    this.cursor = clamp(cursor, 0, chars(value).length)
    this.preferredColumn = this.visualColumn()
    this.clearCompletion()
    this.paint()
  }
  setVimMode(enabled: boolean) {
    this.vimMode = Boolean(enabled)
    this.vimNormal = false
    this.vimPendingD = false
    this.paint()
  }
  isVimMode() { return this.vimMode }
  isVimNormal() { return this.vimNormal }
  private recordEdit() {
    const snap = { value: this.buffer, cursor: this.cursor }
    const last = this.editUndo[this.editUndo.length - 1]
    if (!last || last.value !== snap.value || last.cursor !== snap.cursor) this.editUndo.push(snap)
    if (this.editUndo.length > 200) this.editUndo.shift()
    this.editRedo = []
  }
  private undoEdit() {
    const previous = this.editUndo.pop()
    if (!previous) return false
    this.editRedo.push({ value: this.buffer, cursor: this.cursor })
    this.buffer = previous.value
    this.cursor = clamp(previous.cursor, 0, chars(this.buffer).length)
    this.preferredColumn = this.visualColumn()
    this.clearCompletion()
    this.paint()
    return true
  }
  private redoEdit() {
    const next = this.editRedo.pop()
    if (!next) return false
    this.editUndo.push({ value: this.buffer, cursor: this.cursor })
    this.buffer = next.value
    this.cursor = clamp(next.cursor, 0, chars(this.buffer).length)
    this.preferredColumn = this.visualColumn()
    this.clearCompletion()
    this.paint()
    return true
  }

  remember(value: string) {
    const normalized = value.trimEnd()
    if (!normalized) return
    this.history = [...this.history.filter(x => x !== normalized), normalized].slice(-200)
    this.historyIndex = -1
  }

  reset() {
    this.editUndo = []
    this.editRedo = []
    this.buffer = ''
    this.cursor = 0
    this.preferredColumn = 0
    this.historyIndex = -1
    this.savedBeforeHistory = ''
    this.clearCompletion()
    this.escapeBuffer = ''
    this.pasteMode = false
    this.renderedRows = 0
    // The UI bridge must observe the cleared draft synchronously. Otherwise
    // the submitted message can be painted before the composer receives the
    // empty value, leaving stale text in the prompt for one or more frames.
    this.paint()
  }

  constructor(private options: EditorOptions = {}) {
    this.keybindMap = buildEditorKeybinds(options.keybinds)
    this.prompt = options.prompt ?? '> '
    this.secondaryPrompt = options.secondaryPrompt ?? '... '
    this.history = Array.from(new Set((options.history ?? []).filter(Boolean))).slice(-200)
  }

  private write(value: string) { process.stdout.write(value) }

  private setRaw(enabled: boolean) {
    if (!process.stdin.isTTY) return
    if (enabled && !this.raw) {
      process.stdin.setRawMode?.(true)
      process.stdin.resume()
      process.stdin.setEncoding('utf8')
      this.raw = true
      this.write('\x1b[?2004h')
    } else if (!enabled && this.raw) {
      this.write('\x1b[?2004l')
      process.stdin.setRawMode?.(false)
      process.stdin.pause?.()
      this.raw = false
    }
  }

  private clearPreviousRender() {
    if (!this.renderedRows) return
    this.write('\r')
    if (this.renderedRows > 1) this.write(`${CSI}${this.renderedRows - 1}A`)
    for (let i = 0; i < this.renderedRows; i++) {
      this.write(`${CSI}2K`)
      if (i < this.renderedRows - 1) this.write('\n')
    }
    this.write(`\r${CSI}${Math.max(0, this.renderedRows - 1)}A\r`)
  }

  private renderState(): RenderState {
    const terminalWidth = Math.max(20, process.stdout.columns || 80)
    const inputChars = chars(this.buffer)
    const cursorIndex = clamp(this.cursor, 0, inputChars.length)
    const lines: string[] = []
    let current = ''
    let currentWidth = 0
    let cursorRow = 0
    let cursorCol = widthOf(this.prompt)
    let globalIndex = 0

    const pushRow = () => {
      lines.push(current)
      current = ''
      currentWidth = 0
    }

    const promptWidth = widthOf(this.prompt)
    const secondaryWidth = widthOf(this.secondaryPrompt)

    const beginLogicalLine = () => {
      current = ''
      currentWidth = 0
    }

    let logicalLine = 0
    let lineStartPromptWidth = promptWidth
    const setCursor = () => {
      cursorRow = Math.max(0, lines.length - 1)
      cursorCol = lineStartPromptWidth + currentWidth
    }

    for (let i = 0; i <= inputChars.length; i++) {
      if (i === cursorIndex) setCursor()
      if (i === inputChars.length) break
      const ch = inputChars[i]
      if (ch === '\n') {
        pushRow()
        logicalLine++
        lineStartPromptWidth = secondaryWidth
        globalIndex++
        continue
      }
      const width = widthOf(ch)
      const available = Math.max(1, terminalWidth - lineStartPromptWidth)
      if (current && currentWidth + width > available) {
        pushRow()
        lineStartPromptWidth = secondaryWidth
      }
      current += ch
      currentWidth += width
      globalIndex++
    }
    if (!lines.length || current || this.buffer.endsWith('\n')) pushRow()

    // Recompute cursor column when it lands on an already wrapped row.
    let row = 0
    let col = logicalLine === 0 ? promptWidth : secondaryWidth
    let width = 0
    for (let i = 0; i < cursorIndex; i++) {
      const ch = inputChars[i]
      if (ch === '\n') {
        row++
        col = secondaryWidth
        width = 0
        continue
      }
      const w = widthOf(ch)
      const available = Math.max(1, terminalWidth - (row === 0 && width === 0 ? (logicalLine === 0 ? promptWidth : secondaryWidth) : secondaryWidth))
      if (width > 0 && width + w > available) {
        row++
        col = secondaryWidth
        width = 0
      }
      width += w
      col = (row === 0 ? promptWidth : secondaryWidth) + width
    }
    cursorRow = row
    cursorCol = col
    return { lines, cursorRow, cursorCol }
  }

  private renderCompletions(state: RenderState): { lines: string[] } {
    if (!this.completionItems.length) return { lines: [] }
    const lines = this.completionItems.map((item, i) => `${i === this.completionIndex ? '›' : ' '} ${item}`)
    return { lines }
  }

  private renderLegacy() {
    const state = this.renderState()
    const completion = this.renderCompletions(state)
    const rows = [
      ...state.lines.map((line, i) => (i === 0 ? this.prompt : this.secondaryPrompt) + line),
      ...completion.lines,
    ]
    this.clearPreviousRender()
    this.renderedRows = Math.max(1, rows.length)
    rows.forEach((line, i) => {
      this.write(`${CSI}2K${line}`)
      if (i < rows.length - 1) this.write('\n')
    })
    const targetRow = state.cursorRow
    const visualLastRow = rows.length - 1
    if (visualLastRow > targetRow) this.write(`${CSI}${visualLastRow - targetRow}A`)
    this.write(`\r${CSI}${Math.max(0, state.cursorCol)}C`)
  }

  private paint() {
    if (this.options.onChange) this.options.onChange(this.buffer, this.cursor)
    else this.renderLegacy()
  }
  clearDraft() {
    this.editUndo = []
    this.editRedo = []
    this.buffer = ''
    this.cursor = 0
    this.preferredColumn = 0
    this.historyIndex = -1
    this.savedBeforeHistory = ''
    this.clearCompletion()
    this.paint()
  }

  openCommandPalette(items: string[], onSelect?: PaletteAction) {
    const normalized = [...new Set(items.map(x => x.startsWith('/') ? x : `/${x}`))]
    return this.openRowPalette(normalized.map((value, index) => ({
      id: items.find(source => (source.startsWith('/') ? source : `/${source}`) === value)?.startsWith('/')
        ? `command:${value.replace(/^\//, '') || index}`
        : `palette:${index}`,
      label: value,
      value,
    })), 'palette', onSelect)
  }

  openRowPalette(rows: CompletionItem[], kind: CompletionKind = 'palette', onSelect?: PaletteAction, initialValue?: string) {
    const normalized = rows.filter(row => row && typeof row.value === 'string').map(row => ({ ...row, id: String(row.id), label: String(row.label), value: String(row.value) }))
    this.paletteItems = normalized.map(row => row.value)
    this.paletteRows = normalized
    this.paletteQuery = ''
    this.paletteAction = onSelect
    this.completionItems = [...this.paletteItems]
    this.completionRows = normalized.map(row => ({ ...row, swatches: row.swatches ? [...row.swatches] : undefined }))
    const preferred = initialValue === undefined ? -1 : normalized.findIndex(row => row.value === initialValue && !row.disabled)
    this.completionIndex = preferred >= 0 ? preferred : normalized.findIndex(row => !row.disabled)
    if (this.completionIndex < 0) this.completionIndex = normalized.length ? 0 : -1
    this.completionAnchor = null
    this.completionKind = kind
    this.completionQuery = ''
    this.options.onCompletion?.(this.completionItems.length ? { kind, items: [...this.completionItems], rows: this.completionRows.map(row => ({ ...row })), index: this.completionIndex, query: '' } : null, 'open')
  }

  openThemePalette(rows: CompletionItem[], onSelect?: PaletteAction, initialValue?: string) {
    return this.openRowPalette(rows, 'theme', onSelect, initialValue)
  }

  openEffectPalette(rows: CompletionItem[], onSelect?: PaletteAction, initialValue?: string) {
    return this.openRowPalette(rows, 'effect', onSelect, initialValue)
  }

  openBannerPalette(rows: CompletionItem[], onSelect?: PaletteAction, initialValue?: string) {
    return this.openRowPalette(rows, 'banner', onSelect, initialValue)
  }

  closeCommandPalette() {
    if (!['palette', 'theme', 'effect', 'banner'].includes(this.completionKind)) return
    this.clearCompletion('cancel')
    this.paint()
  }

  openHistoryPalette(items: string[]) {
    const normalized = [...new Set(items.filter(x => x.trim()))]
    this.paletteItems = normalized
    this.paletteRows = normalized.map((value, index) => ({ id: `history:${index}:${value.slice(0, 48)}`, label: value, value }))
    this.paletteQuery = ''
    this.paletteAction = undefined
    this.completionItems = normalized
    this.completionRows = this.paletteRows.map(row => ({ ...row }))
    this.completionIndex = normalized.length ? 0 : -1
    this.completionAnchor = null
    this.completionKind = 'history'
    this.completionQuery = ''
    this.options.onCompletion?.(this.completionItems.length ? { kind: 'history', items: [...this.completionItems], rows: [...this.completionRows], index: this.completionIndex, query: '' } : null, 'open')
  }

  private clearCompletion(reason?: 'commit' | 'cancel') {
    const wasVisualPalette = this.completionKind === 'theme' || this.completionKind === 'effect' || this.completionKind === 'banner'
    this.completionItems = []
    this.completionRows = []
    this.completionIndex = -1
    this.completionAnchor = null
    this.completionKind = 'command'
    this.completionQuery = ''
    this.paletteItems = []
    this.paletteQuery = ''
    this.paletteAction = undefined
    this.paletteRows = []
    this.options.onCompletion?.(null, reason ?? (wasVisualPalette ? 'cancel' : undefined))
  }

  private clearCompletionWithReason(reason: 'commit' | 'cancel') {
    this.clearCompletion(reason)
  }

  private currentToken(): { start: number; end: number; value: string } | null {
    const before = this.buffer.slice(0, this.cursor)
    const at = before.lastIndexOf('@')
    if (at === -1 || /\s/.test(before.slice(at + 1))) return null
    const after = this.buffer.slice(this.cursor).match(/^[^\s]*/)?.[0] ?? ''
    const end = this.cursor + chars(after).length
    return { start: at, end, value: this.buffer.slice(at + 1, end) }
  }

  private async refreshCompletions(cycle = false) {
    if (!this.options.completions) { this.clearCompletion(); return }
    const requestId = ++this.completionRequest
    const value = this.buffer
    const cursor = this.cursor
    const prefix = value.slice(0, cursor)
    let rows: CompletionItem[] = []
    let anchor: CompletionAnchor | null = null
    let kind: CompletionKind = 'command'
    let query = ''

    if (prefix.startsWith('/') && !prefix.includes('\n')) {
      const agentMatch = /^\/agent\s+(\S*)$/.exec(prefix)
      if (agentMatch) {
        query = agentMatch[1] || ''
        const source = normalizeCompletionItems(await this.options.completions(value, cursor))
        rows = filterCompletionRows(source, query)
        anchor = { start: 0, end: cursor }
        kind = 'agent'
      } else {
        const match = /^\/(\S*)$/.exec(prefix)
        if (match) {
          query = match[1] || ''
          const source = normalizeCompletionItems(await this.options.completions(value, cursor))
          rows = filterCompletionRows(source, query)
          anchor = { start: 0, end: cursor }
          kind = 'command'
        }
      }
    } else {
      const token = this.currentToken()
      if (token) {
        query = token.value
        const source = filterCompletionRows(normalizeCompletionItems(await this.options.completions(value, cursor)), token.value)
        rows = source.map(item => ({ ...item, id: item.id.startsWith('file:') ? item.id : `file:${item.id}`, label: `@${item.label}`, value: `@${item.value}` }))
        anchor = { start: token.start, end: token.end }
        kind = 'file'
      }
    }

    if (requestId !== this.completionRequest) return
    const items = rows.map(row => row.value)
    if (cycle && anchor && this.completionAnchor && anchor.start === this.completionAnchor.start && anchor.end === this.completionAnchor.end && this.completionItems.length) {
      this.completionIndex = (this.completionIndex + 1) % this.completionItems.length
    } else {
      this.completionItems = items
      this.completionRows = rows
      this.completionAnchor = anchor
      this.completionIndex = this.completionItems.length ? 0 : -1
    }
    this.completionKind = kind
    this.completionQuery = query
    this.notifyCompletion()
  }

  private filterPalette() {
    this.completionRows = filterCompletionRows(this.paletteRows, this.paletteQuery)
    this.completionItems = this.completionRows.map(row => row.value)
    this.completionIndex = this.completionItems.length ? Math.min(this.completionIndex, this.completionItems.length - 1) : -1
    this.completionQuery = this.paletteQuery
    this.notifyCompletion()
  }

  private notifyCompletion() {
    if (!this.completionItems.length || (this.completionKind !== 'palette' && this.completionKind !== 'history' && this.completionKind !== 'theme' && this.completionKind !== 'effect' && this.completionKind !== 'banner' && !this.completionAnchor)) {
      this.options.onCompletion?.(null)
      return
    }
    this.options.onCompletion?.({
      kind: this.completionKind,
      items: [...this.completionItems],
      rows: this.completionRows.map(row => ({ ...row })),
      index: this.completionIndex,
      query: this.completionQuery,
    }, 'update')
  }

  private moveCompletion(delta: number) {
    if (!this.completionItems.length) return false
    const direction = delta >= 0 ? 1 : -1
    let next = this.completionIndex
    for (let i = 0; i < this.completionItems.length; i++) {
      next = (next + direction + this.completionItems.length) % this.completionItems.length
      if (!this.completionRows[next]?.disabled) break
    }
    const changed = next !== this.completionIndex
    this.completionIndex = next
    this.notifyCompletion()
    this.paint()
    return changed
  }

  private applyCompletion() {
    if (this.completionIndex < 0 || !this.completionAnchor) return false
    if (this.completionRows[this.completionIndex]?.disabled) return false
    const value = this.completionRows[this.completionIndex]?.value ?? this.completionItems[this.completionIndex]
    const a = this.completionAnchor
    this.recordEdit()
    this.buffer = this.buffer.slice(0, a.start) + value + this.buffer.slice(a.end)
    this.cursor = a.start + chars(value).length
    this.clearCompletion()
    return true
  }

  async clickCompletion(index: number): Promise<PromptResult | null> {
    if (!this.completionItems.length) return null
    this.completionIndex = clamp(index, 0, this.completionItems.length - 1)
    const selectedRow = this.completionRows[this.completionIndex]
    if (selectedRow?.disabled) return null
    if (this.completionKind === 'palette' || this.completionKind === 'history' || this.completionKind === 'theme' || this.completionKind === 'effect' || this.completionKind === 'banner') {
      const value = this.completionItems[this.completionIndex] || ''
      const action = ['palette', 'theme', 'effect', 'banner'].includes(this.completionKind) ? this.paletteAction : undefined
      if (action) { await action(value); this.clearCompletionWithReason('commit'); this.paint(); return null }
      this.clearCompletion()
      return value ? { type: 'submit', value } : null
    }
    this.applyCompletion()
    this.paint()
    return null
  }

  private insert(text: string) {
    if (!text) return
    this.recordEdit()
    const all = chars(this.buffer)
    const insert = chars(text)
    all.splice(this.cursor, 0, ...insert)
    this.buffer = all.join('')
    this.cursor += insert.length
    this.preferredColumn = this.visualColumn()
    void this.refreshCompletions()
    this.paint()
  }

  private move(delta: number) {
    this.cursor = clamp(this.cursor + delta, 0, chars(this.buffer).length)
    this.preferredColumn = this.visualColumn()
    this.clearCompletion()
    this.paint()
  }

  private moveLineStart() {
    const all = chars(this.buffer)
    let i = this.cursor
    while (i > 0 && all[i - 1] !== '\n') i--
    this.cursor = i
    this.preferredColumn = 0
    this.clearCompletion()
    this.paint()
  }

  private moveLineEnd() {
    const all = chars(this.buffer)
    let i = this.cursor
    while (i < all.length && all[i] !== '\n') i++
    this.cursor = i
    this.preferredColumn = this.visualColumn()
    this.clearCompletion()
    this.paint()
  }

  private lineBounds(index = this.cursor) {
    const all = chars(this.buffer)
    let start = index
    while (start > 0 && all[start - 1] !== '\n') start--
    let end = index
    while (end < all.length && all[end] !== '\n') end++
    return { start, end }
  }

  private visualColumn(index = this.cursor) {
    const columns = Math.max(20, this.options.getColumns?.() ?? process.stdout.columns ?? 80)
    return layoutTextInput(this.buffer, index, promptTextWidth(columns), Number.MAX_SAFE_INTEGER).cursorColumn
  }

  private columnInLine(index = this.cursor) {
    const bounds = this.lineBounds(index)
    return index - bounds.start
  }

  private moveVertical(delta: -1 | 1) {
    const columns = Math.max(20, this.options.getColumns?.() ?? process.stdout.columns ?? 80)
    const visualWidth = promptTextWidth(columns)
    const layout = layoutTextInput(this.buffer, this.cursor, visualWidth, Number.MAX_SAFE_INTEGER)
    const currentRow = layout.cursorRow
    const targetRow = currentRow + delta
    if (targetRow < 0) return this.historyMove(-1)
    if (targetRow >= layout.rows.length) return this.historyMove(1)

    const target = layout.rows[targetRow]!
    const desiredColumn = this.preferredColumn || layout.cursorColumn
    let next = target.start
    let used = 0
    const targetChars = chars(this.buffer).slice(target.start, target.end)
    for (const ch of targetChars) {
      const w = widthOf(ch)
      if (used + w > desiredColumn) break
      used += w
      next++
    }
    this.cursor = next
    this.preferredColumn = desiredColumn
    this.clearCompletion()
    this.paint()
  }

  private moveWord(delta: number) {
    const all = chars(this.buffer)
    if (delta < 0) {
      let i = this.cursor
      while (i > 0 && /\s/.test(all[i - 1])) i--
      while (i > 0 && !/\s/.test(all[i - 1])) i--
      this.cursor = i
    } else {
      let i = this.cursor
      while (i < all.length && !/\s/.test(all[i])) i++
      while (i < all.length && /\s/.test(all[i])) i++
      this.cursor = i
    }
    this.clearCompletion()
    this.paint()
  }

  private deleteBackward() {
    if (!this.cursor) return this.paint()
    this.recordEdit()
    const all = chars(this.buffer)
    all.splice(this.cursor - 1, 1)
    this.buffer = all.join('')
    this.cursor--
    this.preferredColumn = this.visualColumn()
    void this.refreshCompletions()
    this.paint()
  }

  private deleteForward() {
    const all = chars(this.buffer)
    if (this.cursor >= all.length) return this.paint()
    this.recordEdit()
    if (this.cursor < all.length) all.splice(this.cursor, 1)
    this.buffer = all.join('')
    void this.refreshCompletions()
    this.paint()
  }

  private deleteWordBackward() {
    const all = chars(this.buffer)
    this.recordEdit()
    let start = this.cursor
    while (start > 0 && /\s/.test(all[start - 1])) start--
    while (start > 0 && !/\s/.test(all[start - 1])) start--
    all.splice(start, this.cursor - start)
    this.buffer = all.join('')
    this.cursor = start
    void this.refreshCompletions()
    this.paint()
  }

  private deleteWordForward() {
    const all = chars(this.buffer)
    if (this.cursor >= all.length) return this.paint()
    this.recordEdit()
    let end = this.cursor
    while (end < all.length && !/\s/.test(all[end])) end++
    while (end < all.length && /\s/.test(all[end])) end++
    all.splice(this.cursor, end - this.cursor)
    this.buffer = all.join('')
    void this.refreshCompletions()
    this.paint()
  }

  private killToStart() {
    const all = chars(this.buffer)
    let start = this.cursor
    while (start > 0 && all[start - 1] !== '\n') start--
    all.splice(start, this.cursor - start)
    this.buffer = all.join('')
    this.cursor = start
    void this.refreshCompletions()
    this.paint()
  }

  private killToEnd() {
    const all = chars(this.buffer)
    let end = this.cursor
    while (end < all.length && all[end] !== '\n') end++
    all.splice(this.cursor, end - this.cursor)
    this.buffer = all.join('')
    void this.refreshCompletions()
    this.paint()
  }

  private historyMove(delta: number) {
    if (!this.history.length) return
    if (delta < 0) {
      if (this.historyIndex === -1) this.savedBeforeHistory = this.buffer
      this.historyIndex = this.historyIndex === -1 ? this.history.length - 1 : Math.max(0, this.historyIndex - 1)
    } else {
      if (this.historyIndex === -1) return
      if (this.historyIndex >= this.history.length - 1) {
        this.historyIndex = -1
        this.buffer = this.savedBeforeHistory
        this.cursor = chars(this.buffer).length
        this.preferredColumn = this.visualColumn()
        this.clearCompletion()
        this.paint()
        return
      }
      this.historyIndex++
    }
    this.buffer = this.history[this.historyIndex] ?? ''
    this.cursor = chars(this.buffer).length
    this.preferredColumn = this.visualColumn()
    this.clearCompletion()
    this.paint()
  }

  private onCtrlC(): PromptResult {
    if (this.buffer) {
      this.buffer = ''
      this.cursor = 0
      this.historyIndex = -1
      this.clearCompletion()
      this.ctrlCArmed = false
      if (!this.options.onChange) this.write('^C\n')
      this.renderedRows = 0
      this.paint()
      return { type: 'cancel' }
    }
    if (this.ctrlCArmed) return { type: 'exit' }
    this.ctrlCArmed = true
    if (!this.options.onChange) this.write('^C (press Ctrl+C again to exit)\n')
    this.renderedRows = 0
    this.paint()
    setTimeout(() => { this.ctrlCArmed = false }, 1000)
    return { type: 'cancel' }
  }

  private async handleConfiguredShortcut(seq: string): Promise<boolean> {
    const action = this.keybindMap.get(seq)
    if (!action) return false
    await this.options.onShortcut?.(action)
    if (!this.options.isModalActive?.()) this.paint()
    return true
  }

  private async handleVimSequence(seq: string): Promise<PromptResult | null> {
    if (!this.vimMode) return null
    if (!this.vimNormal) {
      if (seq === '\x1b') { this.vimNormal = true; this.vimPendingD = false; if (this.cursor > 0 && this.buffer) this.cursor--; this.clearCompletion(); this.paint(); return null }
      return null
    }
    if (seq === '\x1b') { this.vimPendingD = false; return null }
    if (this.vimPendingD) {
      if (seq === 'd') {
        const bounds = this.lineBounds()
        this.recordEdit()
        const all = chars(this.buffer)
        const end = bounds.end < all.length ? bounds.end + 1 : bounds.end
        all.splice(bounds.start, end - bounds.start)
        this.buffer = all.join('')
        this.cursor = Math.min(bounds.start, chars(this.buffer).length)
        this.vimPendingD = false
        this.paint()
        return null
      }
      this.vimPendingD = false
    }
    if (seq === 'i') { this.vimNormal = false; this.paint(); return null }
    if (seq === 'a') { this.cursor = Math.min(chars(this.buffer).length, this.cursor + 1); this.vimNormal = false; this.paint(); return null }
    if (seq === 'A') { this.moveLineEnd(); this.vimNormal = false; return null }
    if (seq === 'I') { this.moveLineStart(); this.vimNormal = false; return null }
    if (seq === 'o') { this.moveLineEnd(); this.insert('\n'); this.vimNormal = false; return null }
    if (seq === 'O') { this.moveLineStart(); this.insert('\n'); this.cursor = Math.max(0, this.cursor - 1); this.vimNormal = false; return null }
    if (seq === 'h') { this.move(-1); return null }
    if (seq === 'l') { this.move(1); return null }
    if (seq === 'j') { this.moveVertical(1); return null }
    if (seq === 'k') { this.moveVertical(-1); return null }
    if (seq === 'w') { this.moveWord(1); return null }
    if (seq === 'b') { this.moveWord(-1); return null }
    if (seq === 'x') { this.deleteForward(); return null }
    if (seq === 'd') { this.vimPendingD = true; return null }
    if (seq === 'u') { this.undoEdit(); return null }
    if (seq === '\x12') { await this.options.onShortcut?.('history'); return null }
    if (seq === '\r') {
      const value = this.buffer
      if (!value.trim()) return null
      this.remember(value); this.reset(); return { type: 'submit', value }
    }
    return null
  }

  private async handleSequence(seq: string): Promise<PromptResult | null> {
    // Inspectors are presentation overlays. While the main editor owns stdin,
    // route navigation to the overlay instead of mutating the hidden draft.
    if (this.options.isOverlayActive?.()) {
      if (seq === '\x05') { await this.options.onShortcut?.('thinking'); return null }
      if (seq === '\x0f') { await this.options.onShortcut?.('details'); return null }
      const key = seq === '\x1b' ? 'escape'
        : seq === '\x1b[A' ? 'up'
        : seq === '\x1b[B' ? 'down'
        : seq === '\x1b[C' ? 'right'
        : seq === '\x1b[D' ? 'left'
        : seq === '\x1b[5~' ? 'pageup'
        : seq === '\x1b[6~' ? 'pagedown'
        : seq === '\x1b[1;5A' ? 'pageup'
        : seq === '\x1b[1;5B' ? 'pagedown'
        : (!seq.startsWith('\x1b') ? seq : '')
      if (key) { await this.options.onOverlayKey?.(key); return null }
    }
    if (this.vimMode && this.vimNormal) { const vimResult = await this.handleVimSequence(seq); if (vimResult) return vimResult; if (seq !== '\x1b') return null }
    if (this.vimMode && !this.vimNormal && seq === '\x1b') { return await this.handleVimSequence(seq) }
    if (seq === '\x03') {
      if (this.options.onInterrupt) {
        const handled = await this.options.onInterrupt()
        if (handled !== false) return null
      }
      return this.onCtrlC()
    }
    if (seq === '\x1b') { this.clearCompletion('cancel'); this.paint(); return null }
    if (this.completionKind === 'palette' || this.completionKind === 'history' || this.completionKind === 'theme' || this.completionKind === 'effect' || this.completionKind === 'banner') {
      if (seq === '\x7f' || seq === '\b') {
        this.paletteQuery = this.completionQuery.slice(0, -1)
        this.filterPalette()
        return null
      }
      if (seq === '\t') {
        if (this.completionItems.length) this.completionIndex = (this.completionIndex + 1) % this.completionItems.length
        this.notifyCompletion(); return null
      }
      if (seq === '\x10') { this.clearCompletion('cancel'); this.paint(); return null }
      if (seq.length === 1 && isPrintable(seq.codePointAt(0) || 0)) {
        this.paletteQuery += seq
        this.filterPalette()
        return null
      }
      if (seq.length > 1 && !seq.startsWith('\x1b')) {
        this.paletteQuery += seq.replace(/\r?\n/g, '')
        this.filterPalette()
        return null
      }
    }
    if (await this.handleConfiguredShortcut(seq)) return null
    if (seq === '\x1a') { this.undoEdit(); return null }
    if (seq === '\x19') { this.redoEdit(); return null }
    if (seq === '\x04') {
      if (!this.buffer) return { type: 'exit' }
      this.deleteForward()
      return null
    }
    if (seq === '\x0c') {
      if (!this.options.onChange) this.write('\x1b[2J\x1b[H')
      this.renderedRows = 0
      this.paint()
      return null
    }
    if (seq === '\r') {
      if ((this.completionKind === 'palette' || this.completionKind === 'history' || this.completionKind === 'theme' || this.completionKind === 'effect' || this.completionKind === 'banner') && this.completionItems.length) {
        const value = this.completionRows[this.completionIndex]?.value ?? this.completionItems[this.completionIndex] ?? ''
        const action = ['palette', 'theme', 'effect', 'banner'].includes(this.completionKind) ? this.paletteAction : undefined
        if (action) { await action(value); this.clearCompletionWithReason('commit'); this.paint(); return null }
        this.clearCompletion()
        return value ? { type: 'submit', value } : null
      }
      if (this.completionItems.length) {
        const exact = this.completionKind === 'command'
          ? this.completionItems.find(item => item === this.buffer)
          : undefined
        if (exact) {
          this.clearCompletion()
          const value = this.buffer
          this.remember(value)
          this.reset()
          return { type: 'submit', value }
        }
        this.applyCompletion(); this.paint(); return null
      }
      const value = this.buffer
      if (!value.trim()) return null
      this.remember(value)
      this.reset()
      return { type: 'submit', value }
    }
    if (seq === '\n') { this.insert('\n'); return null }
    if (seq === '\x01') { this.moveLineStart(); return null }
    if (seq === '\x05') { this.moveLineEnd(); return null }
    if (seq === '\x02') { this.move(-1); return null }
    if (seq === '\x06') { this.move(1); return null }
    if (seq === '\x17') { this.deleteWordBackward(); return null }
    if (seq === '\x0b') { this.killToEnd(); return null }
    if (seq === '\x15') { this.killToStart(); return null }
    if (seq === '\x7f' || seq === '\b') { this.deleteBackward(); return null }
    if (seq === '\t') {
      if (this.completionItems.length) { this.applyCompletion(); this.paint() }
      else {
        await this.refreshCompletions(false)
        if (this.completionItems.length) this.applyCompletion()
        else await this.handleConfiguredShortcut(seq)
        this.paint()
      }
      return null
    }
    if (seq === '\x1b[200~') { this.pasteMode = true; this.escapeBuffer = ''; return null }
    if (seq === '\x1b[201~') { this.pasteMode = false; this.escapeBuffer = ''; this.paint(); return null }
    if (seq === '\x1b[A') { if (this.moveCompletion(-1)) return null; this.moveVertical(-1); return null }
    if (seq === '\x1b[B') { if (this.moveCompletion(1)) return null; this.moveVertical(1); return null }
    if (seq === '\x1b[C') { this.move(1); return null }
    if (seq === '\x1b[D') { this.move(-1); return null }
    if (seq === '\x1b[H' || seq === '\x1b[1~' || seq === '\x1b[7~') { this.moveLineStart(); return null }
    if (seq === '\x1b[F' || seq === '\x1b[4~' || seq === '\x1b[8~') { this.moveLineEnd(); return null }
    if (seq === '\x1b[3~') { this.deleteForward(); return null }
    if (seq === '\x1b[5~') { this.options.onScroll?.(5); return null }
    if (seq === '\x1b[6~') { this.options.onScroll?.(-5); return null }
    if (seq === '\x1b[1;5A') { this.options.onScroll?.(3); return null }
    if (seq === '\x1b[1;5B') { this.options.onScroll?.(-3); return null }
    if (seq === '\x1b[1;5H') { this.options.onScroll?.(1000000); return null }
    if (seq === '\x1b[1;5F') { this.options.onScroll?.(-1000000); return null }
    if (seq === '\x1b[Z') {
      if (this.completionItems.length) this.moveCompletion(-1)
      else await this.handleConfiguredShortcut(seq)
      return null
    }
    if (seq === '\x1b[1;5D' || seq === '\x1bb') { this.moveWord(-1); return null }
    if (seq === '\x1b[1;5C' || seq === '\x1bf') { this.moveWord(1); return null }
    if (seq === '\x1bd') { this.deleteWordForward(); return null }
    if (seq === '\x1b\r' || seq === '\x1b[13;2u' || seq === '\x1b[13;3u' || seq === '\x1b[13;5u' || seq === '\x1b[27;2;13~' || seq === '\x1b[27;3;13~' || seq === '\x1b[27;5;13~') { this.insert('\n'); return null }
    if (seq.length === 1 && isPrintable(seq.codePointAt(0) || 0)) { this.insert(seq); return null }
    if (seq.length > 1 && !seq.startsWith('\x1b')) { this.insert(seq.replace(/\r\n/g, '\n').replace(/\r/g, '\n')); return null }
    return null
  }

  async read(): Promise<PromptResult> {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      const chunks: Uint8Array[] = []
      for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
      const input = Buffer.from(chunks).toString('utf8').trimEnd()
      return input ? { type: 'submit', value: input } : { type: 'exit' }
    }

    this.setRaw(true)
    this.options.onReadStateChange?.(true)
    if (this.options.onChange) this.options.onChange(this.buffer, this.cursor)
    else { this.write(this.prompt); this.renderedRows = 1 }

    return await new Promise<PromptResult>((resolve) => {
      const cleanup = () => {
        process.stdin.off('data', onData)
        process.stdout.off('resize', onResize)
        this.setRaw(false)
        this.options.onReadStateChange?.(false)
        this.escapeBuffer = ''
        this.pasteMode = false
        if (this.escapeTimer) clearTimeout(this.escapeTimer)
      }
      const finish = (result: PromptResult) => { cleanup(); resolve(result) }
      const onResize = () => this.paint()
      const onData = async (chunk: string) => {
        if (this.options.isModalActive?.()) return
        for (const ch of chunk) {
          if (this.options.isModalActive?.()) return
          if (this.pasteMode) {
            if (ch === '\x1b') {
            this.escapeBuffer = ch
            if (this.escapeTimer) clearTimeout(this.escapeTimer)
            this.escapeTimer = setTimeout(async () => {
              if (this.escapeBuffer !== '\x1b') return
              this.escapeBuffer = ''
              await this.handleSequence('\x1b')
            }, 45)
            continue
          }
            if (this.escapeBuffer) {
              this.escapeBuffer += ch
              if (this.escapeBuffer === '\x1b[201~') {
                this.pasteMode = false
                this.escapeBuffer = ''
                this.paint()
              }
              continue
            }
            this.insert(ch)
            continue
          }
          if (this.escapeBuffer) {
            if (this.escapeTimer) { clearTimeout(this.escapeTimer); this.escapeTimer = undefined }
            this.escapeBuffer += ch
            if (this.escapeBuffer.startsWith('\x1b[M') && this.escapeBuffer.length < 6) continue
            if (this.escapeBuffer.startsWith('\x1b[M') && this.escapeBuffer.length === 6) {
              const packet = this.escapeBuffer
              this.escapeBuffer = ''
              const event = parsePromptMouseSequence(packet)
              const code = event?.button ?? -1
              if (code === 64) this.options.onScroll?.(3)
              else if (code === 65) this.options.onScroll?.(-3)
              else if (event) void this.options.onMouse?.(event)
              continue
            }
            if (this.escapeBuffer === '\x1b[200~') {
              this.pasteMode = true
              this.escapeBuffer = ''
              continue
            }
            const complete = /^(?:\x1b\[<?[0-9;]*[A-Za-z~]|\x1b[A-Za-z]|\x1b\r)$/.test(this.escapeBuffer)
            if (complete) {
              const seq = this.escapeBuffer
              this.escapeBuffer = ''
              const mouse = parsePromptMouseSequence(seq)
              if (mouse) {
                if (mouse.button === 64) this.options.onScroll?.(3)
                else if (mouse.button === 65) this.options.onScroll?.(-3)
                else void this.options.onMouse?.(mouse)
                continue
              }
              const result = await this.handleSequence(seq)
              if (result) finish(result)
            } else if (this.escapeBuffer.length > 24) {
              this.escapeBuffer = ''
            }
            continue
          }
          if (ch === '\x1b') {
            this.escapeBuffer = ch
            if (this.escapeTimer) clearTimeout(this.escapeTimer)
            this.escapeTimer = setTimeout(async () => {
              if (this.escapeBuffer !== '\x1b') return
              this.escapeBuffer = ''
              this.escapeTimer = undefined
              const result = await this.handleSequence('\x1b')
              if (result) finish(result)
            }, 70)
            continue
          }
          const result = await this.handleSequence(ch)
          if (result) { finish(result); return }
        }
      }
      process.stdout.on('resize', onResize)
      process.stdin.on('data', onData)
    })
  }
}

function normalizeCompletionItems(items: Array<string | CompletionItem>): CompletionItem[] {
  return items.map((item, index) => typeof item === 'string'
    ? { id: `value:${index}:${item}`, label: item, value: item }
    : { ...item, id: String(item.id || `value:${index}:${item.value}`), label: String(item.label || item.value), value: String(item.value) })
}

function filterCompletionRows(items: CompletionItem[], query: string) {
  const q = query.trim().toLowerCase()
  if (!q) return [...items]
  const exact: CompletionItem[] = []
  const prefix: CompletionItem[] = []
  const fuzzy: CompletionItem[] = []
  for (const item of items) {
    const candidate = String(item.label || item.value).replace(/^\//, '').toLowerCase()
    if (candidate === q) exact.push(item)
    else if (candidate.startsWith(q)) prefix.push(item)
    else if (isSubsequence(q, candidate)) fuzzy.push(item)
  }
  return [...exact, ...prefix, ...fuzzy]
}

function rankCompletionItems(items: string[], query: string) {
  const q = query.trim().toLowerCase()
  if (!q) return [...items]
  const exact: string[] = []
  const prefix: string[] = []
  const fuzzy: string[] = []
  for (const item of items) {
    const candidate = item.replace(/^\//, '').toLowerCase()
    if (candidate === q) exact.push(item)
    else if (candidate.startsWith(q)) prefix.push(item)
    else if (isSubsequence(q, candidate)) fuzzy.push(item)
  }
  return [...exact, ...prefix, ...fuzzy]
}

function filterCompletionItems(items: string[], query: string, limit: number) {
  return rankCompletionItems(items, query).slice(0, limit)
}

function isSubsequence(query: string, candidate: string) {
  let i = 0
  for (const ch of candidate) if (ch === query[i]) i++
  return i === query.length
}

export function defaultCompletionItems(commands: string[], agents: string[], cwd: string): (value: string, cursor: number) => Promise<CompletionItem[]> {
  return async (value: string, cursor: number) => {
    const prefix = value.slice(0, cursor)
    if (prefix.startsWith('/') && !prefix.includes('\n')) {
      const commandMatch = /^\/(\S*)$/.exec(prefix)
      if (commandMatch) return commands.map(x => ({ id: `command:${x}`, label: `/${x}`, value: `/${x}` }))
      const agentMatch = /^\/agent\s+(\S*)$/.exec(prefix)
      if (agentMatch) return agents.map(x => ({ id: `agent:${x}`, label: `/agent ${x}`, value: `/agent ${x}` }))
      return []
    }
    const token = prefix.match(/@([^\s]*)$/)?.[1]
    if (token === undefined) return []
    const base = token.includes('/') ? path.dirname(token) : '.'
    const partial = token.includes('/') ? path.basename(token) : token
    try {
      const dir = path.resolve(cwd, base)
      const items: Array<{name: string; isDirectory(): boolean}> = await fs.readdir(dir, { withFileTypes: true })
      return items
        .filter(x => x.name.toLowerCase().startsWith(partial.toLowerCase()))
        .slice(0, 20)
        .map(x => {
          const relative = path.relative(cwd, path.join(dir, x.name)) + (x.isDirectory() ? '/' : '')
          return { id: `file:${relative}`, label: relative, value: relative, badge: x.isDirectory() ? 'dir' : undefined }
        })
    } catch {
      return []
    }
  }
}

export function defaultCompletions(commands: string[], agents: string[], cwd: string) {
  const structured = defaultCompletionItems(commands, agents, cwd)
  return async (value: string, cursor: number) => (await structured(value, cursor)).map(item => item.value)
}
