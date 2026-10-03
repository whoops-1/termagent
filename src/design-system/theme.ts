import type { Theme, ThemeTokens } from './types.js'
import process from 'node:process'
import { promises as fs } from 'node:fs'

const makeTheme = (value: Theme): Theme => ({
  ...value,
  banner: {
    gradient: value.banner?.gradient ?? [value.primary, value.secondary, value.accent],
    accent: value.banner?.accent ?? value.accent,
    highlight: value.banner?.highlight ?? value.info,
    style: value.banner?.style ?? 'showcase',
    tagline: value.banner?.tagline ?? 'Code. Explore. Verify.',
  },
  motion: { intensity: value.motion?.intensity ?? 'subtle' },
})

// Original TermAgent palette catalog. Names and visual recipes are intentionally
// native to this project rather than mirroring another project's theme labels.
const THEMES_INTERNAL: Record<string, Theme> = {
  termagent: {
    name: 'TermAgent', background: '#05070b', panel: '#111722', surface: '#171e2b', text: '#f4f7fb', muted: '#8d98a8', subtle: '#596475', border: '#344052', borderActive: '#a8b8ff', primary: '#a8b8ff', secondary: '#bc8cff', accent: '#ff8a4c', user: '#7dc4ff', assistant: '#ff9d67', tool: '#a8b8ff', reasoning: '#8993a3', success: '#57d889', warning: '#ffd166', error: '#ff6b7a', info: '#86a8ff', selection: '#233a5c', diffAdded: '#173f2a', diffRemoved: '#562433', diffContext: '#252f3d', markdownHeading: '#a8b8ff', markdownLink: '#86a8ff', markdownCode: '#57d889', markdownQuote: '#ffd166', syntaxComment: '#667285', syntaxKeyword: '#b6a3ff', syntaxFunction: '#86c8ff', syntaxVariable: '#f4f7fb', syntaxString: '#6fe29a', syntaxNumber: '#ffd166', syntaxType: '#9dc6ff', syntaxOperator: '#d0a3ff', syntaxPunctuation: '#d7dee8',
    banner: { gradient: ['#78d6ff', '#b29cff', '#ff895c'], accent: '#ff895c', highlight: '#8fd5ff', style: 'showcase', tagline: 'Code. Explore. Verify.' },
    motion: { intensity: 'subtle' },
  },
  forge: {
    name: 'Forge', background: '#100b08', panel: '#1b120e', surface: '#241914', text: '#fff6ee', muted: '#ae9485', subtle: '#705c50', border: '#60483c', borderActive: '#ffb07a', primary: '#ffb07a', secondary: '#ffcc80', accent: '#ff7043', user: '#ffc078', assistant: '#ff8a65', tool: '#ffb07a', reasoning: '#9d8378', success: '#7bd88f', warning: '#ffd166', error: '#ff6b6b', info: '#ffae75', selection: '#4c2a1b', diffAdded: '#1d4b2b', diffRemoved: '#5c2527', diffContext: '#382a22', markdownHeading: '#ffb07a', markdownLink: '#ffc078', markdownCode: '#7bd88f', markdownQuote: '#ffd166', syntaxComment: '#806a60', syntaxKeyword: '#ffb07a', syntaxFunction: '#ffd39a', syntaxVariable: '#fff6ee', syntaxString: '#9ee7a7', syntaxNumber: '#ffd166', syntaxType: '#ffb06d', syntaxOperator: '#ff9b6b', syntaxPunctuation: '#eadbd1',
    banner: { gradient: ['#ffd180', '#ff9966', '#ff5d5d'], accent: '#ff7043', highlight: '#ffd180', style: 'signal', tagline: 'Shape code with intent.' },
    motion: { intensity: 'subtle' },
  },
  tideglass: {
    name: 'Tideglass', background: '#061017', panel: '#0d1b26', surface: '#122633', text: '#eaf7ff', muted: '#89a6b6', subtle: '#557080', border: '#2b4758', borderActive: '#74d6f7', primary: '#74d6f7', secondary: '#89b8ff', accent: '#52e0c4', user: '#6dcfff', assistant: '#83e0ff', tool: '#74d6f7', reasoning: '#8097a5', success: '#65e6a3', warning: '#ffd166', error: '#ff7186', info: '#82b6ff', selection: '#173d50', diffAdded: '#12442e', diffRemoved: '#542736', diffContext: '#213642', markdownHeading: '#74d6f7', markdownLink: '#82b6ff', markdownCode: '#65e6a3', markdownQuote: '#ffd166', syntaxComment: '#5d7582', syntaxKeyword: '#92c6ff', syntaxFunction: '#6edfff', syntaxVariable: '#eaf7ff', syntaxString: '#72e9ae', syntaxNumber: '#ffd166', syntaxType: '#88d2ff', syntaxOperator: '#b6adff', syntaxPunctuation: '#d5e7ef',
    banner: { gradient: ['#6ee7ff', '#7db7ff', '#58e0c6'], accent: '#58e0c6', highlight: '#9ed8ff', style: 'showcase', tagline: 'Calm surface. Sharp tools.' },
    motion: { intensity: 'calm' },
  },
  violetwire: {
    name: 'Violet Wire', background: '#0d0815', panel: '#171024', surface: '#20152f', text: '#f7f1ff', muted: '#a394b5', subtle: '#69577b', border: '#46345c', borderActive: '#d6a8ff', primary: '#d6a8ff', secondary: '#8da7ff', accent: '#ff79c6', user: '#9cc8ff', assistant: '#ff8ac8', tool: '#d6a8ff', reasoning: '#9586a4', success: '#72e4a0', warning: '#ffd37a', error: '#ff6e8f', info: '#98b1ff', selection: '#3b2550', diffAdded: '#19442e', diffRemoved: '#5b2538', diffContext: '#2b2239', markdownHeading: '#d6a8ff', markdownLink: '#98b1ff', markdownCode: '#72e4a0', markdownQuote: '#ffd37a', syntaxComment: '#6f5e7e', syntaxKeyword: '#d0a0ff', syntaxFunction: '#9ed0ff', syntaxVariable: '#f7f1ff', syntaxString: '#78e8aa', syntaxNumber: '#ffd37a', syntaxType: '#b9c5ff', syntaxOperator: '#ee9dff', syntaxPunctuation: '#e2d7ea',
    banner: { gradient: ['#d28cff', '#ff79c6', '#7ea8ff'], accent: '#ff79c6', highlight: '#d5b0ff', style: 'split', tagline: 'Signal through the noise.' },
    motion: { intensity: 'lively' },
  },
  mossline: {
    name: 'Mossline', background: '#09100b', panel: '#101a12', surface: '#17241a', text: '#eff8ef', muted: '#91a58f', subtle: '#60725e', border: '#324733', borderActive: '#a9d78e', primary: '#a9d78e', secondary: '#8ed7c4', accent: '#f3bf6a', user: '#9ed9ca', assistant: '#f6c27b', tool: '#a9d78e', reasoning: '#7f947d', success: '#72da92', warning: '#ffd166', error: '#f07a7a', info: '#8fbcff', selection: '#1c3c28', diffAdded: '#174129', diffRemoved: '#512633', diffContext: '#26382a', markdownHeading: '#a9d78e', markdownLink: '#8fbcff', markdownCode: '#72da92', markdownQuote: '#ffd166', syntaxComment: '#5e705e', syntaxKeyword: '#9ce0b0', syntaxFunction: '#9fd4ff', syntaxVariable: '#eff8ef', syntaxString: '#78e0a0', syntaxNumber: '#ffd166', syntaxType: '#a6d2ff', syntaxOperator: '#c4abff', syntaxPunctuation: '#d9e5d8',
    banner: { gradient: ['#b7e58f', '#79cfae', '#f3bf6a'], accent: '#f3bf6a', highlight: '#a9d78e', style: 'showcase', tagline: 'Quiet tools. Clear intent.' },
    motion: { intensity: 'calm' },
  },
  emberglass: {
    name: 'Emberglass', background: '#16090b', panel: '#241015', surface: '#30151b', text: '#fff4f0', muted: '#b5908d', subtle: '#765d5a', border: '#5b3739', borderActive: '#ffb3a7', primary: '#ffb3a7', secondary: '#ff8d9b', accent: '#ffcc7a', user: '#9ecbff', assistant: '#ff9f9f', tool: '#ffb3a7', reasoning: '#997b78', success: '#73dda0', warning: '#ffd166', error: '#ff6e79', info: '#8eb8ff', selection: '#4e2230', diffAdded: '#1a472e', diffRemoved: '#632733', diffContext: '#412329', markdownHeading: '#ffb3a7', markdownLink: '#8eb8ff', markdownCode: '#73dda0', markdownQuote: '#ffd166', syntaxComment: '#795f5c', syntaxKeyword: '#ff9aa9', syntaxFunction: '#ffbf9d', syntaxVariable: '#fff4f0', syntaxString: '#78e5aa', syntaxNumber: '#ffd166', syntaxType: '#a9ccff', syntaxOperator: '#e5a0ff', syntaxPunctuation: '#f1dfd9',
    banner: { gradient: ['#ffcf7a', '#ff9b7a', '#ff6f91'], accent: '#ff8d9b', highlight: '#ffcf7a', style: 'signal', tagline: 'Warm light for hard problems.' },
    motion: { intensity: 'lively' },
  },
  paperlite: {
    name: 'Paperlite', background: '#f6f4ef', panel: '#ebe8e0', surface: '#dfdbd1', text: '#171716', muted: '#66625a', subtle: '#898479', border: '#b9b4a9', borderActive: '#4f5a8f', primary: '#4f5a8f', secondary: '#7356a8', accent: '#b6501d', user: '#2b6794', assistant: '#a9471c', tool: '#4f5a8f', reasoning: '#6d6961', success: '#2e7c43', warning: '#946b1f', error: '#a93d4d', info: '#516bd4', selection: '#bfd8f4', diffAdded: '#98d7a5', diffRemoved: '#f0aab5', diffContext: '#bab7af', markdownHeading: '#4f5a8f', markdownLink: '#516bd4', markdownCode: '#2e7c43', markdownQuote: '#946b1f', syntaxComment: '#898479', syntaxKeyword: '#4f5a8f', syntaxFunction: '#4f71b8', syntaxVariable: '#171716', syntaxString: '#2e7c43', syntaxNumber: '#946b1f', syntaxType: '#227373', syntaxOperator: '#7356a8', syntaxPunctuation: '#4d4a44',
    banner: { gradient: ['#5368b8', '#7d62ad', '#c05b2e'], accent: '#b6501d', highlight: '#667bd0', style: 'split', tagline: 'A clean desk for messy ideas.' },
    motion: { intensity: 'subtle' },
  },
  signalnight: {
    name: 'Signalnight', background: '#04060d', panel: '#0b1020', surface: '#10182b', text: '#ecf7ff', muted: '#8093a5', subtle: '#53677a', border: '#27384e', borderActive: '#73e6ff', primary: '#73e6ff', secondary: '#6e91ff', accent: '#e6ff6e', user: '#71cfff', assistant: '#a0c7ff', tool: '#73e6ff', reasoning: '#7f91a1', success: '#71e5a0', warning: '#ffe76e', error: '#ff6f89', info: '#7fa6ff', selection: '#15304c', diffAdded: '#13462e', diffRemoved: '#522334', diffContext: '#1f3040', markdownHeading: '#73e6ff', markdownLink: '#7fa6ff', markdownCode: '#71e5a0', markdownQuote: '#ffe76e', syntaxComment: '#596d7e', syntaxKeyword: '#70cfff', syntaxFunction: '#89dcff', syntaxVariable: '#ecf7ff', syntaxString: '#6ee5a0', syntaxNumber: '#ffe76e', syntaxType: '#9ac3ff', syntaxOperator: '#ba9dff', syntaxPunctuation: '#d5e6ef',
    banner: { gradient: ['#73e6ff', '#6e91ff', '#e6ff6e'], accent: '#e6ff6e', highlight: '#84dfff', style: 'signal', tagline: 'Observe. Change. Confirm.' },
    motion: { intensity: 'lively' },
  },
}
const THEME_COLOR_FIELDS = [
  'background','panel','surface','text','muted','subtle','border','borderActive','primary','secondary','accent',
  'user','assistant','tool','reasoning','success','warning','error','info','selection','diffAdded','diffRemoved','diffContext',
  'markdownHeading','markdownLink','markdownCode','markdownQuote','syntaxComment','syntaxKeyword','syntaxFunction','syntaxVariable',
  'syntaxString','syntaxNumber','syntaxType','syntaxOperator','syntaxPunctuation',
] as const

function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value)
}

function sanitizeCustomTheme(id: string, raw: unknown): Theme | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const source = raw as Record<string, unknown>
  const baseName = typeof source.base === 'string' ? source.base : 'termagent'
  const base = getTheme(baseName)
  const candidate: Record<string, unknown> = { ...base, ...source, name: typeof source.name === 'string' && source.name.trim() ? source.name.trim() : id }
  delete candidate.base
  for (const field of THEME_COLOR_FIELDS) {
    if (!isHexColor(candidate[field])) return null
  }
  if (candidate.banner !== undefined) {
    const banner = candidate.banner
    if (!banner || typeof banner !== 'object' || Array.isArray(banner)) return null
    const b = banner as Record<string, unknown>
    const gradient = Array.isArray(b.gradient) ? b.gradient : base.banner?.gradient
    if (!gradient || gradient.length < 2 || gradient.some(color => !isHexColor(color))) return null
    b.gradient = gradient.slice(0, 4)
    if (!isHexColor(b.accent)) b.accent = base.banner?.accent ?? base.accent
    if (!isHexColor(b.highlight)) b.highlight = base.banner?.highlight ?? base.info
    if (!['showcase','split','signal','minimal'].includes(String(b.style ?? base.banner?.style))) return null
    b.style = b.style ?? base.banner?.style ?? 'showcase'
    b.tagline = typeof b.tagline === 'string' && b.tagline.trim() ? b.tagline.trim() : base.banner?.tagline ?? 'Code. Explore. Verify.'
    candidate.banner = b
  } else {
    candidate.banner = base.banner
  }
  if (candidate.motion !== undefined) {
    const motion = candidate.motion
    if (!motion || typeof motion !== 'object' || Array.isArray(motion)) return null
    const m = motion as Record<string, unknown>
    if (!['silent','calm','subtle','lively'].includes(String(m.intensity ?? base.motion?.intensity))) return null
    m.intensity = m.intensity ?? base.motion?.intensity ?? 'subtle'
    candidate.motion = m
  } else {
    candidate.motion = base.motion
  }
  return makeTheme(candidate as Theme)
}

export async function loadThemeCatalog(cwd: string): Promise<Readonly<Record<string, Theme>>> {
  const directories = [
    `${process.env.HOME || cwd}/.termagent/themes`,
    `${cwd}/.termagent/themes`,
  ]
  const catalog: Record<string, Theme> = { ...THEMES }
  const builtInIds = new Set(Object.keys(THEMES))
  for (const directory of directories) {
    try {
      const entries = await fs.readdir(directory, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.json')) continue
        const id = entry.name.replace(/\.json$/i, '').toLowerCase().trim()
        if (!id || builtInIds.has(id)) continue
        try {
          const raw = JSON.parse(await fs.readFile(`${directory}/${entry.name}`, 'utf8'))
          const theme = sanitizeCustomTheme(id, raw)
          if (theme) catalog[id] = theme
        } catch {
          // Invalid custom themes are ignored. A bad presentation file must not brick the agent.
        }
      }
    } catch {
      // Missing theme directories are normal.
    }
  }
  return catalog
}

export const THEMES: Readonly<Record<string, Theme>> = Object.fromEntries(Object.entries(THEMES_INTERNAL).map(([name, theme]) => [name, makeTheme(theme)]))

export function getTheme(name = 'termagent'): Theme {
  return THEMES[name.toLowerCase()] ?? THEMES.termagent!
}

export function listThemes(catalog: Readonly<Record<string, Theme>> = THEMES) {
  return Object.entries(catalog).map(([id, theme]) => ({
    id,
    label: theme.name,
    detail: theme.banner?.tagline ?? 'TermAgent visual theme',
    swatches: theme.banner?.gradient ?? [theme.primary, theme.secondary, theme.accent],
  }))
}

const TOKEN_CACHE = new WeakMap<Theme, ThemeTokens>()

export function themeTokens(theme: Theme): ThemeTokens {
  const cached = TOKEN_CACHE.get(theme)
  if (cached) return cached
  const tokens: ThemeTokens = {
    surface: { background: theme.background, panel: theme.panel, surface: theme.surface, selection: theme.selection },
    content: { text: theme.text, muted: theme.muted, subtle: theme.subtle },
    border: { default: theme.border, active: theme.borderActive },
    accent: { primary: theme.primary, secondary: theme.secondary, brand: theme.accent },
    status: { success: theme.success, warning: theme.warning, error: theme.error, info: theme.info },
    role: { user: theme.user, assistant: theme.assistant, tool: theme.tool, reasoning: theme.reasoning },
    diff: { added: theme.diffAdded, removed: theme.diffRemoved, context: theme.diffContext },
    markdown: { heading: theme.markdownHeading, link: theme.markdownLink, code: theme.markdownCode, quote: theme.markdownQuote },
    syntax: {
      comment: theme.syntaxComment,
      keyword: theme.syntaxKeyword,
      function: theme.syntaxFunction,
      variable: theme.syntaxVariable,
      string: theme.syntaxString,
      number: theme.syntaxNumber,
      type: theme.syntaxType,
      operator: theme.syntaxOperator,
      punctuation: theme.syntaxPunctuation,
    },
    banner: {
      gradient: theme.banner?.gradient ?? [theme.primary, theme.secondary, theme.accent],
      accent: theme.banner?.accent ?? theme.accent,
      highlight: theme.banner?.highlight ?? theme.info,
      style: theme.banner?.style ?? 'showcase',
      tagline: theme.banner?.tagline ?? 'Code. Explore. Verify.',
    },
    motion: { intensity: theme.motion?.intensity ?? 'subtle' },
  }
  TOKEN_CACHE.set(theme, tokens)
  return tokens
}
