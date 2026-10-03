import { promises as fs } from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { ensureDir } from '../util/fs.js'

async function exec(command: string, args: string[], options: { cwd: string; env: any; stdin?: string }) {
  return await new Promise<{stdout:string;stderr:string}>((resolve,reject)=>{
    const child=spawn(command,args,{cwd:options.cwd,env:options.env,stdio:[options.stdin===undefined?'ignore':'pipe','pipe','pipe']}); let stdout=''; let stderr='';
    child.stdout.on('data',(b:any)=>stdout+=b.toString()); child.stderr.on('data',(b:any)=>stderr+=b.toString());
    child.on('error',reject); child.on('close',(code:any)=>code===0?resolve({stdout,stderr}):reject(new Error(stderr||`${command} exited ${code}`)));
    if(options.stdin!==undefined){child.stdin.write(options.stdin);child.stdin.end()}
  })
}

const IGNORED_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.next', '.cache', 'target', 'venv', '.venv', '.termagent'])
const SNAPSHOT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const SNAPSHOT_LOCKS = new Map<string, Promise<void>>()

type SnapshotOptions = { root: string; storeRoot?: string }

async function runGit(repo: string, cwd: string, index: string, args: string[], stdin?: string) {
  const env = { ...process.env, GIT_DIR: repo, GIT_WORK_TREE: cwd, GIT_INDEX_FILE: index }
  const { stdout } = await exec('git', args, { cwd, env, stdin })
  return stdout.trim()
}

function encodeTopLevelLiteralPaths(files: string[]) {
  return files.map(file => `:(top,literal)${file}`).join('\0') + '\0'
}

async function ignoredPaths(repo:string,cwd:string,index:string,files:string[]) {
  if(!files.length) return new Set<string>()
  const env = { ...process.env, GIT_DIR: repo, GIT_WORK_TREE: cwd, GIT_INDEX_FILE: index }
  const input = files.join('\0') + '\0'
  return await new Promise<Set<string>>((resolve,reject)=>{
    const child=spawn('git',['check-ignore','--stdin','-z','--no-index'],{cwd,env,stdio:['pipe','pipe','pipe']})
    let stdout=''; let stderr=''
    child.stdout.on('data',(b:any)=>stdout+=b.toString())
    child.stderr.on('data',(b:any)=>stderr+=b.toString())
    child.on('error',reject)
    child.on('close',(code:any)=>{
      if(code!==0 && code!==1){reject(new Error(stderr||`git check-ignore exited ${code}`));return}
      resolve(new Set(stdout.split('\0').filter(Boolean)))
    })
    child.stdin.write(input); child.stdin.end()
  })
}

async function walkTree(root: string, dir = root, files: string[] = [], dirs: string[] = []) {
  let entries: any[]
  try { entries = await fs.readdir(dir, { withFileTypes: true }) } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return { files, dirs }
    throw error
  }
  for (const ent of entries) {
    if (ent.name === '.git') continue
    if (ent.isDirectory() && IGNORED_DIRS.has(ent.name)) continue
    const full = path.join(dir, ent.name)
    const relative = path.relative(root, full).split(path.sep).join('/')
    if (ent.isDirectory()) {
      dirs.push(relative)
      await walkTree(root, full, files, dirs)
    } else if (ent.isFile() || ent.isSymbolicLink()) {
      files.push(relative)
    }
  }
  return { files, dirs }
}

async function walkFiles(root: string) {
  return (await walkTree(root)).files
}

async function walkDirs(root: string) {
  return (await walkTree(root)).dirs
}

function snapshotParentsFirst(target:Set<string>, parent:string) {
  for (const snapshotPath of target) if (snapshotPath.startsWith(`${parent}/`)) return snapshotPath
  return parent
}

async function removeEmptyParents(root: string, file: string) {
  let current = path.dirname(path.join(root, file))
  const resolvedRoot = path.resolve(root)
  while (path.resolve(current).startsWith(resolvedRoot + path.sep) && path.resolve(current) !== resolvedRoot) {
    try {
      const entries = await fs.readdir(current)
      if (entries.length) break
      await fs.rmdir(current)
    } catch { break }
    current = path.dirname(current)
  }
}

/**
 * A private Git object store used only for TermAgent turn snapshots.
 * It never touches the project's real .git/index or working-tree metadata.
 * This follows TermAgent's important property: snapshots represent the whole
 * relevant working tree, not merely the files the agent happened to edit.
 */
export class SnapshotStore {
  readonly root: string
  readonly repo: string
  private initialized = false
  private lastCleanupAt = 0

  constructor(private options: SnapshotOptions) {
    const sessionRoot = options.storeRoot || path.join(process.env.HOME || options.root, '.termagent', 'snapshots')
    this.root = path.resolve(sessionRoot)
    this.repo = path.join(this.root, 'git')
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const previous = SNAPSHOT_LOCKS.get(this.repo) ?? Promise.resolve()
    let release!: () => void
    const next = new Promise<void>(resolve => { release = resolve })
    const queued = previous.then(() => next)
    SNAPSHOT_LOCKS.set(this.repo, queued)
    await previous
    try {
      return await fn()
    } finally {
      release()
      if (SNAPSHOT_LOCKS.get(this.repo) === queued) SNAPSHOT_LOCKS.delete(this.repo)
    }
  }

  private async initUnlocked() {
    if (this.initialized) return
    await ensureDir(this.root)
    const head = path.join(this.repo, 'HEAD')
    try {
      await fs.access(head)
      this.initialized = true
      return
    } catch {}

    // The in-process semaphore does not protect a second TermAgent process.
    // Use mkdir as an atomic cross-process lock so concurrent first-use cannot
    // both run `git init --bare` or delete a partially initialized repository.
    const lock = path.join(this.root, 'git-init.lock')
    const deadline = Date.now() + 60_000
    while (Date.now() < deadline) {
      let ownsLock = false
      try {
        await fs.mkdir(lock)
        ownsLock = true
        try {
          try {
            await fs.access(head)
          } catch {
            await fs.rm(this.repo, { recursive: true, force: true })
            await exec('git', ['init', '--bare', this.repo], { cwd: this.options.root, env: process.env })
          }
          this.initialized = true
          return
        } finally {
          if (ownsLock) await fs.rm(lock, { recursive: true, force: true }).catch(() => {})
        }
      } catch (error) {
        if ((error as { code?: string }).code !== 'EEXIST') throw error
        try {
          await fs.access(head)
          this.initialized = true
          return
        } catch {}
        await new Promise(resolve => setTimeout(resolve, 20))
      }
    }
    throw new Error(`Timed out waiting for snapshot repository initialization lock: ${this.repo}`)
  }

  async init() {
    await this.withLock(() => this.initUnlocked())
  }

  private tempIndex() {
    return path.join(this.repo, `index-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`)
  }

  private snapshotRef(id: string) {
    if (!SNAPSHOT_ID.test(id)) throw new Error(`Invalid snapshot id: ${id}`)
    return `refs/termagent/snapshots/${id}`
  }

  private async treePaths(snapshotId: string): Promise<string[]> {
    if (!SNAPSHOT_ID.test(snapshotId)) throw new Error(`Invalid snapshot id: ${snapshotId}`)
    const index = this.tempIndex()
    try {
      const output = await runGit(this.repo, this.options.root, index, ['ls-tree', '-r', '-z', '--name-only', snapshotId])
      return output ? output.split('\0').filter(Boolean) : []
    } finally {
      await fs.rm(index, { force: true })
    }
  }

  private async protectPaths(index: string, snapshotId: string) {
    const beforePaths = await this.treePaths(snapshotId)
    if (!beforePaths.length) return
    const stagedOutput = await runGit(this.repo, this.options.root, index, ['ls-files', '-z'])
    const staged = new Set(stagedOutput ? stagedOutput.split('\0').filter(Boolean) : [])
    const missing:string[]=[]
    for (const file of beforePaths) {
      if (staged.has(file)) continue
      try {
        const info = await fs.lstat(path.join(this.options.root, file))
        if (info.isFile() || info.isSymbolicLink()) missing.push(file)
      } catch {}
    }
    if (missing.length) {
      await runGit(this.repo, this.options.root, index, ['add', '-f', '--', ...missing.map(x => `:(top,literal)${x}`)])
    }
  }

  async create(label = 'turn', protectFromSnapshot?: string, persist = true) {
    return await this.withLock(async () => {
      await this.initUnlocked()
      const index = this.tempIndex()
      try {
        await runGit(this.repo, this.options.root, index, ['read-tree', '--empty'])

        // Do not pass `.` to git add here. Git treats ignored directories as explicit
        // pathspec candidates and can fail before the exclusions are evaluated.
        // Build the candidate set ourselves, resolve .gitignore against that exact
        // set, and stage only allowed paths via a NUL-delimited pathspec file. This
        // keeps snapshot cleanup safe for unusual filenames.
        const files = await walkFiles(this.options.root)
        const ignored = await ignoredPaths(this.repo, this.options.root, index, files)
        const allow = files.filter(file => !ignored.has(file))
        if (allow.length) {
          await runGit(this.repo, this.options.root, index, [
            'add', '-A', '--pathspec-from-file=-', '--pathspec-file-nul', '--',
          ], encodeTopLevelLiteralPaths(allow))
        }
        if (protectFromSnapshot) await this.protectPaths(index, protectFromSnapshot)
        const tree = await runGit(this.repo, this.options.root, index, ['write-tree'])
        if (!SNAPSHOT_ID.test(tree)) throw new Error(`Invalid snapshot id returned by git: ${tree}`)
        if (persist) {
          // Keep the snapshot tree reachable so an ordinary Git GC can never
          // silently invalidate a turn boundary.
          await runGit(this.repo, this.options.root, index, ['update-ref', this.snapshotRef(tree), tree])
          const metadata = { id: tree, label, ts: Date.now(), root: this.options.root }
          await fs.writeFile(path.join(this.root, `${tree}.json`), JSON.stringify(metadata) + '\n', 'utf8')
        }
        return tree
      } finally {
        await fs.rm(index, { force: true })
      }
    })
  }

  async cleanupIfDue(keepIds: Set<string>, force = false) {
    if (!force && Date.now() - this.lastCleanupAt < 60 * 60 * 1000) return
    await this.cleanup(keepIds)
    this.lastCleanupAt = Date.now()
  }

  async cleanup(keepIds: Set<string>) {
    for (const id of keepIds) if (!SNAPSHOT_ID.test(id)) throw new Error(`Invalid snapshot id: ${id}`)
    await this.withLock(async () => {
      await this.initUnlocked()
      const index = this.tempIndex()
      try {
        const output = await runGit(this.repo, this.options.root, index, ['for-each-ref', '--format=%(refname)', 'refs/termagent/snapshots'])
        const refs = output ? output.split('\n').filter(Boolean) : []
        for (const ref of refs) {
          const id = ref.slice('refs/termagent/snapshots/'.length)
          if (!SNAPSHOT_ID.test(id) || !keepIds.has(id)) {
            await runGit(this.repo, this.options.root, index, ['update-ref', '-d', ref])
            await fs.rm(path.join(this.root, `${id}.json`), { force: true })
          }
        }
        // Also remove stale metadata files left by interrupted snapshot writes.
        for (const file of await fs.readdir(this.root)) {
          if (!file.endsWith('.json')) continue
          const id = file.slice(0, -5)
          if (SNAPSHOT_ID.test(id) && !keepIds.has(id)) await fs.rm(path.join(this.root, file), { force: true })
        }
        // Snapshot maintenance is best-effort; cleanup should never block the active session
        // from turning a healthy session into a failed turn when Git maintenance
        // itself cannot complete.
        try { await runGit(this.repo, this.options.root, index, ['gc', '--auto']) } catch {}
      } finally {
        await fs.rm(index, { force: true })
      }
    })
  }

  async restore(snapshotId: string) {
    if (!SNAPSHOT_ID.test(snapshotId)) throw new Error(`Invalid snapshot id: ${snapshotId}`)
    return await this.withLock(async () => {
      await this.initUnlocked()
      const index = this.tempIndex()
      try {
        try {
          await runGit(this.repo, this.options.root, index, ['show-ref', '--verify', '--quiet', this.snapshotRef(snapshotId)])
        } catch {
          throw new Error(`Snapshot not found: ${snapshotId}`)
        }
        await runGit(this.repo, this.options.root, index, ['read-tree', snapshotId])
        const output = await runGit(this.repo, this.options.root, index, ['ls-files', '-z'])
        const target = new Set(output ? output.split('\0').filter(Boolean) : [])
        const current = await walkFiles(this.options.root)
        const directories = await walkDirs(this.options.root)
        const currentEntries = [...current, ...directories]
        const candidates = currentEntries.filter(file => !target.has(file))
        const ignored = await ignoredPaths(this.repo,this.options.root,index,candidates)

        // Never silently delete ignored user files. Also fail before any mutation
        // when an ignored file or symlink would block a file/directory required by
        // the snapshot. Ignored directories are preserved unless the snapshot
        // needs that exact path to be a file.
        const targetParents = new Set<string>()
        for (const snapshotPath of target) {
          const parts = snapshotPath.split('/')
          let parent=''
          for (let i=0;i<parts.length-1;i++) {
            parent=parent ? `${parent}/${parts[i]}` : parts[i]
            targetParents.add(parent)
          }
        }
        for (const file of ignored) {
          if (directories.includes(file)) {
            if (target.has(file)) {
              throw new Error(`Cannot restore snapshot safely: ignored path '${file}' conflicts with snapshot path '${file}'`)
            }
            continue
          }
          const parts=file.split('/')
          let ancestor=''
          for (let i=0;i<parts.length;i++) {
            ancestor=ancestor ? `${ancestor}/${parts[i]}` : parts[i]
            if (target.has(ancestor)) {
              throw new Error(`Cannot restore snapshot safely: ignored path '${file}' conflicts with snapshot path '${ancestor}'`)
            }
          }
          if (targetParents.has(file)) {
            const blocked=snapshotParentsFirst(target,file)
            throw new Error(`Cannot restore snapshot safely: ignored path '${file}' blocks snapshot path '${blocked}'`)
          }
        }

        for (const file of current) {
          if (!target.has(file) && !ignored.has(file)) {
            await fs.rm(path.join(this.options.root, file), { force: true, recursive: true })
            await removeEmptyParents(this.options.root, file)
          }
        }
        // Empty, non-ignored directories can also block a snapshot path that
        // changes directory -> file. Remove them bottom-up, never recursively.
        for (const dir of directories.sort((a,b)=>b.split('/').length-a.split('/').length)) {
          if (target.has(dir) || targetParents.has(dir) || ignored.has(dir)) continue
          try { await fs.rmdir(path.join(this.options.root, dir)) } catch (error) {
            const code=(error as {code?:string}).code
            if (code!=='ENOENT' && code!=='ENOTEMPTY' && code!=='EEXIST') throw error
          }
        }
        await runGit(this.repo, this.options.root, index, ['checkout-index', '-a', '-f'])
      } finally {
        await fs.rm(index, { force: true })
      }
    })
  }

  async exists(snapshotId: string) {
    if (!SNAPSHOT_ID.test(snapshotId)) return false
    return await this.withLock(async () => {
      await this.initUnlocked()
      const index=this.tempIndex()
      try { await runGit(this.repo, this.options.root, index, ['show-ref', '--verify', '--quiet', this.snapshotRef(snapshotId)]); return true } catch { return false } finally { await fs.rm(index,{force:true}) }
    })
  }
}
