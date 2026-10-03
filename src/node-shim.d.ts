declare const process: any
declare const Buffer: any
declare module 'node:fs' { export const promises: any; export const createReadStream: any }
declare module 'node:path' { const path: any; export default path; export = path }
declare module 'node:crypto' { const crypto: any; export default crypto }
declare module 'node:child_process' { export const spawn: any; export const spawnSync: any; export const execFile: any }
declare module 'node:readline/promises' { const readline: any; export default readline }
declare module 'node:process' { const process: any; export default process }
declare module 'node:test' { const test: any; export default test; export = test }
declare module 'node:assert/strict' { const assert: any; export default assert; export = assert }
declare module 'node:url' { export const pathToFileURL: any; export const URL: any }
declare module 'node:http' {
  const http: any
  export default http
  export type Server = any
  export type IncomingMessage = any
  export type ServerResponse = any
}

declare module 'node:os' { export const homedir: any; export const tmpdir: any; const os:any; export default os }

declare module 'node:util' { export const promisify: any }
