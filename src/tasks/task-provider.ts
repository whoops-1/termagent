import type { Provider } from '../providers/openai-compatible.js'
import type { ProviderConfig } from '../providers/types.js'
import { ProviderRouter } from '../providers/router.js'

export function persistedSubagentConfigForTask(provider:Provider,fallback?:ProviderConfig):ProviderConfig & {provider:string} {
  const selected=provider instanceof ProviderRouter ? provider.select('subagent') : {provider,config:provider.config||fallback}
  const cfg=selected.config
  if(!cfg?.baseUrl)throw new Error(`Provider ${selected.provider.id} has no base URL for a child task`)
  const {apiKey: _apiKey,...safe}=cfg
  return {...safe,apiKeyEnv:cfg.apiKeyEnv,provider:cfg.provider||selected.provider.id,model:selected.provider.model,baseUrl:cfg.baseUrl}
}
