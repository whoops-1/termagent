import { clip, paint, padRight, widthOf } from './ansi.js'
import type { ColorCapability, Theme } from './types.js'

export type BannerEffect = 'off' | 'drift' | 'glyphfall' | 'spark' | 'ripple' | 'dust' | 'pulse'

export const BANNER_EFFECTS: ReadonlyArray<{ id: BannerEffect; label: string; detail: string }> = [
  { id: 'off', label: 'Still', detail: 'No ambient motion' },
  { id: 'drift', label: 'Drift', detail: 'Soft particles crossing the banner' },
  { id: 'glyphfall', label: 'Glyph Fall', detail: 'Sparse coding glyphs descend through the band' },
  { id: 'spark', label: 'Spark', detail: 'Occasional bright accents near the wordmark' },
  { id: 'ripple', label: 'Ripple', detail: 'A restrained wave through the banner edge' },
  { id: 'dust', label: 'Dust', detail: 'Very low density texture for small terminals' },
  { id: 'pulse', label: 'Pulse', detail: 'Only the banner accent breathes, no particles' },
]

export function normalizeBannerEffect(value: string | undefined): BannerEffect {
  return BANNER_EFFECTS.some(item => item.id === value) ? value as BannerEffect : 'off'
}

function phase(frame: number, modulo: number, offset = 0) {
  const n = Math.max(1, modulo)
  return ((Math.floor(frame) + offset) % n + n) % n
}

function visibleCellAt(row: string, targetColumn: number) {
  let column = 0
  for (let i = 0; i < row.length;) {
    if (row[i] === '\x1b') {
      const match = row.slice(i).match(/^\x1b\[[0-9;?]*[A-Za-z]/)
      if (match) { i += match[0].length; continue }
    }
    const codePoint = row.codePointAt(i) ?? 0
    const ch = String.fromCodePoint(codePoint)
    const width = widthOf(ch)
    if (targetColumn >= column && targetColumn < column + Math.max(1, width)) return ch
    column += width
    i += ch.length
  }
  return undefined
}

function paintOverlayRow(row: string, overlay: Map<number, { glyph: string; color: string }>, capability: ColorCapability) {
  if (!overlay.size) return row
  let out = ''
  let column = 0
  for (let i = 0; i < row.length;) {
    if (row[i] === '\x1b') {
      const match = row.slice(i).match(/^\x1b\[[0-9;?]*[A-Za-z]/)
      if (match) { out += match[0]; i += match[0].length; continue }
    }
    const codePoint = row.codePointAt(i) ?? 0
    const ch = String.fromCodePoint(codePoint)
    const cell = overlay.get(column)
    out += cell && ch === ' ' ? paint(cell.glyph, { fg: cell.color, capability, attrs: { bold: true } }) : ch
    column += widthOf(ch)
    i += ch.length
  }
  return out
}

export function applyBannerEffect(options: {
  rows: string[]
  width: number
  frame: number
  effect: BannerEffect
  theme: Theme
  capability: ColorCapability
}) {
  const rows = options.rows.map(row => padRight(clip(row, options.width), options.width))
  if (options.effect === 'off' || options.capability === 'plain' && options.effect === 'pulse') return rows

  const overlay = new Map<number, { glyph: string; color: string }>()
  const colorA = options.theme.banner?.accent ?? options.theme.primary
  const colorB = options.theme.banner?.highlight ?? options.theme.secondary
  const height = rows.length

  if (options.effect === 'drift' || options.effect === 'dust' || options.effect === 'spark') {
    const density = options.effect === 'dust' ? 13 : options.effect === 'drift' ? 9 : 17
    for (let x = phase(options.frame * 2, density * 3); x < options.width; x += density) {
      const y = phase(Math.floor(options.frame / 2), Math.max(1, height), x % Math.max(1, height))
      const row = rows[y] ?? ''
      if (visibleCellAt(row, x) === ' ') {
        overlay.set(x, {
          glyph: options.effect === 'spark' ? '✦' : options.effect === 'drift' ? '·' : '∙',
          color: options.effect === 'spark' && x % 2 === 0 ? colorB : colorA,
        })
      }
    }
  }

  if (options.effect === 'glyphfall') {
    const glyphs = ['.', ':', '|', '+']
    for (let x = phase(options.frame, 11); x < options.width; x += 11) {
      const y = phase(options.frame + x, Math.max(1, height))
      const row = rows[y] ?? ''
      if (visibleCellAt(row, x) === ' ') overlay.set(x, { glyph: glyphs[(x + options.frame) % glyphs.length]!, color: colorA })
    }
  }

  if (options.effect === 'ripple') {
    const y = height - 1
    const row = rows[y] ?? ''
    for (let x = phase(options.frame, 8); x < options.width; x += 8) {
      if (visibleCellAt(row, x) === ' ') overlay.set(x, { glyph: x % 16 === 0 ? '≈' : '~', color: colorB })
    }
  }

  return rows.map(row => paintOverlayRow(row, overlay, options.capability))
}

export function renderEffectPickerRows(theme: Theme, activeEffect: BannerEffect = 'off') {
  return BANNER_EFFECTS.map(item => ({
    id: `effect:${item.id}`,
    label: item.label,
    value: item.id,
    detail: item.detail,
    badge: item.id === activeEffect ? 'selected' : item.id === 'off' ? 'quiet' : 'banner',
    status: item.id === activeEffect ? 'active' as const : 'default' as const,
    swatches: item.id === 'off' ? [theme.muted] : [theme.banner?.accent ?? theme.primary, theme.banner?.highlight ?? theme.secondary],
  }))
}
