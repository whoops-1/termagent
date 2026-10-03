import type { MarketplacePluginEntry, MarketplaceSource, PluginState } from '../../plugins/marketplace-types.js'
import type { SkillDescriptor, SkillDetails } from '../../skills/catalog.js'
import { widthOf } from './text-input.js'
import { background, foreground } from '../../design-system/ansi.js'
import { getTheme } from '../../design-system/theme.js'
import type { ColorCapability, Theme } from '../../design-system/types.js'

const RESET = '\x1b[0m'
const DIM = '\x1b[2m'
const BOLD = '\x1b[1m'
const CYAN = '\x1b[36m'
const GREEN = '\x1b[32m'
const YELLOW = '\x1b[33m'
const RED = '\x1b[31m'
const WHITE = '\x1b[37m'
const BG = '\x1b[48;5;235m'
const BG2 = '\x1b[48;5;236m'
const BORDER = '\x1b[38;5;67m'
const SELECT = '\x1b[48;5;60m'

export type PluginUIPlugin = PluginState & {
  components: { commands: number; agents: number; skills: number; mcp: number; hooks: number }
}

export type MarketplaceUI = {
  name: string
  owner: string
  description?: string
  source: MarketplaceSource
  status: 'ready' | 'broken'
  lastUpdated?: string
  revision?: string
  digest?: string
  plugins: MarketplacePluginEntry[]
  installLocation: string
}

export type PluginManagerSnapshot = {
  plugins: PluginUIPlugin[]
  marketplaces: MarketplaceUI[]
  skills: SkillDescriptor[]
}

export type PluginManagerCallbacks = {
  refresh: () => Promise<PluginManagerSnapshot>
  togglePlugin: (marketplace: string, plugin: string, enabled: boolean) => Promise<void>
  removePlugin: (marketplace: string, plugin: string) => Promise<void>
  installPlugin: (marketplace: string, plugin: string, confirmed: boolean) => Promise<{ requiresConfirmation?: boolean; message?: string }>
  refreshMarketplace: (name: string) => Promise<void>
  removeMarketplace: (name: string) => Promise<void>
  skillDetails: (id: string) => Promise<SkillDetails | undefined>
}

export type PluginManagerMode = 'plugins' | 'marketplaces' | 'skills'
type View = 'list' | 'detail' | 'confirm-trust' | 'confirm-remove'

type Row = { label: string; secondary?: string; value?: string }

function clip(text: string, max: number): string {
  if (max <= 0) return ''
  if (widthOf(text) <= max) return text
  if (max <= 1) return text.slice(0, max)
  let out = ''
  let used = 0
  for (const ch of Array.from(text)) {
    const w = widthOf(ch)
    if (used + w > max - 1) break
    out += ch
    used += w
  }
  return `${out}…`
}

function padRow(text: string, width: number): string {
  const plain = widthOf(text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ''))
  return `${text}${' '.repeat(Math.max(0, width - plain))}`
}

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase()
}

function sourceLabel(source: MarketplaceSource): string {
  switch (source.source) {
    case 'github': return `github:${source.repo}${source.ref ? `@${source.ref}` : ''}${source.sha ? `#${source.sha.slice(0, 8)}` : ''}`
    case 'git': return `git:${source.url}${source.ref ? `@${source.ref}` : ''}${source.sha ? `#${source.sha.slice(0, 8)}` : ''}`
    case 'url': return `url:${source.url}`
    case 'directory': return `dir:${source.path}`
    case 'file': return `file:${source.path}`
  }
}

function pluginSourceLabel(entry: MarketplacePluginEntry): string {
  if (typeof entry.source === 'string') return `local:${entry.source}`
  if (entry.source.source === 'github') return `github:${entry.source.repo}${entry.source.ref ? `@${entry.source.ref}` : ''}`
  if (entry.source.source === 'git') return `git:${entry.source.url}${entry.source.ref ? `@${entry.source.ref}` : ''}`
  if (entry.source.source === 'git-subdir') return `git:${entry.source.url}:${entry.source.path}${entry.source.ref ? `@${entry.source.ref}` : ''}`
  if (entry.source.source === 'url') return `url:${entry.source.url}`
  return `${entry.source.source}:${entry.source.package}`
}

function digestShort(digest?: string): string {
  if (!digest) return 'none'
  return digest.startsWith('sha256:') ? `sha256:${digest.slice(7, 19)}…` : clip(digest, 22)
}

function stateLabel(plugin: PluginUIPlugin): { text: string; tone: string } {
  if (plugin.status === 'broken') return { text: 'BROKEN', tone: RED }
  if (plugin.status === 'orphaned') return { text: 'ORPHANED', tone: RED }
  if (plugin.status === 'update-available') return { text: 'UPDATE', tone: YELLOW }
  if (plugin.enabled === false) return { text: 'DISABLED', tone: DIM }
  return { text: 'ENABLED', tone: GREEN }
}

export class PluginManagerController {
  private mode: PluginManagerMode
  private view: View = 'list'
  private selected = 0
  private query = ''
  private searching = false
  private busy = false
  private message = ''
  private messageTone: 'dim' | 'warn' | 'error' = 'dim'
  private selectedSkillDetails?: SkillDetails
  private trustTarget?: { marketplace: string; plugin: string; action: 'install' | 'update' }
  private removeTarget?: { marketplace: string; plugin: string; marketplaceRemove?: boolean }
  private marketplacePluginSelected = 0
  private marketplacePluginDetail = false
  private pluginSearch = ''
  private snapshot: PluginManagerSnapshot
  private lastHeight = 24
  private readonly theme: Theme
  private readonly capability: ColorCapability

  constructor(private readonly callbacks: PluginManagerCallbacks, snapshot: PluginManagerSnapshot, mode: PluginManagerMode = 'plugins', initialQuery = '', theme?: Theme, capability?: ColorCapability) {
    this.theme = theme ?? getTheme()
    this.capability = capability ?? 'ansi16'
    this.snapshot = snapshot
    this.mode = mode
    this.query = initialQuery
  }

  getMode() { return this.mode }
  isBusy() { return this.busy }
  isSearching() { return this.searching }
  getQuery() { return this.query }
  getSelectedIndex() { return this.selected }
  // List items begin on terminal row 5: title, counts, subtitle, separator.
  // Mouse row coordinates are 1-based.
  getSelectedRowTop() { return 5 }

  async refresh(message = 'Refreshed') {
    this.busy = true
    try {
      this.snapshot = await this.callbacks.refresh()
      this.selected = Math.min(this.selected, Math.max(0, this.rows().length - 1))
      this.selectedSkillDetails = undefined
      this.marketplacePluginSelected = Math.min(this.marketplacePluginSelected, Math.max(0, this.currentMarketplacePluginRows().length - 1))
      this.setMessage(message, 'dim')
    } catch (error) {
      this.setMessage(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      this.busy = false
    }
  }

  private setMessage(message: string, tone: 'dim' | 'warn' | 'error' = 'dim') {
    this.message = message
    this.messageTone = tone
  }

  private sourcePlugins(): PluginUIPlugin[] {
    return [...this.snapshot.plugins].sort((a, b) => a.id.localeCompare(b.id))
  }

  private filteredPlugins(): PluginUIPlugin[] {
    const query = normalize(this.query)
    const all = this.sourcePlugins()
    if (!query) return all
    return all.filter(p => normalize(`${p.id} ${p.plugin} ${p.marketplace} ${p.version ?? ''} ${p.status} ${p.error ?? ''}`).includes(query))
  }

  private filteredMarketplaces(): MarketplaceUI[] {
    const query = normalize(this.query)
    const all = [...this.snapshot.marketplaces].sort((a, b) => a.name.localeCompare(b.name))
    if (!query) return all
    return all.filter(m => normalize(`${m.name} ${m.owner} ${m.description ?? ''} ${sourceLabel(m.source)}`).includes(query))
  }

  private filteredSkills(): SkillDescriptor[] {
    const query = normalize(this.query)
    const all = [...this.snapshot.skills].sort((a, b) => a.id.localeCompare(b.id))
    if (!query) return all
    return all.filter(s => normalize(`${s.id} ${s.name} ${s.description} ${s.pluginId ?? ''}`).includes(query))
  }

  private marketplacePluginRows(marketplace: MarketplaceUI): MarketplacePluginEntry[] {
    const query = normalize(this.pluginSearch)
    const all = [...marketplace.plugins].sort((a, b) => a.name.localeCompare(b.name))
    if (!query) return all
    return all.filter(p => normalize(`${p.name} ${p.description ?? ''} ${p.category ?? ''} ${(p.tags ?? []).join(' ')} ${pluginSourceLabel(p)}`).includes(query))
  }
  private currentMarketplace(): MarketplaceUI | undefined {
    return this.filteredMarketplaces()[this.selected]
  }

  private currentMarketplacePluginRows(): MarketplacePluginEntry[] {
    const marketplace = this.currentMarketplace()
    return marketplace ? this.marketplacePluginRows(marketplace) : []
  }

  private pluginDetailRows(entry: MarketplacePluginEntry, marketplace: MarketplaceUI): Row[] {
    const installed = this.snapshot.plugins.find(p => p.id === `${entry.name}@${marketplace.name}`)
    const state = installed ? stateLabel(installed).text : 'NOT INSTALLED'
    return [
      { label: 'State', secondary: state },
      { label: 'Marketplace', secondary: marketplace.name },
      { label: 'Source', secondary: pluginSourceLabel(entry) },
      { label: 'Version', secondary: entry.version ?? 'unknown' },
      ...(entry.category ? [{ label: 'Category', secondary: entry.category }] : []),
      ...(entry.tags?.length ? [{ label: 'Tags', secondary: entry.tags.join(', ') }] : []),
      ...(entry.description ? [{ label: 'About', secondary: entry.description }] : []),
    ]
  }

  private rows(): Row[] {
    if (this.mode === 'plugins') {
      return this.filteredPlugins().map(plugin => {
        const state = stateLabel(plugin)
        const counts = plugin.components
        return {
          label: plugin.plugin,
          secondary: `${state.text.toLowerCase()} · v${plugin.version ?? '?'} · ${counts.commands}c ${counts.agents}a ${counts.skills}s ${counts.mcp}m ${counts.hooks}h`,
          value: plugin.id,
        }
      })
    }
    if (this.mode === 'marketplaces') {
      return this.filteredMarketplaces().map(m => ({
        label: m.name,
        secondary: `${m.status} · ${m.plugins.length} plugins · ${sourceLabel(m.source)}`,
        value: m.name,
      }))
    }
    return this.filteredSkills().map(skill => ({
      label: skill.id,
      secondary: `${skill.source}${skill.pluginId ? ` · ${skill.pluginId}` : ''} · ${clip(skill.description.replace(/\s+/g, ' '), 54)}`,
      value: skill.id,
    }))
  }

  private detailRows(height = this.lastHeight): Row[] {
    if (this.mode === 'plugins') {
      const plugin = this.filteredPlugins()[this.selected]
      if (!plugin) return []
      const s = stateLabel(plugin)
      return [
        { label: 'State', secondary: s.text },
        { label: 'Marketplace', secondary: plugin.marketplace },
        { label: 'Version', secondary: plugin.version ?? 'unknown' },
        { label: 'Revision', secondary: plugin.revision ? plugin.revision.slice(0, 12) : 'not recorded' },
        { label: 'Digest', secondary: digestShort(plugin.digest) },
        { label: 'Trust', secondary: plugin.trust ? plugin.trust : 'not recorded' },
        { label: 'Path', secondary: plugin.installPath ?? 'unknown' },
        { label: 'Components', secondary: `${plugin.components.commands} commands · ${plugin.components.agents} agents · ${plugin.components.skills} skills · ${plugin.components.mcp} MCP · ${plugin.components.hooks} hooks` },
        ...(plugin.error ? [{ label: 'Failure', secondary: plugin.error }] : []),
      ]
    }
    if (this.mode === 'marketplaces') {
      const marketplace = this.filteredMarketplaces()[this.selected]
      if (!marketplace) return []
      if (height <= 20) {
        // At 60x20 the plugin list is more useful than verbose metadata.
        // Keep the trust/provenance fields that matter (source, revision,
        // digest) and let the 80x24 view expose owner/about details.
        return [
          { label: 'Source', secondary: sourceLabel(marketplace.source) },
          { label: 'Status', secondary: marketplace.status },
          { label: 'Revision', secondary: marketplace.revision ? marketplace.revision.slice(0, 12) : 'not recorded' },
          { label: 'Digest', secondary: digestShort(marketplace.digest) },
        ]
      }
      return [
        { label: 'Owner', secondary: marketplace.owner },
        { label: 'Source', secondary: sourceLabel(marketplace.source) },
        { label: 'Status', secondary: marketplace.status },
        { label: 'Plugins', secondary: `${marketplace.plugins.length} available` },
        { label: 'Updated', secondary: marketplace.lastUpdated ? new Date(marketplace.lastUpdated).toLocaleString() : 'never' },
        { label: 'Revision', secondary: marketplace.revision ? marketplace.revision.slice(0, 12) : 'not recorded' },
        { label: 'Digest', secondary: digestShort(marketplace.digest) },
        ...(marketplace.description ? [{ label: 'About', secondary: marketplace.description }] : []),
      ]
    }
    const skill = this.filteredSkills()[this.selected]
    if (!skill) return []
    const details = this.selectedSkillDetails
    return [
      { label: 'Description', secondary: skill.description },
      { label: 'Source', secondary: skill.source },
      ...(skill.securityStatus ? [{ label: 'Security', secondary: skill.securityStatus }] : []),
      ...(skill.pluginId ? [{ label: 'Plugin', secondary: skill.pluginId }] : []),
      ...(skill.version ? [{ label: 'Version', secondary: skill.version }] : []),
      ...(details ? [{ label: 'SHA-256', secondary: digestShort(details.sha256) }, { label: 'Path', secondary: details.path }, ...(details.warnings.length ? [{ label: 'Warnings', secondary: `${details.warnings.length} frontmatter warning(s)` }] : [])] : [{ label: 'Path', secondary: 'press Enter to load details' }]),
    ]
  }

  render(width: number, height: number): string[] {
    this.lastHeight = height
    const theme = this.theme
    const capability = this.capability
    const RESET = '\x1b[0m'
    const DIM = '\x1b[2m'
    const BOLD = '\x1b[1m'
    const WHITE = foreground(theme.text, capability)
    const CYAN = foreground(theme.primary, capability)
    const GREEN = foreground(theme.success, capability)
    const YELLOW = foreground(theme.warning, capability)
    const RED = foreground(theme.error, capability)
    const BG = background(theme.background, capability)
    const BG2 = background(theme.panel, capability)
    const BORDER = foreground(theme.border, capability)
    const SELECT = background(theme.selection, capability)
    const rows: string[] = []
    const inner = Math.max(20, width - 4)
    const title = this.mode === 'plugins' ? 'Plugin manager' : this.mode === 'marketplaces' ? 'Marketplace browser' : 'Skill browser'
    const counts = this.mode === 'plugins'
      ? `${this.snapshot.plugins.filter(p => p.status === 'installed').length} installed · ${this.snapshot.plugins.filter(p => p.enabled !== false && p.status === 'installed').length} enabled · ${this.snapshot.plugins.filter(p => p.enabled === false && p.status === 'installed').length} disabled`
      : this.mode === 'marketplaces'
        ? `${this.snapshot.marketplaces.length} marketplaces`
        : `${this.snapshot.skills.length} skills`

    const line = (content: string, bg = BG2) => {
      const plain = widthOf(content.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ''))
      return `${bg}${content}${RESET}${bg}${' '.repeat(Math.max(0, width - plain))}${RESET}`
    }
    rows.push(padRow(`${BG}${BOLD}${WHITE}  ◆ ${title}${RESET}${BG}`, width))
    rows.push(line(`${BORDER}│${RESET}  ${DIM}${counts}${this.query ? ` · filter: ${clip(this.query, 36)}` : ''}${this.mode === 'marketplaces' && this.view === 'detail' && this.pluginSearch ? ` · plugin filter: ${clip(this.pluginSearch, 28)}` : ''}${RESET}`))
    rows.push(line(`${BORDER}│${RESET}  ${this.mode === 'plugins' ? 'Installed components and activation state.' : this.mode === 'marketplaces' ? 'Browse registered sources and their available plugins.' : 'Search and inspect discovered skills.'}`))
    rows.push(line(`${BORDER}│${RESET}`))

    if (this.view === 'list') {
      const list = this.rows()
      const maxVisible = Math.max(3, Math.min(8, height - 10))
      const start = list.length <= maxVisible ? 0 : Math.min(Math.max(0, this.selected - Math.floor(maxVisible / 2)), list.length - maxVisible)
      const visible = list.slice(start, start + maxVisible)
      if (!visible.length) rows.push(line(`${BORDER}│${RESET}  ${DIM}${this.busy ? 'Refreshing…' : this.query ? 'No matches.' : 'Nothing found.'}${RESET}`))
      for (let i = 0; i < visible.length; i++) {
        const absolute = start + i
        const selected = absolute === this.selected
        const marker = selected ? `${GREEN}›${RESET}` : ' '
        const primary = clip(visible[i]!.label, Math.max(12, Math.floor(inner * 0.42)))
        const secondary = clip(visible[i]!.secondary ?? '', Math.max(18, inner - widthOf(primary) - 7))
        rows.push(line(`${BORDER}│${RESET} ${marker} ${selected ? BOLD : ''}${primary}${RESET}${secondary ? ` ${DIM}${secondary}${RESET}` : ''}`, selected ? SELECT : BG2))
      }
      if (list.length > maxVisible) rows.push(line(`${BORDER}│${RESET}  ${DIM}${start + 1}-${Math.min(list.length, start + maxVisible)} of ${list.length}${this.query ? ` · ${list.length} match${list.length === 1 ? '' : 'es'}` : ''}${RESET}`))
    } else if (this.view === 'confirm-trust') {
      const target = this.trustTarget
      const marketplace = target ? this.snapshot.marketplaces.find(m => m.name === target.marketplace) : undefined
      const entry = marketplace?.plugins.find(p => p.name === target?.plugin)
      rows.push(line(`${BORDER}│${RESET}  ${YELLOW}${BOLD}Trust confirmation${RESET}`))
      rows.push(line(`${BORDER}│${RESET}`))
      rows.push(line(`${BORDER}│${RESET}  ${YELLOW}⚠${RESET} ${BOLD}${clip(target?.action === 'update' ? 'Update plugin?' : 'Install plugin?', inner - 8)}${RESET}`))
      if (target) rows.push(line(`${BORDER}│${RESET}  Plugin: ${BOLD}${clip(`${target.plugin}@${target.marketplace}`, inner - 12)}${RESET}`))
      if (entry) rows.push(line(`${BORDER}│${RESET}  Source: ${clip(pluginSourceLabel(entry), inner - 12)}`))
      rows.push(line(`${BORDER}│${RESET}`))
      rows.push(line(`${BORDER}│${RESET}  ${DIM}Plugins may provide commands, agents, skills, MCP${RESET}`))
      rows.push(line(`${BORDER}│${RESET}  ${DIM}servers, and hooks that affect this TermAgent session.${RESET}`))
      rows.push(line(`${BORDER}│${RESET}  ${DIM}Only continue when you trust this source.${RESET}`))
    } else if (this.view === 'confirm-remove') {
      const target = this.removeTarget
      rows.push(line(`${BORDER}│${RESET}  ${RED}${BOLD}Confirm removal${RESET}`))
      rows.push(line(`${BORDER}│${RESET}`))
      if (target?.marketplaceRemove) {
        rows.push(line(`${BORDER}│${RESET}  Remove marketplace ${BOLD}${clip(target.marketplace, inner - 20)}${RESET}?`))
        rows.push(line(`${BORDER}│${RESET}  ${DIM}This also removes its installed plugins from the marketplace state.${RESET}`))
      } else if (target) {
        rows.push(line(`${BORDER}│${RESET}  Remove plugin ${BOLD}${clip(`${target.plugin}@${target.marketplace}`, inner - 20)}${RESET}?`))
        rows.push(line(`${BORDER}│${RESET}  ${DIM}The installed plugin files will be removed.${RESET}`))
      }
    } else if (this.view === 'detail' && this.mode === 'marketplaces' && this.marketplacePluginDetail) {
      const marketplace = this.currentMarketplace()
      const entry = this.currentMarketplacePluginRows()[this.marketplacePluginSelected]
      const subject = entry ? `${entry.name}@${marketplace?.name ?? ''}` : 'Plugin details'
      rows.push(line(`${BORDER}│${RESET}  ${BOLD}${clip(subject, inner - 4)}${RESET}`))
      rows.push(line(`${BORDER}│${RESET}`))
      if (marketplace && entry) {
        for (const item of this.pluginDetailRows(entry, marketplace)) {
          const key = clip(item.label, 13).padEnd(13, ' ')
          rows.push(line(`${BORDER}│${RESET}  ${CYAN}${key}${RESET} ${clip(item.secondary ?? '', inner - 18)}`))
        }
        rows.push(line(`${BORDER}│${RESET}`))
        const installed = this.snapshot.plugins.find(p => p.id === `${entry.name}@${marketplace.name}`)
        if (installed?.status === 'installed') {
          rows.push(line(`${BORDER}│${RESET}  ${DIM}Already installed. Use Esc to return.${RESET}`))
        } else {
          rows.push(line(`${BORDER}│${RESET}  ${GREEN}Press Enter or i to install${RESET}`))
        }
      }
    } else {
      const subject = this.mode === 'plugins' ? this.filteredPlugins()[this.selected]?.plugin : this.mode === 'marketplaces' ? this.filteredMarketplaces()[this.selected]?.name : this.filteredSkills()[this.selected]?.id
      rows.push(line(`${BORDER}│${RESET}  ${BOLD}${clip(subject ?? 'Details', inner - 4)}${RESET}`))
      rows.push(line(`${BORDER}│${RESET}`))
      for (const item of this.detailRows(height)) {
        const key = clip(item.label, 13).padEnd(13, ' ')
        rows.push(line(`${BORDER}│${RESET}  ${CYAN}${key}${RESET} ${clip(item.secondary ?? '', inner - 18)}`))
      }

      if (this.mode === 'marketplaces') {
        const marketplace = this.filteredMarketplaces()[this.selected]
        if (marketplace) {
          rows.push(line(`${BORDER}│${RESET}`))
          const installed = new Map(this.snapshot.plugins.map(p => [p.id, p]))
          const allEntries = this.marketplacePluginRows(marketplace)
          rows.push(line(`${BORDER}│${RESET}  ${BOLD}Available plugins · ${allEntries.length}${this.pluginSearch ? ' matches' : ''}${RESET}`))
          const pluginMax = 6
          const pluginStart = allEntries.length <= pluginMax ? 0 : Math.min(Math.max(0, this.marketplacePluginSelected - Math.floor(pluginMax / 2)), allEntries.length - pluginMax)
          const entries = allEntries.slice(pluginStart, pluginStart + pluginMax)
          for (let i = 0; i < entries.length; i++) {
            const absolute = pluginStart + i
            const entry = entries[i]!
            const state = installed.get(`${entry.name}@${marketplace.name}`)
            const status = state?.status === 'installed' ? (state.enabled === false ? 'disabled' : 'installed') : 'available'
            const selected = absolute === this.marketplacePluginSelected
            rows.push(line(`${BORDER}│${RESET} ${selected ? GREEN + '›' + RESET : ' '} ${selected ? BOLD : ''}${clip(entry.name, 26)}${RESET} ${DIM}${clip(status, 14)}${RESET}`, selected ? SELECT : BG2))
          }
          if (allEntries.length > entries.length) rows.push(line(`${BORDER}│${RESET}    ${DIM}${pluginStart + 1}-${pluginStart + entries.length} of ${allEntries.length}${this.pluginSearch ? ` · ${allEntries.length} matches` : ''}${RESET}`))
        }
      }

      if (this.mode === 'skills' && this.selectedSkillDetails) {
        rows.push(line(`${BORDER}│${RESET}`))
        rows.push(line(`${BORDER}│${RESET}  ${BOLD}Frontmatter${RESET}`))
        for (const [key, value] of Object.entries(this.selectedSkillDetails.frontmatter).slice(0, 5)) rows.push(line(`${BORDER}│${RESET}    ${clip(key, 16)}: ${clip(value, inner - 22)}`))
      }
    }

    if (this.message) {
      const tone = this.messageTone === 'error' ? RED : this.messageTone === 'warn' ? YELLOW : DIM
      rows.push(line(`${BORDER}│${RESET}  ${tone}${clip(this.message, inner - 4)}${RESET}`))
    }

    // Always reserve the final terminal row for the footer. Details can be
    // information-dense, especially at 60x20, so truncate content rather than
    // letting the footer disappear off-screen.
    const contentLimit = Math.max(1, height - 1)
    if (rows.length > contentLimit) {
      rows.length = contentLimit
      rows[contentLimit - 1] = line(`${BORDER}│${RESET}  ${DIM}… details truncated for terminal height${RESET}`)
    }
    while (rows.length < contentLimit) rows.push(line(''))
    const footer = this.view === 'list'
      ? this.searching
        ? `type to filter · Backspace delete · Enter stop · Esc close search`
        : `↑↓ select · Enter details · / search · ${this.mode === 'plugins' ? 'e toggle · r refresh' : this.mode === 'marketplaces' ? 'r refresh' : 'r refresh'} · 1/2/3 switch · Esc close`
      : this.view === 'confirm-trust'
        ? `Enter/y confirm · n/Esc cancel`
        : this.view === 'confirm-remove'
          ? `Enter/y confirm removal · n/Esc cancel`
          : this.mode === 'marketplaces' && this.marketplacePluginDetail
            ? `Enter/i install · Esc back · ↑↓ select`
            : this.mode === 'marketplaces'
              ? `Esc back · ↑↓ select plugin · Enter plugin · / filter plugins · i install · r refresh · d remove`
              : this.mode === 'plugins'
                ? `Esc back · e toggle · u update · x remove`
                : `Esc back · ↑↓ select skill · r reload details`
    rows.push(padRow(`${BG}${DIM}  ${clip(footer, width - 4)}${RESET}${BG}`, width))
    return rows.slice(0, height)
  }

  async handleKey(ch: string): Promise<'close' | 'stay'> {
    if (this.busy) return 'stay'
    if (this.view === 'confirm-trust') {
      if (ch === 'y' || ch === 'Y' || ch === 'enter') {
        const target = this.trustTarget
        if (!target) { this.view = 'list'; return 'stay' }
        this.busy = true
        try {
          await this.callbacks.installPlugin(target.marketplace, target.plugin, true)
          const successMessage = `${target.action === 'update' ? 'Updated' : 'Installed'} ${target.plugin}@${target.marketplace}`
          this.view = 'list'
          await this.refresh(successMessage)
        } catch (error) {
          this.setMessage(error instanceof Error ? error.message : String(error), 'error')
          this.view = 'detail'
        } finally { this.busy = false }
        return 'stay'
      }
      if (ch === 'n' || ch === 'N' || ch === 'escape') { this.view = 'detail'; this.trustTarget = undefined; this.setMessage('Cancelled', 'warn'); return 'stay' }
      return 'stay'
    }
    if (this.view === 'confirm-remove') {
      if (ch === 'y' || ch === 'Y' || ch === 'enter') {
        const target = this.removeTarget
        if (!target) { this.view = 'list'; return 'stay' }
        this.busy = true
        try {
          if (target.marketplaceRemove) await this.callbacks.removeMarketplace(target.marketplace)
          else await this.callbacks.removePlugin(target.marketplace, target.plugin)
          const successMessage = target.marketplaceRemove ? `Removed marketplace ${target.marketplace}` : `Removed ${target.plugin}@${target.marketplace}`
          this.view = 'list'
          await this.refresh(successMessage)
        } catch (error) {
          this.setMessage(error instanceof Error ? error.message : String(error), 'error')
          this.view = 'detail'
        } finally { this.busy = false }
        return 'stay'
      }
      if (ch === 'n' || ch === 'N' || ch === 'escape') { this.view = 'detail'; this.removeTarget = undefined; this.setMessage('Cancelled', 'warn'); return 'stay' }
      return 'stay'
    }

    if (this.searching) {
      if (ch === 'escape' || ch === 'enter') { this.searching = false; this.selected = 0; return 'stay' }
      if (ch === 'backspace') {
        if (this.mode === 'marketplaces' && this.view === 'detail' && !this.marketplacePluginDetail) this.pluginSearch = Array.from(this.pluginSearch).slice(0, -1).join('')
        else this.query = Array.from(this.query).slice(0, -1).join('')
        this.selected = 0
        this.marketplacePluginSelected = 0
        return 'stay'
      }
      if (ch.length === 1 && widthOf(ch) > 0 && ch >= ' ') {
        if (this.mode === 'marketplaces' && this.view === 'detail' && !this.marketplacePluginDetail) this.pluginSearch += ch
        else this.query += ch
        this.selected = 0
        this.marketplacePluginSelected = 0
        return 'stay'
      }
      return 'stay'
    }

    if (ch === 'escape' || ch === 'q') {
      if (this.view === 'detail') {
        if (this.mode === 'marketplaces' && this.marketplacePluginDetail) { this.marketplacePluginDetail = false; return 'stay' }
        this.view = 'list'; this.selectedSkillDetails = undefined; this.pluginSearch = ''; this.marketplacePluginSelected = 0; return 'stay'
      }
      return 'close'
    }
    if (ch === '/' && (this.view === 'list' || (this.view === 'detail' && this.mode === 'marketplaces' && !this.marketplacePluginDetail))) { this.searching = true; return 'stay' }
    if (ch === '1') { this.mode = 'plugins'; this.view = 'list'; this.query = ''; this.pluginSearch = ''; this.selected = 0; this.marketplacePluginDetail = false; return 'stay' }
    if (ch === '2') { this.mode = 'marketplaces'; this.view = 'list'; this.query = ''; this.pluginSearch = ''; this.selected = 0; this.marketplacePluginDetail = false; return 'stay' }
    if (ch === '3') { this.mode = 'skills'; this.view = 'list'; this.query = ''; this.pluginSearch = ''; this.selected = 0; this.marketplacePluginDetail = false; return 'stay' }

    if (this.mode === 'marketplaces' && this.view === 'detail' && !this.marketplacePluginDetail) {
      const marketplace = this.currentMarketplace()
      const plugins = marketplace ? this.marketplacePluginRows(marketplace) : []
      if (ch === 'up' || ch === 'k') { this.marketplacePluginSelected = Math.max(0, this.marketplacePluginSelected - 1); return 'stay' }
      if (ch === 'down' || ch === 'j') { this.marketplacePluginSelected = Math.min(Math.max(0, plugins.length - 1), this.marketplacePluginSelected + 1); return 'stay' }
      if (ch === 'home') { this.marketplacePluginSelected = 0; return 'stay' }
      if (ch === 'end') { this.marketplacePluginSelected = Math.max(0, plugins.length - 1); return 'stay' }
      if (ch === 'enter' || ch === 'd') { if (plugins[this.marketplacePluginSelected]) this.marketplacePluginDetail = true; return 'stay' }
    }
    if (ch === 'up' || ch === 'k') { this.selected = Math.max(0, this.selected - 1); return 'stay' }
    if (ch === 'down' || ch === 'j') { this.selected = Math.min(Math.max(0, this.rows().length - 1), this.selected + 1); return 'stay' }
    if (ch === 'pageup') {
      const page = this.mode === 'marketplaces' && this.view === 'detail' ? 6 : 8
      if (this.mode === 'marketplaces' && this.view === 'detail' && !this.marketplacePluginDetail) this.marketplacePluginSelected = Math.max(0, this.marketplacePluginSelected - page)
      else this.selected = Math.max(0, this.selected - page)
      return 'stay'
    }
    if (ch === 'pagedown') {
      const page = this.mode === 'marketplaces' && this.view === 'detail' ? 6 : 8
      if (this.mode === 'marketplaces' && this.view === 'detail' && !this.marketplacePluginDetail) this.marketplacePluginSelected = Math.min(Math.max(0, this.currentMarketplacePluginRows().length - 1), this.marketplacePluginSelected + page)
      else this.selected = Math.min(Math.max(0, this.rows().length - 1), this.selected + page)
      return 'stay'
    }
    if (ch === 'home') { this.selected = 0; return 'stay' }
    if (ch === 'end') { this.selected = Math.max(0, this.rows().length - 1); return 'stay' }
    if (ch === 'r' && !(this.mode === 'marketplaces' && this.view === 'detail')) { await this.refresh(); return 'stay' }

    if (ch === 'enter') {
      if (this.view === 'list') {
        this.view = 'detail'
        if (this.mode === 'marketplaces') this.marketplacePluginSelected = 0
        if (this.mode === 'skills') {
          const selected = this.filteredSkills()[this.selected]
          if (selected) {
            this.busy = true
            try { this.selectedSkillDetails = await this.callbacks.skillDetails(selected.id) } catch (error) { this.setMessage(error instanceof Error ? error.message : String(error), 'error') }
            finally { this.busy = false }
          }
        }
      }
      if (this.view === 'detail' && this.mode === 'marketplaces' && this.marketplacePluginDetail) {
        const marketplace = this.currentMarketplace()
        const entry = this.currentMarketplacePluginRows()[this.marketplacePluginSelected]
        if (marketplace && entry) {
          const installed = this.snapshot.plugins.find(p => p.id === `${entry.name}@${marketplace.name}`)
          if (installed?.status !== 'installed') {
            this.trustTarget = { marketplace: marketplace.name, plugin: entry.name, action: 'install' }
            this.view = 'confirm-trust'
          } else this.setMessage(`${entry.name} is already installed.`, 'warn')
        }
      }
      return 'stay'
    }

    if (this.mode === 'plugins') {
      const plugin = this.filteredPlugins()[this.selected]
      if (!plugin) return 'stay'
      if (ch === 'e') {
        if (plugin.status !== 'installed') { this.setMessage('Only installed plugins can be enabled or disabled.', 'warn'); return 'stay' }
        try {
          const enabled = plugin.enabled === false
          await this.callbacks.togglePlugin(plugin.marketplace, plugin.plugin, enabled)
          const successMessage = `${enabled ? 'Enabled' : 'Disabled'} ${plugin.plugin}@${plugin.marketplace}. Reload the session to apply component changes.`
          await this.refresh(successMessage)
        } catch (error) { this.setMessage(error instanceof Error ? error.message : String(error), 'error') }
      } else if (ch === 'd' && this.view === 'list') { this.view = 'detail' }
      else if (ch === 'u' && this.view === 'detail') { this.trustTarget = { marketplace: plugin.marketplace, plugin: plugin.plugin, action: 'update' }; this.view = 'confirm-trust' }
      else if (ch === 'x' && this.view === 'detail') { this.removeTarget = { marketplace: plugin.marketplace, plugin: plugin.plugin }; this.view = 'confirm-remove' }
      return 'stay'
    }

    if (this.mode === 'marketplaces') {
      const marketplace = this.currentMarketplace()
      if (!marketplace) return 'stay'
      if (this.view === 'detail' && ch === 'i') {
        const entry = this.currentMarketplacePluginRows()[this.marketplacePluginSelected]
        if (!entry) { this.setMessage('No plugins available in this marketplace.', 'warn'); return 'stay' }
        const installed = this.snapshot.plugins.find(p => p.id === `${entry.name}@${marketplace.name}`)
        if (installed?.status === 'installed') { this.setMessage(`${entry.name} is already installed.`, 'warn'); return 'stay' }
        this.trustTarget = { marketplace: marketplace.name, plugin: entry.name, action: 'install' }; this.view = 'confirm-trust'
      } else if (this.view === 'detail' && ch === 'd') { this.removeTarget = { marketplace: marketplace.name, plugin: '', marketplaceRemove: true }; this.view = 'confirm-remove' }
      else if (this.view === 'detail' && ch === 'r') {
        this.busy = true
        try { await this.callbacks.refreshMarketplace(marketplace.name); this.setMessage(`Refreshed ${marketplace.name}`); await this.refresh() }
        catch (error) { this.setMessage(error instanceof Error ? error.message : String(error), 'error') }
        finally { this.busy = false }
      }
      return 'stay'
    }

    if (this.mode === 'skills') {
      if (this.view === 'detail' && ch === 'r') {
        const skill = this.filteredSkills()[this.selected]
        if (skill) {
          this.busy = true
          try { this.selectedSkillDetails = await this.callbacks.skillDetails(skill.id); this.setMessage('Reloaded skill details') }
          catch (error) { this.setMessage(error instanceof Error ? error.message : String(error), 'error') }
          finally { this.busy = false }
        }
      }
    }
    return 'stay'
  }

  private marketplacePluginRowInfo(): { top: number; start: number; count: number } {
    const marketplace = this.currentMarketplace()
    if (!marketplace) return { top: 0, start: 0, count: 0 }
    const allEntries = this.marketplacePluginRows(marketplace)
    const max = 6
    const start = allEntries.length <= max ? 0 : Math.min(Math.max(0, this.marketplacePluginSelected - Math.floor(max / 2)), allEntries.length - max)
    return { top: 9 + this.detailRows(this.lastHeight).length, start, count: Math.min(max, allEntries.length - start) }
  }

  async mouseClick(row: number, button = 0): Promise<'close' | 'stay'> {
    if (button === 64 || button === 65) {
      const delta = button === 64 ? -3 : 3
      if (this.view === 'detail' && this.mode === 'marketplaces' && !this.marketplacePluginDetail) {
        const total = this.currentMarketplacePluginRows().length
        this.marketplacePluginSelected = Math.min(Math.max(0, total - 1), Math.max(0, this.marketplacePluginSelected + delta))
      } else {
        this.selected = Math.min(Math.max(0, this.rows().length - 1), Math.max(0, this.selected + delta))
      }
      return 'stay'
    }
    if (button !== 0) return 'stay'
    if (this.view === 'detail' && this.mode === 'marketplaces' && !this.marketplacePluginDetail) {
      const info = this.marketplacePluginRowInfo()
      const index = info.start + row - info.top
      const total = this.currentMarketplacePluginRows().length
      if (row >= info.top && row < info.top + info.count && index >= 0 && index < total) {
        this.marketplacePluginSelected = index
        this.marketplacePluginDetail = true
        return 'stay'
      }
      return 'stay'
    }
    if (this.view !== 'list') return 'stay'
    const index = row - this.getSelectedRowTop()
    if (index >= 0 && index < this.rows().length) {
      this.selected = index
      return this.handleKey('enter')
    }
    return 'stay'
  }
}
