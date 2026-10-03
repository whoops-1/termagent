import type { Provider, ProviderConfig, StreamEvent } from './types.js'
import type { ChatMessage } from '../session/store.js'
import type { ToolRegistry } from '../tools/registry.js'
import { isRetryableError } from '../agent/retry.js'
import { chooseSmartRoute, type SmartRoutingConfig, type RoutingDecision } from '../agent/smart-routing.js'

type RoleMap=Partial<Record<string,Provider[]>>
export interface ProviderSelection { provider:Provider; config:ProviderConfig }

export class ProviderRouter implements Provider {
  readonly id='router'
  readonly model:string
  readonly config:any
  private role='default'
  private turnNumber=0
  private decision:RoutingDecision|null=null

  constructor(private providers:Provider[],private onSwitch?:(from:string,to:string,reason:string)=>void,private roles:RoleMap={},private smartRouting?:SmartRoutingConfig){
    if(!providers.length&&!Object.values(roles).some(x=>x?.length))throw new Error('No providers configured')
    const first=providers[0]||Object.values(roles).flat().find(Boolean)!
    this.model=first.model;this.config=first.config
  }
  setRole(role:string){this.role=role||'default'}
  setTurnContext(input:{userText:string;turnNumber?:number;hasNonTextContent?:boolean}){
    this.turnNumber=input.turnNumber??(this.turnNumber+1)
    this.decision=this.smartRouting?chooseSmartRoute({...input,turnNumber:this.turnNumber},this.smartRouting):null
  }
  routingDecision(){return this.decision}
  private candidates(role=this.role):Provider[]{
    let preferred=this.roles[role]||this.roles.default||[]
    if(this.decision && (role==='default'||role==='build') && !this.roles[role]?.length){
      const smart=this.roles[this.decision.complexity]
      if(smart?.length)preferred=smart
    }
    const seen=new Set<string>();const out:Provider[]=[]
    for(const p of [...preferred,...this.providers]){const key=`${p.id||''}:${p.model||''}:${p.config?.baseUrl||''}`;if(!seen.has(key)){seen.add(key);out.push(p)}}
    return out
  }
  select(role='subagent'):ProviderSelection{
    const selected=this.candidates(role)[0];if(!selected)throw new Error(`No provider configured for role ${role}`)
    const cfg=selected.config||{provider:selected.id,model:selected.model,baseUrl:'',apiKey:undefined}
    return {provider:selected,config:{...cfg,provider:cfg.provider||selected.id,model:selected.model}}
  }
  async *stream(messages:ChatMessage[],tools:ReturnType<ToolRegistry['schemas']>,signal:AbortSignal):AsyncGenerator<StreamEvent>{
    let last:any;const candidates=this.candidates()
    for(const [i,current] of candidates.entries()){
      let emitted=false
      try{for await(const event of current.stream(messages,tools,signal)){emitted=true;yield event}return}
      catch(e){
        last=e;const message=String((e as Error).message||e)
        const permanent=/\b(?:400|401|402|403|404|422)\b/.test(message)&&!/429/.test(message)
        if(signal.aborted||emitted||permanent||(!isRetryableError(e)&&!/^(?:down|temporary|unavailable|network)/i.test(message))||i+1>=candidates.length)throw e
        const next=candidates[i+1]!;this.onSwitch?.(current.id,next.id,message.slice(0,300))
      }
    }
    throw last
  }
}
