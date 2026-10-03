import type { ColorCapability, TextAttrs } from './types.js'

export const ESC = '\x1b['
export const RESET = `${ESC}0m`

export function detectColorCapability(env: Record<string, string | undefined>): ColorCapability {
  if (env.NO_COLOR !== undefined || env.TERM === 'dumb') return 'plain'
  const colorTerm = (env.COLORTERM ?? '').toLowerCase()
  const term = (env.TERM ?? '').toLowerCase()
  if (colorTerm === 'truecolor' || colorTerm === '24bit') return 'truecolor'
  if (term.includes('256color')) return 'ansi256'
  return 'ansi16'
}

export function styleSequence(attrs: TextAttrs = {}) {
  const codes: string[] = []
  if (attrs.bold) codes.push('1')
  if (attrs.dim) codes.push('2')
  if (attrs.italic) codes.push('3')
  if (attrs.underline) codes.push('4')
  if (attrs.inverse) codes.push('7')
  return codes.length ? `${ESC}${codes.join(';')}m` : ''
}

function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace(/^#/, '')
  if (clean.length === 3) {
    return [
      Number.parseInt(clean[0] + clean[0], 16),
      Number.parseInt(clean[1] + clean[1], 16),
      Number.parseInt(clean[2] + clean[2], 16),
    ]
  }
  if (!/^[0-9a-fA-F]{6}$/.test(clean)) return [255, 255, 255]
  return [
    Number.parseInt(clean.slice(0, 2), 16),
    Number.parseInt(clean.slice(2, 4), 16),
    Number.parseInt(clean.slice(4, 6), 16),
  ]
}

const ANSI16: Array<[number, number, number]> = [
  [0, 0, 0], [128, 0, 0], [0, 128, 0], [128, 128, 0],
  [0, 0, 128], [128, 0, 128], [0, 128, 128], [192, 192, 192],
  [128, 128, 128], [255, 0, 0], [0, 255, 0], [255, 255, 0],
  [0, 0, 255], [255, 0, 255], [0, 255, 255], [255, 255, 255],
]

function distance(a: [number, number, number], b: [number, number, number]) {
  const dr = a[0] - b[0]
  const dg = a[1] - b[1]
  const db = a[2] - b[2]
  return dr * dr + dg * dg + db * db
}

function rgbToAnsi256(rgb: [number, number, number]) {
  const [r, g, b] = rgb
  const cube = [0, 95, 135, 175, 215, 255]
  const ri = Math.max(0, Math.min(5, Math.round((r - 95) / 40)))
  const gi = Math.max(0, Math.min(5, Math.round((g - 95) / 40)))
  const bi = Math.max(0, Math.min(5, Math.round((b - 95) / 40)))
  const cubeCode = 16 + 36 * ri + 6 * gi + bi
  const cubeRgb: [number, number, number] = [cube[ri]!, cube[gi]!, cube[bi]!]
  const gray = Math.round((r + g + b) / 3)
  const grayIndex = Math.max(0, Math.min(23, Math.round((gray - 8) / 10)))
  const grayValue = 8 + grayIndex * 10
  const grayCode = 232 + grayIndex
  return distance(rgb, cubeRgb) <= distance(rgb, [grayValue, grayValue, grayValue]) ? cubeCode : grayCode
}

export function foreground(hex: string, capability: ColorCapability) {
  if (capability === 'plain' || !hex) return ''
  const rgb = hexToRgb(hex)
  if (capability === 'truecolor') return `${ESC}38;2;${rgb[0]};${rgb[1]};${rgb[2]}m`
  if (capability === 'ansi256') return `${ESC}38;5;${rgbToAnsi256(rgb)}m`
  let best = 0
  let bestDistance = Number.POSITIVE_INFINITY
  for (let i = 0; i < ANSI16.length; i++) {
    const d = distance(rgb, ANSI16[i]!)
    if (d < bestDistance) { bestDistance = d; best = i }
  }
  if (best < 8) return `${ESC}${30 + best}m`
  return `${ESC}${90 + best - 8}m`
}

export function background(hex: string, capability: ColorCapability) {
  if (capability === 'plain' || !hex) return ''
  const rgb = hexToRgb(hex)
  if (capability === 'truecolor') return `${ESC}48;2;${rgb[0]};${rgb[1]};${rgb[2]}m`
  if (capability === 'ansi256') return `${ESC}48;5;${rgbToAnsi256(rgb)}m`
  let best = 0
  let bestDistance = Number.POSITIVE_INFINITY
  for (let i = 0; i < ANSI16.length; i++) {
    const d = distance(rgb, ANSI16[i]!)
    if (d < bestDistance) { bestDistance = d; best = i }
  }
  if (best < 8) return `${ESC}${40 + best}m`
  return `${ESC}${100 + best - 8}m`
}

export function paint(text: string, options: { fg?: string; bg?: string; attrs?: TextAttrs; capability: ColorCapability }) {
  if (options.capability === 'plain') return text
  const prefix = `${foreground(options.fg ?? '', options.capability)}${background(options.bg ?? '', options.capability)}${styleSequence(options.attrs)}`
  return prefix ? `${prefix}${text}${RESET}` : text
}

export function stripAnsi(value: string) {
  return value.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
}

export function widthOf(value: string) {
  const text = stripAnsi(value)
  let width = 0
  for (const ch of Array.from(text)) {
    const code = ch.codePointAt(0) ?? 0
    if (code === 0 || code < 32 || (code >= 0x7f && code < 0xa0)) continue
    if (
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2329 && code <= 0x232a) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe10 && code <= 0xfe6f) ||
      (code >= 0xff01 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x1f300 && code <= 0x1faff)
    ) width += 2
    else width += 1
  }
  return width
}

export function clip(value: string, maxWidth: number, ellipsis = '…') {
  if (maxWidth <= 0) return ''
  if (widthOf(value) <= maxWidth) return value
  if (maxWidth === 1) return ellipsis.slice(0, 1)
  const target = maxWidth - widthOf(ellipsis)
  let out = ''
  let used = 0
  for (const ch of Array.from(stripAnsi(value))) {
    const w = widthOf(ch)
    if (used + w > target) break
    out += ch
    used += w
  }
  return `${out}${ellipsis}`
}

export function padRight(value: string, targetWidth: number) {
  return `${value}${' '.repeat(Math.max(0, targetWidth - widthOf(value)))}`
}
