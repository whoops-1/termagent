import type { ToolDefinition } from './types.js'
import type { ExecutionWorkflow, WorkflowPhase } from '../agent/workflow.js'

export function workflowPhaseTool(workflow:ExecutionWorkflow,onPersist?:(state:any)=>Promise<void>):ToolDefinition {
 return {name:'workflow_phase',description:'Advance the autonomous execution workflow when the current phase is complete. Planning must precede building; verification gates completion.',risk:'read',schema:{type:'object',properties:{phase:{type:'string',enum:['planning','building','verifying','iterating','complete','blocked']},reason:{type:'string'}},required:['phase']},async execute(args){
   const phase=String(args.phase) as WorkflowPhase
   workflow.transitionTo(phase,String(args.reason||'model requested transition'))
   await onPersist?.(workflow.state)
   return {output:JSON.stringify(workflow.state),metadata:{workflow:{...workflow.state}}}
 }}
}
