import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { ToolDefinition } from './types.js'
import { formatSkillSearchResults, searchSkills } from '../skills/discovery.js'
import { boundSkillContent, loadSkill } from '../skills/invoker.js'
import { estimateTokens } from '../context/budget.js'

export type SkillEvent = {
  action: 'search' | 'load' | 'skip'
  signal?: string
  query?: string
  id?: string
  reason?: string
  relevance?: number
  resultCount?: number
  sha256?: string
}

export interface SkillToolOptions { maxBodyTokens?: number }

export function skillTools(onEvent?: (sessionID: string, event: SkillEvent) => Promise<void> | void, options: SkillToolOptions = {}): ToolDefinition[] {
  const search_skills: ToolDefinition = {
    name: 'search_skills',
    risk: 'read',
    description: 'Search available skills by intent. Returns compact descriptor metadata and relevance only; never loads SKILL.md content.',
    schema: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1 },
        limit: { type: 'integer', minimum: 1, maximum: 12 },
        threshold: { type: 'number', minimum: 0, maximum: 1 },
        signal: { type: 'string', enum: ['explicit', 'user_input', 'assistant_turn', 'write_pivot', 'subagent_spawn'] },
      },
      required: ['query'],
    },
    async execute(args, ctx) {
      const query = String(args?.query || '').trim()
      if (!query) throw new Error('search_skills requires a non-empty query')
      const results = await searchSkills(ctx.cwd, query, { limit: Number(args?.limit || 8), threshold: args?.threshold === undefined ? undefined : Number(args.threshold) })
      const signal = args?.signal ? String(args.signal) : 'explicit'
      await onEvent?.(ctx.sessionID, { action: 'search', signal, query, resultCount: results.length })
      if (results.length === 0) {
        await onEvent?.(ctx.sessionID, { action: 'skip', signal, query, reason: 'no-match', resultCount: 0 })
      }
      return {
        title: `skill search · ${results.length}`,
        output: JSON.stringify({ query, signal, skills: results }),
        metadata: { skillDiscovery: true, signal },
      }
    },
  }

  const use_skill: ToolDefinition = {
    name: 'skill',
    risk: 'read',
    description: 'Load one exact skill by name. Returns bounded SKILL.md instructions plus a sampled resource list only after explicit invocation.',
    schema: {
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 1 },
      },
      required: ['name'],
    },
    async execute(args, ctx) {
      const name = String(args?.name || '').trim()
      if (!name) throw new Error('use_skill requires a skill name')
      try {
        const loaded = await loadSkill(ctx.cwd, name)
        const directory=path.dirname(loaded.path)
        let resources:string[]=[]
        try { resources=(await fs.readdir(directory,{withFileTypes:true})).map((entry:{name:string})=>entry.name).filter((file:string)=>file!=='SKILL.md').sort().slice(0,10) } catch {}
        await onEvent?.(ctx.sessionID, { action: 'load', id: loaded.descriptor.id, sha256: loaded.sha256, resultCount: 1 })
        const maxTokens=Math.max(128,Math.floor(options.maxBodyTokens ?? 2048))
        const resourceText=resources.length ? `\n\nBase directory: ${directory}\nResource files (sample):\n${resources.map(file=>`- ${file}`).join('\n')}` : `\n\nBase directory: ${directory}`
        const wrapper=`<skill_content name="${loaded.descriptor.id}">\n\n${resourceText}\n</skill_content>`
        const bodyBudget=Math.max(96,maxTokens-estimateTokens(wrapper)-8)
        const body=boundSkillContent(loaded.content,bodyBudget)
        return {
          title: `skill · ${loaded.descriptor.id}`,
          output: `<skill_content name="${loaded.descriptor.id}">\n${body}${resourceText}\n</skill_content>`,
          metadata: { skill:{id: loaded.descriptor.id,sha256: loaded.sha256,path: loaded.path,resourceCount: resources.length,resources}, skillId: loaded.descriptor.id, sha256: loaded.sha256, path: loaded.path, preserveOutput: true },
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        await onEvent?.(ctx.sessionID, { action: 'skip', id: name, reason })
        throw error
      }
    },
  }

  const legacy_use_skill: ToolDefinition = { ...use_skill, name: 'use_skill', description: 'Compatibility alias for the native skill tool.' }
  return [search_skills, use_skill, legacy_use_skill]
}

export { formatSkillSearchResults }
