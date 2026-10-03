import process from 'node:process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { PermissionChoice, PermissionRequest } from '../tools/permissions.js'
import type { QuestionPrompt, QuestionResponse } from '../tools/types.js'
import type { CompletionItem, CompletionState, PromptMouseEvent } from './input.js'
import { clamp, layoutTextInput, promptTextWidth, widthOf } from './tui/text-input.js'
import { paint } from '../design-system/ansi.js'
import { SelectModel } from './tui/select.js'
import { renderTextDiff } from '../diff/render.js'
import type { DiffResult } from '../diff/render.js'
import { within } from '../util/fs.js'
import type { ProviderManagerProfile, ProviderManagerSnapshot, ProviderProfileDraft } from '../providers/manager.js'
import type { TodoItem } from '../tools/todo.js'
import { PluginManagerController, type PluginManagerCallbacks, type PluginManagerMode, type PluginManagerSnapshot } from './tui/plugin-manager.js'
import { detectColorCapability } from '../design-system/ansi.js'
import { renderActivity } from '../design-system/activity.js'
import { animationFrame, elapsedSecondsSince, renderCompletion, renderStartup } from '../design-system/motion.js'
import { renderBanner } from '../design-system/banner.js'
import { normalizeBannerEffect, type BannerEffect } from '../design-system/effects.js'
import { buildExplorationHUDModel, renderExplorationHUD } from '../design-system/exploration-hud.js'
import type { ExplorationStateSnapshot } from '../context/exploration.js'
import type { ExplorationTelemetrySnapshot } from '../agent/exploration-telemetry.js'
import { renderFooter } from '../design-system/footer.js'
import { renderComposer, composerStateFrom, type ComposerMeta } from '../design-system/composer.js'
import { renderQueuePanel, queuePanelEntries } from '../design-system/queue.js'
import type { QueuedPrompt } from '../session/prompt-queue.js'
import { getTheme, THEMES } from '../design-system/theme.js'
import { renderMarkdown } from '../design-system/markdown.js'
import { COMMAND_PICKER_GEOMETRY, pickerLayout, renderPicker, type PickerRow } from '../design-system/picker.js'
import { renderGoodbye } from '../design-system/goodbye.js'
import { renderDialogFrame, renderDockFrame } from '../design-system/surfaces.js'
import { renderTip } from '../design-system/tips.js'
import { renderAssistantTurn, renderSystemRow, renderToolActivity, renderUserTurn } from '../design-system/transcript.js'
import { statusDescriptor, todoStatus } from '../design-system/status.js'
import { contentWidth } from '../design-system/geometry.js'
import { normalizeDiffMetadata, parseDiffDocument, renderDiffFile, renderDiffFiles, type DiffFile as SharedDiffFile, type DiffView } from '../design-system/diff.js'
import type { BannerStyle, ColorCapability, Theme } from '../design-system/types.js'
import { HitTargetRegistry } from '../design-system/hit-targets.js'
import { TranscriptRenderCache, type TranscriptRenderResult } from '../design-system/transcript-cache.js'

type Entry =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string; reasoning?: string }
  | { kind: 'tool'; name: string; args: string; output?: string; running?: boolean; waiting?: boolean; startedAt?: number; durationMs?: number; metadata?: unknown }
  | { kind: 'system'; text: string; tone?: 'dim' | 'warn' | 'error' }

type InputState = { value: string; cursor: number }
type ActivityPhase = 'idle' | 'thinking' | 'reasoning' | 'writing' | 'tool' | 'permission' | 'question' | 'retrying' | 'compacting' | 'done' | 'error'
type ActivityState = { phase: ActivityPhase; label: string; startedAt: number }

type UIOptions = {
  title: string
  model: string
  provider: string
  mode: string
  cwd: string
  version?: string
  theme?: string
  themes?: Readonly<Record<string, Theme>>
  bannerStyle?: BannerStyle
  effect?: BannerEffect
  animations?: boolean
  motion?: 'full' | 'reduced' | 'off'
  output?: { write(chunk: string): boolean; columns?: number; rows?: number; on?(event: string, listener: () => void): void; off?(event: string, listener: () => void): void }
  input?: typeof process.stdin
  onMouseTarget?: (id: string) => void | Promise<void>
  onQueueAction?: (action: 'edit' | 'cancel' | 'up' | 'down', id: string) => void | Promise<void>
}

type ToolDiff = { path: string; text: string; additions: number; deletions: number }
type InspectorFile = SharedDiffFile
type InspectorState =
  | { kind: 'reasoning'; scroll: number }
  | { kind: 'tool'; index: number; scroll: number }
  | { kind: 'diff'; title: string; files: InspectorFile[]; selected: number; view: 'list' | 'detail'; scroll: number }

type PendingPermission = {
  request: PermissionRequest
  preview?: ToolDiff
  resolve: (choice: PermissionChoice) => void
  reject?: (error: unknown) => void
  abort?: () => void
  selected: SelectModel<PermissionChoice>
}

type PendingQuestion = {
  questions: QuestionPrompt[]
  index: number
  selections: string[][]
  selected: number
  custom: string
  editingCustom: boolean
  resolve: (response: QuestionResponse) => void
  signal?: AbortSignal
  abort: () => void
}

type ProviderManagerCallbacks = {
  refresh: () => ProviderManagerSnapshot | Promise<ProviderManagerSnapshot>
  setActive: (name: string) => string | void | Promise<string | void>
  save: (draft: ProviderProfileDraft, existingName?: string) => string | void | Promise<string | void>
  remove: (name: string) => string | void | Promise<string | void>
}

type ProviderManagerField = 'name' | 'provider' | 'model' | 'baseUrl' | 'apiKey'

type PendingProviderManager = {
  callbacks: ProviderManagerCallbacks
  profiles: ProviderManagerProfile[]
  activeName?: string
  screen: 'menu' | 'set' | 'edit' | 'remove' | 'form' | 'confirm-remove'
  selected: number
  formField: number
  formFields: ProviderProfileDraft
  formCursors: Record<ProviderManagerField, number>
  existingName?: string
  removeName?: string
  error?: string
  message?: string
  resolve: (value: string | undefined) => void
}

const CSI = '\x1b['
const RESET = '\x1b[0m'
const DIM = '\x1b[2m'
const BOLD = '\x1b[1m'
const BLUE = '\x1b[34m'
const CYAN = '\x1b[36m'
const GREEN = '\x1b[32m'
const YELLOW = '\x1b[33m'
const RED = '\x1b[31m'
const WHITE = '\x1b[37m'
const BG = '\x1b[48;5;235m'
const BG2 = '\x1b[48;5;236m'
const BORDER = '\x1b[38;5;67m'
const SELECT = '\x1b[48;5;60m'

const COMMAND_DESCRIPTIONS: Record<string, string> = {
  help: 'Show available commands',
  model: 'Show the current model',
  theme: 'Change visual theme',
  effect: 'Choose banner motion effect',
  banner: 'Choose banner composition',
  animations: 'Toggle UI motion',
  provider: 'Switch provider profile',
  agent: 'Choose an agent mode',
  agents: 'List available agents',
  commands: 'List custom commands',
  plan: 'Switch to read-only planning',
  build: 'Switch to development mode',
  explore: 'Switch to read-only exploration',
  sessions: 'List saved sessions',
  resume: 'Resume a saved session',
  fork: 'Fork the current session',
  branch: 'Create a branch from a checkpoint',
  skills: 'Browse discovered skills',
  plugins: 'Manage installed plugins',
  marketplace: 'Browse registered marketplaces',
  doctor: 'Run environment diagnostics',
  permissions: 'Show permission mode',
  compact: 'Compact conversation context',
  thinking: 'Open reasoning inspector',
  diff: 'Show working tree diff',
  tasks: 'List background tasks',
  'task-log': 'Show background task events',
  checkpoints: 'List session checkpoints',
  checkpoint: 'Create a checkpoint',
  restore: 'Restore a checkpoint and workspace',
  cancel: 'Cancel a background task',
  history: 'Search session history',
  editor: 'Open the external editor',
  export: 'Export the current conversation',
  details: 'Open latest tool details',
  stash: 'Stash the current prompt draft',
  queue: 'Queue a prompt for later',
  models: 'List configured models and routing roles',
  vim: 'Toggle Vim-style prompt editing',
  auto: 'Run an autonomous coding task',
  clear: 'Clear the visible conversation',
  quit: 'Exit TermAgent',
  exit: 'Exit TermAgent',
}

function visibleAnsiWidth(s: string) {
  return widthOf(s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ''))
}

function clip(s: string, maxWidth: number) {
  if (maxWidth <= 0) return ''
  let out = ''
  let used = 0
  for (let i = 0; i < s.length;) {
    if (s[i] === '\x1b') {
      const match = s.slice(i).match(/^\x1b\[[0-9;?]*[A-Za-z]/)
      if (match) { out += match[0]; i += match[0].length; continue }
    }
    const cp = s.codePointAt(i) || 0
    const ch = String.fromCodePoint(cp)
    const w = widthOf(ch)
    if (used + w > maxWidth) break
    out += ch
    used += w
    i += ch.length
  }
  return out
}

function padRow(s: string, width: number) {
  return `${s}${' '.repeat(Math.max(0, width - visibleAnsiWidth(s)))}`
}

function wrapText(text: string, width: number) {
  const safeWidth = Math.max(10, width)
  const result: string[] = []
  for (const logical of text.replace(/\r\n/g, '\n').split('\n')) {
    if (!logical) { result.push(''); continue }
    let row = ''
    let rowWidth = 0
    for (const token of logical.split(/(\s+)/)) {
      const tokenWidth = widthOf(token)
      if (!row && tokenWidth <= safeWidth) { row = token; rowWidth = tokenWidth; continue }
      if (row && rowWidth + tokenWidth <= safeWidth) { row += token; rowWidth += tokenWidth; continue }
      if (row) result.push(row.replace(/\s+$/, ''))
      row = ''; rowWidth = 0
      for (const ch of Array.from(token)) {
        const w = widthOf(ch)
        if (row && rowWidth + w > safeWidth) { result.push(row); row = ''; rowWidth = 0 }
        row += ch; rowWidth += w
      }
    }
    result.push(row.replace(/\s+$/, ''))
  }
  return result
}
function normalizeToolDiffFiles(metadata: unknown): SharedDiffFile[] {
  return normalizeDiffMetadata(metadata)
}

function normalizeToolDiff(metadata: unknown): ToolDiff | null {
  const files = normalizeToolDiffFiles(metadata)
  if (!files.length) return null
  if (files.length === 1) {
    const file = files[0]!
    return { path: file.path, text: file.patch, additions: file.additions, deletions: file.deletions }
  }
  return {
    path: `${files.length} files`,
    text: files.map((file) => file.patch).join('\n'),
    additions: files.reduce((sum, file) => sum + file.additions, 0),
    deletions: files.reduce((sum, file) => sum + file.deletions, 0),
  }
}

async function previewToolDiff(cwd: string, toolName: string, args: any): Promise<ToolDiff | null> {
  if (toolName !== 'write_file' && toolName !== 'edit_file') return null
  const rawPath = typeof args?.path === 'string' ? args.path : ''
  if (!rawPath) return null
  const target = path.resolve(cwd, rawPath)
  if (!within(cwd, target)) return null
  try {
    const stat = await fs.stat(target).catch(() => undefined)
    if (stat && stat.size > 512 * 1024) return null
    let previous = ''
    try { previous = await fs.readFile(target, 'utf8') } catch {
      if (toolName === 'edit_file') return null
    }
    let next = ''
    if (toolName === 'write_file') {
      next = String(args?.content ?? '')
    } else {
      const oldText = String(args?.oldText ?? '')
      const newText = String(args?.newText ?? '')
      const count = previous.split(oldText).length - 1
      if (!args?.all && count !== 1) return null
      next = args?.all ? previous.split(oldText).join(newText) : previous.replace(oldText, newText)
    }
    const relative = path.relative(cwd, target) || path.basename(target)
    const diff = await renderTextDiff(relative, previous, next, { maxBytes: 24000 })
    if (!diff.text) return null
    return { path: relative, text: diff.text, additions: diff.additions, deletions: diff.deletions }
  } catch {
    return null
  }
}

function compactPath(cwd: string) {
  const home = process.env.HOME || ''
  if (home && cwd.startsWith(home)) return `~${cwd.slice(home.length)}`
  return cwd
}

export class TerminalUI {
  private entries: Entry[] = []
  private input: InputState = { value: '', cursor: 0 }
  private status = ''
  private activity: ActivityState = { phase: 'idle', label: '', startedAt: 0 }
  private vimMode = false
  private turnEscape = ''
  private turnEscapeTimer: ReturnType<typeof setTimeout> | undefined
  private statusTone: 'dim' | 'warn' | 'error' = 'dim'
  private todos: TodoItem[] = []
  private activeTool: Entry & { kind: 'tool' } | null = null
  private completion: CompletionState | null = null
  private startupUntil = 0
  private completionFlashUntil = 0
  private completionLabel = ''
  private scrollOffset = 0
  private permission: PendingPermission | null = null
  private question: PendingQuestion | null = null
  private questionEscape = ''
  private questionEscapeTimer: ReturnType<typeof setTimeout> | undefined
  private active = false
  private turnActive = false
  private promptFocused = false
  private renderQueued = false
  private renderTimer: ReturnType<typeof setTimeout> | undefined
  private previousFrame: string[] = []
  private lastSize = { width: 0, height: 0 }
  private permissionEscape = ''
  private permissionEscapeTimer: ReturnType<typeof setTimeout> | undefined
  private providerManager: PendingProviderManager | null = null
  private pluginManager: PluginManagerController | null = null
  private pluginManagerResolver: ((value: string | undefined) => void) | null = null
  private pluginManagerEscape = ''
  private pluginManagerEscapeTimer: ReturnType<typeof setTimeout> | undefined
  private pluginManagerInputBuffer = ''
  private providerManagerEscape = ''
  private providerManagerEscapeTimer: ReturnType<typeof setTimeout> | undefined
  private inspector: InspectorState | null = null
  private inspectorEscape = ''
  private inspectorEscapeTimer: ReturnType<typeof setTimeout> | undefined
  private editorReading = false
  private turnAbort: AbortController | null = null
  private activityTimer: ReturnType<typeof setInterval> | undefined
  private motionTimer: ReturnType<typeof setInterval> | undefined
  private bannerStyle: BannerStyle
  private bannerStyleExplicit = false
  private bannerEffect: BannerEffect
  private animations = true
  private motionMode: 'full' | 'reduced' | 'off' = 'full'
  private explorationSnapshot: ExplorationStateSnapshot | undefined
  private explorationTelemetry: ExplorationTelemetrySnapshot | undefined
  private readonly output: NonNullable<UIOptions['output']>
  private readonly inputStream: typeof process.stdin
  private theme: Theme
  private readonly colorCapability: ColorCapability
  private readonly hitTargets = new HitTargetRegistry()
  private readonly transcriptCache = new TranscriptRenderCache<string>()
  private readonly entryRevisions = new WeakMap<Entry, number>()
  private queueItems: QueuedPrompt[] = []
  private contextTokens = 0
  private contextLimit = 12000
  private activeTools = 0
  private explorationTool = ''
  private explorationToolArgs: unknown

  constructor(private readonly options: UIOptions) {
    this.output = options.output ?? process.stdout
    this.inputStream = options.input ?? process.stdin
    const catalog = options.themes ?? THEMES
    this.theme = catalog[options.theme?.toLowerCase() ?? ''] ?? getTheme(options.theme ?? 'termagent')
    this.bannerStyleExplicit = options.bannerStyle !== undefined
    this.bannerStyle = options.bannerStyle ?? this.theme.banner?.style ?? 'showcase'
    this.bannerEffect = normalizeBannerEffect(options.effect ?? 'off')
    this.motionMode = options.motion ?? (options.animations === false ? 'off' : 'full')
    this.animations = this.motionMode !== 'off'
    this.colorCapability = detectColorCapability({ TERM: process.env.TERM, COLORTERM: process.env.COLORTERM, NO_COLOR: process.env.NO_COLOR })
  }

  enter() {
    if (this.active) return
    this.active = true
    this.output.write(`${CSI}?1049h${CSI}H${CSI}2J${CSI}?25l${CSI}?7l${CSI}?1000h${CSI}?1006h${CSI}1 q`)
    this.output.on?.('resize', this.onResize)
    this.lastSize = { width: 0, height: 0 }
    this.previousFrame = []
    this.promptFocused = true
    this.startupUntil = Date.now() + 900
    this.completionFlashUntil = 0
    this.ensureMotionTimer()
    this.render()
    setTimeout(() => this.scheduleRender(), 950)
  }

  leave(sessionId?: string) {
    if (!this.active) return
    this.cancelPermission('deny')
    this.cancelQuestion()
    this.cancelProviderManager()
    this.cancelPluginManager()
    this.closeInspector(false)
    this.endAgentTurn()
    this.output.off?.('resize', this.onResize)
    if (this.renderTimer) clearTimeout(this.renderTimer)
    if (this.activityTimer) clearInterval(this.activityTimer)
    if (this.motionTimer) clearInterval(this.motionTimer)
    this.activityTimer = undefined
    this.motionTimer = undefined
    this.output.write(`${CSI}0 q${CSI}?25h${CSI}?7l${CSI}?1000l${CSI}?1006l${CSI}?1049l`)
    this.active = false
    this.previousFrame = []
    if (sessionId) {
      const width = Math.max(24, this.output.columns || process.stdout.columns || 80)
      const goodbye = renderGoodbye({ width, sessionId, theme: this.theme, capability: this.colorCapability })
      this.output.write(`\n${goodbye.join('\n')}\n`)
    }
  }

  setInput(value: string, cursor = value.length) {
    this.input = { value, cursor: clamp(cursor, 0, Array.from(value).length) }
    this.promptFocused = !this.permission && !this.question && !this.providerManager && !this.pluginManager && !this.inspector
    this.scheduleRender()
  }

  hydrate(messages: any[]) {
    this.entries = []
    for (const message of messages || []) {
      if (message?.role === 'user' && typeof message.content === 'string') this.entries.push({ kind: 'user', text: message.content })
      else if (message?.role === 'assistant' && (typeof message.content === 'string' || typeof message.reasoning === 'string')) this.entries.push({ kind: 'assistant', text: typeof message.content === 'string' ? message.content : '', reasoning: typeof message.reasoning === 'string' ? message.reasoning : undefined })
    }
    this.trimEntries()
    this.scrollOffset = 0
    this.scheduleRender()
  }

  setTitle(title: string) { this.options.title = title; this.scheduleRender() }
  setCompletion(state: CompletionState | null) { this.completion = state; this.scheduleRender() }

  async handleMouse(event: PromptMouseEvent) {
    if (event.button === 64) { this.scroll(3); return true }
    if (event.button === 65) { this.scroll(-3); return true }
    if (event.action !== 'press' || event.button !== 0) return false
    return await this.hitTargets.dispatch(event.column, event.row, { busy: this.turnActive })
  }

  hitTargetSnapshot() { return this.hitTargets.list() }
  transcriptCacheStats() { return this.transcriptCache.stats() }
  setTodos(items: TodoItem[] | null | undefined) {
    this.todos = Array.isArray(items) ? items.map(item => ({ id: String(item.id), task: String(item.task), status: item.status })) : []
    this.scheduleRender()
  }

  scroll(delta: number) {
    const amount = Number.isFinite(delta) ? delta : 0
    this.scrollOffset = Math.max(0, this.scrollOffset + amount)
    this.scheduleRender()
  }

  scrollToTop() { this.scrollOffset = Number.MAX_SAFE_INTEGER; this.scheduleRender() }
  scrollToBottom() { this.scrollOffset = 0; this.scheduleRender() }
  setMode(mode: string) { this.options.mode = mode; this.scheduleRender() }

  setQueue(items: QueuedPrompt[]) {
    this.queueItems = items.filter(item => item.status === 'queued').map(item => ({ ...item }))
    this.scheduleRender()
  }

  queuedCount() { return this.queueItems.length }

  setContextUsage(inputTokens: number, limit = this.contextLimit) {
    this.contextTokens = Math.max(0, Math.round(inputTokens))
    this.contextLimit = Math.max(1, Math.round(limit))
    this.scheduleRender()
  }

  setExplorationSnapshot(snapshot: ExplorationStateSnapshot | undefined, telemetry: ExplorationTelemetrySnapshot | undefined) {
    this.explorationSnapshot = snapshot
    this.explorationTelemetry = telemetry
    this.scheduleRender()
  }
  setTheme(name: string) {
    const catalog = this.options.themes ?? THEMES
    const theme = catalog[name.toLowerCase()] ?? getTheme(name)
    if (!theme || (!catalog[name.toLowerCase()] && !THEMES[name.toLowerCase()])) return false
    this.theme = theme
    if (!this.bannerStyleExplicit) this.bannerStyle = theme.banner?.style ?? 'showcase'
    this.previousFrame = []
    this.ensureMotionTimer()
    this.scheduleRender()
    return true
  }

  getThemeName() { return this.theme.name }
  getTheme() { return this.theme }
  getThemeId() {
    const catalog = this.options.themes ?? THEMES
    return Object.entries(catalog).find(([, value]) => value === this.theme)?.[0] ?? this.theme.name.toLowerCase().replace(/\s+/g, '-')
  }
  setBannerStyle(style: BannerStyle) {
    if (!['showcase','split','signal','minimal'].includes(style)) return false
    this.bannerStyleExplicit = true
    this.bannerStyle = style
    this.previousFrame = []
    this.scheduleRender()
    return true
  }
  getBannerStyle() { return this.bannerStyle }
  setBannerEffect(effect: BannerEffect) {
    this.bannerEffect = normalizeBannerEffect(effect)
    this.ensureMotionTimer()
    this.previousFrame = []
    this.scheduleRender()
    return true
  }
  getBannerEffect() { return this.bannerEffect }
  setAnimations(enabled: boolean) { this.setMotionMode(enabled ? 'full' : 'off') }
  getAnimations() { return this.motionMode !== 'off' }
  setMotionMode(mode: 'full' | 'reduced' | 'off') {
    this.motionMode = mode
    this.animations = mode !== 'off'
    if (this.motionTimer) { clearInterval(this.motionTimer); this.motionTimer = undefined }
    this.ensureMotionTimer()
    this.previousFrame = []
    this.scheduleRender()
  }
  getMotionMode() { return this.motionMode }
  setExploration(snapshot: ExplorationStateSnapshot | undefined, telemetry: ExplorationTelemetrySnapshot | undefined) {
    this.explorationSnapshot = snapshot
    this.explorationTelemetry = telemetry
    this.scheduleRender()
  }

  setModel(model: string, provider = this.options.provider) {
    this.options.model = model
    this.options.provider = provider
    this.scheduleRender()
  }

  addUser(text: string) {
    this.entries.push({ kind: 'user', text })
    if (!this.entries.slice(0, -1).some(x => x.kind === 'user')) {
      const firstLine = text.trim().split(/\r?\n/, 1)[0] || 'Session'
      this.options.title = firstLine.length > 56 ? `${firstLine.slice(0, 53)}...` : firstLine
    }
    this.trimEntries()
    this.scrollOffset = 0
    this.scheduleRender()
  }

  setActivity(phase: ActivityPhase, label = '') {
    this.activity = { phase, label, startedAt: this.activity.phase === phase && this.activity.startedAt ? this.activity.startedAt : Date.now() }
    const live = phase === 'thinking' || phase === 'reasoning' || phase === 'writing' || phase === 'tool' || phase === 'permission' || phase === 'question' || phase === 'retrying' || phase === 'compacting'
    if (live) {
      // The activity row is the canonical live status. Do not render a second
      // stale status line saying the same thing, which wastes the tiny mobile
      // viewport and makes the UI look like two independent state machines.
      this.status = ''
      if (!this.activityTimer) this.activityTimer = setInterval(() => this.scheduleRender(), 1000)
      this.ensureMotionTimer()
    }
    if (phase === 'idle' || phase === 'done' || phase === 'error') {
      if (this.activityTimer) clearInterval(this.activityTimer)
      this.activityTimer = undefined
    }
    this.scheduleRender()
  }

  toggleThinking() {
    if (this.inspector?.kind === 'reasoning') this.closeInspector()
    else this.openReasoningView()
    return this.isThinkingVisible()
  }

  isThinkingVisible() { return this.inspector?.kind === 'reasoning' }
  toggleToolDetails() {
    if (this.inspector?.kind === 'tool') this.closeInspector()
    else this.openLatestToolDetails()
    return this.areToolDetailsVisible()
  }
  areToolDetailsVisible() { return this.inspector?.kind === 'tool' }

  setVimMode(enabled: boolean) { this.vimMode = enabled; this.scheduleRender() }

  appendReasoning(text: string) {
    if (!text) return
    let last = this.entries[this.entries.length - 1]
    if (!last || last.kind !== 'assistant') {
      const assistant: Entry & { kind: 'assistant' } = { kind: 'assistant', text: '', reasoning: '' }
      this.entries.push(assistant)
      last = assistant
    }
    if (last.kind === 'assistant') { last.reasoning = `${last.reasoning || ''}${text}`; this.bumpEntry(last) }
    this.setActivity('reasoning', 'reasoning')
    this.scheduleRender()
  }

  startAssistant() {
    // TermAgent's prompt state is separate from message history. When a turn
    // begins, the composer is emptied and focus moves to the running-turn UI.
    this.turnActive = true
    this.promptFocused = true
    this.input = { value: '', cursor: 0 }
    this.activeTool = null
    const last = this.entries[this.entries.length - 1]
    if (!last || last.kind !== 'assistant' || last.text || last.reasoning) {
      this.entries.push({ kind: 'assistant', text: '', reasoning: '' })
    }
    this.setActivity('thinking', 'thinking')
    this.scheduleRender()
  }

  beginAgentTurn(controller: AbortController) {
    if (!this.active) return
    this.turnActive = true
    this.promptFocused = true
    this.turnAbort = controller
    this.turnEscape = ''
    if (!this.editorReading && this.inputStream.isTTY) {
      this.inputStream.setRawMode?.(true)
      this.inputStream.resume()
      this.inputStream.setEncoding('utf8')
      this.inputStream.on('data', this.onTurnInput)
    }
    this.hideCursor()
  }

  endAgentTurn() {
    if (!this.editorReading && this.inputStream.isTTY) {
      this.inputStream.off('data', this.onTurnInput)
      if (!this.inspector && !this.permission && !this.question && !this.providerManager && !this.pluginManager) {
        this.inputStream.setRawMode?.(false)
        this.inputStream.pause?.()
      }
    }
    this.turnAbort = null
    this.turnActive = false
    this.turnEscape = ''
    const tail = this.entries[this.entries.length - 1]
    if (tail?.kind === 'assistant' && !tail.text && !tail.reasoning) this.entries.pop()
    if (this.turnEscapeTimer) { clearTimeout(this.turnEscapeTimer); this.turnEscapeTimer = undefined }
    this.promptFocused = !this.inspector && !this.pluginManager && !this.providerManager && !this.permission && !this.question
    this.hideCursor()
    this.setActivity('idle', '')
    this.explorationTool = ''
    this.explorationToolArgs = undefined
    this.activeTools = 0
    this.completionLabel = this.entries.some(entry => entry.kind === 'tool') ? 'Turn complete · changes applied' : 'Turn complete'
    this.completionFlashUntil = Date.now() + 900
    this.scheduleRender()
  }

  private bumpEntry(entry: Entry) {
    this.entryRevisions.set(entry, (this.entryRevisions.get(entry) ?? 0) + 1)
  }

  private entryRevision(entry: Entry) { return this.entryRevisions.get(entry) ?? 0 }

  private interruptTurn() {
    if (!this.turnAbort || !this.turnActive) return false
    this.turnAbort.abort()
    this.setActivity('done', 'interrupting')
    this.setStatus('interrupting…', 'warn')
    return true
  }

  appendAssistant(text: string) {
    let last = this.entries[this.entries.length - 1]
    if (!last || last.kind !== 'assistant') {
      const assistant: Entry & { kind: 'assistant' } = { kind: 'assistant', text: '', reasoning: '' }
      this.entries.push(assistant)
      last = assistant
    }
    if (last.kind === 'assistant') { last.text += text; this.bumpEntry(last) }
    this.setActivity('writing', 'writing response')
    this.trimEntries()
    this.scheduleRender()
  }

  startTool(name: string, args: unknown) {
    const entry: Entry & { kind: 'tool' } = { kind: 'tool', name, args: safeJson(args, 5000), running: true, waiting: false, startedAt: Date.now() }
    this.entries.push(entry)
    this.activeTool = entry
    this.activeTools += 1
    if (['read_file','grep','glob','repo_map','verify_project'].includes(name)) {
      this.explorationTool = name
      this.explorationToolArgs = args
    }
    this.setActivity('tool', `running ${name}`)
    this.trimEntries()
    this.scheduleRender()
  }

  endTool(name: string, output: string, metadata?: any) {
    const target = this.activeTool?.name === name
      ? this.activeTool
      : [...this.entries].reverse().find(x => x.kind === 'tool' && x.name === name) as Entry & { kind: 'tool' } | undefined
    if (target) {
      target.running = false
      target.waiting = false
      target.output = output || ''
      if (metadata !== undefined) target.metadata = metadata
      target.durationMs = target.startedAt ? Math.max(0, Date.now() - target.startedAt) : undefined
      this.bumpEntry(target)
    } else {
      this.entries.push({ kind: 'tool', name, args: '{}', output: output || '', running: false, metadata })
    }
    this.activeTool = null
    this.activeTools = Math.max(0, this.activeTools - 1)
    if (!this.permission) this.setActivity('thinking', 'thinking')
    this.scheduleRender()
  }

  system(text: string, tone: 'dim' | 'warn' | 'error' = 'dim') {
    this.entries.push({ kind: 'system', text, tone })
    this.trimEntries()
    this.scheduleRender()
  }

  setStatus(text: string, tone: 'dim' | 'warn' | 'error' = 'dim') {
    this.status = text
    this.statusTone = tone
    this.scheduleRender()
  }

  clearStatus() { this.status = ''; this.scheduleRender() }
  clearConversation() { this.entries = []; this.scrollOffset = 0; this.scheduleRender() }
  isPermissionActive() { return this.permission !== null }
  isQuestionActive() { return this.question !== null }
  isProviderManagerActive() { return this.providerManager !== null }
  isPluginManagerActive() { return this.pluginManager !== null }
  isInspectorActive() { return this.inspector !== null }
  setEditorReading(active: boolean) { this.editorReading = active }
  isInputOverlayActive() { return this.inspector !== null }
  async handleInputOverlayKey(key: string) {
    if (!this.inspector) return false
    if (key === 'escape') { this.closeInspector(); return true }
    if (key === 'up') { this.inspectorScroll(-1); return true }
    if (key === 'down') { this.inspectorScroll(1); return true }
    if (key === 'pageup') { this.inspectorScroll(-Math.max(3, Math.floor((this.output.rows || 24) / 2))); return true }
    if (key === 'pagedown') { this.inspectorScroll(Math.max(3, Math.floor((this.output.rows || 24) / 2))); return true }
    if (key === 'left') { this.moveDiffSelection(-1); return true }
    if (key === 'right') { this.moveDiffSelection(1); return true }
    return false
  }

  openReasoningView() {
    if (!this.active) return
    const index = [...this.entries].reverse().findIndex(e => e.kind === 'assistant' && Boolean(e.reasoning))
    if (index < 0) {
      this.system('No reasoning is available for inspection yet.')
      return
    }
    this.openInspector({ kind: 'reasoning', scroll: 0 })
  }

  openLatestToolDetails() {
    if (!this.active) return
    const index = this.latestToolIndex()
    if (index < 0) {
      this.system('No tool call is available for inspection yet.')
      return
    }
    this.openInspector({ kind: 'tool', index, scroll: 0 })
  }

  openWorkingTreeDiff(result: DiffResult, title = 'Working tree') {
    if (!this.active) return
    const files = this.diffInspectorFiles(result)
    this.openInspector({ kind: 'diff', title, files, selected: 0, view: 'list', scroll: 0 })
  }

  async openProviderManager(callbacks: ProviderManagerCallbacks): Promise<string | undefined> {
    if (!this.active || !this.inputStream.isTTY) return undefined
    this.closeInspector(false)
    this.cancelPluginManager()
    if (this.permission) this.cancelPermission('deny')
    if (this.question) this.cancelQuestion()
    this.completion = null
    const snapshot = await callbacks.refresh()
    return await new Promise<string | undefined>((resolve) => {
      const initial: ProviderProfileDraft = {
        name: '',
        provider: 'openai-compatible',
        model: '',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: '',
      }
      this.providerManager = {
        callbacks,
        profiles: [...snapshot.profiles],
        activeName: snapshot.activeName,
        screen: 'menu',
        selected: 0,
        formField: 0,
        formFields: initial,
        formCursors: { name: 0, provider: 0, model: 0, baseUrl: initial.baseUrl.length, apiKey: 0 },
        resolve,
      }
      this.promptFocused = false
      this.providerManagerEscape = ''
      this.setActivity('idle', '')
      this.status = ''
      if (this.inputStream.isTTY) {
        this.inputStream.setRawMode?.(true)
        this.inputStream.resume()
        this.inputStream.setEncoding('utf8')
      }
      this.render()
      this.inputStream.on('data', this.onProviderManagerData)
    })
  }
  async openPluginManager(callbacks: PluginManagerCallbacks, mode: PluginManagerMode = 'plugins', initialQuery = ''): Promise<string | undefined> {
    if (!this.active || !this.inputStream.isTTY || this.turnActive) return undefined
    this.closeInspector(false)
    if (this.permission) this.cancelPermission('deny')
    if (this.question) this.cancelQuestion()
    this.completion = null
    let snapshot: PluginManagerSnapshot
    try {
      snapshot = await callbacks.refresh()
    } catch (error) {
      this.system(`Plugin manager: ${error instanceof Error ? error.message : String(error)}`, 'error')
      return undefined
    }
    return await new Promise<string | undefined>((resolve) => {
      this.pluginManager = new PluginManagerController(callbacks, snapshot, mode, initialQuery, this.theme, this.colorCapability)
      this.pluginManagerResolver = resolve
      this.pluginManagerEscape = ''
      this.promptFocused = false
      this.status = ''
      this.setActivity('idle', '')
      if (this.inputStream.isTTY) {
        this.inputStream.setRawMode?.(true)
        this.inputStream.resume()
        this.inputStream.setEncoding('utf8')
      }
      this.render()
      this.inputStream.on('data', this.onPluginManagerData)
    })
  }

  private closePluginManager(message?: string) {
    if (!this.pluginManager) return
    this.inputStream.off('data', this.onPluginManagerData)
    if (this.pluginManagerEscapeTimer) { clearTimeout(this.pluginManagerEscapeTimer); this.pluginManagerEscapeTimer = undefined }
    this.pluginManager = null
    this.pluginManagerEscape = ''
    this.pluginManagerInputBuffer = ''
    if (this.inputStream.isTTY) {
      this.inputStream.setRawMode?.(false)
      this.inputStream.pause?.()
    }
    this.promptFocused = !this.turnActive
    const resolve = this.pluginManagerResolver
    this.pluginManagerResolver = null
    if (message) this.system(message)
    resolve?.(message)
    this.scheduleRender()
  }

  private cancelPluginManager() {
    if (this.pluginManager) this.closePluginManager()
  }

  private onPluginManagerData = (chunk: string | Uint8Array) => {
    const manager = this.pluginManager
    if (!manager) return
    const decoded = typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk)
    const text = this.pluginManagerInputBuffer + decoded
    this.pluginManagerInputBuffer = ''
    let i = 0

    const runKey = async (key: string) => {
      const result = await manager.handleKey(key)
      if (this.pluginManager !== manager) return
      if (result === 'close') this.closePluginManager()
      this.scheduleRender()
    }

    while (i < text.length) {
      const remainder = text.slice(i)

      // SGR mouse sequences are frequently split across Node stream chunks.
      // Keep the incomplete sequence buffered instead of feeding its digits to
      // the manager, which could accidentally switch sections (e.g. `2`).
      if (remainder.startsWith('\x1b[<')) {
        const match = remainder.match(/^\x1b\[<(\d+);(\d+);(\d+)([mM])/ )
        if (match) {
          const code = Number(match[1]); const row = Number(match[3]); const final = match[4]
          if (final === 'M') {
            const button = code === 64 || code === 65 ? code : code & 3
            void manager.mouseClick(row, button).then(result => { if (result === 'close') this.closePluginManager(); this.scheduleRender() })
          } else if (code === 64 || code === 65) {
            void manager.mouseClick(0, code).then(() => this.scheduleRender())
          }
          i += match[0].length
          continue
        }
        if (/^\x1b\[<[0-9;]*$/.test(remainder)) {
          this.pluginManagerInputBuffer = remainder
          break
        }
      }

      // Legacy X10 mouse packets are exactly 6 bytes. Buffer incomplete packets.
      if (remainder.startsWith('\x1b[M')) {
        if (remainder.length < 6) {
          this.pluginManagerInputBuffer = remainder
          break
        }
        const code = (remainder.charCodeAt(3) || 32) - 32
        const row = (remainder.charCodeAt(5) || 32) - 32
        if (code === 64 || code === 65) void manager.mouseClick(row, code).then(() => this.scheduleRender())
        else if ((code & 3) === 0) void manager.mouseClick(row, 0).then(result => { if (result === 'close') this.closePluginManager(); this.scheduleRender() })
        i += 6
        continue
      }

      if (remainder.startsWith(`${CSI}A`)) { void runKey('up'); i += 3; continue }
      if (remainder.startsWith(`${CSI}B`)) { void runKey('down'); i += 3; continue }
      if (remainder.startsWith(`${CSI}5~`)) { void runKey('pageup'); i += 4; continue }
      if (remainder.startsWith(`${CSI}6~`)) { void runKey('pagedown'); i += 4; continue }

      // Buffer a split CSI prefix for arrow/page sequences.
      if (/^\x1b\[[0-9;?]*$/.test(remainder)) {
        this.pluginManagerInputBuffer = remainder
        break
      }

      const ch = text[i]!
      if (ch === '\x1b') {
        if (remainder === '\x1b') {
          this.pluginManagerEscape = '\x1b'
          if (this.pluginManagerEscapeTimer) clearTimeout(this.pluginManagerEscapeTimer)
          this.pluginManagerEscapeTimer = setTimeout(() => {
            if (this.pluginManagerEscape === '\x1b') {
              this.pluginManagerEscape = ''
              void runKey('escape')
            }
          }, 180)
          i++
          continue
        }
        i++
        continue
      }
      if (this.pluginManagerEscape) {
        this.pluginManagerEscape = ''
        if (this.pluginManagerEscapeTimer) { clearTimeout(this.pluginManagerEscapeTimer); this.pluginManagerEscapeTimer = undefined }
        i++
        continue
      }
      if (ch === '\x03') { this.closePluginManager('Plugin manager cancelled.'); i++; continue }
      if (ch === '\x7f' || ch === '\b') { void runKey('backspace'); i++; continue }
      if (ch === '\r' || ch === '\n') { void runKey('enter'); i++; continue }
      if (ch === ' ') { void runKey(' '); i++; continue }
      if (ch.length === 1) { void runKey(ch); i++; continue }
      i++
    }
  }

  private closeProviderManager(message?: string) {
    const pending = this.providerManager
    if (!pending) return
    this.inputStream.off('data', this.onProviderManagerData)
    if (this.providerManagerEscapeTimer) { clearTimeout(this.providerManagerEscapeTimer); this.providerManagerEscapeTimer = undefined }
    this.providerManager = null
    this.providerManagerEscape = ''
    if (this.inputStream.isTTY) {
      this.inputStream.setRawMode?.(false)
      this.inputStream.pause?.()
    }
    this.promptFocused = !this.turnActive
    if (message) this.system(message)
    pending.resolve(message)
    this.scheduleRender()
  }

  private cancelProviderManager() {
    if (this.providerManager) this.closeProviderManager()
  }

  private async refreshProviderManager() {
    const pending = this.providerManager
    if (!pending) return
    try {
      const snapshot = await pending.callbacks.refresh()
      if (!this.providerManager) return
      pending.profiles = [...snapshot.profiles]
      pending.activeName = snapshot.activeName
      pending.selected = Math.min(pending.selected, Math.max(0, pendingScreenLength(pending.screen, pending.profiles) - 1))
      pending.error = undefined
      this.scheduleRender()
    } catch (error) {
      pending.error = error instanceof Error ? error.message : String(error)
      this.scheduleRender()
    }
  }

  private providerFormFields(): ProviderManagerField[] {
    return ['name', 'provider', 'model', 'baseUrl', 'apiKey']
  }

  private providerTypeOptions() {
    return ['openai-compatible', 'anthropic', 'gemini']
  }

  private providerFormValue(field: ProviderManagerField) {
    if (!this.providerManager) return ''
    return this.providerManager.formFields[field] ?? ''
  }

  private providerDefaultBaseUrl(provider: string) {
    if (provider === 'anthropic') return 'https://api.anthropic.com/v1'
    if (provider === 'gemini') return 'https://generativelanguage.googleapis.com'
    return 'https://api.openai.com/v1'
  }

  private setProviderFormValue(field: ProviderManagerField, value: string, cursor = value.length) {
    const pending = this.providerManager
    if (!pending) return
    pending.formFields[field] = value
    pending.formCursors[field] = Math.max(0, Math.min(cursor, Array.from(value).length))
  }

  private selectProviderType(delta: number) {
    const pending = this.providerManager
    if (!pending) return
    const options = this.providerTypeOptions()
    const current = Math.max(0, options.indexOf(pending.formFields.provider))
    const next = options[(current + delta + options.length) % options.length]!
    const oldDefault = this.providerDefaultBaseUrl(pending.formFields.provider)
    pending.formFields.provider = next
    pending.formCursors.provider = 0
    if (!pending.formFields.baseUrl || pending.formFields.baseUrl === oldDefault) {
      pending.formFields.baseUrl = this.providerDefaultBaseUrl(next)
      pending.formCursors.baseUrl = pending.formFields.baseUrl.length
    }
    this.scheduleRender()
  }

  private async submitProviderManagerSelection() {
    const pending = this.providerManager
    if (!pending) return
    pending.error = undefined
    try {
      if (pending.screen === 'menu') {
        const actions = ['set', 'edit', 'add', 'remove', 'done'] as const
        const action = actions[pending.selected]
        if (action === 'done') { this.closeProviderManager(); return }
        pending.selected = 0
        if (action === 'set' || action === 'edit' || action === 'remove') {
          pending.screen = action
          pending.selected = 0
          this.scheduleRender()
          return
        }
        pending.formFields = { name: '', provider: 'openai-compatible', model: '', baseUrl: 'https://api.openai.com/v1', apiKey: '' }
        pending.formCursors = { name: 0, provider: 0, model: 0, baseUrl: pending.formFields.baseUrl.length, apiKey: 0 }
        pending.existingName = undefined
        pending.formField = 0
        pending.screen = 'form'
        this.scheduleRender()
        return
      }

      if (pending.screen === 'set') {
        const options = [{ name: '__environment__' } as any, ...pending.profiles]
        const option = options[pending.selected]
        if (!option) return
        if (option.name === '__environment__') {
          const message = await pending.callbacks.setActive('__environment__')
          await this.refreshProviderManager()
          pending.message = message || 'Using environment/default provider.'
          this.scheduleRender()
          return
        }
        const message = await pending.callbacks.setActive(option.name)
        await this.refreshProviderManager()
        pending.message = message || `Active provider: ${option.name}`
        this.scheduleRender()
        return
      }

      if (pending.screen === 'edit') {
        const profile = pending.profiles[pending.selected]
        if (!profile) return
        pending.formFields = { name: profile.name, provider: profile.provider, model: profile.model, baseUrl: profile.baseUrl, apiKey: '' }
        pending.formCursors = { name: profile.name.length, provider: 0, model: profile.model.length, baseUrl: profile.baseUrl.length, apiKey: 0 }
        pending.existingName = profile.name
        pending.formField = 0
        pending.screen = 'form'
        this.scheduleRender()
        return
      }

      if (pending.screen === 'remove') {
        const profile = pending.profiles[pending.selected]
        if (!profile) return
        pending.removeName = profile.name
        pending.selected = 0
        pending.screen = 'confirm-remove'
        this.scheduleRender()
        return
      }

      if (pending.screen === 'confirm-remove') {
        if (pending.selected === 0) {
          const name = pending.removeName
          if (!name) return
          const message = await pending.callbacks.remove(name)
          await this.refreshProviderManager()
          pending.message = message || `Removed provider: ${name}`
          pending.screen = 'menu'
          pending.selected = 0
          pending.removeName = undefined
          this.scheduleRender()
        } else {
          pending.screen = 'remove'
          pending.selected = 0
          this.scheduleRender()
        }
        return
      }

      if (pending.screen === 'form') {
        const fields = this.providerFormFields()
        const field = fields[pending.formField]!
        if (field !== 'provider') {
          if (pending.formField < fields.length - 1) {
            pending.formField++
            this.scheduleRender()
            return
          }
        } else {
          if (pending.formField < fields.length - 1) {
            pending.formField++
            this.scheduleRender()
            return
          }
        }
        if (!pending.formFields.name.trim()) throw new Error('Provider name is required.')
        if (!pending.formFields.model.trim()) throw new Error('Model is required.')
        if (!pending.formFields.baseUrl.trim()) throw new Error('Base URL is required.')
        const message = await pending.callbacks.save({ ...pending.formFields }, pending.existingName)
        await this.refreshProviderManager()
        pending.message = message || `Saved provider: ${pending.formFields.name}`
        pending.screen = 'menu'
        pending.selected = 0
        pending.formField = 0
        pending.existingName = undefined
        pending.formFields = { name: '', provider: 'openai-compatible', model: '', baseUrl: 'https://api.openai.com/v1', apiKey: '' }
        pending.formCursors = { name: 0, provider: 0, model: 0, baseUrl: pending.formFields.baseUrl.length, apiKey: 0 }
        this.scheduleRender()
      }
    } catch (error) {
      pending.error = error instanceof Error ? error.message : String(error)
      this.scheduleRender()
    }
  }

  private onProviderManagerData = (chunk: string | Uint8Array) => {
    const pending = this.providerManager
    if (!pending) return
    const text = typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk)
    for (const ch of text) {
      if (!this.providerManager) return
      if (this.providerManagerEscape) {
        if (this.providerManagerEscapeTimer) { clearTimeout(this.providerManagerEscapeTimer); this.providerManagerEscapeTimer = undefined }
        this.providerManagerEscape += ch
        const seq = this.providerManagerEscape
        if (seq === `${CSI}A`) { this.providerManagerMove(-1); this.providerManagerEscape = ''; continue }
        if (seq === `${CSI}B`) { this.providerManagerMove(1); this.providerManagerEscape = ''; continue }
        if (seq === `${CSI}C`) {
          if (this.providerManager?.screen === 'form') {
            const field = this.providerFormFields()[pending.formField]!
            if (field === 'provider') this.selectProviderType(1)
            else {
              const length = Array.from(this.providerFormValue(field)).length
              pending.formCursors[field] = Math.min(length, (pending.formCursors[field] ?? length) + 1)
              this.scheduleRender()
            }
          }
          this.providerManagerEscape = ''
          continue
        }
        if (seq === `${CSI}D`) {
          if (this.providerManager?.screen === 'form') {
            const field = this.providerFormFields()[pending.formField]!
            if (field === 'provider') this.selectProviderType(-1)
            else {
              pending.formCursors[field] = Math.max(0, (pending.formCursors[field] ?? 0) - 1)
              this.scheduleRender()
            }
          }
          this.providerManagerEscape = ''
          continue
        }
        if (seq === `${CSI}H`) {
          if (this.providerManager?.screen === 'form') {
            const field = this.providerFormFields()[pending.formField]!
            pending.formCursors[field] = 0
            this.scheduleRender()
          }
          this.providerManagerEscape = ''
          continue
        }
        if (seq === `${CSI}F`) {
          if (this.providerManager?.screen === 'form') {
            const field = this.providerFormFields()[pending.formField]!
            pending.formCursors[field] = Array.from(this.providerFormValue(field)).length
            this.scheduleRender()
          }
          this.providerManagerEscape = ''
          continue
        }
        if (seq === `${CSI}3~`) {
          if (this.providerManager?.screen === 'form') {
            const field = this.providerFormFields()[pending.formField]!
            if (field !== 'provider') {
              const chars = Array.from(this.providerFormValue(field))
              const cursor = pending.formCursors[field] ?? chars.length
              if (cursor < chars.length) {
                chars.splice(cursor, 1)
                this.setProviderFormValue(field, chars.join(''), cursor)
              }
              this.scheduleRender()
            }
          }
          this.providerManagerEscape = ''
          continue
        }
        if (seq.length > 10) this.providerManagerEscape = ''
        continue
      }
      if (ch === '\x1b') {
        this.providerManagerEscape = '\x1b'
        this.providerManagerEscapeTimer = setTimeout(() => { if (this.providerManagerEscape === '\x1b') { this.providerManagerEscape=''; this.providerManagerBack() } }, 70)
        continue
      }
      if (ch === '\x03') { this.cancelProviderManager(); return }
      if (ch === '\x15' && pending.screen === 'form') {
        const field = this.providerFormFields()[pending.formField]!
        if (field !== 'provider') {
          this.setProviderFormValue(field, '', 0)
          this.scheduleRender()
        }
        continue
      }
      if (ch === '\t') { this.providerManagerMove(1); continue }
      if (ch === '\x7f' || ch === '\b') {
        if (pending.screen === 'form') {
          const field = this.providerFormFields()[pending.formField]!
          if (field !== 'provider') {
            const current = this.providerFormValue(field)
            const chars = Array.from(current)
            const cursor = pending.formCursors[field] ?? chars.length
            if (cursor > 0) {
              chars.splice(cursor - 1, 1)
              this.setProviderFormValue(field, chars.join(''), cursor - 1)
            }
          }
          this.scheduleRender()
        }
        continue
      }
      if (ch === '\r' || ch === '\n') {
        if (pending.screen === 'form') {
          const fields = this.providerFormFields()
          if (pending.formField < fields.length - 1) {
            pending.formField++
            const nextField = fields[pending.formField]!
            pending.formCursors[nextField] = Array.from(this.providerFormValue(nextField)).length
            pending.error = undefined
            this.scheduleRender()
          } else {
            void this.submitProviderManagerSelection()
          }
        } else {
          void this.submitProviderManagerSelection()
        }
        continue
      }
      if (ch === ' ' && pending.screen !== 'form') { void this.submitProviderManagerSelection(); continue }
      if (pending.screen !== 'form' && (ch === 'j' || ch === 'k')) { this.providerManagerMove(ch === 'j' ? 1 : -1); continue }
      if (pending.screen !== 'form' && ch === 'h') { this.providerManagerMove(-1); continue }
      if (pending.screen !== 'form' && ch === 'l') { this.providerManagerMove(1); continue }
      if (ch >= '1' && ch <= '9') {
        const idx = Number(ch) - 1
        const max = pending.screen === 'menu' ? 5 : pending.screen === 'set' ? pending.profiles.length + 1 : pending.screen === 'edit' || pending.screen === 'remove' ? pending.profiles.length : pending.screen === 'confirm-remove' ? 2 : 0
        if (idx < max) { pending.selected = idx; this.scheduleRender(); continue }
      }
      if (pending.screen === 'form') {
        const field = this.providerFormFields()[pending.formField]!
        if (field === 'provider') {
          // Provider types are changed with left/right arrows. Printable characters remain literal.
        } else if (ch >= ' ' && widthOf(ch) > 0) {
          const chars = Array.from(this.providerFormValue(field))
          const cursor = pending.formCursors[field] ?? chars.length
          chars.splice(cursor, 0, ch)
          this.setProviderFormValue(field, chars.join(''), cursor + 1)
        }
        this.scheduleRender()
      }
    }
  }

  private providerManagerMove(delta: number) {
    const pending = this.providerManager
    if (!pending) return
    const max = pendingScreenLength(pending.screen, pending.profiles)
    if (pending.screen === 'form') {
      pending.formField = (pending.formField + delta + this.providerFormFields().length) % this.providerFormFields().length
    } else if (max > 0) {
      pending.selected = (pending.selected + delta + max) % max
    }
    pending.error = undefined
    this.scheduleRender()
  }

  private providerManagerBack() {
    const pending = this.providerManager
    if (!pending) return
    if (pending.screen === 'menu') { this.closeProviderManager(); return }
    if (pending.screen === 'form') { pending.screen = pending.existingName ? 'edit' : 'menu'; pending.selected = 0; pending.error = undefined; this.scheduleRender(); return }
    if (pending.screen === 'confirm-remove') { pending.screen = 'remove'; pending.selected = 0; this.scheduleRender(); return }
    pending.screen = 'menu'; pending.selected = 0; pending.error = undefined; this.scheduleRender()
  }

  async requestPermission(request: PermissionRequest): Promise<PermissionChoice> {
    if (!this.active || !this.inputStream.isTTY) return 'deny'
    this.closeInspector(false)
    if (this.permission) this.cancelPermission('deny')
    const preview = await previewToolDiff(this.options.cwd, request.tool.name, request.args)
    return await new Promise<PermissionChoice>((resolve, reject) => {
      const pending: PendingPermission = {
        request,
        preview: preview || undefined,
        resolve,
        reject,
        selected: new SelectModel<PermissionChoice>([
          { value: 'once', label: 'Allow once', key: '1' },
          { value: 'always', label: 'Always allow', key: '2' },
          { value: 'deny', label: 'Reject', key: '3' },
        ]),
      }
      pending.abort = () => this.resolvePermission('deny')
      this.permission = pending
      this.promptFocused = false
      this.setActivity('permission', 'permission required')
      const activeTool = this.activeTool
      if (activeTool?.name === request.tool.name) {
        activeTool.waiting = true
        activeTool.running = false
        this.bumpEntry(activeTool)
      }
      // The approval row itself is the status indicator. Keeping a second
      // 'awaiting permission' body line wastes scarce terminal height.
      this.status = ''
      this.statusTone = 'warn'
      this.permissionEscape = ''
      const signal = request.signal
      if (signal) {
        if (signal.aborted) return this.resolvePermission('deny')
        signal.addEventListener('abort', pending.abort, { once: true })
      }
      this.inputStream.on('data', this.onPermissionData)
      this.render()
    })
  }

  private resolvePermission(choice: PermissionChoice) {
    const pending = this.permission
    if (!pending) return
    const signal = pending.request.signal
    if (signal && pending.abort) signal.removeEventListener('abort', pending.abort)
    this.inputStream.off('data', this.onPermissionData)
    this.permission = null
    this.permissionEscape = ''
    if (this.activeTool) {
      if (choice === 'once' || choice === 'always') {
        this.activeTool.waiting = false
        this.activeTool.running = true
        this.bumpEntry(this.activeTool)
        this.status = `running ${this.activeTool.name}…`
        this.setActivity('tool', `running ${this.activeTool.name}`)
        this.statusTone = 'dim'
      } else {
        this.activeTool.waiting = false
        this.activeTool.running = false
        this.bumpEntry(this.activeTool)
        this.status = `permission denied for ${this.activeTool.name}`
        this.statusTone = 'warn'
      }
    }
    if (this.permissionEscapeTimer) { clearTimeout(this.permissionEscapeTimer); this.permissionEscapeTimer = undefined }
    pending.resolve(choice)
    this.promptFocused = !this.turnActive
    this.scheduleRender()
  }

  private cancelPermission(choice: PermissionChoice) { if (this.permission) this.resolvePermission(choice) }

  private onTurnInput = (chunk: string | Uint8Array) => {
    if (!this.turnAbort || this.permission || this.question) return
    const text = typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk)
    let i = 0

    while (i < text.length) {
      const ch = text[i]!
      if (ch === '\x03') {
        this.interruptTurn()
        i++
        continue
      }

      if (ch === '\x05') {
        this.openReasoningView()
        i++
        continue
      }

      if (ch === '\x0f') {
        this.openLatestToolDetails()
        i++
        continue
      }

      // ESC is meaningful only when it is actually a standalone interrupt.
      // Mouse clicks, wheel events, cursor keys and other terminal controls are
      // all ESC-prefixed, so they must be recognized before considering ESC an
      // interrupt. In particular, SGR mouse reports may arrive split across
      // multiple stdin chunks on mobile terminals.
      if (ch === '\x1b') {
        const remainder = text.slice(i)
        if (remainder.startsWith('\x1b[<')) {
          const match = remainder.match(/^\x1b\[<(\d+);(\d+);(\d+)([mM])/)
          if (match) {
            const code = Number(match[1])
            const event: PromptMouseEvent = { button: code, column: Math.max(0, Number(match[2]) - 1), row: Math.max(0, Number(match[3]) - 1), action: match[4] === 'm' ? 'release' : 'press', protocol: 'sgr' }
            if (code === 64) this.scroll(3)
            else if (code === 65) this.scroll(-3)
            else void this.handleMouse(event)
            i += match[0].length
            continue
          }
          this.turnEscape += remainder
          i = text.length
          continue
        }

        if (remainder.startsWith('\x1b[M')) {
          // Legacy X10 mouse format: ESC [ M Cb Cx Cy. We only need the
          // wheel buttons here. Clicks are intentionally ignored.
          if (remainder.length >= 6) {
            const code = (remainder.charCodeAt(3) || 32) - 32
            const event: PromptMouseEvent = { button: code, column: Math.max(0, (remainder.charCodeAt(4) || 32) - 33), row: Math.max(0, (remainder.charCodeAt(5) || 32) - 33), action: 'press', protocol: 'x10' }
            if (code === 64) this.scroll(3)
            else if (code === 65) this.scroll(-3)
            else void this.handleMouse(event)
            i += 6
            continue
          }
          this.turnEscape += remainder
          i = text.length
          continue
        }

        if (remainder.startsWith('\x1b[')) {
          const match = remainder.match(/^\x1b\[[0-9;?]*[A-Za-z~]/)
          if (match) {
            const seq = match[0]
            if (seq === `${CSI}5~`) this.scroll(5)
            else if (seq === `${CSI}6~`) this.scroll(-5)
            // All other CSI sequences are navigation/mouse/control input and
            // must not interrupt a running model turn.
            i += seq.length
            continue
          }
          this.turnEscape += remainder
          i = text.length
          continue
        }

        // A bare ESC remains an interrupt, but give a split terminal sequence
        // enough time to arrive before treating it as one. 300ms is deliberate
        // for Termux/mobile touch input, where event delivery can be bursty.
        this.turnEscape = '\x1b'
        if (this.turnEscapeTimer) clearTimeout(this.turnEscapeTimer)
        this.turnEscapeTimer = setTimeout(() => {
          if (this.turnEscape === '\x1b') {
            this.turnEscape = ''
            this.interruptTurn()
          }
        }, 300)
        i++
        continue
      }

      // If a previous chunk ended halfway through an ESC sequence, combine
      // the fragments and consume it now using the same parser.
      if (this.turnEscape) {
        this.turnEscape += ch
        const seq = this.turnEscape
        if (/^\x1b\[<(\d+);(\d+);(\d+)[mM]$/.test(seq)) {
          const match = /^\x1b\[<(\d+);(\d+);(\d+)([mM])$/.exec(seq)
          if (match) {
            const code = Number(match[1])
            const event: PromptMouseEvent = { button: code, column: Math.max(0, Number(match[2]) - 1), row: Math.max(0, Number(match[3]) - 1), action: match[4] === 'm' ? 'release' : 'press', protocol: 'sgr' }
            if (code === 64) this.scroll(3)
            else if (code === 65) this.scroll(-3)
            else void this.handleMouse(event)
          }
          this.turnEscape = ''
          if (this.turnEscapeTimer) { clearTimeout(this.turnEscapeTimer); this.turnEscapeTimer = undefined }
          i++
          continue
        }
        if (/^\x1b\[[0-9;?]*[A-Za-z~]$/.test(seq)) {
          this.turnEscape = ''
          if (this.turnEscapeTimer) { clearTimeout(this.turnEscapeTimer); this.turnEscapeTimer = undefined }
          i++
          continue
        }
        if (seq.length > 64) this.turnEscape = ''
        i++
        continue
      }

      i++
      // Normal text and touch-generated bytes are ignored while the agent owns
      // the turn. Only explicit Ctrl+C and Ctrl+E above have meaning here.
    }
  }

  private onPermissionData = (chunk: string | Uint8Array) => {
    if (!this.permission) return
    const text = typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk)
    for (const ch of text) {
      if (this.permissionEscape) {
        if (this.permissionEscapeTimer) { clearTimeout(this.permissionEscapeTimer); this.permissionEscapeTimer = undefined }
        this.permissionEscape += ch
        if (this.permissionEscape === `${CSI}A`) { this.movePermission(-1); this.permissionEscape = ''; continue }
        if (this.permissionEscape === `${CSI}B`) { this.movePermission(1); this.permissionEscape = ''; continue }
        if (this.permissionEscape === `${CSI}C` || this.permissionEscape === `${CSI}D`) { this.permissionEscape = ''; continue }
        if (this.permissionEscape.length > 8) this.permissionEscape = ''
        continue
      }
      if (ch === '\x1b') {
        this.permissionEscape = ch
        this.permissionEscapeTimer = setTimeout(() => {
          if (this.permissionEscape === '\x1b') {
            this.permissionEscape = ''
            this.resolvePermission('deny')
          }
        }, 50)
        continue
      }
      if (ch === '\x03') { this.resolvePermission('deny'); continue }
      const key = ch === '\r' || ch === '\n' ? 'enter' : ch.toLowerCase()
      if (ch === 'y') { this.permission.selected.setSelected(0); this.resolvePermission('once'); continue }
      if (ch === 'a') { this.permission.selected.setSelected(1); this.resolvePermission('always'); continue }
      if (ch === 'n' || ch === 'd') { this.permission.selected.setSelected(2); this.resolvePermission('deny'); continue }
      const action = this.permission.selected.handleKey(key)
      if (action?.type === 'submit') { this.resolvePermission(action.value); continue }
      if (action?.type === 'move') { this.scheduleRender(); continue }
    }
  }

  async requestQuestion(questions: QuestionPrompt[], signal?: AbortSignal): Promise<QuestionResponse> {
    if (!this.active || !this.inputStream.isTTY) return { status: 'cancelled', answers: [] }
    this.closeInspector(false)
    if (this.permission) this.resolvePermission('deny')
    if (this.question) this.finishQuestion({ status: 'rejected', answers: [] })
    const normalized = questions.map((q, i) => ({
      id: q.id || `q_${i + 1}`,
      question: String(q.question || `Question ${i + 1}`),
      header: String(q.header || `Q${i + 1}`).slice(0, 30),
      options: Array.isArray(q.options) ? q.options.map((o:any) => ({ label: String(o?.label || ''), description: o?.description ? String(o.description) : undefined })).filter((o:any) => o.label) : [],
      multi: Boolean(q.multiple ?? q.multi),
      multiple: Boolean(q.multiple ?? q.multi),
      custom: q.custom !== false,
    }))
    if (!normalized.length) return { status: 'cancelled', answers: [] }
    return await new Promise<QuestionResponse>((resolve) => {
      const pending: PendingQuestion = { questions: normalized, index: 0, selections: normalized.map(() => []), selected: 0, custom: '', editingCustom: false, resolve, signal, abort: () => this.finishQuestion({ status: 'cancelled', answers: [] }) }
      this.question = pending
      this.promptFocused = false
      this.setActivity('question', 'question required')
      this.status = ''
      if (signal) {
        if (signal.aborted) return this.finishQuestion({ status: 'cancelled', answers: [] })
        signal.addEventListener('abort', pending.abort, { once: true })
      }
      this.inputStream.on('data', this.onQuestionData)
      this.render()
    })
  }

  private questionOptions() {
    if (!this.question) return []
    const q = this.question.questions[this.question.index]!
    return [...(q.options || []), ...(q.custom !== false ? [{ label: 'Type your own answer', description: 'Enter a custom response.' }] : [])]
  }

  private moveQuestion(delta: number) {
    if (!this.question || this.question.editingCustom) return
    const total = this.questionOptions().length
    if (!total) return
    this.question.selected = (this.question.selected + delta + total) % total
    this.scheduleRender()
  }

  private toggleQuestionSelection() {
    const pending = this.question
    if (!pending) return
    const q = pending.questions[pending.index]!
    if (!q.multi) return
    const options = this.questionOptions()
    const choice = options[pending.selected]?.label || ''
    const customChoice = q.custom !== false && pending.selected === options.length - 1
    if (!choice || customChoice) return
    const set = pending.selections[pending.index] || []
    const at = set.indexOf(choice)
    if (at >= 0) set.splice(at, 1)
    else set.push(choice)
    pending.selections[pending.index] = set
    this.scheduleRender()
  }

  private acceptQuestionSelection() {
    const pending = this.question
    if (!pending) return
    const q = pending.questions[pending.index]!
    const options = this.questionOptions()
    const choice = options[pending.selected]?.label || ''
    const customChoice = q.custom !== false && pending.selected === options.length - 1
    if (customChoice) {
      pending.editingCustom = true
      this.scheduleRender()
      return
    }
    if (!choice) return
    if (q.multi) {
      if (!(pending.selections[pending.index] || []).length) pending.selections[pending.index] = [choice]
      this.advanceQuestion()
      return
    }
    pending.selections[pending.index] = [choice]
    this.advanceQuestion()
  }

  private advanceQuestion() {
    const pending = this.question
    if (!pending) return
    pending.editingCustom = false
    pending.custom = ''
    if (pending.index >= pending.questions.length - 1) { this.finishQuestion({ status: 'replied', answers: pending.selections.map(x => [...x]) }); return }
    pending.index++
    pending.selected = 0
    this.scheduleRender()
  }

  private finishQuestion(response: QuestionResponse) {
    const pending = this.question
    if (!pending) return
    pending.signal?.removeEventListener('abort', pending.abort)
    this.inputStream.off('data', this.onQuestionData)
    this.question = null
    this.questionEscape = ''
    if (this.questionEscapeTimer) { clearTimeout(this.questionEscapeTimer); this.questionEscapeTimer = undefined }
    this.setActivity(this.activeTool ? 'tool' : 'thinking', this.activeTool ? `running ${this.activeTool.name}` : 'thinking')
    this.promptFocused = !this.turnActive
    pending.resolve(response)
    this.scheduleRender()
  }

  private cancelQuestion() {
    this.finishQuestion({ status: 'rejected', answers: [] })
  }

  private onQuestionData = (chunk: string | Uint8Array) => {
    const pending = this.question
    if (!pending) return
    const text = typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk)
    for (const ch of text) {
      if (!this.question) return
      if (this.questionEscape) {
        this.questionEscape += ch
        if (this.questionEscape === `${CSI}A`) { this.moveQuestion(-1); this.questionEscape = ''; if (this.questionEscapeTimer) { clearTimeout(this.questionEscapeTimer); this.questionEscapeTimer = undefined }; continue }
        if (this.questionEscape === `${CSI}B`) { this.moveQuestion(1); this.questionEscape = ''; if (this.questionEscapeTimer) { clearTimeout(this.questionEscapeTimer); this.questionEscapeTimer = undefined }; continue }
        if (this.questionEscape.length > 8) { this.questionEscape = ''; if (this.questionEscapeTimer) { clearTimeout(this.questionEscapeTimer); this.questionEscapeTimer = undefined } }
        continue
      }
      if (ch === '\x1b') {
        this.questionEscape = '\x1b'
        if (this.questionEscapeTimer) clearTimeout(this.questionEscapeTimer)
        this.questionEscapeTimer = setTimeout(() => {
          if (this.questionEscape === '\x1b') { this.questionEscape = ''; this.cancelQuestion() }
        }, 60)
        continue
      }
      if (pending.editingCustom) {
        if (ch === '\r' || ch === '\n') {
          pending.selections[pending.index] = pending.custom.trim() ? [pending.custom.trim()] : []
          this.advanceQuestion()
        } else if (ch === '\x7f' || ch === '\b') pending.custom = Array.from(pending.custom).slice(0, -1).join('')
        else if (ch.length === 1 && widthOf(ch) > 0 && ch >= ' ') pending.custom += ch
        this.scheduleRender(); continue
      }
      if (ch === '\x03') { this.cancelQuestion(); return }
      if (ch === '\r' || ch === '\n') { this.acceptQuestionSelection(); continue }
      if (ch === ' ') { this.toggleQuestionSelection(); continue }
      if (ch === 'j') { this.moveQuestion(1); continue }
      if (ch === 'k') { this.moveQuestion(-1); continue }
      if (ch >= '1' && ch <= '9') { const idx=Number(ch)-1; const total=this.questionOptions().length; if(idx<total) { pending.selected=idx; this.scheduleRender() }; continue }
      const options=this.questionOptions(); const q=pending.questions[pending.index]!
      if (q.custom !== false && pending.selected === options.length - 1 && ch >= ' ') { pending.editingCustom=true; pending.custom += ch }
      this.scheduleRender()
    }
  }

  private movePermission(delta: number) {
    if (!this.permission) return
    this.permission.selected.move(delta)
    this.scheduleRender()
  }

  private confirmPermission() {
    this.resolvePermission(this.permission!.selected.selected.value)
  }

  private hideCursor() {
    this.output.write(`${CSI}?25l`)
  }

  render() {
    this.renderQueued = false
    this.ensureMotionTimer()
    this.renderTimer = undefined
    if (!this.active) return

    const width = Math.max(24, this.output.columns || process.stdout.columns || 80)
    const height = Math.max(10, this.output.rows || process.stdout.rows || 24)
    const sizeChanged = width !== this.lastSize.width || height !== this.lastSize.height
    this.lastSize = { width, height }

    const footerLines = 2
    const completionActive = Boolean(this.completion?.items.length) && !this.inspector && !this.permission && !this.question && !this.providerManager && !this.pluginManager
    const showSplash = this.entries.length === 0 && !this.turnActive && !completionActive
    let headerLines = showSplash ? this.header(width) : this.compactHeader(width)
    const inspectorActive = Boolean(this.inspector)
    const modalActive = inspectorActive || Boolean(this.providerManager || this.pluginManager)
    const inputInner = promptTextWidth(width)
    const preview = layoutTextInput(this.input.value, this.input.cursor, inputInner, width < 48 ? 3 : 6)
    const inputRows = Math.max(1, Math.min(width < 48 ? 3 : 6, preview.totalRows))
    const composerMeta = this.composerMeta()
    const composerPreview = renderComposer({
      width,
      inputLines: preview.rows.map(row => row.text),
      inputCursor: { row: preview.cursorRow, column: preview.cursorColumn },
      showCursor: this.promptFocused && !this.permission && !this.question && !this.providerManager && !this.pluginManager && !this.inspector,
      hiddenAbove: preview.hiddenAbove,
      hiddenBelow: preview.hiddenBelow,
      meta: composerMeta,
      theme: this.theme,
      capability: this.colorCapability,
    })
    const composerRows = composerPreview.length
    const queuePreview = !modalActive ? renderQueuePanel({ width, items: this.queueItems, theme: this.theme, capability: this.colorCapability }) : []
    const queueRows = queuePreview.length
    const permissionRows = this.permission ? this.permissionBox(width).length : 0
    const questionRows = this.question ? this.questionBox(width).length : 0
    const dockRows = permissionRows + questionRows
    const providerManagerRows = this.providerManager ? this.providerManagerBox(width).length : 0
    const pluginManagerRows = this.pluginManager ? height : 0
    const liveRows = !modalActive && !this.permission && !this.question && this.isLiveActivity() ? 1 : 0
    const statusRows = !modalActive && !this.permission && !this.question && this.status ? 1 : 0
    const completionRows = !modalActive && this.completionFlashUntil > Date.now() ? 1 : 0
    const startupRows = !modalActive && this.startupUntil > Date.now() ? 1 : 0
    const todoRows = !modalActive ? this.todoPanelLines(width).length : 0
    const explorationPreview = !modalActive ? this.explorationPanelRows(width, height) : []
    const explorationRows = explorationPreview.length
    const nonMenuRows = composerRows + queueRows + explorationRows + todoRows + dockRows + liveRows + statusRows + completionRows + startupRows
    // Keep the splash banner only when the viewport can still afford the
    // minimum live body. Otherwise the banner pushes the composer/footer
    // below the terminal edge on short mobile sessions (for example 56x20).
    if (showSplash && headerLines.length > 1) {
      const minBodyRows = width >= 60 ? 1 : 3
      const fits = height - headerLines.length - footerLines - nonMenuRows >= minBodyRows
      if (!fits) headerLines = this.compactHeader(width)
    }
    const menuBudget = Math.max(1, height - headerLines.length - footerLines - nonMenuRows)
    const menuPreview = !modalActive && this.completion?.items.length ? this.commandMenu(width, menuBudget) : []
    const menuRows = menuPreview.length
    const bottomRows = this.providerManager ? providerManagerRows
      : this.pluginManager ? pluginManagerRows
      : inspectorActive ? footerLines
      : nonMenuRows + menuRows
    const bodyHeight = Math.max(3, height - headerLines.length - bottomRows - footerLines)

    this.hitTargets.clear()
    let screen: string[] = []
    if (this.inspector) {
      screen = this.renderInspectorScreen(width, height)
    } else if (this.pluginManager || this.providerManager) {
      screen = this.renderBlockingModalScreen(width, height)
    } else {
      screen.push(...headerLines)
      if (startupRows) screen.push(this.startupRow(width))
      if (explorationRows) screen.push(...explorationPreview)
      const body = this.bodyLines(width)
      const maxScroll = Math.max(0, body.length - bodyHeight)
      this.scrollOffset = clamp(this.scrollOffset, 0, maxScroll)
      const startRow = Math.max(0, body.length - bodyHeight - this.scrollOffset)
      const visible = body.slice(startRow, startRow + bodyHeight)
      while (visible.length < bodyHeight) visible.unshift('')
      const shown = visible.slice(0, bodyHeight)
      if (maxScroll > 0 && shown.length) shown[shown.length - 1] = appendScrollRail(shown[shown.length - 1]!, this.scrollOffset / maxScroll, width)
      screen.push(...shown)

      if (this.completion?.items.length) {
        const menuTop = screen.length
        screen.push(...menuPreview)
        this.registerCompletionTargets(width, menuTop, menuBudget)
      }
      if (todoRows) screen.push(...this.todoPanelLines(width))
      if (this.permission) screen.push(...this.permissionBox(width))
      else if (this.question) screen.push(...this.questionBox(width))
      if (!this.permission && !this.question && this.isLiveActivity()) screen.push(this.activityRow(width))
      if (!this.permission && !this.question && this.status) screen.push(this.statusRow(width))
      if (completionRows) screen.push(this.completionRow(width))
      if (queueRows) {
        const queueTop = screen.length
        screen.push(...queuePreview)
        this.registerQueueTargets(width, queueTop)
      }
      screen.push(...composerPreview)
      const footer = this.footer(width)
      screen.push(...footer)
      if (this.turnActive && !this.inspector && !this.permission && !this.question) {
        this.hitTargets.register({
          id: 'interrupt',
          x: 0,
          y: Math.max(0, height - footer.length),
          width: Math.max(1, widthOf('esc interrupt')),
          height: 1,
          priority: 100,
          allowWhileBusy: true,
          onActivate: () => { this.interruptTurn() },
        })
      }
    }

    const rows = screen.slice(0, height)
    while (rows.length < height) rows.push('')
    const fittedRows = rows.map((row) => padRow(clip(row || '', width), width))

    let out = ''
    if (sizeChanged) {
      out += `${CSI}?25l${CSI}?7l${CSI}H${CSI}2J`
      this.previousFrame = []
    } else {
      out += `${CSI}?25l${CSI}?7l`
    }

    for (let i = 0; i < fittedRows.length; i++) {
      const next = fittedRows[i]!
      if (!sizeChanged && this.previousFrame[i] === next) continue
      out += `${CSI}${i + 1};1H${CSI}2K${next}${RESET}`
    }

    this.output.write(out)
    this.previousFrame = fittedRows
  }

  private renderBlockingModalScreen(width: number, height: number) {
    if (this.pluginManager) return this.renderPluginManagerScreen(width, height)
    const content = this.providerManagerBox(width).map(stripModalChrome).map(line => line.replace(/^\s*│\s?/, ''))
    return renderDialogFrame({
      width,
      height,
      title: 'Provider manager',
      subtitle: 'Manage saved provider profiles.',
      content,
      footer: '↑↓ select · Enter choose · Esc back',
      theme: this.theme,
      capability: this.colorCapability,
      tone: 'info',
      maxWidth: Math.min(92, width - 2),
      preserveAnsi: true,
    })
  }

  private renderInspectorScreen(width: number, height: number) {
    const inspector = this.inspector!
    const content: string[] = inspector.kind === 'reasoning'
      ? this.reasoningInspectorLines(width)
      : inspector.kind === 'tool'
        ? this.toolInspectorLines(width, inspector)
        : this.diffInspectorLines(width, height, inspector)

    const header = this.inspectorSubtitle(inspector, width)
    return renderDialogFrame({
      width,
      height,
      title: this.inspectorTitle(inspector),
      subtitle: header,
      content,
      footer: this.inspectorFooter(inspector, width).trim(),
      theme: this.theme,
      capability: this.colorCapability,
      tone: inspector.kind === 'diff' ? 'info' : inspector.kind === 'tool' ? 'normal' : 'info',
      maxWidth: Math.min(92, width - 2),
      preserveAnsi: true,
    })
  }

  private renderPluginManagerScreen(width: number, height: number) {
    const manager = this.pluginManager!
    const raw = manager.render(width, height)
    const mode = manager.getMode()
    const title = mode === 'plugins' ? 'Plugin manager' : mode === 'marketplaces' ? 'Marketplace browser' : 'Skill browser'
    const visible = raw.slice(4, Math.max(4, raw.length - 1))
      .map(stripPluginManagerChrome)
      .filter(line => line.trim().length > 0)
    return renderDialogFrame({
      width,
      height,
      title,
      subtitle: mode === 'plugins'
        ? 'Installed components and activation state.'
        : mode === 'marketplaces'
          ? 'Browse registered sources and available plugins.'
          : 'Search and inspect discovered skills.',
      content: visible,
      footer: raw.length ? stripPluginManagerChrome(raw[raw.length - 1]!).trim() : '',
      theme: this.theme,
      capability: this.colorCapability,
      tone: 'info',
      maxWidth: Math.min(92, width - 2),
      preserveAnsi: true,
    })
  }

  private inspectorTitle(inspector: InspectorState) {
    if (inspector.kind === 'reasoning') return '◆ Reasoning'
    if (inspector.kind === 'tool') {
      const entry = this.entries[inspector.index]
      return `◆ Tool details${entry?.kind === 'tool' ? ` · ${entry.name}` : ''}`
    }
    return `◆ ${inspector.title}`
  }

  private inspectorSubtitle(inspector: InspectorState, width: number) {
    if (inspector.kind === 'reasoning') return 'Full streamed reasoning · read-only inspector'
    if (inspector.kind === 'tool') {
      const toolCount = this.entries.filter(e => e.kind === 'tool').length
      const pos = this.toolOrdinal(inspector.index)
      return `${pos}/${toolCount} · ↑↓ scroll · ←→ previous/next tool`
    }
    if (!inspector.files.length) return 'No changed files'
    return `${inspector.files.length} file${inspector.files.length === 1 ? '' : 's'} · ${inspector.view === 'list' ? 'select a file' : 'file detail'}`
  }

  private inspectorFooter(inspector: InspectorState, width: number) {
    if (inspector.kind === 'reasoning') return padFooter('↑↓ scroll   PgUp/PgDn page   Esc close', width)
    if (inspector.kind === 'tool') return padFooter('↑↓ scroll   ←→ tool   d diff   Esc close', width)
    return inspector.view === 'list'
      ? padFooter('↑↓ file   Enter open   Esc close', width)
      : padFooter('↑↓ scroll   ←→ file   Esc back', width)
  }

  private reasoningInspectorLines(width: number) {
    const entry = [...this.entries].reverse().find(e => e.kind === 'assistant' && Boolean(e.reasoning))
    if (!entry || entry.kind !== 'assistant') return [`  ${DIM}No reasoning available.${RESET}`]
    const lines: string[] = []
    lines.push(`  ${DIM}${entry.reasoning!.length.toLocaleString()} characters${RESET}`)
    lines.push('')
    for (const line of wrapText(entry.reasoning || '', Math.max(10, width - 6))) lines.push(`  ${line}`)
    return lines
  }

  private toolInspectorLines(width: number, inspector: Extract<InspectorState, { kind: 'tool' }>) {
    const entry = this.entries[inspector.index]
    if (!entry || entry.kind !== 'tool') return [`  ${DIM}Tool call no longer exists.${RESET}`]
    const lines: string[] = []
    const status = statusDescriptor(entry.waiting ? 'waiting' : entry.running ? 'working' : 'done').label
    lines.push(`  ${BOLD}${entry.name}${RESET}  ${DIM}${status}${entry.durationMs != null ? ` · ${(entry.durationMs / 1000).toFixed(2)}s` : ''}${RESET}`)
    lines.push('')
    lines.push(`  ${CYAN}Arguments${RESET}`)
    for (const line of wrapText(entry.args, Math.max(10, width - 6)).slice(0, 80)) lines.push(`    ${DIM}${line}${RESET}`)
    if (entry.output) {
      lines.push('')
      lines.push(`  ${CYAN}Output${RESET}`)
      const outLines = wrapText(entry.output, Math.max(10, width - 6))
      const visible = outLines.slice(0, 160)
      for (const line of visible) lines.push(`    ${DIM}${line}${RESET}`)
      if (outLines.length > visible.length) lines.push(`    ${DIM}… output truncated${RESET}`)
    }
    const diff = (entry.name === 'write_file' || entry.name === 'edit_file') ? normalizeToolDiff(entry.metadata) : null
    if (diff) {
      lines.push('')
      lines.push(`  ${CYAN}Changes${RESET} · ${BOLD}${diff.path || 'file'}${RESET} ${GREEN}+${diff.additions}${RESET} ${RED}-${diff.deletions}${RESET}`)
      lines.push(`    ${DIM}Press d to open the diff inspector.${RESET}`)
    }
    return lines
  }

  private diffInspectorLines(width: number, height: number, inspector: Extract<InspectorState, { kind: 'diff' }>) {
    if (inspector.view === 'list') {
      if (!inspector.files.length) return [`  ${DIM}No changed files.${RESET}`]
      const rows: string[] = []
      inspector.files.forEach((file, index) => {
        const selected = index === inspector.selected
        const marker = selected ? `${GREEN}›${RESET}` : ' '
        const stats = file.binary ? `${DIM}binary${RESET}` : `${GREEN}+${file.additions}${RESET} ${RED}-${file.deletions}${RESET}`
        const status = file.status && !file.binary && file.status !== 'modified' ? ` ${DIM}${file.status}${RESET}` : ''
        rows.push(`  ${marker} ${selected ? BOLD : ''}${clip(file.path, Math.max(12, width - 34))}${RESET} ${stats}${status}`)
      })
      return rows
    }

    const file = inspector.files[inspector.selected]
    if (!file) return [`  ${DIM}No file selected.${RESET}`]

    const contentRows = renderDiffFile({
      width: Math.max(24, width - 2),
      file,
      theme: this.theme,
      capability: this.colorCapability,
      view: this.diffViewForWidth(width),
      maxRows: Math.max(1, height + 80),
    })
    const maxWindow = Math.max(1, height - 7)
    const maxScroll = Math.max(0, contentRows.length - maxWindow)
    inspector.scroll = Math.min(inspector.scroll, maxScroll)
    const windowStart = inspector.scroll
    const visible = contentRows.slice(windowStart, windowStart + maxWindow)
    if (windowStart > 0) visible.unshift(padRow(`${DIM}  ↑ ${windowStart} more rows${RESET}`, width))
    if (windowStart + maxWindow < contentRows.length) visible.push(padRow(`${DIM}  ↓ ${contentRows.length - windowStart - maxWindow} more rows${RESET}`, width))
    return visible
  }

  private diffViewForWidth(width: number): DiffView {
    return width >= 120 ? 'split' : 'unified'
  }

  private latestToolIndex() {
    for (let i = this.entries.length - 1; i >= 0; i--) if (this.entries[i]?.kind === 'tool') return i
    return -1
  }

  private toolOrdinal(index: number) {
    let ordinal = 0
    for (let i = 0; i <= index; i++) if (this.entries[i]?.kind === 'tool') ordinal++
    return ordinal
  }

  private diffInspectorFiles(result: DiffResult): InspectorFile[] {
    if (!result?.text || !result.files.length || result.text === 'No changes.') return []
    const parsed = parseDiffDocument(result.text)
    return parsed.files
  }

  private toolDiffFiles(entry: Entry & { kind: 'tool' }): InspectorFile[] {
    return normalizeToolDiffFiles(entry.metadata)
  }

  private openInspector(state: InspectorState) {
    if (!this.active || this.providerManager) return
    if (this.permission) this.cancelPermission('deny')
    if (this.question) this.cancelQuestion()
    this.completion = null
    this.inspector = state
    this.promptFocused = false
    this.inspectorEscape = ''
    this.setActivity('idle', '')
    this.status = ''
    this.inputStream.off('data', this.onTurnInput)
    if (this.inputStream.isTTY && !this.editorReading) {
      this.inputStream.setRawMode?.(true)
      this.inputStream.resume()
      this.inputStream.setEncoding('utf8')
    }
    if (this.inputStream.isTTY) this.inputStream.on('data', this.onInspectorData)
    this.render()
  }

  private closeInspector(render = true) {
    if (!this.inspector) return
    this.inputStream.off('data', this.onInspectorData)
    if (this.inspectorEscapeTimer) { clearTimeout(this.inspectorEscapeTimer); this.inspectorEscapeTimer = undefined }
    this.inspector = null
    this.inspectorEscape = ''
    if (this.turnActive) {
      if (this.inputStream.isTTY) this.inputStream.on('data', this.onTurnInput)
      this.promptFocused = false
      this.setActivity(this.activeTool ? (this.activeTool.waiting ? 'permission' : 'tool') : 'thinking', this.activeTool ? (this.activeTool.waiting ? 'permission required' : `running ${this.activeTool.name}`) : 'thinking')
    } else if (!this.editorReading) {
      if (this.inputStream.isTTY) {
        this.inputStream.setRawMode?.(false)
        this.inputStream.pause?.()
      }
      this.promptFocused = true
    } else {
      this.promptFocused = true
    }
    if (render) this.render()
  }

  private inspectorScroll(delta: number) {
    if (!this.inspector) return
    if (this.inspector.kind === 'diff' && this.inspector.view === 'list') {
      this.moveDiffSelection(delta)
      return
    }
    if (this.inspector.kind === 'reasoning' || this.inspector.kind === 'tool' || this.inspector.kind === 'diff') {
      this.inspector.scroll = Math.max(0, this.inspector.scroll + delta)
      this.scheduleRender()
    }
  }

  private moveDiffSelection(delta: number) {
    const inspector = this.inspector
    if (!inspector || inspector.kind !== 'diff' || inspector.view !== 'list' || !inspector.files.length) return
    inspector.selected = (inspector.selected + delta + inspector.files.length) % inspector.files.length
    inspector.scroll = 0
    this.scheduleRender()
  }

  private moveToolInspector(delta: number) {
    const inspector = this.inspector
    if (!inspector || inspector.kind !== 'tool') return
    const tools = this.entries.map((entry, index) => entry.kind === 'tool' ? index : -1).filter(index => index >= 0)
    if (!tools.length) return
    const current = Math.max(0, tools.indexOf(inspector.index))
    const next = tools[(current + delta + tools.length) % tools.length]!
    inspector.index = next
    inspector.scroll = 0
    this.scheduleRender()
  }

  private openInspectorDiffFromTool() {
    const inspector = this.inspector
    if (!inspector || inspector.kind !== 'tool') return
    const entry = this.entries[inspector.index]
    if (!entry || entry.kind !== 'tool') return
    const files = this.toolDiffFiles(entry)
    if (!files.length) return
    this.inspector = { kind: 'diff', title: `Changes · ${entry.name}`, files, selected: 0, view: 'list', scroll: 0 }
    this.scheduleRender()
  }

  private onInspectorData = (chunk: string | Uint8Array) => {
    const inspector = this.inspector
    if (!inspector) return
    const text = typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk)
    for (let i = 0; i < text.length; i++) {
      const ch = text[i]!
      const remainder = text.slice(i)
      if (!this.inspectorEscape && remainder.startsWith('\x1b[<')) {
        const match = remainder.match(/^\x1b\[<(\d+);(\d+);(\d+)([mM])/)
        if (match) {
          const code = Number(match[1])
          if (code === 64) this.inspectorScroll(3)
          else if (code === 65) this.inspectorScroll(-3)
          i += match[0].length - 1
          continue
        }
      }
      if (!this.inspectorEscape && remainder.startsWith('\x1b[M') && remainder.length >= 6) {
        const code = (remainder.charCodeAt(3) || 32) - 32
        if (code === 64) this.inspectorScroll(3)
        else if (code === 65) this.inspectorScroll(-3)
        i += 5
        continue
      }
      if (this.inspectorEscape) {
        if (this.inspectorEscapeTimer) { clearTimeout(this.inspectorEscapeTimer); this.inspectorEscapeTimer = undefined }
        this.inspectorEscape += ch
        const seq = this.inspectorEscape
        if (seq === `${CSI}A`) { this.inspectorScroll(-1); this.inspectorEscape = ''; continue }
        if (seq === `${CSI}B`) { this.inspectorScroll(1); this.inspectorEscape = ''; continue }
        if (seq === `${CSI}5~`) { this.inspectorScroll(-8); this.inspectorEscape = ''; continue }
        if (seq === `${CSI}6~`) { this.inspectorScroll(8); this.inspectorEscape = ''; continue }
        if (seq === `${CSI}C`) {
          if (this.inspector?.kind === 'tool') this.moveToolInspector(1)
          else if (this.inspector?.kind === 'diff' && this.inspector.view === 'detail' && this.inspector.files.length) {
            this.inspector.selected = (this.inspector.selected + 1) % this.inspector.files.length
            this.inspector.scroll = 0
            this.scheduleRender()
          }
          this.inspectorEscape = ''
          continue
        }
        if (seq === `${CSI}D`) {
          if (this.inspector?.kind === 'tool') this.moveToolInspector(-1)
          else if (this.inspector?.kind === 'diff' && this.inspector.view === 'detail' && this.inspector.files.length) {
            this.inspector.selected = (this.inspector.selected - 1 + this.inspector.files.length) % this.inspector.files.length
            this.inspector.scroll = 0
            this.scheduleRender()
          }
          this.inspectorEscape = ''
          continue
        }
        if (seq.startsWith(`${CSI}<`)) continue
        if (seq.length > 24) this.inspectorEscape = ''
        continue
      }
      if (ch === '\x03') {
        if (this.turnAbort) this.turnAbort.abort()
        this.closeInspector()
        continue
      }
      if (ch === '\x1b') {
        this.inspectorEscape = '\x1b'
        this.inspectorEscapeTimer = setTimeout(() => {
          if (this.inspectorEscape === '\x1b') {
            this.inspectorEscape = ''
            if (this.inspector?.kind === 'diff' && this.inspector.view === 'detail') {
              this.inspector.view = 'list'
              this.inspector.scroll = 0
              this.scheduleRender()
            } else this.closeInspector()
          }
        }, 70)
        continue
      }
      if (ch === 'j' || ch === 'arrowdown') { this.inspectorScroll(1); continue }
      if (ch === 'k' || ch === 'arrowup') { this.inspectorScroll(-1); continue }
      if (ch === 'd' && inspector.kind === 'tool') { this.openInspectorDiffFromTool(); continue }
      if ((ch === '\r' || ch === '\n') && this.inspector?.kind === 'diff' && this.inspector.view === 'list') {
        if (this.inspector.files.length) { this.inspector.view = 'detail'; this.inspector.scroll = 0; this.scheduleRender() }
        continue
      }
    }
  }

  private todoPanelLines(width: number) {
    const activeItems = this.todos.filter(item => item.status !== 'done')
    if (!activeItems.length) return []
    const inner = Math.max(20, contentWidth(width, { borderLeft: 0, borderRight: 0, paddingLeft: 2, paddingRight: 2 }))
    const done = this.todos.filter(item => item.status === 'done').length
    const maxItems = width < 58 ? 3 : width < 80 ? 4 : 5
    const visible = activeItems.slice(0, maxItems)
    const rows: string[] = []
    rows.push(padRow(`${BG2}${DIM}  Todo ${done}/${this.todos.length}${RESET}`, width))
    for (const item of visible) {
      const descriptor = statusDescriptor(todoStatus(item.status))
      const markerColor = item.status === 'in_progress' ? CYAN : DIM
      const marker = `${markerColor}${descriptor.marker}${RESET}`
      const task = clip(item.task, Math.max(1, inner - 5))
      rows.push(padRow(`${BG2}  ${marker} ${task}${RESET}`, width))
    }
    if (visible.length < activeItems.length) rows.push(padRow(`${BG2}  ${DIM}… ${activeItems.length - visible.length} more${RESET}`, width))
    return rows
  }

  private bodyLines(width: number) {
    const lines: string[] = []
    const themeKey = this.theme.name
    const capability = this.colorCapability
    const reasoningVisible = this.isThinkingVisible()
    const diffView = this.diffViewForWidth(width)
    for (const entry of this.entries) {
      const key = `${width}|${themeKey}|${capability}|${reasoningVisible ? 'reasoning' : 'collapsed'}|${diffView}`
      const rendered: TranscriptRenderResult<string> = this.transcriptCache.getOrRender(entry, key, this.entryRevision(entry), () => {
        if (entry.kind === 'user') {
          return { lines: renderUserTurn({ text: entry.text, width, theme: this.theme, capability }) }
        }
        if (entry.kind === 'assistant') {
          return { lines: renderAssistantTurn({ text: entry.text, reasoning: entry.reasoning, width, theme: this.theme, capability, reasoningVisible }) }
        }
        if (entry.kind === 'tool') {
          const diffFiles = entry.running || entry.waiting ? [] : normalizeToolDiffFiles(entry.metadata)
          const toolLines = renderToolActivity({
            width,
            theme: this.theme,
            capability,
            tool: {
              name: entry.name,
              summary: toolSummary(entry.name, entry.args),
              running: entry.running,
              waiting: entry.waiting,
              durationMs: entry.durationMs,
              additions: diffFiles.reduce((sum, file) => sum + file.additions, 0),
              deletions: diffFiles.reduce((sum, file) => sum + file.deletions, 0),
              hasDiff: diffFiles.length > 0,
            },
          })
          let lines = [...toolLines]
          if (diffFiles.length) {
            lines.push(...renderDiffFiles({
              width: Math.max(24, width - 2),
              files: diffFiles,
              theme: this.theme,
              capability,
              view: diffView,
              maxRows: width < 56 ? 8 : width < 80 ? 12 : 18,
              gapRows: 0,
            }))
            lines.push('')
          }
          return { lines }
        }
        return { lines: renderSystemRow({ system: { text: entry.text, tone: entry.tone }, width, theme: this.theme, capability }) }
      })
      lines.push(...rendered.lines)
    }
    return lines
  }

  private completionPickerRows(): PickerRow[] {
    const source: CompletionItem[] = this.completion?.rows?.length
      ? this.completion.rows
      : (this.completion?.items ?? []).map((value, index) => ({ id: `value:${index}:${value}`, label: value, value }))
    return source.map(row => {
      const commandName = row.id.startsWith('command:') ? row.id.slice('command:'.length) : ''
      return {
        id: row.id,
        label: row.label,
        detail: row.detail ?? (commandName ? COMMAND_DESCRIPTIONS[commandName] : this.completion?.kind === 'file' ? 'file' : undefined),
        badge: row.badge,
        status: row.status,
        value: row.value,
        disabled: row.disabled,
        key: row.key,
        swatches: row.swatches ? [...row.swatches] : undefined,
      }
    })
  }

  private registerCompletionTargets(width: number, menuTop: number, availableRows: number) {
    const completion = this.completion
    if (!completion?.items.length) return
    const pickerWidth = Math.min(COMMAND_PICKER_GEOMETRY.maxWidth, Math.max(COMMAND_PICKER_GEOMETRY.minWidth, width - 4))
    const stacked = width < COMMAND_PICKER_GEOMETRY.stackedBreakpoint
    const rows = this.completionPickerRows()
    const layout = pickerLayout({
      total: rows.length,
      selectedIndex: Math.max(0, Math.min(completion.index, rows.length - 1)),
      maxVisible: 8,
      availableRows,
      commandStacked: stacked,
      framed: true,
      hasQuery: ['palette','theme','effect','banner'].includes(completion.kind),
      hasFooter: true,
    })
    for (let i = layout.window.start; i < layout.window.end; i++) {
      const row = rows[i]
      if (!row) continue
      this.hitTargets.register({
        id: `picker:${i}`,
        x: 0,
        y: menuTop + layout.listOffsetRows + (i - layout.window.start) * layout.rowHeight,
        width: pickerWidth,
        height: layout.rowHeight,
        priority: 20,
        disabled: Boolean(row.disabled),
        onActivate: () => { void this.options.onMouseTarget?.(`picker:${i}`) },
      })
    }
  }

  private scheduleRender() {
    if (!this.active || this.renderQueued) return
    this.renderQueued = true
    this.renderTimer = setTimeout(() => this.render(), 0)
  }

  private onResize = () => {
    this.previousFrame = []
    this.scheduleRender()
  }

  private trimEntries() { if (this.entries.length > 160) this.entries.splice(0, this.entries.length - 160) }

  private motionIntervalMs() {
    if (this.motionMode !== 'full') return 0
    if (this.theme.motion?.intensity === 'lively') return 90
    if (this.theme.motion?.intensity === 'subtle') return 130
    if (this.theme.motion?.intensity === 'calm') return 220
    return 0
  }

  private ensureMotionTimer() {
    const interval = this.motionIntervalMs()
    const needsMotion = interval > 0 && (this.bannerEffect !== 'off' || this.isLiveActivity() || this.startupUntil > Date.now())
    if (!this.active || !needsMotion) {
      if (this.motionTimer) clearInterval(this.motionTimer)
      this.motionTimer = undefined
      return
    }
    if (this.motionTimer) return
    this.motionTimer = setInterval(() => this.scheduleRender(), interval)
  }

  private explorationPanelRows(width: number, height: number) {
    if (!this.turnActive || !this.explorationSnapshot || !this.explorationTelemetry) return []
    const model = buildExplorationHUDModel(this.explorationSnapshot, this.explorationTelemetry, this.activeTool?.name, true)
    if (!model.visible) return []
    return renderExplorationHUD({
      width,
      theme: this.theme,
      capability: this.colorCapability,
      model,
      compact: width < 58 || height < 18,
    })
  }

  private header(width: number) {
    const version = this.options.version ?? '1.18.0'
    const banner = renderBanner({ width, version, theme: this.theme, capability: this.colorCapability, style: this.bannerStyle, effect: this.motionMode === 'reduced' ? 'off' : this.bannerEffect, frame: this.motionMode === 'full' ? animationFrame(Date.now(), Math.max(16, this.motionIntervalMs() || 120)) : 0, animations: this.motionMode === 'full' })
    if (width >= 52) {
      const mode = this.options.mode ? this.options.mode[0]!.toUpperCase() + this.options.mode.slice(1) : 'Build'
      const meta = `${mode} · ${this.options.model || 'unconfigured'} ${this.options.provider || 'provider'}`
      banner.push(padRow(paint(clip(meta, Math.max(1, width - 2)), { fg: this.theme.muted, capability: this.colorCapability }), width))
    }
    return banner
  }

  private compactHeader(width: number) {
    const version = this.options.version ?? '1.18.0'
    const label = `${paint('>_', { fg: this.theme.primary, capability: this.colorCapability, attrs: { bold: true } })} ${paint('TermAgent', { fg: this.theme.text, capability: this.colorCapability, attrs: { bold: true } })} ${paint(`v${version}`, { fg: this.theme.muted, capability: this.colorCapability })}`
    return [padRow(clip(label, width), width)]
  }

  private startupRow(width: number) {
    return renderStartup({
      width,
      frame: this.motionMode === 'full' ? animationFrame(Date.now(), 120) : 0,
      theme: this.theme,
      capability: this.colorCapability,
    })
  }

  private completionRow(width: number) {
    return renderCompletion({
      width,
      label: clip(this.completionLabel || 'Turn complete', Math.max(8, width - 6)),
      now: Date.now(),
      animate: this.motionMode === 'full',
      theme: this.theme,
      capability: this.colorCapability,
    })
  }
  private isLiveActivity() {
    return this.activity.phase === 'thinking' || this.activity.phase === 'reasoning' || this.activity.phase === 'writing' || this.activity.phase === 'tool' || this.activity.phase === 'permission' || this.activity.phase === 'question' || this.activity.phase === 'retrying' || this.activity.phase === 'compacting'
  }

  private activityRow(width: number) {
    const phase = this.activity.phase === 'thinking' || this.activity.phase === 'reasoning' ? 'thinking'
      : this.activity.phase === 'writing' ? 'writing'
        : this.activity.phase === 'tool' ? 'tool'
          : this.activity.phase === 'permission' ? 'permission'
            : this.activity.phase === 'question' ? 'question'
              : this.activity.phase === 'retrying' ? 'retrying'
                : this.activity.phase === 'compacting' ? 'compacting'
                  : this.activity.phase === 'done' ? 'done' : 'error'
    return renderActivity({
      width,
      phase,
      label: this.activity.label,
      elapsedSeconds: elapsedSecondsSince(this.activity.startedAt),
      frame: this.motionMode === 'full' ? animationFrame(Date.now(), 80) : 0,
      theme: this.theme,
      capability: this.colorCapability,
    })
  }

  private statusRow(width: number) {
    if (!this.status) return ''
    const color = this.statusTone === 'error' ? this.theme.error : this.statusTone === 'warn' ? this.theme.warning : this.theme.muted
    return padRow(paint(`  ${clip(this.status, Math.max(8, width - 4))}`, { fg: color, bg: this.theme.panel, capability: this.colorCapability }), width)
  }

  private registerQueueTargets(width: number, top: number) {
    if (!this.queueItems.length || width < 48) return
    for (const entry of queuePanelEntries(this.queueItems, width)) {
      if (!entry.controls) continue
      const row = top + entry.row
      const editWidth = width >= 64 ? 6 : 2
      const editX = Math.max(0, width - (width >= 64 ? 14 : 8))
      this.hitTargets.register({ id: `queue:edit:${entry.item.id}`, x: editX, y: row, width: editWidth, height: 1, priority: 40, allowWhileBusy: true, onActivate: () => { void this.options.onQueueAction?.('edit', entry.item.id) } } as any)
      const cancelX = Math.max(0, width - 5)
      this.hitTargets.register({ id: `queue:cancel:${entry.item.id}`, x: cancelX, y: row, width: 2, height: 1, priority: 40, allowWhileBusy: true, onActivate: () => { void this.options.onQueueAction?.('cancel', entry.item.id) } } as any)
    }
  }

  private composerMeta(): ComposerMeta {
    const state = composerStateFrom({
      turnActive: this.turnActive,
      queuedCount: this.queueItems.length,
      permission: Boolean(this.permission),
      question: Boolean(this.question),
      statusTone: this.statusTone,
      activityPhase: this.activity.phase,
    })
    return {
      state,
      provider: this.options.provider || 'provider',
      model: this.options.model || 'unconfigured',
      mode: this.options.mode || 'build',
      contextTokens: this.contextTokens,
      contextLimit: this.contextLimit,
      queuedCount: this.queueItems.length,
      activeTools: this.activeTools,
      connection: state === 'error' ? 'error' : 'connected',
      workspace: compactPath(this.options.cwd),
      modelLine: `${this.options.mode ? this.options.mode[0]!.toUpperCase() + this.options.mode.slice(1) : 'Build'} · ${this.options.model || 'No model'} ${this.options.provider || 'provider'}`,
    }
  }

  private promptBox(width: number, totalRows: number, layout: ReturnType<typeof layoutTextInput>, showCursor: boolean) {
    const rows: string[] = []
    const inner = promptTextWidth(width)
    for (const [i, row] of layout.rows.entries()) {
      const atTop = layout.hiddenAbove && i === 0
      const atBottom = layout.hiddenBelow && i === layout.rows.length - 1
      const marker = atTop ? '↑ ' : '  '
      const suffix = atBottom ? '  ↓' : ''
      const cursorHere = showCursor && i === layout.cursorRow
      const text = cursorHere ? paintCursor(row.text, layout.cursorColumn) : row.text
      const used = widthOf(marker) + widthOf(text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')) + widthOf(suffix)
      const available = Math.max(0, inner - used)
      const body = `${marker}${text}${' '.repeat(available)}${suffix}`
      const paintedBody = paint(body, { fg: this.theme.text, bg: this.theme.panel, capability: this.colorCapability })
      const content = `${paint('│', { fg: this.theme.border, capability: this.colorCapability })}${paintedBody}`
      rows.push(padRow(content, width))
    }
    if (!rows.length && showCursor) {
      const body = `  ${cursorBlock()}${' '.repeat(Math.max(0, inner - 2))}`
      rows.push(padRow(`${paint('│', { fg: this.theme.border, capability: this.colorCapability })}${paint(body, { fg: this.theme.text, bg: this.theme.panel, capability: this.colorCapability })}`, width))
    }
    const modeLabel = this.options.mode ? this.options.mode[0]!.toUpperCase() + this.options.mode.slice(1) : 'Build'
    const model = this.options.model || 'No model'
    const modelLine = `${modeLabel} · ${model} ${providerLabel(this.options.provider)}`
    rows.push(padRow(`${paint('│', { fg: this.theme.border, capability: this.colorCapability })}${paint(` ${clip(modelLine, Math.max(1, width - 1) )}`, { fg: this.theme.text, bg: this.theme.panel, capability: this.colorCapability, attrs: { bold: true } })}`, width))
    if (width >= 64 && !this.turnActive) {
      const tip = renderTip({ width: Math.max(24, width - 2), theme: this.theme, capability: this.colorCapability })
      rows.push(padRow(`${paint('│', { fg: this.theme.border, capability: this.colorCapability })}${paint(` ${tip}`, { bg: this.theme.panel, capability: this.colorCapability })}`, width))
    }
    while (rows.length < totalRows) rows.push(padRow(paint(' '.repeat(width), { bg: this.theme.panel, capability: this.colorCapability }), width))
    return rows.slice(0, totalRows)
  }

  private commandMenu(width: number, availableRows: number) {
    const completion = this.completion!
    const rows = this.completionPickerRows()
    const selectedIndex = Math.max(0, Math.min(completion.index, rows.length - 1))
    const pickerWidth = Math.min(COMMAND_PICKER_GEOMETRY.maxWidth, Math.max(COMMAND_PICKER_GEOMETRY.minWidth, width - 4))
    const visualKind = completion.kind === 'theme' || completion.kind === 'effect' || completion.kind === 'banner'
    const title = completion.kind === 'palette' ? 'Command palette' : completion.kind === 'theme' ? 'Theme studio' : completion.kind === 'effect' ? 'Banner atmosphere' : completion.kind === 'banner' ? 'Banner style' : 'Commands'
    const footer = visualKind ? '↑↓ preview · Enter apply · Esc revert' : '↑↓ select · Enter run · Esc close'
    return renderPicker({
      width: pickerWidth,
      selectedIndex,
      maxVisible: visualKind ? 6 : 8,
      availableRows,
      query: ['palette','theme','effect','banner'].includes(completion.kind) ? completion.query : undefined,
      title,
      footer,
      commandLayout: width >= COMMAND_PICKER_GEOMETRY.stackedBreakpoint ? true : 'stacked',
      commandNameWidth: COMMAND_PICKER_GEOMETRY.fixedNameWidth,
      commandDescriptionGap: COMMAND_PICKER_GEOMETRY.descriptionGap,
      commandItemPaddingLeft: COMMAND_PICKER_GEOMETRY.itemPaddingLeft,
      commandItemPaddingRight: COMMAND_PICKER_GEOMETRY.itemPaddingRight,
      theme: this.theme,
      capability: this.colorCapability,
      rows,
    })
  }

  private permissionBox(width: number) {
    const request = this.permission!.request
    const tool = request.tool.name
    const inner = Math.max(18, width - 10)
    const compact = width < 64
    const preview = this.permission!.preview
    const content: string[] = []
    const title = tool === 'bash' ? 'Run shell command?' : `Allow ${tool}?`
    const requestText = tool === 'bash' ? `$ ${String(request.args?.command ?? safeJson(request.args))}` : safeJson(request.args)
    content.push(`${BOLD}${title}${RESET}`)
    for (const line of wrapText(requestText, inner).slice(0, compact ? 1 : 2)) content.push(`${DIM}${line}${RESET}`)
    if (preview) {
      content.push(`${CYAN}changes${RESET} · ${BOLD}${preview.path || 'file'}${RESET} ${GREEN}+${preview.additions}${RESET} ${RED}-${preview.deletions}${RESET}`)
      const shared: SharedDiffFile = { path: preview.path || 'file', patch: preview.text, additions: preview.additions, deletions: preview.deletions }
      const rendered = renderDiffFile({
        width: Math.max(24, width - 8),
        file: shared,
        theme: this.theme,
        capability: this.colorCapability,
        view: 'unified',
        maxRows: compact ? 3 : 5,
        showHeader: false,
      })
      for (const row of rendered) content.push(row)
    }

    const options = [
      ['1', 'Allow once'],
      ['2', 'Always allow'],
      ['3', 'Reject'],
    ] as const
    const selected = this.permission!.selected.selectedIndex
    const optionCells = options.map((option, i) => {
      const label = `[${option[0]}] ${option[1]}`
      return i === selected ? `${GREEN}›${RESET} ${BOLD}${label}${RESET}` : `  ${label}`
    })
    const optionLine = compact
      ? optionCells.join('  ')
      : optionCells.map((item, i) => i === selected ? `${paintOptionBackground(item, this.theme, this.colorCapability)}` : item).join('   ')
    content.push(clip(optionLine, Math.max(18, width - 8)))
    return renderDockFrame({
      width,
      title: `Permission required · ${tool}`,
      content,
      footer: '↑↓ select · Enter confirm · 1/2/3 quick select · Esc reject',
      theme: this.theme,
      capability: this.colorCapability,
      tone: 'warning',
      maxWidth: Math.min(96, width - 2),
    })
  }

  private providerManagerBox(width: number) {
    const pending = this.providerManager!
    const rows: string[] = []
    const inner = Math.max(22, width - 6)
    const line = (content: string, bg = BG2) => padRow(`${bg}${content}${RESET}`, width)
    rows.push(line(`${BORDER}│${RESET}${BOLD}${CYAN}◆ Provider manager${RESET}`))
    rows.push(line(`${BORDER}│${RESET}  ${DIM}Configure providers saved in .termagent/config.json${RESET}`))

    if (pending.screen === 'menu') {
      const active = pending.activeName ? pending.profiles.find(p => p.name === pending.activeName) : undefined
      const activeText = active ? `${active.name} · ${active.provider} · ${active.model}` : 'environment/default'
      rows.push(line(`${BORDER}│${RESET}  ${BOLD}Active:${RESET} ${clip(activeText, inner - 12)}`))
      if (pending.message) rows.push(line(`${BORDER}│${RESET}  ${GREEN}${clip(pending.message, inner - 4)}${RESET}`))
      const options = [
        ['1', 'Set provider', 'Choose the active saved provider.'],
        ['2', 'Edit provider', 'Change provider type, model, URL, or key.'],
        ['3', 'Add provider', 'Create a new saved provider profile.'],
        ['4', 'Remove provider', 'Delete a saved provider profile.'],
        ['5', 'Done', 'Return to chat.'],
      ]
      options.forEach((o, i) => {
        const selected = pending.selected === i
        rows.push(line(`${selected ? `${GREEN}›${RESET}` : ' '} ${BOLD}[${o[0]}] ${o[1]}${RESET} ${DIM}${clip(o[2], inner - 16)}${RESET}`, selected ? SELECT : BG2))
      })
    } else if (pending.screen === 'set' || pending.screen === 'edit' || pending.screen === 'remove') {
      const title = pending.screen === 'set' ? 'Set active provider' : pending.screen === 'edit' ? 'Edit provider' : 'Remove provider'
      rows.push(line(`${BORDER}│${RESET}${BOLD}${title}${RESET}`))
      if (!pending.profiles.length) rows.push(line(`${BORDER}│${RESET}  ${DIM}No saved provider profiles.${RESET}`))
      const profiles = pending.screen === 'set' ? [{ name: '__environment__', provider: '', model: 'Use environment/default', baseUrl: '', apiKeyConfigured: false } as ProviderManagerProfile, ...pending.profiles] : pending.profiles
      profiles.forEach((p, i) => {
        const selected = pending.selected === i
        const active = p.name === pending.activeName
        const label = p.name === '__environment__' ? 'Environment / default' : p.name
        const suffix = p.name === '__environment__' ? p.model : `${p.provider} · ${p.model}`
        const cred = p.apiKeyConfigured ? ' · key configured' : ''
        rows.push(line(`${selected ? `${GREEN}›${RESET}` : ' '} ${BOLD}[${Math.min(9, i + 1)}] ${clip(label, Math.max(8, inner - 28))}${RESET} ${active ? `${GREEN}●${RESET}` : ' '} ${DIM}${clip(`${suffix}${cred}`, Math.max(8, inner - 30))}${RESET}`, selected ? SELECT : BG2))
        if (p.name !== '__environment__' && width >= 72) rows.push(line(`${BORDER}│${RESET}      ${DIM}${clip(p.baseUrl, inner - 8)}${RESET}`))
      })
      rows.push(line(`${BORDER}│${RESET}${DIM}  ↑↓ select · Enter choose · Esc back${RESET}`))
    } else if (pending.screen === 'confirm-remove') {
      rows.push(line(`${BORDER}│${RESET}${BOLD}${YELLOW}◆ Remove provider?${RESET}`))
      rows.push(line(`${BORDER}│${RESET}  ${BOLD}${clip(pending.removeName || 'unknown', inner - 8)}${RESET}`))
      rows.push(line(`${BORDER}│${RESET}  ${DIM}This removes the saved profile from your TermAgent config.${RESET}`))
      const options = [['1', 'Remove'], ['2', 'Cancel']]
      options.forEach((o, i) => {
        const selected = pending.selected === i
        rows.push(line(`${selected ? `${GREEN}›${RESET}` : ' '} ${BOLD}[${o[0]}] ${o[1]}${RESET}`, selected ? SELECT : BG2))
      })
      rows.push(line(`${BORDER}│${RESET}${DIM}  ↑↓ select · Enter confirm · Esc back${RESET}`))
    } else {
      const fields = this.providerFormFields()
      rows.push(line(`${BORDER}│${RESET}${BOLD}${pending.existingName ? 'Edit provider' : 'Add provider'}${RESET}`))
      rows.push(line(`${BORDER}│${RESET}  ${DIM}Blank API key keeps the existing key when editing.${RESET}`))
      fields.forEach((field, i) => {
        const selected = pending.formField === i
        const labels: Record<string, string> = { name: 'Name', provider: 'Type', model: 'Model', baseUrl: 'Base URL', apiKey: 'API key' }
        let value = pending.formFields[field] ?? ''
        if (field === 'apiKey') value = value ? '•'.repeat(Math.min(28, value.length)) : '(unchanged / not set)'
        if (field === 'provider') value = `${value}  ←→`
        else if (selected && value && !value.startsWith('(')) {
          value = paintCursor(value, pending.formCursors[field] ?? Array.from(value).length)
        }
        rows.push(line(`${selected ? `${GREEN}›${RESET}` : ' '} ${BOLD}${labels[field]}:${RESET} ${clip(value, inner - 14)}`, selected ? SELECT : BG2))
      })
      rows.push(line(`${BORDER}│${RESET}${DIM}  ↑↓/Tab field · ←→ type · Ctrl+U clear · Enter next/save · Backspace/Delete · Esc back${RESET}`))
    }
    if (pending.error) rows.push(line(`${BORDER}│${RESET}${RED}${clip(pending.error, inner - 4)}${RESET}`))
    return rows
  }

  private questionBox(width: number) {
    const pending = this.question!
    const q = pending.questions[pending.index]!
    const options = this.questionOptions()
    const inner = Math.max(18, width - 10)
    const maxOptions = width < 56 ? 3 : 4
    let start = Math.max(0, pending.selected - maxOptions + 1)
    if (start + maxOptions > options.length) start = Math.max(0, options.length - maxOptions)
    const visible = options.slice(start, start + maxOptions)
    const content: string[] = []
    const mode = q.multi ? 'select all that apply' : 'choose one'
    content.push(`${BOLD}${clip(q.question, inner)}${RESET}`)
    content.push(`${DIM}${pending.questions.length > 1 ? `Question ${pending.index + 1}/${pending.questions.length} · ` : ''}${mode}${RESET}`)
    for (let offset = 0; offset < visible.length; offset++) {
      const index = start + offset
      const option = visible[offset]!
      const selected = index === pending.selected
      const checked = q.multi && (pending.selections[pending.index] || []).includes(option.label)
      const marker = selected ? `${GREEN}›${RESET}` : ' '
      const prefix = q.multi ? `[${checked ? '✓' : ' '}] ` : ''
      content.push(`${marker} ${BOLD}${index + 1}. ${prefix}${clip(option.label, Math.max(12, inner - 7))}${RESET}`)
    }
    if (start > 0 || start + visible.length < options.length) {
      content.push(`${DIM}… showing ${start + 1}-${start + visible.length} of ${options.length}${RESET}`)
    }
    if (pending.editingCustom) {
      content.push(`${CYAN}answer:${RESET} ${paintCursor(clip(pending.custom, Math.max(1, inner - 8)), Math.min(Array.from(pending.custom).length, Math.max(0, inner - 9)))}`)
    }
    content.push(`${DIM}↑↓ select · Enter ${pending.editingCustom ? 'save' : q.multi ? 'toggle' : 'choose'} · ${q.custom !== false ? 'type for custom' : ''}${q.custom !== false ? ' · ' : ''}Esc dismiss${RESET}`)
    return renderDockFrame({
      width,
      title: `Question${pending.questions.length > 1 ? ` · ${pending.index + 1}/${pending.questions.length}` : ''}`,
      content,
      theme: this.theme,
      capability: this.colorCapability,
      tone: 'info',
      maxWidth: Math.min(96, width - 2),
    })
  }

  private footer(width: number) {
    const context = this.inspector ? 'inspector' : this.providerManager || this.pluginManager ? 'modal' : this.permission || this.question ? 'dock' : this.completion?.items.length ? 'picker' : this.isLiveActivity() ? 'activity' : 'prompt'
    return renderFooter({
      width,
      cwd: compactPath(this.options.cwd),
      context,
      theme: this.theme,
      capability: this.colorCapability,
      vim: this.vimMode,
      turnActive: this.turnActive,
    })
  }
}
function paintOptionBackground(value: string, theme: Theme, capability: ColorCapability) {
  return paint(value.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ''), { fg: theme.text, bg: theme.selection, capability, attrs: { bold: true } })
}
function stripPluginManagerChrome(value: string) {
  // Keep the plugin manager's semantic row backgrounds intact. The modal
  // frame owns the outer border/surface, but selected rows still need their
  // background to survive so the picker remains visually obvious.
  return value
    .replace(/^(?:\s*│\s?)+/, '')
    .replace(/\s+$/, '')
}

function stripModalChrome(value: string) {
  return value
    .replace(/\x1b\[48;5;(235|236)m/g, '')
    .replace(/\x1b\[39m/g, '\x1b[39m')
    .replace(/\x1b\[0m\x1b\[48;5;(235|236)m/g, '\x1b[0m')
}

function pendingScreenLength(screen: PendingProviderManager['screen'], profiles: ProviderManagerProfile[]) {
  if (screen === 'menu') return 5
  if (screen === 'set') return profiles.length + 1
  if (screen === 'edit' || screen === 'remove') return profiles.length
  if (screen === 'confirm-remove') return 2
  return 1
}

function appendScrollRail(row: string, ratio: number, width: number) {
  const plain = visibleAnsiWidth(row)
  const position = Math.max(0, Math.min(1, ratio))
  const rail = position <= 0 ? '▲' : position >= 1 ? '▼' : '│'
  if (plain >= width) return `${clip(row, Math.max(1, width - 1))}${DIM}${rail}${RESET}`
  return `${row}${' '.repeat(Math.max(0, width - plain - 1))}${DIM}${rail}${RESET}`
}

function cursorBlock() {
  // Explicit background cursor: unlike a terminal hardware caret this is
  // part of the frame, so it cannot drift to a line below the composer.
  return '\x1b[7m \x1b[27m'
}

function paintCursor(text: string, column: number) {
  let used = 0
  const chars = Array.from(text)
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]!
    const w = widthOf(ch)
    if (column < used + w) {
      // Use inverse video so the cursor is visible on stock ANSI terminals
      // and remains portable across Termux color palettes.
      return `${chars.slice(0, i).join('')}\x1b[7m${ch}\x1b[27m${chars.slice(i + 1).join('')}`
    }
    used += w
  }
  return `${text}${cursorBlock()}`
}

function ellipsize(value: string, maxWidth: number) {
  if (visibleAnsiWidth(value) <= maxWidth) return value
  if (maxWidth <= 1) return '…'
  return `${clip(value, maxWidth - 1)}…`
}

function safeJson(value: unknown, maxLength = 260) {
  try {
    const s = JSON.stringify(value)
    const limit = Math.max(40, maxLength)
    return s && s.length > limit ? `${s.slice(0, limit - 3)}...` : s || '{}'
  } catch { return '{}' }
}

function padFooter(value: string, width: number) {
  return `${value}${' '.repeat(Math.max(0, width - visibleAnsiWidth(value)))}`
}

function toolSummary(name: string, argsJson: string) {
  try {
    const args = JSON.parse(argsJson || '{}')
    if (name === 'bash' || name === 'shell') return `$ ${String(args.command || '')}`
    if (typeof args.path === 'string') return args.path
    if (typeof args.file === 'string') return args.file
    if (typeof args.pattern === 'string') return `/${args.pattern}/`
    if (typeof args.query === 'string') return args.query
  } catch {}
  return argsJson || '{}'
}

function providerLabel(provider: string) {
  if (!provider) return 'Provider'
  if (provider === 'openai-compatible') return 'OpenAI Compatible'
  if (provider === 'anthropic') return 'Anthropic'
  if (provider === 'gemini') return 'Google Gemini'
  return provider
}

function shortTitle(title: string) {
  const first = title.split(/[\\/]/).filter(Boolean).pop() || title || 'Session'
  return first.length > 46 ? `${first.slice(0, 43)}...` : first
}
