export type SkillSecuritySeverity = 'error' | 'warning'

export type SkillSecurityFinding = {
  code: string
  severity: SkillSecuritySeverity
  message: string
  line: number
  snippet: string
}

export type SkillSecurityStatus = 'clean' | 'warning' | 'blocked'

const ZERO_WIDTH_RE = /[\u200B-\u200D\uFEFF]/
const BIDI_CONTROL_RE = /[\u202A-\u202E\u2066-\u2069]/
const UNICODE_TAG_RE = /[\u{E0000}-\u{E007F}]/u
const HTML_COMMENT_RE = /<!--|--!?>/
const HTTP_URL_RE = /https?:\/\//
const CREDENTIAL_RE = /\b(?:env|environ|secret|credential|api[_-]?key|password|token|bearer|authorization)\b/i
const PROMPT_OVERRIDE_RE = /\b(?:ignore|disregard|bypass|override)\s+(?:the\s+)?(?:previous|prior|all|system|developer)\s+(?:instructions?|messages?|rules?)\b/i
const ROLEPLAY_RE = /\b(?:you are now|act as|pretend (?:to be|you are))\b.*\b(?:system|developer|assistant|root|admin|jailbreak|unrestricted|uncensored|dan)\b/i
const FAKE_ROLE_MARKER_RE = /<\/?(?:system|assistant|developer|user)>|<\|im_(?:start|end)\|>|\[\/?inst\]/i
const ROLE_PREFIX_RE = /^\s*(?:human|assistant|system|developer)\s*:\s+/i
const SENSITIVE_PATH_RE = /(?:~\/\.ssh|\.ssh\/|id_rsa|id_ed25519|~\/\.aws|\.aws\/credentials|~\/\.config|~\/\.npmrc|\bgh\s+auth\s+token\b|\baws_access_key_id\b)/i
const ENV_FILE_RE = /(?:^|[\s"'`(])\.env(?:\.[a-z0-9_-]+)?(?:$|[\s"'`.)])/i
const SENSITIVE_READ_VERB_RE = /\b(?:read|cat|open|print|copy|include|send|upload|post|exfiltrate|leak|paste)\b/i
const EXFIL_ENDPOINT_RE = /(?:discord\.com\/api\/webhooks|hooks\.slack\.com|t\.me\/|telegram\.org\/bot|requestbin|webhook\.site|ngrok(?:-free)?\.app|ngrok\.io|beeceptor|pastebin\.com)/i
const FETCH_WITH_URL_RE = /(?:\b(?:curl|wget)\b|\bfetch\s*\(|\baxios\s*\(|\b(?:httpx|requests)\s*\.\s*(?:get|post|put|delete|request)\s*\(|\b(?:invoke-webrequest|invoke-restmethod|iwr|irm)\b|\bnet::http\b)/i
const DISABLE_SAFETY_RE = /(?:(?:do not|don't|dont)\s+ask\s+(?:the\s+)?user|skip\s+confirmation|auto-?accept|auto-?approve|auto-?run)/i
const YES_WITH_DESTRUCTIVE_RE = /(?:--yes\b.*\b(?:rm|delete|remove|destroy|wipe|format)\b|\b(?:rm|delete|remove|destroy|wipe|format)\b.*--yes\b)/i
const EXEC_SNIPPET_RE = /\b(?:node|nodejs|python|python3|perl|ruby|php|bash|sh|zsh)\s+-[ce]\b/i
const LATIN_RE = /[A-Za-z]/
const MIXED_SCRIPT_RE = /[\u0370-\u03FF\u0400-\u04FF]/

const RULES: Array<{
  code: string
  severity: SkillSecuritySeverity
  message: string
  test: (line: string, normalized: string, lower: string) => boolean
}> = [
  { code: 'security.unicode_tag_chars', severity: 'error', message: 'Line contains Unicode tag characters that can hide instructions from reviewers.', test: line => UNICODE_TAG_RE.test(line) },
  { code: 'security.zero_width_chars', severity: 'error', message: 'Line contains zero-width characters that can hide instructions from reviewers.', test: line => ZERO_WIDTH_RE.test(line) },
  { code: 'security.bidi_control_chars', severity: 'error', message: 'Line contains bidirectional control characters that can disguise visible text order.', test: line => BIDI_CONTROL_RE.test(line) },
  { code: 'security.html_comment', severity: 'error', message: 'Line contains an HTML comment marker that can conceal instructions.', test: (_line, normalized) => HTML_COMMENT_RE.test(normalized) },
  { code: 'security.curl_external_url', severity: 'error', message: 'Line uses curl or wget against an external URL.', test: (_line, _normalized, lower) => /\b(?:curl|wget)\b/.test(lower) && HTTP_URL_RE.test(lower) },
  { code: 'security.external_fetch', severity: 'error', message: 'Line uses a network-fetch helper with an external URL.', test: (_line, _normalized, lower) => FETCH_WITH_URL_RE.test(lower) && HTTP_URL_RE.test(lower) && !/\b(?:curl|wget)\b/.test(lower) },
  { code: 'security.secret_exfiltration', severity: 'error', message: 'Line references credentials or tokens together with a URL.', test: (_line, _normalized, lower) => CREDENTIAL_RE.test(lower) && HTTP_URL_RE.test(lower) },
  { code: 'security.encoded_eval', severity: 'error', message: 'Line combines decoding/base64 with exec, eval, system, or shell execution.', test: (_line, _normalized, lower) => /\b(?:base64|atob|btoa|decode)\b/.test(lower) && /\b(?:exec|eval|system|shell)\b/.test(lower) },
  { code: 'security.rm_rf_absolute', severity: 'error', message: 'Line uses rm -rf against an absolute path.', test: (_line, _normalized, lower) => /\brm\s+-rf?\s+["']?\//.test(lower) },
  { code: 'security.script_tag', severity: 'error', message: 'Line contains a <script> tag.', test: (_line, _normalized, lower) => /<script\b/.test(lower) },
  { code: 'security.prompt_instruction_override', severity: 'error', message: 'Line appears to override higher-priority agent instructions.', test: (_line, _normalized, lower) => PROMPT_OVERRIDE_RE.test(lower) },
  { code: 'security.prompt_roleplay_escalation', severity: 'error', message: 'Line appears to escalate the agent into a higher-privilege or unrestricted role.', test: (_line, _normalized, lower) => ROLEPLAY_RE.test(lower) },
  { code: 'security.fake_role_marker', severity: 'error', message: 'Line contains fake system/chat role markers.', test: (_line, normalized) => FAKE_ROLE_MARKER_RE.test(normalized) || ROLE_PREFIX_RE.test(normalized) },
  { code: 'security.sensitive_file_reference', severity: 'error', message: 'Line references sensitive local credential files or token commands.', test: (_line, _normalized, lower) => SENSITIVE_PATH_RE.test(lower) || (ENV_FILE_RE.test(lower) && SENSITIVE_READ_VERB_RE.test(lower)) },
  { code: 'security.exfiltration_endpoint', severity: 'error', message: 'Line references a common exfiltration or callback endpoint.', test: (_line, _normalized, lower) => EXFIL_ENDPOINT_RE.test(lower) },
  { code: 'security.safety_bypass', severity: 'error', message: 'Line asks the agent to bypass confirmation or auto-approve risky actions.', test: (_line, _normalized, lower) => DISABLE_SAFETY_RE.test(lower) || YES_WITH_DESTRUCTIVE_RE.test(lower) },
  { code: 'security.hidden_execution', severity: 'error', message: 'Line contains a direct interpreter -c/-e execution instruction.', test: (_line, _normalized, lower) => EXEC_SNIPPET_RE.test(lower) },
  { code: 'security.url_to_ip', severity: 'warning', message: 'URL points to a raw IP address instead of a hostname.', test: (_line, _normalized, lower) => /https?:\/\/(?:\d{1,3}\.){3}\d{1,3}/.test(lower) },
  { code: 'security.mixed_scripts', severity: 'warning', message: 'Line mixes Latin with Cyrillic/Greek characters, which can indicate Unicode confusables.', test: (_line, _normalized, lower) => LATIN_RE.test(lower) && MIXED_SCRIPT_RE.test(lower) },
]

function normalize(line: string): string {
  return line.normalize('NFKC').replace(/[\u200B-\u200D\uFEFF]/g, '')
}

function snippet(line: string): string {
  const visible = line
    .replace(UNICODE_TAG_RE, '[unicode-tag]')
    .replace(BIDI_CONTROL_RE, '[bidi-control]')
    .replace(ZERO_WIDTH_RE, '[zero-width]')
  return visible.length > 120 ? `${visible.slice(0, 117)}...` : visible
}

export function scanSkillContent(content: string): { status: SkillSecurityStatus; findings: SkillSecurityFinding[] } {
  const findings: SkillSecurityFinding[] = []
  const lines = content.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    const normalized = normalize(line)
    const lower = normalized.toLowerCase()
    for (const rule of RULES) {
      if (rule.test(line, normalized, lower)) {
        findings.push({ code: rule.code, severity: rule.severity, message: rule.message, line: i + 1, snippet: snippet(line) })
      }
    }
  }
  const status: SkillSecurityStatus = findings.some(f => f.severity === 'error')
    ? 'blocked'
    : findings.length > 0
      ? 'warning'
      : 'clean'
  return { status, findings }
}

export function formatSkillSecurityWarnings(findings: SkillSecurityFinding[]): string[] {
  return findings.map(f => `security ${f.severity} [line ${f.line}] ${f.code}: ${f.message}`)
}
