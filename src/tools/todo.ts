import type { ToolDefinition } from './types.js'

export type TodoItem={id:string;task:string;status:'pending'|'in_progress'|'done';priority?:'high'|'medium'|'low'}

export function hasActiveTodoItems(items: readonly TodoItem[]): boolean {
 return items.some(item=>item.status!=='done')
}

export function activeTodoItems(items: readonly TodoItem[]): TodoItem[] {
 return hasActiveTodoItems(items) ? items.map(item=>({...item})) : []
}

type Persist = (items:TodoItem[])=>Promise<void>

export function todoTool(state:TodoItem[],persist?:Persist,onChange?:(items:TodoItem[])=>void):ToolDefinition {
 return {name:'todo',description:'Maintain a durable task list for the current session. Use it for multi-step work and update it as work progresses.',risk:'read',schema:{type:'object',properties:{action:{type:'string',enum:['set','add','update','remove','list']},items:{type:'array',items:{type:'object',properties:{id:{type:'string'},task:{type:'string'},status:{type:'string',enum:['pending','in_progress','done']},priority:{type:'string',enum:['high','medium','low']}},required:['id']}},id:{type:'string'},task:{type:'string'},status:{type:'string',enum:['pending','in_progress','done']},priority:{type:'string',enum:['high','medium','low']}},required:['action']},async execute(args){
  const action=String(args.action)
  const previous=state.map(item=>({...item}))
  if(action==='set'){
    const items=Array.isArray(args.items)?args.items.map((x:any)=>({id:String(x.id),task:String(x.task),status:(x.status||'pending') as TodoItem['status'],...(['high','medium','low'].includes(x.priority)?{priority:x.priority as TodoItem['priority']}:{})})):[]
    const ids=new Set<string>(); for(const item of items){if(!item.id||!item.task)throw new Error('Each todo requires id and task');if(ids.has(item.id))throw new Error(`Duplicate todo id: ${item.id}`);ids.add(item.id)}
    state.splice(0,state.length,...items)
  } else if(action==='add'){
    if(!args.id||!args.task)throw new Error('id and task required')
    const id=String(args.id);if(state.some(i=>i.id===id))throw new Error(`Todo already exists: ${id}`)
    state.push({id,task:String(args.task),status:(args.status||'pending') as TodoItem['status'],...(['high','medium','low'].includes(args.priority)?{priority:args.priority as TodoItem['priority']}:{})})
  } else if(action==='update'){
    if(Array.isArray(args.items)) {
      for(const patch of args.items) {
        const x=state.find(i=>i.id===String(patch?.id||''));if(!x)throw new Error(`Unknown todo: ${patch?.id}`)
        if(patch.task!==undefined)x.task=String(patch.task)
        if(patch.priority!==undefined){if(!['high','medium','low'].includes(patch.priority))throw new Error(`Invalid todo priority: ${patch.priority}`);x.priority=patch.priority}
        if(patch.status!==undefined){
          if(!['pending','in_progress','done'].includes(patch.status))throw new Error(`Invalid todo status: ${patch.status}`)
          x.status=patch.status
        }
      }
    } else {
      const x=state.find(i=>i.id===String(args.id));if(!x)throw new Error(`Unknown todo: ${args.id}`)
      if(args.task!==undefined)x.task=String(args.task)
      if(args.priority!==undefined){if(!['high','medium','low'].includes(args.priority))throw new Error(`Invalid todo priority: ${args.priority}`);x.priority=args.priority}
      if(args.status!==undefined){
        if(!['pending','in_progress','done'].includes(args.status))throw new Error(`Invalid todo status: ${args.status}`)
        x.status=args.status
      }
    }
  } else if(action==='remove'){
    const id=String(args.id);const index=state.findIndex(i=>i.id===id);if(index<0)throw new Error(`Unknown todo: ${id}`);state.splice(index,1)
  } else if(action!=='list') throw new Error(`Unknown todo action: ${action}`)
  const snapshot=state.map(item=>({...item}))
  if(persist&&action!=='list')await persist(snapshot)
  const active=activeTodoItems(snapshot)
  const completed=snapshot.filter(item=>item.status==='done')
  // Keep completed items in the tool state/history so a same-turn `list`
  // still reflects what happened, but only expose active work to the UI.
  onChange?.(active)
  return {output:JSON.stringify(snapshot,null,2),metadata:{todo:{old:previous,new:snapshot,active,completed,collapsed:active.length===0,verificationNudge:active.length===0&&completed.length>0}}}
 }}}
