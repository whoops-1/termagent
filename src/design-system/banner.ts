import { clip, paint, padRight, widthOf } from './ansi.js'
import { applyBannerEffect, normalizeBannerEffect, type BannerEffect } from './effects.js'
import type { BannerStyle, ColorCapability, Theme } from './types.js'
import { BANNER_WORD, BANNER_WORD_LINES, composeBannerWordmark, compose3DWord } from './banner-font.js'

export const BANNER_STYLES: ReadonlyArray<{ id: BannerStyle; label: string; detail: string }> = [
  { id: 'showcase', label: 'Showcase', detail: 'Full wordmark with a three-line color flow' },
  { id: 'split', label: 'Split Signal', detail: 'Two visual bands for wider terminals' },
  { id: 'signal', label: 'Signal', detail: 'Compact framed identity for medium screens' },
  { id: 'minimal', label: 'Minimal', detail: 'One-line identity for constrained screens' },
]

function center(value: string, width: number) {
  const left = Math.max(0, Math.floor((width - widthOf(value)) / 2))
  return `${' '.repeat(left)}${value}`
}

function lerpHex(a: string, b: string, t: number) {
  const parse = (value: string) => {
    const clean = value.replace(/^#/, '')
    return [parseInt(clean.slice(0, 2), 16), parseInt(clean.slice(2, 4), 16), parseInt(clean.slice(4, 6), 16)]
  }
  const aa = parse(a), bb = parse(b)
  const mix = aa.map((v, i) => Math.round(v + (bb[i]! - v) * t))
  return `#${mix.map(v => v.toString(16).padStart(2, '0')).join('')}`
}

function renderGradientLine(text: string, gradient: readonly string[], lineProgress: number, capability: ColorCapability, pulse = 0) {
  if (!text) return ''
  const stops = gradient.length >= 2 ? gradient : [gradient[0] ?? '#ffffff', gradient[0] ?? '#ffffff']
  let out = ''
  const count = Math.max(1, Array.from(text).length - 1)
  Array.from(text).forEach((char, index) => {
    const t = Math.max(0, Math.min(1, lineProgress * 0.35 + (index / count) * 0.65 + pulse))
    const segment = t * (stops.length - 1)
    const left = Math.min(stops.length - 2, Math.floor(segment))
    const local = segment - left
    out += paint(char, { fg: lerpHex(stops[left]!, stops[left + 1]!, local), capability, attrs: { bold: true } })
  })
  return out
}

function compactLine(width: number, version: string, theme: Theme, capability: ColorCapability) {
  const label = `${paint('>_', { fg: theme.primary, capability, attrs: { bold: true } })} ${paint('TermAgent', { fg: theme.text, capability, attrs: { bold: true } })} ${paint(`v${version}`, { fg: theme.muted, capability })}`
  return [padRight(center(clip(label, width), width), width)]
}

export function bannerWidth(_version: string) {
  const rows = composeBannerWordmark(BANNER_WORD_LINES, 1)
  return Math.max(...rows.map(widthOf))
}

export function renderBanner(options: {
  width: number
  version: string
  theme: Theme
  capability: ColorCapability
  style?: BannerStyle
  effect?: BannerEffect
  frame?: number
  animations?: boolean
}) {
  const width = Math.max(24, options.width)
  const version = options.version
  const theme = options.theme
  const capability = options.capability
  const style = options.style ?? theme.banner?.style ?? 'showcase'
  const effect = options.animations === false ? 'off' : normalizeBannerEffect(options.effect)
  const frame = options.frame ?? 0
  const gradient = theme.banner?.gradient ?? [theme.primary, theme.secondary, theme.accent]
  const tagline = theme.banner?.tagline ?? 'Code. Explore. Verify.'

  if (width < 48 || style === 'minimal') return compactLine(width, version, theme, capability)

  let rows: string[]
  if (style === 'signal') {
    const title = `◆ TermAgent  ·  ${version}`
    const signal = `  ${theme.banner?.highlight ? paint('●', { fg: theme.banner.highlight, capability }) : '●'}  ${tagline}`
    rows = [
      padRight(center(paint(`╭─ ${clip(title, Math.max(16, width - 8))} ─╮`, { fg: theme.banner?.accent ?? theme.accent, capability, attrs: { bold: true } }), width), width),
      padRight(center(paint(clip(signal, width - 4), { fg: theme.text, capability }), width), width),
      padRight(center(paint('inspect · change · verify', { fg: theme.muted, capability }), width), width),
    ]
  } else {
    const logoRows = composeBannerWordmark(BANNER_WORD_LINES, 1)
    const pulse = effect === 'pulse' ? ((Math.sin(frame / 3) + 1) / 2) * 0.035 : 0
    rows = logoRows.map((row, i) => {
      const painted = renderGradientLine(clip(row, width), gradient, logoRows.length <= 1 ? 0 : i / (logoRows.length - 1), capability, pulse)
      return padRight(center(painted, width), width)
    })
    if (style === 'split') {
      rows.push(padRight(center(paint(`▸ ${tagline}`, { fg: theme.banner?.accent ?? theme.accent, capability, attrs: { bold: true } }), width), width))
      rows.push(padRight(center(paint(`termagent · v${version}`, { fg: theme.muted, capability }), width), width))
    } else {
      const legacyDefault = theme.name === 'TermAgent'
      ? { tagline: 'Open terminal for any LLM', versionLabel: `termagent v${version}` }
      : { tagline, versionLabel: `TermAgent  v${version}` }
      rows.push(padRight(center(paint(`✦ ${legacyDefault.tagline} ✦`, { fg: theme.banner?.highlight ?? theme.info, capability, attrs: { bold: true } }), width), width))
      rows.push(padRight(center(paint(legacyDefault.versionLabel, { fg: theme.muted, capability }), width), width))
    }
  }

  return applyBannerEffect({ rows, width, frame, effect, theme, capability })
}

export function renderBannerStyleRows(theme: Theme, activeStyle: BannerStyle = theme.banner?.style ?? 'showcase') {
  return BANNER_STYLES.map(item => ({
    id: `banner:${item.id}`,
    label: item.label,
    value: item.id,
    detail: item.detail,
    badge: item.id === activeStyle ? 'active' : 'style',
    status: item.id === activeStyle ? 'active' as const : 'default' as const,
    swatches: theme.banner?.gradient ? [...theme.banner.gradient] : [theme.primary, theme.secondary, theme.accent],
  }))
}

// Retain the original helper for external consumers and existing visual tests.
export function bannerWordmarkRows() {
  return compose3DWord(BANNER_WORD, 1)
}
