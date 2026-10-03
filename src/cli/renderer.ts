export const ansi = { reset:'\x1b[0m', dim:'\x1b[2m', bold:'\x1b[1m', cyan:'\x1b[36m', green:'\x1b[32m', red:'\x1b[31m', yellow:'\x1b[33m' }
export function banner(model:string,cwd:string){ console.log(`${ansi.bold}TermAgent${ansi.reset}  ${ansi.dim}${model||'unconfigured'} · ${cwd}${ansi.reset}`) }
export function toolStart(name:string,args:any){ console.log(`\n${ansi.cyan}▸ ${name}${ansi.reset} ${ansi.dim}${JSON.stringify(args)}${ansi.reset}`) }
export function toolEnd(name:string,out:string){ const short=out.length>800?out.slice(0,800)+'…':out; console.log(`${ansi.green}✓ ${name}${ansi.reset}${short?`\n${ansi.dim}${short}${ansi.reset}`:''}`) }
export function error(e:unknown){ console.error(`${ansi.red}✗ ${(e as Error).message}${ansi.reset}`) }
