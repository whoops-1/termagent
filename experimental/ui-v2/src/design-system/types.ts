export type ColorCapability = 'plain' | 'ansi16' | 'ansi256' | 'truecolor'

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
}

export type TextAttrs = {
  bold?: boolean
  dim?: boolean
  italic?: boolean
  underline?: boolean
  inverse?: boolean
}
