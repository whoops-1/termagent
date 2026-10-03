import type { ChatMessage } from '../session/store.js'
import type { ToolDefinition } from '../tools/types.js'

export type WorkflowPhase = 'planning'|'building'|'verifying'|'iterating'|'complete'|'blocked'

export interface WorkflowState {
  phase: WorkflowPhase
  iteration: number
  planItems: number
  completedItems: number
  dirty: boolean
  noProgressRounds: number
  verificationFailures: number
  verificationPassed: boolean
  repeatedCallCount: number
  todoFingerprint?: string
  lastToolSignature?: string
  lastProgress?: string
}

const transition = new Map<WorkflowPhase, readonly WorkflowPhase[]>([
  ['planning', ['building','blocked']],
  ['building', ['verifying','iterating','complete','blocked']],
  ['verifying', ['complete','iterating','blocked']],
  ['iterating', ['verifying','complete','blocked']],
  ['complete', []],
  ['blocked', []],
])

const writeTools = new Set(['write_file','edit_file','apply_patch'])
const verifyTools = new Set(['verify_project'])
const planningTools = new Set(['todo','workflow_phase'])
const verificationTools = new Set(['verify_project','task_status','repo_map','read_file','grep','glob','search_skills','skill','use_skill'])
const readOnlyNames = new Set(['read_file','grep','glob','repo_map','search_skills','skill','use_skill','todo','workflow_phase','task_status','verify_project'])

export function initialWorkflow(): WorkflowState {
  return {phase:'planning',iteration:0,planItems:0,completedItems:0,dirty:false,noProgressRounds:0,verificationFailures:0,verificationPassed:false,repeatedCallCount:0}
}

function todoFingerprint(items:any[]):string {
  return JSON.stringify((items||[]).map(item=>({id:String(item?.id||''),task:String(item?.task||''),status:String(item?.status||'pending'),priority:item?.priority===undefined?undefined:String(item.priority)})))
}

export function restoreWorkflow(events: readonly {type:string;data?:any}[]): WorkflowState {
  let state=initialWorkflow()
  const phases=new Set<WorkflowPhase>(['planning','building','verifying','iterating','complete','blocked'])
  for(const event of events){
    if(event.type!=='workflow' || !event.data || typeof event.data!=='object') continue
    const next={...state,...event.data}
    if(!phases.has(next.phase)) continue
    for(const key of ['iteration','planItems','completedItems','noProgressRounds','verificationFailures','repeatedCallCount'] as const){
      if(!Number.isInteger(next[key]) || next[key]<0) next[key]=state[key]
    }
    next.completedItems=Math.min(next.completedItems,next.planItems)
    next.verificationPassed=Boolean(next.verificationPassed)
    if(next.todoFingerprint!==undefined) next.todoFingerprint=String(next.todoFingerprint)
    if(next.phase==='complete' && !next.verificationPassed) { next.phase='blocked'; next.lastProgress='invalid persisted workflow: complete without verification' }
    if(next.phase==='complete' && next.verificationFailures>0) { next.verificationFailures=0 }
    state=next
  }
  return state
}

export class ExecutionWorkflow {
  constructor(public state: WorkflowState, private readonly maxVerificationFailures=3) {}

  transitionTo(next: WorkflowPhase, reason:string) {
    if(next===this.state.phase) return
    if(next==='complete' && !this.state.verificationPassed) throw new Error('Workflow cannot complete until verification passes')
    if(!transition.get(this.state.phase)?.includes(next)) throw new Error(`Invalid workflow transition: ${this.state.phase} -> ${next}`)
    this.state={...this.state,phase:next,lastProgress:reason,noProgressRounds:0}
  }

  applyTodo(items: any[]) {
    if(this.state.phase==='complete' || this.state.phase==='blocked') throw new Error(`Cannot update todos after workflow is ${this.state.phase}`)
    if(!Array.isArray(items)) return false
    const fingerprint=todoFingerprint(items)
    const unchanged=fingerprint===this.state.todoFingerprint
    if(unchanged) return false
    const completedItems=items.filter(x=>x?.status==='done').length
    this.state={...this.state,planItems:items.length,completedItems,verificationPassed:false,lastProgress:'todo updated',noProgressRounds:0,todoFingerprint:fingerprint}
    if(this.state.phase==='planning' && items.length>0) this.transitionTo('building','plan established')
    return true
  }

  observeTool(name:string, args:any, output:string, metadata?:any) {
    if(this.state.phase==='complete' || this.state.phase==='blocked') return
    const signature=`${name}:${JSON.stringify(args||{})}`
    const lower=output.toLowerCase()
    const repeated=this.state.lastToolSignature===signature ? this.state.repeatedCallCount+1 : 0
    let state: WorkflowState={...this.state,lastToolSignature:signature,repeatedCallCount:repeated}
    if(repeated>=4){
      this.state={...state,phase:'blocked',lastProgress:`repeated tool call loop detected: ${name}`}
      return
    }
    if(writeTools.has(name)) {
      const ok=!/^\s*error\s*:/i.test(output)
      state={...state,dirty:ok||state.dirty,lastProgress:ok?`${name} changed files`:`${name} failed`,noProgressRounds:ok?0:state.noProgressRounds}
    } else if(verifyTools.has(name)) {
      const failed=metadata?.ok===false || ['failed','timeout','cancelled','no_command'].includes(String(metadata?.status||'')) || /\b(?:exit=[1-9]|failed|failure|error|timed out|exception)\b/i.test(output)
      if(failed) {
        const failures=state.verificationFailures+1
        state={...state,verificationFailures:failures,verificationPassed:false,lastProgress:`verification failed: ${name}`,noProgressRounds:0}
        this.state=state
        if(failures>=this.maxVerificationFailures) this.transitionTo('blocked','verification failure limit reached')
        else if(state.phase==='verifying' || state.phase==='building') this.transitionTo('iterating','verification failed; iteration required')
        state={...this.state}
      } else {
        state={...state,verificationFailures:0,verificationPassed:true,lastProgress:'verification passed',noProgressRounds:0}
        this.state=state
        if(this.state.phase==='verifying' || this.state.phase==='building' || this.state.phase==='iterating') this.transitionTo('complete','verification passed')
        state={...this.state}
      }
    } else if(name==='workflow_phase') {
      state={...state,noProgressRounds:0,lastProgress:'workflow transition requested'}
    } else if(lower.trim()) {
      state={...state,lastProgress:signature}
    }
    this.state=state
  }

  afterRound(hadCalls:boolean, wroteFiles:boolean, meaningfulProgress:boolean) {
    if(this.state.phase==='complete' || this.state.phase==='blocked') return
    let next={...this.state}
    if(wroteFiles) {
      if(this.state.phase==='building' || this.state.phase==='iterating') next={...next,phase:'verifying',iteration:this.state.iteration+(this.state.phase==='iterating'?1:0),dirty:false,verificationPassed:false,noProgressRounds:0}
    } else if(this.state.phase==='planning' && this.state.planItems>0) {
      next={...next,phase:'building',noProgressRounds:0}
    } else if(!meaningfulProgress) {
      next={...next,noProgressRounds:this.state.noProgressRounds+1}
      if(this.state.phase==='building' || this.state.phase==='iterating') next={...next,phase:'verifying',noProgressRounds:0}
    } else if(!hadCalls) {
      next={...next,noProgressRounds:this.state.noProgressRounds+1}
    }
    this.state=next
  }

  assertProgressAllowed() {
    if(this.state.phase==='blocked') throw new Error(`Autonomous workflow blocked: ${this.state.lastProgress||'no progress'}`)
    if(this.state.noProgressRounds>=3) {
      this.state={...this.state,phase:'blocked'}
      throw new Error('Autonomous workflow stopped after repeated no-progress rounds')
    }
  }

  allowedTool(tool: ToolDefinition, autonomous:boolean):boolean {
    if(!autonomous) return true
    switch(this.state.phase){
      case 'planning': return tool.risk==='read' || planningTools.has(tool.name)
      case 'building': return tool.risk!=='read' || readOnlyNames.has(tool.name) || writeTools.has(tool.name)
      case 'verifying': return verificationTools.has(tool.name) && !writeTools.has(tool.name)
      case 'iterating': return tool.risk!=='read' || readOnlyNames.has(tool.name)
      case 'complete': return tool.risk==='read'
      case 'blocked': return tool.risk==='read'
    }
  }

  reminder(): string {
    switch(this.state.phase){
      case 'planning': return 'WORKFLOW: Planning phase. Inspect the repository and create/update a concrete todo plan. Do not edit files, run shell commands, or claim completion. The plan must exist before implementation.'
      case 'building': return 'WORKFLOW: Building phase. Implement the approved plan. After meaningful file changes, verify the project. Do not declare completion without verification.'
      case 'verifying': return 'WORKFLOW: Verification phase. Do not modify files or run arbitrary shell commands. Run verify_project and inspect its result. If verification fails, the workflow will enter iteration automatically.'
      case 'iterating': return 'WORKFLOW: Iteration phase. Fix the verification failure. Re-run verification after changes. Do not claim completion until verification passes.'
      case 'complete': return 'WORKFLOW: Verification passed. Provide the final concise result and verification evidence. Do not modify files.'
      case 'blocked': return 'WORKFLOW: Blocked. Report the blocker and the concrete recovery action. Do not continue making changes.'
    }
  }
}

export function workflowSummary(state: WorkflowState): string {
  return `phase=${state.phase}; iteration=${state.iteration}; plan=${state.completedItems}/${state.planItems}; dirty=${state.dirty}; verificationFailures=${state.verificationFailures}; noProgress=${state.noProgressRounds}; repeats=${state.repeatedCallCount}`
}
