import { clip, padRight, widthOf } from './ansi.js'

export type FrameGeometry = {
  outerWidth: number
  borderLeft: number
  borderRight: number
  paddingLeft: number
  paddingRight: number
}

/**
 * Compute the content width for a terminal row exactly once.
 * Borders and padding are structural costs and must never be subtracted again
 * by a child renderer.
 */
export function contentWidth(width: number, geometry: Pick<FrameGeometry, 'borderLeft' | 'borderRight' | 'paddingLeft' | 'paddingRight'>): number {
  return Math.max(1, width - geometry.borderLeft - geometry.borderRight - geometry.paddingLeft - geometry.paddingRight)
}

export function boundedWidth(available: number, minWidth: number, maxWidth: number): number {
  const safeMax = Math.max(minWidth, maxWidth)
  return Math.max(minWidth, Math.min(safeMax, available))
}

export function centeredFrame(width: number, requested: number, minWidth: number, maxWidth: number) {
  const available = Math.max(1, width)
  const effectiveMin = Math.min(Math.max(1, minWidth), available)
  const effectiveMax = Math.max(effectiveMin, Math.min(Math.max(1, maxWidth), available))
  const frameWidth = Math.max(effectiveMin, Math.min(effectiveMax, Math.max(effectiveMin, requested)))
  const left = Math.max(0, Math.floor((available - frameWidth) / 2))
  const right = Math.max(0, available - frameWidth - left)
  return { frameWidth, left, right }
}

export function fitRow(value: string, width: number): string {
  return padRight(clip(value, Math.max(0, width)), Math.max(0, width))
}

export function remainingWidth(total: number, ...parts: number[]) {
  return Math.max(0, total - parts.reduce((sum, value) => sum + Math.max(0, value), 0))
}

export function columnWidth(labelWidths: readonly number[], min = 1, max = Number.MAX_SAFE_INTEGER) {
  if (!labelWidths.length) return min
  const widest = Math.max(...labelWidths)
  return Math.max(min, Math.min(max, widest))
}

export function widthBudget(value: string, available: number, reserve = 0) {
  return Math.max(0, available - widthOf(value) - Math.max(0, reserve))
}
