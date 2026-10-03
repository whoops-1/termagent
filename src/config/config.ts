import path from 'node:path'
import { promises as fs } from 'node:fs'
import { exists } from '../util/fs.js'

export type ApprovalMode='ask'|'auto'|'deny'
export interface ProviderVariant{reasoningEffort?:'low'|'medium'|'high'|'max';temperature?:number;maxTokens?:number;extra?:Record<string,unknown>}
export interface ProviderProfile{provider:string;model:string;baseUrl:string;apiKeyEnv?:string;apiKey?:string;temperature?:number;maxTokens?:number;streamIdleTimeoutMs?:number;variants?:Record<string,ProviderVariant>}
export interface MCPServer{command:string;args?:string[];env?:Record<string,string>}
export type PermissionDecision='ask'|'allow'|'deny'
function envNonNegativeInt(name:string,fallback:number){ const raw=process.env[name]; if(raw===undefined||raw.trim()==='') return fallback; const value=Number(raw); return Number.isSafeInteger(value)&&value>=0 ? value : fallback }
export interface PermissionRule{tool:string;decision:PermissionDecision;pattern?:string}
export interface SmartRoutingConfig{enabled:boolean;simpleModel:string;strongModel:string;simpleMaxChars?:number;simpleMaxWords?:number}
export interface PostEditVerificationConfig{enabled:boolean;command?:string;timeoutMs?:number;maxOutputBytes?:number;tools?:string[]}
export interface UIPreferences{theme?:string;bannerStyle?:'showcase'|'split'|'signal'|'minimal';effect?:'off'|'drift'|'glyphfall'|'spark'|'ripple'|'dust'|'pulse';animations?:boolean;motion?:'full'|'reduced'|'off'}
export interface Config{provider:string;model:string;baseUrl:string;apiKeyEnv:string;approvals:ApprovalMode;maxToolRounds:number;maxOutputBytes:number;shellTimeoutMs:number;maxContextMessages:number; maxContextBytes:number;compactionThreshold:number;contextReserveTokens:number;contextRecentTokens:number;repoMapTokens:number;providers?:Record<string,ProviderProfile>;routing?:{default?:string;planning?:string;building?:string;verification?:string;subagent?:string};smartRouting?:SmartRoutingConfig;postEditVerification?:PostEditVerificationConfig;keybinds?:Record<string,string|string[]>;permissionRules?:PermissionRule[];mcp?:Record<string,MCPServer>;plugins?:string[];skillPaths?:string[];fallbackProviders?:string[];maxContextTokens?:number;retryMax?:number;streamIdleTimeoutMs?:number;toolOutputMaxLines?:number;toolOutputMaxBytes?:number;toolOutputRetentionDays?:number;ui?:UIPreferences}
function environmentDefaults():Config{
 const envProvider=process.env.TERMAGENT_PROVIDER||'openai-compatible'
 return {provider:envProvider,model:process.env.TERMAGENT_MODEL||'',baseUrl:process.env.TERMAGENT_BASE_URL||(envProvider==='anthropic'?'https://api.anthropic.com/v1':envProvider==='gemini'?'https://generativelanguage.googleapis.com':'https://api.openai.com/v1'),apiKeyEnv:process.env.TERMAGENT_API_KEY?'TERMAGENT_API_KEY':envProvider==='anthropic'?'ANTHROPIC_API_KEY':envProvider==='gemini'?'GEMINI_API_KEY':'OPENAI_API_KEY',approvals:(process.env.TERMAGENT_APPROVALS as ApprovalMode)||'ask',maxToolRounds:envNonNegativeInt('TERMAGENT_MAX_TOOL_ROUNDS',50),maxOutputBytes:20000,shellTimeoutMs:120000,maxContextMessages:80,maxContextBytes:36000,compactionThreshold:0.82,contextReserveTokens:768,contextRecentTokens:3000,repoMapTokens:2600,providers:{},mcp:{},plugins:[],fallbackProviders:[],maxContextTokens:12000,retryMax:4,streamIdleTimeoutMs:90000,toolOutputMaxLines:2000,toolOutputMaxBytes:50*1024,toolOutputRetentionDays:7,ui:{theme:'termagent',effect:'off',animations:true,motion:'full'},routing:{},smartRouting:{enabled:false,simpleModel:'',strongModel:''},postEditVerification:{enabled:false,tools:['write_file','edit_file','apply_patch']},keybinds:{},permissionRules:[]}
}
export async function loadConfig(cwd:string):Promise<Config>{
 const defaults=environmentDefaults(); const candidates=[path.join(cwd,'.termagent','config.json'),path.join(process.env.HOME||cwd,'.termagent','config.json')];let file:Partial<Config>={}
 for(const p of candidates)if(await exists(p)){try{file=JSON.parse(await fs.readFile(p,'utf8'))}catch(e){throw new Error(`Invalid config: ${p}: ${(e as Error).message}`)}break}
 const merged={...defaults,...file}; if(file.ui) merged.ui={...defaults.ui,...file.ui}; if(file.postEditVerification) merged.postEditVerification={...defaults.postEditVerification,...file.postEditVerification}; if(file.providers)merged.providers={...defaults.providers,...file.providers}; if(file.routing)merged.routing={...defaults.routing,...file.routing}; if(file.mcp)merged.mcp={...defaults.mcp,...file.mcp}; return merged
}
export function resolveProviderConfig(cfg:Config,name?:string):ProviderProfile{
 const key=name||cfg.provider; const profile=cfg.providers?.[key]
 if(profile)return {...profile,apiKey:profile.apiKey||process.env[profile.apiKeyEnv||''],apiKeyEnv:profile.apiKeyEnv}
 return {provider:cfg.provider,model:cfg.model,baseUrl:cfg.baseUrl,apiKey:process.env[cfg.apiKeyEnv],apiKeyEnv:cfg.apiKeyEnv,streamIdleTimeoutMs:cfg.streamIdleTimeoutMs}
}

export async function saveUIPreferences(cwd:string, patch:UIPreferences):Promise<void>{
 const candidates=[path.join(cwd,'.termagent','config.json'),path.join(process.env.HOME||cwd,'.termagent','config.json')];
 let filePath=candidates[0]!; let raw:Record<string,unknown>={};
 for(const candidate of candidates){ if(await exists(candidate)){ filePath=candidate; raw=JSON.parse(await fs.readFile(candidate,'utf8')) as Record<string,unknown>; break } }
 const current=raw.ui&&typeof raw.ui==='object'&&!Array.isArray(raw.ui)?raw.ui as Record<string,unknown>:{ };
 raw.ui={...current,...patch};
 await fs.mkdir(path.dirname(filePath),{recursive:true,mode:0o700});
 await fs.writeFile(filePath,`${JSON.stringify(raw,null,2)}\n`,{mode:0o600});
 try{await fs.chmod(filePath,0o600)}catch{}
}
