export type SmartRoutingConfig = {
  enabled: boolean
  simpleModel: string
  strongModel: string
  simpleMaxChars?: number
  simpleMaxWords?: number
}

export type RoutingDecision = {
  model: string
  complexity: 'simple' | 'strong'
  reason: string
}

const STRONG_KEYWORDS = [
  'plan','design','architect','architecture','refactor','debug','investigate','analyze','analyse',
  'implement','optimize','optimise','review','audit','diagnose','root cause','root-cause','why does',
  'why is','how should','why did','propose','trace','reproduce',
]
const STRONG_RE = new RegExp(`\\b(?:${STRONG_KEYWORDS.map(k=>k.replace(/[.*+?^${}()|[\]\\]/g,'\\$&').replace(/[- ]/g,'[-\\s]')).join('|')})\\b`,'i')
const CODE_RE = /```[\s\S]*?```|`[^`\n]+`/

function words(text:string){const x=text.trim();return x?x.split(/\s+/).length:0}

export function chooseSmartRoute(input:{userText:string;hasNonTextContent?:boolean;turnNumber?:number},config:SmartRoutingConfig):RoutingDecision{
  const strong=()=>({model:config.strongModel,complexity:'strong' as const,reason:''})
  if(!config.enabled)return {...strong(),reason:'smart routing disabled'}
  if(!config.simpleModel||!config.strongModel)return {...strong(),reason:'simpleModel or strongModel missing'}
  if(config.simpleModel===config.strongModel)return {...strong(),reason:'simpleModel equals strongModel'}
  const text=input.userText?.trim()||''
  if(input.hasNonTextContent)return {...strong(),reason:'contains non-text content'}
  if(input.turnNumber===1)return {...strong(),reason:'first turn of session'}
  if(CODE_RE.test(text))return {...strong(),reason:'contains code block or inline code'}
  if(STRONG_RE.test(text))return {...strong(),reason:'contains reasoning/planning keyword'}
  if(/\n\s*\n/.test(text))return {...strong(),reason:'multi-paragraph input'}
  const maxChars=config.simpleMaxChars??160
  const maxWords=config.simpleMaxWords??28
  if(text.length>maxChars)return {...strong(),reason:`input > ${maxChars} chars`}
  if(words(text)>maxWords)return {...strong(),reason:`input > ${maxWords} words`}
  return {model:config.simpleModel,complexity:'simple',reason:`short (${text.length} chars, ${words(text)} words)`}
}
