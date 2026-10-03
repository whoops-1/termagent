#!/usr/bin/env node
import { access, readdir } from 'node:fs/promises'
import { constants } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'

import { fileURLToPath } from 'node:url'

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const allowNonAndroid = process.env.TERMAGENT_ALLOW_NON_ANDROID === '1'
const termux = Boolean(process.env.TERMUX_VERSION)
const platform = process.platform
const arch = process.arch

const fail = (message) => {
  console.error(`✗ ${message}`)
  process.exit(1)
}
const run = (args) => spawnSync(process.execPath, [path.join(root, 'dist/index.js'), ...args], { cwd: root, encoding: 'utf8' })

if (!termux && !allowNonAndroid) fail('run this smoke script inside Termux, or set TERMAGENT_ALLOW_NON_ANDROID=1 for a non-Android rehearsal')
if (Number(process.versions.node.split('.')[0]) < 22) fail(`Node.js >=22 required; found ${process.version}`)
if (termux && platform !== 'android' && platform !== 'linux') fail(`unexpected Termux platform: ${platform}`)
if (termux && !['arm', 'arm64'].includes(arch)) fail(`unsupported Termux architecture: ${arch}`)

const entry = path.join(root, 'dist', 'index.js')
await access(entry, constants.R_OK).catch(() => fail('dist/index.js is missing; install the release bundle or build the project first'))

const distFiles = []
const walk = async (dir) => {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const next = path.join(dir, entry.name)
    if (entry.isDirectory()) await walk(next)
    else distFiles.push(next)
  }
}
await walk(path.join(root, 'dist'))
if (distFiles.some(file => file.endsWith('.node'))) fail('native .node addon found in production dist; ARMv7 release must remain native-addon free')

for (const args of [['--version'], ['--help']]) {
  const result = run(args)
  if (result.status !== 0) fail(`CLI ${args[0]} failed: ${result.stderr || result.stdout}`)
}

const version = run(['--version']).stdout.trim()
const target = termux
  ? (arch === 'arm' ? 'android-armv7' : 'android-arm64')
  : `${platform}-${arch}`

console.log(JSON.stringify({
  ok: true,
  target,
  platform,
  arch,
  node: process.version,
  termux,
  version,
  nativeAddons: distFiles.filter(file => file.endsWith('.node')).length,
}, null, 2))
