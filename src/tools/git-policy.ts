export type GitRisk='read-only'|'mutation'|'destructive'|'sensitive'

export interface GitAnalysis {
  subcommand:string
  operation:string
  risk:GitRisk
  destructive:boolean
  forced:boolean
  affectedPaths:string[]
  summary:string
}

const READ_COMMANDS=new Set(['status','diff','log','show','branch','tag','remote','rev-parse','ls-files','ls-tree','cat-file','describe','shortlog','name-rev','blame','grep'])
const MUTATING_COMMANDS=new Set(['add','commit','am','apply','checkout','cherry-pick','fetch','pull','merge','mv','restore','rebase','revert','switch','tag','update-index','worktree'])
const SENSITIVE_COMMANDS=new Set(['config','credential','credential-cache','credential-store'])

function firstSubcommand(args:string[]){
  for(let i=0;i<args.length;i++){
    const value=args[i]!
    if(value==='--') return {subcommand:'',index:i}
    if(value==='-C'||value==='--git-dir'||value==='--work-tree'||value==='--namespace'||value==='--exec-path') { i++; continue }
    if(value==='-c'||value.startsWith('--git-dir=')||value.startsWith('--work-tree=')||value.startsWith('--namespace=')||value.startsWith('--exec-path=')) continue
    if(value.startsWith('-')) continue
    return {subcommand:value.toLowerCase(),index:i}
  }
  return {subcommand:'',index:args.length}
}

export function analyzeGitArgs(input:unknown):GitAnalysis {
  const args=Array.isArray(input)?input.map(String):[]
  const {subcommand,index}=firstSubcommand(args)
  const rest=args.slice(index+1)
  const forced=/^(push|fetch)$/.test(subcommand) && rest.some(x=>x==='-f'||x==='--force'||x==='--force-with-lease'||x.startsWith('--force-with-lease='))
  const destructive=
    subcommand==='reset' ||
    subcommand==='clean' ||
    (subcommand==='push' && forced) ||
    (subcommand==='branch' && rest.some(x=>x==='-D'||x==='--delete-force')) ||
    (subcommand==='checkout' && rest.includes('--')) ||
    (subcommand==='restore' && (rest.includes('--source') || rest.includes('--staged') || rest.includes('--worktree') || rest.includes('.'))) ||
    (subcommand==='rebase' && rest.includes('--onto'))
  const sensitive=SENSITIVE_COMMANDS.has(subcommand) || (subcommand==='remote' && rest.some(x=>x==='-v'))
  const risk:GitRisk=destructive?'destructive':sensitive?'sensitive':MUTATING_COMMANDS.has(subcommand)?'mutation':READ_COMMANDS.has(subcommand)||!subcommand?'read-only':'mutation'
  const separator=rest.indexOf('--')
  const affectedPaths=separator>=0 ? rest.slice(separator+1).filter(x=>!x.startsWith('-')) : []
  const operation=subcommand||'unknown'
  const summary=destructive
    ? `Destructive git ${operation}${forced?' (forced)':''}`
    : sensitive
      ? `Sensitive git ${operation}`
      : risk==='mutation'
        ? `Git ${operation} changes repository state`
        : `Git ${operation||'command'}`
  return {subcommand,operation,risk,destructive,forced,affectedPaths,summary}
}
