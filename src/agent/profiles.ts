export type AgentMode = 'build' | 'plan' | 'explore'

export interface AgentProfile {
  name: AgentMode
  description: string
  allowWrite: boolean
  allowShell: boolean
  maxRounds: number
}

export const AGENT_PROFILES: Record<AgentMode, AgentProfile> = {
  build: { name: 'build', description: 'Full development agent with file edits and shell access.', allowWrite: true, allowShell: true, maxRounds: 0 },
  plan: { name: 'plan', description: 'Read-only analysis agent. It can inspect the project but cannot edit files or run shell commands.', allowWrite: false, allowShell: false, maxRounds: 0 },
  explore: { name: 'explore', description: 'Fast read-only exploration agent for locating and understanding code.', allowWrite: false, allowShell: false, maxRounds: 0 },
}

export function profileFor(name?: string): AgentProfile {
  return AGENT_PROFILES[(name as AgentMode) || 'build'] || AGENT_PROFILES.build
}
