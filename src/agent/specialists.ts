export type SpecialistRoleName = 'general' | 'researcher' | 'planner' | 'coder' | 'reviewer' | 'tester'

export interface SpecialistRole {
  name: SpecialistRoleName
  description: string
  prompt: string
  allowedTools: readonly string[]
  readOnly: boolean
  allowShell: boolean
  allowWrite: boolean
  maxRounds: number
}

const READ_TOOLS = ['read_file', 'grep', 'glob', 'repo_map'] as const

export const SPECIALIST_ROLES: Record<SpecialistRoleName, SpecialistRole> = {
  general: {
    name: 'general',
    description: 'General focused child task constrained by the parent tool policy.',
    prompt: 'You are a focused specialist. Complete only the assigned task, inspect before acting, and return a compact factual report with findings, changes, verification, and remaining work.',
    allowedTools: [],
    readOnly: false,
    allowShell: false,
    allowWrite: false,
    maxRounds: 80,
  },
  researcher: {
    name: 'researcher',
    description: 'Read-only codebase researcher for locating and understanding relevant implementation.',
    prompt: 'You are the RESEARCHER. Explore the relevant code and documentation, cite concrete file paths and symbols, distinguish facts from inference, and do not modify files or run arbitrary commands.',
    allowedTools: READ_TOOLS,
    readOnly: true,
    allowShell: false,
    allowWrite: false,
    maxRounds: 10,
  },
  planner: {
    name: 'planner',
    description: 'Read-only planner that turns findings into a concrete implementation and verification plan.',
    prompt: 'You are the PLANNER. Inspect the repository, then produce a concise ordered plan naming files, functions, risks, dependencies, and tests. Do not edit files or run shell commands.',
    allowedTools: READ_TOOLS,
    readOnly: true,
    allowShell: false,
    allowWrite: false,
    maxRounds: 10,
  },
  coder: {
    name: 'coder',
    description: 'Focused implementation specialist with file mutation tools but no arbitrary shell access.',
    prompt: 'You are the CODER. Implement exactly the assigned change. Inspect before editing, keep the diff minimal, preserve existing architecture, and run only the verification mechanism explicitly provided by the parent.',
    allowedTools: ['read_file', 'grep', 'glob', 'repo_map', 'write_file', 'edit_file', 'apply_patch', 'verify_project'],
    readOnly: false,
    allowShell: false,
    allowWrite: true,
    maxRounds: 12,
  },
  reviewer: {
    name: 'reviewer',
    description: 'Read-only change reviewer for bugs, regressions, and edge cases.',
    prompt: 'You are the REVIEWER. Inspect the specified implementation or diff and report critical issues, warnings, and notable edge cases with file and symbol references. Do not modify files or run shell commands.',
    allowedTools: READ_TOOLS,
    readOnly: true,
    allowShell: false,
    allowWrite: false,
    maxRounds: 10,
  },
  tester: {
    name: 'tester',
    description: 'Verification specialist restricted to the project verification tool instead of arbitrary shell.',
    prompt: 'You are the TESTER. Inspect the relevant code and run project verification through verify_project. Diagnose failures precisely and return a compact verification report. Do not modify files or invoke arbitrary shell commands.',
    allowedTools: ['read_file', 'grep', 'glob', 'repo_map', 'verify_project'],
    readOnly: true,
    allowShell: true,
    allowWrite: false,
    maxRounds: 10,
  },
}

export function specialistRole(name?: string): SpecialistRole {
  const key = String(name || 'general').trim().toLowerCase() as SpecialistRoleName
  return SPECIALIST_ROLES[key] || SPECIALIST_ROLES.general
}

export function specialistRoleNames(): SpecialistRoleName[] {
  return Object.keys(SPECIALIST_ROLES) as SpecialistRoleName[]
}

export function restrictSpecialistTools(roleName: string, parentAllowedTools: readonly string[]): string[] {
  const role = specialistRole(roleName)
  if (!role.allowedTools.length) return [...new Set(parentAllowedTools)]
  const parent = new Set(parentAllowedTools)
  return role.allowedTools.filter(tool => parent.has(tool))
}

export function validateSpecialistRole(roleName: string): SpecialistRole {
  const role = specialistRole(roleName)
  if (role.name !== String(roleName || 'general').trim().toLowerCase()) {
    throw new Error(`Unknown specialist role '${roleName}'. Available roles: ${specialistRoleNames().join(', ')}`)
  }
  return role
}
