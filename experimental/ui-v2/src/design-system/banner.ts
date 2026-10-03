import { clip, paint, padRight, widthOf } from './ansi.js'
import type { ColorCapability, Theme } from './types.js'
import { BANNER_GLYPH_HEIGHT, BANNER_WORD, BANNER_WORD_LINES, composeBannerWordmark, compose3DWord } from './banner-font.js'

// Startup-only forest tones keep the wordmark distinct from the semantic TUI palette.
// They are intentionally scoped to the banner and do not change other surfaces.
const FOREST_GRADIENT = [
  [180, 240, 170],
  [130, 215, 130],
  [85, 180, 95],
  [55, 145, 75],
  [40, 110, 60],
  [25, 80, 45],
] as const
const FOREST_ACCENT = [120, 200, 120] as const
const FOREST_CREAM = [200, 220, 190] as const
const FOREST_DIM = [90, 120, 90] as const

type RGB = readonly [number, number, number]

function lerp(a: RGB, b: RGB, t: number): RGB {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ]
}

function gradAt(stops: readonly RGB[], t: number): RGB {
  const c = Math.max(0, Math.min(1, t))
  const s = c * (stops.length - 1)
  const i = Math.floor(s)
  if (i >= stops.length - 1) return stops[stops.length - 1]!
  return lerp(stops[i]!, stops[i + 1]!, s - i)
}

function center(value: string, width: number) {
  const left = Math.max(0, Math.floor((width - widthOf(value)) / 2))
  return `${' '.repeat(left)}${value}`
}

function paintLine(text: string, stops: readonly RGB[], lineT: number, capability: ColorCapability) {
  let out = ''
  for (let i = 0; i < text.length; i++) {
    const t = text.length > 1
      ? lineT * 0.5 + (i / (text.length - 1)) * 0.5
      : lineT
    const [r, g, b] = gradAt(stops, t)
    out += paint(text[i]!, {
      fg: `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`,
      capability,
      attrs: { bold: true },
    })
  }
  return out
}

function bannerWordWidth() {
  const rows = composeBannerWordmark(BANNER_WORD_LINES, 1)
  return Math.max(...rows.map(row => widthOf(row)))
}

export function bannerWidth(_version: string) {
  return bannerWordWidth()
}

function compactFallback(width: number, version: string, theme: Theme, capability: ColorCapability) {
  const compact = `${paint('>_', { fg: theme.primary, capability, attrs: { bold: true } })} ${paint(BANNER_WORD, { fg: theme.text, capability, attrs: { bold: true } })} ${paint(`v${version}`, { fg: theme.muted, capability })}`
  const rows = [padRight(center(clip(compact, width), width), width)]
  if (width >= 48) {
    rows.push(padRight(center(
      paint('AI AGENT FOR YOUR TERMINAL', { fg: theme.muted, capability }),
      width,
    ), width))
  }
  return rows
}

/**
 * Startup banner built around TermAgent's block wordmark:
 * ANSI Shadow wordmark, centered tagline, and dim version line.
 * The provider metadata remains the responsibility of the surrounding header,
 * matching the separation already used by TermAgent's CLI renderer.
 */
export function renderBanner(options: {
  width: number
  version: string
  theme: Theme
  capability: ColorCapability
}) {
  const { width, version, theme, capability } = options
  const safe = Math.max(24, width)
  const logoRows = composeBannerWordmark(BANNER_WORD_LINES, 1)
  const logoWidth = Math.max(...logoRows.map(row => widthOf(row)))

  // Full block-art is used at comfortable widths;
  // falls back to stacked blocks below its single-row threshold. TermAgent's
  // own two-line wordmark is already designed around that stacked presentation.
  if (safe >= logoWidth + 2) {
    const rows = logoRows.map((row, i) => {
      const lineT = logoRows.length <= 1 ? 0 : i / (logoRows.length - 1)
      return padRight(center(paintLine(clip(row, safe), FOREST_GRADIENT, lineT, capability), safe), safe)
    })

    const tagline = `${paint('✦', { fg: `#${FOREST_ACCENT.map(v => v.toString(16).padStart(2, '0')).join('')}`, capability, attrs: { bold: true } })} ${paint('Open terminal for any LLM', { fg: `#${FOREST_CREAM.map(v => v.toString(16).padStart(2, '0')).join('')}`, capability })} ${paint('✦', { fg: `#${FOREST_ACCENT.map(v => v.toString(16).padStart(2, '0')).join('')}`, capability, attrs: { bold: true } })}`
    rows.push(padRight(center(tagline, safe), safe))

    const versionText = `${paint('termagent', { fg: `#${FOREST_DIM.map(v => v.toString(16).padStart(2, '0')).join('')}`, capability })} ${paint(`v${version}`, { fg: `#${FOREST_ACCENT.map(v => v.toString(16).padStart(2, '0')).join('')}`, capability })}`
    rows.push(padRight(center(versionText, safe), safe))
    return rows
  }

  return compactFallback(safe, version, theme, capability)
}

// Keep a small compatibility export for older experimental imports.
export function bannerWordmarkRows() {
  return compose3DWord(BANNER_WORD, 1)
}
