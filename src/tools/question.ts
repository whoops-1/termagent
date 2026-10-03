import crypto from 'node:crypto'
import type { QuestionPrompt, QuestionResponse, ToolDefinition } from './types.js'
import type { SessionStore } from '../session/store.js'

function requestId(sessionId:string, toolCallId:string|undefined, questions:QuestionPrompt[]):string {
  const seed = `${sessionId}\0${toolCallId||'question'}\0${questions.map((q,i)=>`${q.id||''}\0${q.question}\0${q.header||''}`).join('\0')}`
  return `que_${crypto.createHash('sha256').update(seed).digest('hex').slice(0,24)}`
}

function normalizeQuestions(raw:unknown[]):QuestionPrompt[] {
  return raw.map((value:any, i) => {
    const options=Array.isArray(value?.options)
      ? value.options.map((o:any)=>({label:String(o?.label||'').trim(),description:o?.description===undefined?undefined:String(o.description)})).filter((o:any)=>o.label)
      : []
    const multi=Boolean(value?.multiple ?? value?.multi)
    return {
      id: typeof value?.id==='string' && value.id.trim() ? value.id.trim() : `q_${i+1}`,
      question:String(value?.question||`Question ${i+1}`).trim(),
      header:String(value?.header||`Q${i+1}`).trim().slice(0,30),
      options,
      multi,
      multiple:multi,
      custom:value?.custom!==false,
    }
  })
}

function normalizeResponse(value:string[][]|QuestionResponse, fallbackId:string):Required<QuestionResponse> {
  if (Array.isArray(value)) return {requestId:fallbackId,status:'replied',answers:value.map(a=>Array.isArray(a)?a.map(String):[String(a)])}
  return {requestId:String(value.requestId||fallbackId),status:value.status||'replied',answers:Array.isArray(value.answers)?value.answers.map(a=>Array.isArray(a)?a.map(String):[String(a)]):[]}
}

export function questionTool(store?:SessionStore): ToolDefinition {
  return {
    name:'question',
    risk:'read',
    description:'Use this tool when you need to ask the user questions during execution. Supports multiple structured questions, selectable options, multiple selection, custom answers, and explicit rejection/cancellation states.',
    schema:{type:'object',properties:{questions:{type:'array',minItems:1,items:{type:'object',properties:{id:{type:'string'},header:{type:'string',maxLength:30},question:{type:'string'},options:{type:'array',items:{type:'object',properties:{label:{type:'string'},description:{type:'string'}},required:['label']}},multiple:{type:'boolean'},multi:{type:'boolean'},custom:{type:'boolean'}},required:['question']}}},required:['questions']},
    async execute(args,ctx){
      if(!ctx.questioner) throw new Error('Interactive questions are unavailable in this runtime.')
      const questions=normalizeQuestions(Array.isArray(args?.questions)?args.questions:[])
      if(!questions.length) throw new Error('At least one question is required.')
      const rid=requestId(ctx.sessionID,ctx.toolCallId,questions)
      const prior=store ? await store.getQuestion(ctx.sessionID,rid) : undefined
      if(prior){
        const status=String(prior.status||'replied') as QuestionResponse['status']
        return {title:`Question ${status}`,output: status==='replied' ? formatAnswers(questions,prior.answers||[]) : `Question request ${rid} was ${status}; no new input was requested.`,metadata:{question:{requestId:rid,status,answers:prior.answers||[],replayed:true,questions}}}
      }
      await store?.appendQuestionAsked(ctx.sessionID,{requestId:rid,sessionID:ctx.sessionID,toolCallId:ctx.toolCallId,questions})
      let response:QuestionResponse
      try {
        response=normalizeResponse(await ctx.questioner(questions,ctx.abort),rid)
      } catch(error) {
        await store?.appendQuestionCancelled(ctx.sessionID,{requestId:rid,sessionID:ctx.sessionID,error:error instanceof Error?error.message:String(error),questions})
        throw error
      }
      const answers=response.answers||[]
      if(store){
        const resolution={commandId:`question:${rid}:${ctx.toolCallId||'runtime'}`,clientId:'runtime',disposition:response.status,answers}
        const result=await store.resolveQuestion(ctx.sessionID,rid,resolution)
        if(result.applied===false && result.request.kind==='question' && result.request.resolution?.disposition!=='replied'){
          response={status:result.request.resolution?.disposition||response.status,requestId:rid,answers:result.request.resolution?.answers||[]}
        }
      }
      return {
        title:`Question ${response.status}`,
        output: response.status==='replied' ? formatAnswers(questions,answers) : `User ${response.status} the question request. You can continue without asking the same questions again.`,
        metadata:{question:{requestId:rid,status:response.status,answers,questions,replayed:false}},
      }
    },
  }
}

function formatAnswers(questions:QuestionPrompt[],answers:string[][]):string {
  const formatted=questions.map((q,i)=>`"${q.question}"="${answers[i]?.length?answers[i].join(', '):'Unanswered'}"`).join(', ')
  return `User has answered your questions: ${formatted}. You can now continue with the user's answers in mind.`
}
