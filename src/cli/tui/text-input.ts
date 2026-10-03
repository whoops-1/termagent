export type VisualInputRow = { text: string; start: number; end: number }

export type TextInputLayout = {
  rows: VisualInputRow[]
  cursorRow: number
  cursorColumn: number
  totalRows: number
  viewportCharOffset: number
  viewportCharEnd: number
  hiddenAbove: boolean
  hiddenBelow: boolean
}

export function widthOf(value: string) {
  let width = 0
  for (const ch of Array.from(value)) {
    const c = ch.codePointAt(0) || 0
    if (
      (c >= 0x1100 && c <= 0x115f) || (c >= 0x2329 && c <= 0x232a) ||
      (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe10 && c <= 0xfe6f) ||
      (c >= 0xff01 && c <= 0xff60) || (c >= 0xffe0 && c <= 0xffe6) ||
      (c >= 0x1f300 && c <= 0x1faff)
    ) width += 2
    else width += 1
  }
  return width
}

export function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n))
}

export function promptTextWidth(columns: number) {
  // Keep the established prompt rail while reserving one cell for the caret
  // for the declared caret. The editor and renderer share this exact width.
  return Math.max(12, Math.max(20, columns) - 4)
}

/**
 * TermAgent's text-input state keeps the cursor separate from the rendered
 * value and tracks a viewport over the rendered rows. TermAgent mirrors that
 * invariant without importing the renderer itself.
 */
export function layoutTextInput(value: string, cursor: number, width: number, maxVisibleLines: number): TextInputLayout {
  const safeWidth = Math.max(8, width)
  const chars = Array.from(value)
  const cursorIndex = clamp(cursor, 0, chars.length)
  const rows: VisualInputRow[] = []
  let start = 0
  let text = ''
  let used = 0

  const push = (end: number) => {
    rows.push({ text, start, end })
    text = ''
    used = 0
    start = end
  }

  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]!
    if (ch === '\n') {
      push(i)
      start = i + 1
      continue
    }
    const w = widthOf(ch)
    if (text && used + w > safeWidth) push(i)
    text += ch
    used += w
  }
  push(chars.length)

  let cursorRow = rows.length - 1
  let cursorColumn = 0
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!
    const belongs = cursorIndex < row.end ||
      (cursorIndex === row.end && i === rows.length - 1) ||
      (cursorIndex === row.end && rows[i + 1]?.start !== cursorIndex)
    if (!belongs) continue
    cursorRow = i
    cursorColumn = widthOf(chars.slice(row.start, cursorIndex).join(''))
    break
  }

  const maxLines = Math.max(1, maxVisibleLines)
  let windowStart = 0
  if (rows.length > maxLines) {
    // Keep a little context above the caret while guaranteeing the caret is
    // visible. This is the same basic viewport model used by TermAgent's
    // BaseTextInput rather than scrolling the whole prompt as one string.
    windowStart = clamp(cursorRow - Math.max(1, Math.floor(maxLines / 2)), 0, rows.length - maxLines)
  }
  const windowRows = rows.slice(windowStart, windowStart + maxLines)
  const first = windowRows[0]
  const last = windowRows[windowRows.length - 1]

  return {
    rows: windowRows,
    cursorRow: cursorRow - windowStart,
    cursorColumn,
    totalRows: rows.length,
    viewportCharOffset: first?.start ?? 0,
    viewportCharEnd: last?.end ?? chars.length,
    hiddenAbove: windowStart > 0,
    hiddenBelow: windowStart + maxLines < rows.length,
  }
}

export function visualCursorColumn(value: string, cursor: number, width: number) {
  return layoutTextInput(value, cursor, width, Number.MAX_SAFE_INTEGER).cursorColumn
}
