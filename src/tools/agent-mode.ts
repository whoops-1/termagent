import type { ToolDefinition } from './types.js'
import { AGENT_PROFILES } from '../agent/profiles.js'

export function agentModeTool(getMode:()=>string,setMode:(mode:string)=>void):ToolDefinition {
  return { name:'agent_mode', description:'Switch the current session agent mode between build, plan, and explore. Plan/explore are read-only.', risk:'read', schema:{type:'object',properties:{mode:{type:'string',enum:Object.keys(AGENT_PROFILES)}},required:['mode']}, async execute(args){const mode=String(args.mode);if(!AGENT_PROFILES[mode as keyof typeof AGENT_PROFILES])throw new Error(`Unknown agent mode: ${mode}`);setMode(mode);return {output:`agent mode: ${mode} - ${AGENT_PROFILES[mode as keyof typeof AGENT_PROFILES].description}`}} }
}
