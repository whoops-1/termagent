import type { Provider } from '../providers/openai-compatible.js'
import type { ToolRegistry } from '../tools/registry.js'
import { SessionStore } from '../session/store.js'
import { Agent } from './agent.js'

export async function runTask(provider:Provider, tools:ToolRegistry, store:SessionStore, cwd:string, prompt:string, parent:string){
  const meta=await store.create(cwd,'subagent')
  const agent=new Agent(provider,tools,store,8)
  const messages:any[]=[]
  return agent.run({sessionId:meta.id,messages,cwd,instructions:`You are a focused subagent. Parent session: ${parent}. Complete only the assigned task and return concise findings.`,onText:(s:string)=>process.stdout.write(s),prompt} as any)
}
