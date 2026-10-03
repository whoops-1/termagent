import type { SessionStore } from '../session/store.js'
import type { ToolDefinition } from './types.js'
import type { TodoItem } from './todo.js'

function normalize(items:any[]):TodoItem[] {
  const out:TodoItem[]=[]
  const ids=new Set<string>()
  for(const x of items||[]) {
    const item={id:String(x?.id||''),task:String(x?.task||''),status:(x?.status||'pending') as TodoItem['status'],priority:['high','medium','low'].includes(x?.priority)?x.priority:undefined}
    if(!item.id||!item.task) throw new Error('Each todo requires id and task')
    if(!['pending','in_progress','done'].includes(item.status)) throw new Error(`Invalid todo status: ${item.status}`)
    if(ids.has(item.id)) throw new Error(`Duplicate todo id: ${item.id}`)
    ids.add(item.id); out.push(item)
  }
  return out
}

export function sessionTodoTool(store:SessionStore):ToolDefinition {
  const loadLatest=async(sessionID:string):Promise<TodoItem[]>=>{
    const loaded=await store.load(sessionID)
    const latest=[...loaded.events].reverse().find((e:any)=>e.type==='todo')
    return normalize(Array.isArray(latest?.data?.items)?latest.data.items:[])
  }
  return {
    name:'todo',
    description:'Maintain a durable task list for the current session. Use it for multi-step work and update it as work progresses.',
    risk:'read',
    schema:{type:'object',properties:{action:{type:'string',enum:['set','add','update','remove','list']},items:{type:'array',items:{type:'object',properties:{id:{type:'string'},task:{type:'string'},status:{type:'string',enum:['pending','in_progress','done']},priority:{type:'string',enum:['high','medium','low']}},required:['id']}},id:{type:'string'},task:{type:'string'},status:{type:'string',enum:['pending','in_progress','done']},priority:{type:'string',enum:['high','medium','low']}},required:['action']},
    async execute(args,ctx){
      const action=String(args.action)
      return await store.withSessionMutation(ctx.sessionID,async()=>{
        const state=await loadLatest(ctx.sessionID)
        const oldItems=state.map(x=>({...x}))
        if(action==='set') {
          state.splice(0,state.length,...normalize(Array.isArray(args.items)?args.items:[]))
        } else if(action==='add') {
          const id=String(args.id||''); const task=String(args.task||'')
          if(!id||!task) throw new Error('id and task required')
          if(state.some(i=>i.id===id)) throw new Error(`Todo already exists: ${id}`)
          const status=(args.status||'pending') as TodoItem['status']
          if(!['pending','in_progress','done'].includes(status)) throw new Error(`Invalid todo status: ${status}`)
          state.push({id,task,status,...(['high','medium','low'].includes(args.priority)?{priority:args.priority as TodoItem['priority']}:{})})
        } else if(action==='update') {
          if(Array.isArray(args.items)) {
            for(const patch of args.items) {
              const x=state.find(i=>i.id===String(patch?.id||'')); if(!x) throw new Error(`Unknown todo: ${patch?.id}`)
              if(patch.task!==undefined) x.task=String(patch.task)
              if(patch.priority!==undefined){if(!['high','medium','low'].includes(patch.priority)) throw new Error(`Invalid todo priority: ${patch.priority}`);x.priority=patch.priority}
              if(patch.status!==undefined) {
                if(!['pending','in_progress','done'].includes(patch.status)) throw new Error(`Invalid todo status: ${patch.status}`)
                x.status=patch.status
              }
            }
          } else {
            const x=state.find(i=>i.id===String(args.id||'')); if(!x) throw new Error(`Unknown todo: ${args.id}`)
            if(args.task!==undefined) x.task=String(args.task)
            if(args.priority!==undefined){if(!['high','medium','low'].includes(args.priority)) throw new Error(`Invalid todo priority: ${args.priority}`);x.priority=args.priority}
            if(args.status!==undefined) {
              if(!['pending','in_progress','done'].includes(args.status)) throw new Error(`Invalid todo status: ${args.status}`)
              x.status=args.status
            }
          }
        } else if(action==='remove') {
          const id=String(args.id||''); const idx=state.findIndex(i=>i.id===id); if(idx<0) throw new Error(`Unknown todo: ${id}`)
          state.splice(idx,1)
        } else if(action!=='list') throw new Error(`Unknown todo action: ${action}`)
        if(action!=='list') await store.appendTodo(ctx.sessionID,state.map(x=>({...x})),oldItems)
        const nextItems=state.map(x=>({...x}))
        const active=nextItems.filter(x=>x.status!=='done')
        const completed=nextItems.filter(x=>x.status==='done')
        return {output:JSON.stringify(nextItems,null,2),metadata:{todo:{old:oldItems,new:nextItems,active,completed,collapsed:active.length===0,verificationNudge:active.length===0&&completed.length>0}}}
      })
    }
  }
}
