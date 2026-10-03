import type { ChatMessage, ToolCall } from '../session/store.js'
import type { ToolRegistry } from '../tools/registry.js'

export type StreamEvent =
  | { type:'text'; delta:string }
  | { type:'reasoning'; delta:string }
  | { type:'tool_call'; call:ToolCall; providerExecuted?:boolean; providerMetadata?:unknown }
  | { type:'tool_result'; call:ToolCall; output:string; error?:string; providerExecuted?:boolean; providerMetadata?:unknown }
  | { type:'done'; finishReason?:string }

export interface ProviderConfig { provider?:string; model:string; apiKey?:string; apiKeyEnv?:string; baseUrl:string; temperature?:number; maxTokens?:number; variant?:string; reasoningEffort?:'low'|'medium'|'high'|'max'; streamIdleTimeoutMs?:number; extra?:Record<string,unknown> }
export interface Provider { readonly id:string; readonly model:string; readonly config?:ProviderConfig; setRole?(role:string):void; setTurnContext?(input:{userText:string;turnNumber?:number;hasNonTextContent?:boolean}):void; stream(messages:ChatMessage[], tools:ReturnType<ToolRegistry['schemas']>, signal:AbortSignal): AsyncGenerator<StreamEvent> }
