import path from 'node:path'
import { promises as fs } from 'node:fs'
import { pathToFileURL } from 'node:url'
import type { ToolDefinition } from '../tools/types.js'
import type { ToolRegistry } from '../tools/registry.js'

export interface PluginContext{cwd:string;registerTool:(tool:ToolDefinition)=>void;log:(message:string)=>void}
export async function loadPlugins(cwd:string,registry:ToolRegistry,configured:string[]=[]){
 const dirs=[path.join(cwd,'.termagent','plugins'),path.join(process.env.HOME||cwd,'.termagent','plugins'),...configured.map(p=>path.resolve(cwd,p))]
 const files=new Set<string>(); for(const dir of dirs){try{for(const f of await fs.readdir(dir))if(f.endsWith('.mjs')||f.endsWith('.js'))files.add(path.join(dir,f))}catch{}}
 for(const file of files){const mod:any=await import(pathToFileURL(file).href);const fn=mod.default||mod.register||mod.plugin;if(typeof fn!=='function')continue;const pluginId=pathToFileURL(file).href;const pluginName=path.basename(file,path.extname(file));await fn({cwd,registerTool:(t:ToolDefinition)=>registry.add({...t,kind:'plugin',provenance:t.provenance?.kind==='plugin'?t.provenance:{kind:'plugin',pluginId,pluginName,source:file}}),log:(m:string)=>console.error(`[plugin] ${m}`)})}
 return [...files]
}

export { discoverPluginPackages } from './registry.js'
export { assertPluginManifest, readPluginManifest, resolvePluginComponentPath } from './manifest.js'
export type { PluginManifest, PluginPackage, PluginManifestLocation, PluginDiscoveryResult } from './types.js'

export * from './marketplace.js'
export * from './marketplace-types.js'
export * from './plugin-install.js'
