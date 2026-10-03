import { renderActivity } from './design-system/activity.js'
import { renderBanner } from './design-system/banner.js'
import { detectColorCapability, paint, padRight, widthOf, clip } from './design-system/ansi.js'
import { renderDialogFrame } from './design-system/surfaces.js'
import { renderDiffBlock } from './design-system/diff.js'
import { renderFooter } from './design-system/footer.js'
import { renderGoodbye } from './design-system/goodbye.js'
import { renderMarkdown } from './design-system/markdown.js'
import { renderPicker } from './design-system/picker.js'
import { getTheme } from './design-system/theme.js'
import { renderToolActivity, renderAssistantTurn, renderUserTurn, renderSystemRow } from './design-system/transcript.js'
import type { Theme } from './design-system/types.js'

type PreviewContext = {
  width: number
  theme: Theme
  capability: ReturnType<typeof detectColorCapability>
}

function fit(rows: string[], width: number) {
  return rows.slice(0, Math.max(1, 100)).map(row => padRight(clip(row, width), width))
}

export function renderDialogPreview({ width, theme, capability }: PreviewContext) {
  return renderDialogFrame({
    width,
    height: Math.min(18, 20),
    title: 'Permission required',
    subtitle: 'The agent is waiting for your approval.',
    tone: 'warning',
    theme,
    capability,
    content: [
      `${paint('Run shell command?', { fg: theme.text, attrs: { bold: true }, capability })}`,
      `${paint('$ npm test', { fg: theme.tool, capability })}`,
      '',
      `${paint('Proposed changes', { fg: theme.info, attrs: { bold: true }, capability })}`,
      `${paint('src/cli/ui.ts', { fg: theme.text, capability })}  ${paint('+12', { fg: theme.success, capability })} ${paint('-4', { fg: theme.error, capability })}`,
      '',
      `${paint('› [1] Allow once', { fg: theme.text, bg: theme.selection, attrs: { bold: true }, capability })}`,
      `${paint('  [2] Always allow', { fg: theme.text, capability })}`,
      `${paint('  [3] Reject', { fg: theme.text, capability })}`,
    ],
    footer: '↑↓ select · Enter confirm · y once · a always · n reject · Esc close',
    maxWidth: Math.min(76, width - 2),
    preserveAnsi: true,
  })
}

export function renderQuestionPreview({ width, theme, capability }: PreviewContext) {
  return renderDialogFrame({
    width,
    height: Math.min(18, 20),
    title: 'Question 1/2',
    subtitle: 'Choose an option or enter a custom response.',
    tone: 'info',
    theme,
    capability,
    content: [
      `${paint('Which output format should be used?', { fg: theme.text, attrs: { bold: true }, capability })}`,
      '',
      `${paint('›', { fg: theme.primary, capability })} ${paint('Markdown', { fg: theme.text, bg: theme.selection, attrs: { bold: true }, capability })}`,
      `  ${paint('Plain text', { fg: theme.text, capability })}`,
      `  ${paint('JSON', { fg: theme.text, capability })}`,
      `  ${paint('Type your own answer', { fg: theme.text, capability })}`,
    ],
    footer: '↑↓ select · Enter choose · Space toggle · Esc dismiss',
    maxWidth: Math.min(76, width - 2),
    preserveAnsi: true,
  })
}

export function renderPickerPreview({ width, theme, capability }: PreviewContext) {
  return renderPicker({
    width: Math.min(width, 60),
    selectedIndex: 7,
    maxVisible: width < 58 ? 6 : 8,
    query: 'theme',
    title: 'Command palette',
    footer: '↑↓ select · Enter run · Esc close',
    theme,
    capability,
    options: [
      '/theme termagent',
      '/theme nord',
      '/theme dracula',
      '/theme light',
      '/provider',
      '/plugins',
      '/skills',
      '/doctor',
      '/checkpoint',
      '/undo',
      '/redo',
      '/help',
    ].map((label, index) => ({ label, description: index === 7 ? 'Open diagnostics' : 'Command' })),
  })
}

export function renderMarkdownPreview({ width, theme, capability }: PreviewContext) {
  return renderMarkdown([
    '# Response formatting',
    '',
    'Headings, **strong text**, *emphasis*, `inline code`, links, lists and blockquotes.',
    '',
    '- First item',
    '- Second item',
    '',
    '> This is a blockquote with a restrained visual bar.',
    '',
    '```ts',
    'const answer = 42',
    'console.log(answer)',
    '```',
    '',
    '| Feature | State |',
    '| --- | ---: |',
    '| Markdown | Ready |',
    '| Tables | Ready |',
  ].join('\n'), { width, theme, capability })
}

export function renderTranscriptPreview({ width, theme, capability }: PreviewContext) {
  return [
    ...renderUserTurn({ text: 'Explain the terminal UI hierarchy.', width, theme, capability }),
    ...renderAssistantTurn({ text: 'The transcript separates the user, assistant, tools, reasoning, and system states.', reasoning: 'Checking the current presentation model.', width, theme, capability }),
    ...renderToolActivity({ tool: { name: 'bash', summary: 'npm test', running: true }, width, theme, capability }),
    ...renderToolActivity({ tool: { name: 'write_file', summary: 'src/cli/ui.ts', durationMs: 1200, additions: 12, deletions: 4, hasDiff: true }, width, theme, capability }),
    ...renderSystemRow({ system: { text: 'Session ready.', tone: 'dim' }, width, theme, capability }),
  ]
}
export function renderReasoningPreview({ width, theme, capability }: PreviewContext) {
  return renderDialogFrame({
    width,
    height: Math.min(18, 20),
    title: '◆ Reasoning',
    subtitle: 'Full streamed reasoning · read-only inspector',
    tone: 'info',
    theme,
    capability,
    content: [
      '1,248 characters',
      '',
      'I am checking the current transcript structure before choosing how to present the next response.',
      'The final answer should remain compact while keeping the reasoning available on demand.',
      '',
      'Ctrl+E closes this inspector and returns to the transcript.',
    ],
    footer: '↑↓ scroll · PgUp/PgDn page · Esc close',
    maxWidth: Math.min(76, width - 2),
  })
}

export function renderToolInspectorPreview({ width, theme, capability }: PreviewContext) {
  return renderDialogFrame({
    width,
    height: Math.min(18, 20),
    title: '◆ Tool details · bash',
    subtitle: '1/3 · ↑↓ scroll · ←→ previous/next tool',
    tone: 'normal',
    theme,
    capability,
    content: [
      'bash  running · 1.8s',
      '',
      'Arguments',
      '  $ npm test',
      '',
      'Output',
      '  TAP version 13',
      '  tests 325',
      '  pass 325',
      '',
      'Changes  src/cli/ui.ts  +12 -4',
    ],
    footer: '↑↓ scroll · ←→ tool · d diff · Esc close',
    maxWidth: Math.min(82, width - 2),
  })
}

export function renderDiffPreview({ width, theme, capability }: PreviewContext) {
  return renderDiffBlock({
    width: Math.min(60, width),
    title: 'src/cli/ui.ts',
    theme,
    capability,
    lines: [
      { kind: 'hunk', text: '@@ prompt footer @@' },
      { kind: 'remove', text: 'const color = BLUE' },
      { kind: 'remove', text: 'return `${BG2}${content}${RESET}`' },
      { kind: 'add', text: 'const color = theme.text' },
      { kind: 'add', text: 'return paint(content, { bg: theme.panel })' },
      { kind: 'context', text: 'scheduleRender()' },
    ],
  })
}

export function renderProviderPreview({ width, theme, capability }: PreviewContext) {
  return renderDialogFrame({
    width,
    height: Math.min(18, 20),
    title: 'Provider manager',
    subtitle: 'Manage saved provider profiles.',
    tone: 'info',
    theme,
    capability,
    content: [
      'Active: openai-primary · openai · gpt-5',
      '',
      '› [1] Set provider      Choose the active saved provider.',
      '  [2] Edit provider     Change model, URL, or key.',
      '  [3] Add provider      Create a new profile.',
      '  [4] Remove provider   Delete a saved profile.',
      '  [5] Done              Return to chat.',
    ],
    footer: '↑↓ select · Enter choose · Esc back',
    maxWidth: Math.min(82, width - 2),
  })
}

export function renderPluginPreview({ width, theme, capability }: PreviewContext) {
  return renderDialogFrame({
    width,
    height: Math.min(18, 20),
    title: 'Plugin manager',
    subtitle: 'Installed components and activation state.',
    tone: 'info',
    theme,
    capability,
    content: [
      '3 installed · 2 enabled · 1 disabled',
      '',
      '› formatter             enabled · v1.4.0 · 2c 0a 3s',
      '  git-tools             enabled · v2.0.1 · 4c 1a 0s',
      '  experimental-search   disabled · v0.8.2 · 1c 0a 2s',
      '',
      'Use Enter to inspect component details.',
    ],
    footer: '↑↓ select · Enter inspect · Tab switch view · Esc close',
    maxWidth: Math.min(86, width - 2),
  })
}

export function renderExitPreview({ width, theme, capability }: PreviewContext) {
  return renderGoodbye({ width, sessionId: '9c306fe9-ef78-4768-a363-e1e020a6e94e', theme, capability })
}

export function renderStateScene(scene: string, ctx: PreviewContext) {
  const body = scene === 'dialog'
    ? renderDialogPreview(ctx)
    : scene === 'question'
      ? renderQuestionPreview(ctx)
      : scene === 'picker'
        ? renderPickerPreview(ctx)
        : scene === 'markdown'
          ? renderMarkdownPreview(ctx)
          : scene === 'transcript'
            ? renderTranscriptPreview(ctx)
            : scene === 'exit'
              ? renderExitPreview(ctx)
              : scene === 'reasoning'
                ? renderReasoningPreview(ctx)
                : scene === 'tool'
                  ? renderToolInspectorPreview(ctx)
                  : scene === 'diff'
                    ? renderDiffPreview(ctx)
                    : scene === 'provider'
                      ? renderProviderPreview(ctx)
                      : scene === 'plugins'
                        ? renderPluginPreview(ctx)
                        : [
                  ...renderBanner({ width: ctx.width, version: '1.18.0', theme: ctx.theme, capability: ctx.capability }),
                  '',
                  renderActivity({ width: ctx.width, phase: 'writing', label: 'Writing response', elapsedSeconds: 3, frame: 4, theme: ctx.theme, capability: ctx.capability }),
                  '',
                  ...renderFooter({ width: ctx.width, cwd: '~/TermAgent', context: 'prompt', theme: ctx.theme, capability: ctx.capability }),
                ]
  return fit(body, ctx.width)
}

export function previewContext(env: Record<string, string | undefined>) {
  const width = Number.parseInt(env.TERMAGENT_UI_PREVIEW_WIDTH ?? '80', 10) || 80
  const theme = getTheme(env.TERMAGENT_UI_PREVIEW_THEME ?? 'termagent')
  const capability = detectColorCapability(env)
  return { width, theme, capability, scene: env.TERMAGENT_UI_PREVIEW_SCENE ?? 'default' }
}
