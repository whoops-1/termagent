import crypto from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { loadSkillCatalog, type SkillDescriptor } from './catalog.js'
import { within } from '../util/fs.js'
import { getSkillRegistryInstallRoot } from './registry.js'
import { scanSkillContent } from './security.js'
import { getSkillRegistryRevocationState } from './registry.js'
import { truncateAroundTokenBudget } from '../context/budget.js'

export type SkillInvocation = {
  descriptor: SkillDescriptor
  path: string
  sha256: string
  content: string
}

function digest(content: string): string {
  return `sha256:${crypto.createHash('sha256').update(content).digest('hex')}`
}

function normalizeId(id: string): string {
  const trimmed = id.trim()
  return trimmed.startsWith('/') ? trimmed.slice(1) : trimmed
}

export function boundSkillContent(content: string, maxTokens = 2048): string {
  return truncateAroundTokenBudget(content, Math.max(128, Math.floor(maxTokens)))
}

export async function loadSkill(cwd: string, id: string, options: { requireUserInvocable?: boolean } = {}): Promise<SkillInvocation> {
  const normalized = normalizeId(id)
  if (!normalized) throw new Error('Skill name is required')

  const catalog = await loadSkillCatalog(cwd)
  const details = catalog.get(normalized)
  if (!details) throw new Error(`Unknown skill: ${normalized}`)
  if (options.requireUserInvocable && details.userInvocable === false) {
    throw new Error(`Skill ${normalized} cannot be invoked directly by the user`)
  }
  if (details.disableModelInvocation) {
    throw new Error(`Skill ${normalized} is disabled for model invocation`)
  }
  if (details.source === 'registry') {
    const revocation = await getSkillRegistryRevocationState({ id: details.id, version: details.version || '0.0.0', sha256: details.sha256 })
    if (revocation.revoked) throw new Error(`Skill ${normalized} is revoked${revocation.reason ? `: ${revocation.reason}` : ''}`)
  }

  const realRoot = await fs.realpath(details.root).catch(() => null)
  const realPath = await fs.realpath(details.path).catch(() => null)
  if (!realRoot || !realPath || !within(realRoot, realPath)) {
    throw new Error(`Skill ${normalized} resolves outside its configured root`)
  }
  if (details.source === 'registry') {
    const registryRoot = await fs.realpath(getSkillRegistryInstallRoot()).catch(() => null)
    if (!registryRoot || !within(registryRoot, realRoot)) {
      throw new Error(`Skill ${normalized} resolves outside the pure registry install root`)
    }
  }
  const stat = await fs.stat(realPath)
  if (!stat.isFile()) throw new Error(`Skill ${normalized} is not a regular file`)
  if (path.basename(realPath) !== 'SKILL.md') throw new Error(`Skill ${normalized} does not resolve to SKILL.md`)

  const content = await fs.readFile(realPath, 'utf8')
  const security = scanSkillContent(content)
  if (security.status === 'blocked') {
    throw new Error(`Skill ${normalized} is blocked by content security policy (${security.findings.map(f => `${f.code} line ${f.line}`).join(', ')})`)
  }
  const actualDigest = digest(content)
  if (actualDigest !== details.sha256) {
    throw new Error(`Skill ${normalized} changed after discovery (digest mismatch: expected ${details.sha256}, got ${actualDigest})`)
  }

  return { descriptor: details, path: realPath, sha256: actualDigest, content }
}
