import { paint } from './ansi.js'
import type { ColorCapability, Theme } from './types.js'

const ALIASES: Record<string, string> = {
  js: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript', py: 'python', sh: 'bash', shell: 'bash', zsh: 'bash', yml: 'yaml', md: 'markdown', text: 'plaintext', txt: 'plaintext',
}

const KEYWORDS: Record<string, Set<string>> = {
  javascript: new Set('const let var function return if else for while import from export class extends new async await try catch throw true false null undefined typeof in of switch case break continue'.split(/\s+/)),
  typescript: new Set('const let var function return if else for while import from export class extends new async await try catch throw true false null undefined typeof interface type implements public private readonly enum unknown any number string boolean void'.split(/\s+/)),
  python: new Set('def class return if elif else for while import from as async await try except finally raise True False None and or not in is lambda yield with pass'.split(/\s+/)),
  bash: new Set('if then else fi for in do done case esac function export local readonly unset source return'.split(/\s+/)),
  json: new Set(['true', 'false', 'null']),
  yaml: new Set(['true', 'false', 'null']),
}

function languageName(language: string) {
  const normalized = language.toLowerCase().trim()
  return ALIASES[normalized] ?? normalized
}

function styleToken(token: string, language: string, theme: Theme, capability: ColorCapability, next: string) {
  if (!token || /^\s+$/.test(token)) return token
  if (/^\b\d+(?:\.\d+)?\b$/.test(token)) return paint(token, { fg: theme.syntaxNumber, capability })
  if (/^(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)$/.test(token)) return paint(token, { fg: theme.syntaxString, capability })
  if (KEYWORDS[language]?.has(token)) return paint(token, { fg: theme.syntaxKeyword, capability, attrs: { bold: true } })
  if (/^[A-Za-z_$][\w$-]*$/.test(token) && /\(\s*$/.test(next)) return paint(token, { fg: theme.syntaxFunction, capability })
  if (/^[{}()[\].,:;]$/.test(token)) return paint(token, { fg: theme.syntaxPunctuation, capability })
  if (/^(?:===|!==|==|!=|=>|<=|>=|&&|\|\||[+*/%=!?<>-])$/.test(token)) return paint(token, { fg: theme.syntaxOperator, capability })
  if (/^[A-Z][A-Za-z0-9_$-]*$/.test(token)) return paint(token, { fg: theme.syntaxType, capability })
  return token
}

export function highlightLine(line: string, languageInput: string, theme: Theme, capability: ColorCapability) {
  const language = languageName(languageInput)
  if (language === 'plaintext' || language === 'markdown') return line

  const commentIndex = language === 'python' || language === 'bash' || language === 'yaml'
    ? line.indexOf('#')
    : line.indexOf('//')

  let code = line
  let comment = ''
  if (commentIndex >= 0) {
    code = line.slice(0, commentIndex)
    comment = line.slice(commentIndex)
  }

  const tokens = code.match(/("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b\d+(?:\.\d+)?\b|[A-Za-z_$][\w$-]*|===|!==|==|!=|=>|<=|>=|&&|\|\||[{}()[\].,:;]|[+*/%=!?<>-]|\s+)/g) ?? []
  let out = ''
  for (let i = 0; i < tokens.length; i++) out += styleToken(tokens[i]!, language, theme, capability, tokens[i + 1] ?? '')
  if (comment) out += paint(comment, { fg: theme.syntaxComment, capability, attrs: { dim: true, italic: true } })
  return out
}
