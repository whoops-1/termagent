export type ColorCapability = 'plain' | 'ansi16' | 'ansi256' | 'truecolor'
export type BannerStyle = 'showcase' | 'split' | 'signal' | 'minimal'
export type MotionIntensity = 'silent' | 'calm' | 'subtle' | 'lively'

export type Theme = {
  name: string
  background: string
  panel: string
  surface: string
  text: string
  muted: string
  subtle: string
  border: string
  borderActive: string
  primary: string
  secondary: string
  accent: string
  user: string
  assistant: string
  tool: string
  reasoning: string
  success: string
  warning: string
  error: string
  info: string
  selection: string
  diffAdded: string
  diffRemoved: string
  diffContext: string
  markdownHeading: string
  markdownLink: string
  markdownCode: string
  markdownQuote: string
  syntaxComment: string
  syntaxKeyword: string
  syntaxFunction: string
  syntaxVariable: string
  syntaxString: string
  syntaxNumber: string
  syntaxType: string
  syntaxOperator: string
  syntaxPunctuation: string
  banner?: {
    gradient: readonly string[]
    accent: string
    highlight: string
    style: BannerStyle
    tagline: string
  }
  motion?: { intensity: MotionIntensity }
}

export type TextAttrs = {
  bold?: boolean
  dim?: boolean
  italic?: boolean
  underline?: boolean
  inverse?: boolean
}
export type ThemeTokens = {
  surface: {
    background: string
    panel: string
    surface: string
    selection: string
  }
  content: {
    text: string
    muted: string
    subtle: string
  }
  border: {
    default: string
    active: string
  }
  accent: {
    primary: string
    secondary: string
    brand: string
  }
  status: {
    success: string
    warning: string
    error: string
    info: string
  }
  role: {
    user: string
    assistant: string
    tool: string
    reasoning: string
  }
  diff: {
    added: string
    removed: string
    context: string
  }
  markdown: {
    heading: string
    link: string
    code: string
    quote: string
  }
  syntax: {
    comment: string
    keyword: string
    function: string
    variable: string
    string: string
    number: string
    type: string
    operator: string
    punctuation: string
  }
  banner: {
    gradient: readonly string[]
    accent: string
    highlight: string
    style: BannerStyle
    tagline: string
  }
  motion: { intensity: MotionIntensity }
}
