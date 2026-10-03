export type Glyph = readonly string[]

// TermAgent's startup banner uses a six-row ANSI Shadow-style block-letter treatment.
// The glyphs remain static terminal rows so banner rendering stays deterministic and
// dependency-light while preserving TermAgent's own wordmark.
const ANSI_SHADOW_GLYPHS: Record<string, Glyph> = {
  A: [
    ' █████╗ ',
    '██╔══██╗',
    '███████║',
    '██╔══██║',
    '██║  ██║',
    '╚═╝  ╚═╝',
  ],
  E: [
    '███████╗',
    '██╔════╝',
    '█████╗  ',
    '██╔══╝  ',
    '███████╗',
    '╚══════╝',
  ],
  G: [
    ' ██████╗ ',
    '██╔════╝ ',
    '██║  ███╗',
    '██║   ██║',
    '╚██████╔╝',
    ' ╚═════╝ ',
  ],
  M: [
    '███╗   ███╗',
    '████╗ ████║',
    '██╔████╔██║',
    '██║╚██╔╝██║',
    '██║ ╚═╝ ██║',
    '╚═╝     ╚═╝',
  ],
  N: [
    '███╗   ██╗',
    '████╗  ██║',
    '██╔██╗ ██║',
    '██║╚██╗██║',
    '██║ ╚████║',
    '╚═╝  ╚═══╝',
  ],
  R: [
    '██████╗ ',
    '██╔══██╗',
    '██████╔╝',
    '██╔══██╗',
    '██║  ██║',
    '╚═╝  ╚═╝',
  ],
  T: [
    '████████╗',
    '╚══██╔══╝',
    '   ██║   ',
    '   ██║   ',
    '   ██║   ',
    '   ╚═╝   ',
  ],
  ' ': ['', '', '', '', '', ''],
}

export const CELL = '█'
export const SHADOW_NEAR = '▓'
export const SHADOW_FAR = '░'
export const BANNER_WORD = 'TermAgent'
export const BANNER_WORD_LINES = ['TERM', 'AGENT'] as const
export const BANNER_GLYPH_HEIGHT = 6
export const BANNER_LINE_GAP = 0

export function glyph(char: string): Glyph {
  return ANSI_SHADOW_GLYPHS[char.toUpperCase()] ?? ANSI_SHADOW_GLYPHS[' ']!
}

function composeAnsiShadowWord(word: string, letterSpacing: number): string[] {
  const chars = Array.from(word.toUpperCase())
  if (chars.length === 0) return Array.from({ length: BANNER_GLYPH_HEIGHT }, () => '')

  const rows = Array.from({ length: BANNER_GLYPH_HEIGHT }, () => '')
  for (let row = 0; row < BANNER_GLYPH_HEIGHT; row++) {
    rows[row] = chars
      .map(char => glyph(char)[row] ?? '')
      .join(' '.repeat(Math.max(1, letterSpacing)))
  }
  // Keep every row the same width. Trimming trailing spaces makes glyphs with
  // lower-row whitespace (notably T) narrower, which shifts those rows when
  // callers center each line independently.
  const width = Math.max(...rows.map(row => Array.from(row).length))
  return rows.map(row => row + ' '.repeat(width - Array.from(row).length))
}

/** Compose one ANSI Shadow-style word using TermAgent's static terminal-art style. */
export function compose3DWord(word: string, letterSpacing = 1): string[] {
  return composeAnsiShadowWord(word, letterSpacing)
}

/** Compose the compact 6-row variant without extrusion/shade blocks. */
export function composeWord(word: string, letterSpacing = 1): string[] {
  return composeAnsiShadowWord(word, letterSpacing)
}

export function composeBannerWordmark(words: readonly string[] = BANNER_WORD_LINES, letterSpacing = 1): string[] {
  const out: string[] = []
  for (let i = 0; i < words.length; i++) {
    out.push(...composeAnsiShadowWord(words[i]!, letterSpacing))
    if (i < words.length - 1 && BANNER_LINE_GAP > 0) {
      out.push(...Array.from({ length: BANNER_LINE_GAP }, () => ''))
    }
  }
  return out
}
