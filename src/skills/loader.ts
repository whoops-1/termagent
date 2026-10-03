import type { SkillDescriptor, SkillDetails } from './catalog.js'
import { formatSkillDescriptors, getSkillDetails, loadSkillCatalog } from './catalog.js'

export type Skill = SkillDescriptor

/** Descriptor-only compatibility wrapper. Full SKILL.md bodies are no longer loaded here. */
export async function loadSkills(cwd: string): Promise<SkillDescriptor[]> {
  return (await loadSkillCatalog(cwd)).list()
}

/** Descriptor-only compatibility wrapper. Full skill content is intentionally not searched. */
export function selectSkills(skills: SkillDescriptor[], query: string, max = 3): SkillDescriptor[] {
  const words = new Set(query.toLowerCase().split(/[^a-z0-9:@.-]+/).filter(value => value.length > 2))
  return skills
    .map(skill => ({
      skill,
      score: [skill.id, skill.name, skill.description].join(' ').toLowerCase().split(/[^a-z0-9:@.-]+/).filter(word => words.has(word)).length,
    }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || a.skill.id.localeCompare(b.skill.id))
    .slice(0, max)
    .map(item => item.skill)
}

/** Formats compact descriptors only. It never includes SKILL.md body content. */
export function formatSkills(skills: SkillDescriptor[], maxChars = 8000): string {
  return formatSkillDescriptors(skills, maxChars)
}

export type { SkillDescriptor, SkillDetails }
export { getSkillDetails }
