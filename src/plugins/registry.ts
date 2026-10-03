import path from 'node:path'
import { promises as fs } from 'node:fs'
import { exists } from '../util/fs.js'
import { readPluginManifest } from './manifest.js'
import type { PluginPackage } from './types.js'

async function isDirectory(candidate: string): Promise<boolean> {
  try {
    return (await fs.stat(candidate)).isDirectory()
  } catch {
    return false
  }
}

async function inspectCandidate(root: string, source: PluginPackage['source'], errors: Array<{ path: string; error: string }>, packages: PluginPackage[], seen: Set<string>) {
  const resolved = path.resolve(root)
  if (!await isDirectory(resolved)) return
  const hasManifest = await exists(path.join(resolved, '.claude-plugin', 'plugin.json')) || await exists(path.join(resolved, '.termagent-plugin', 'plugin.json'))
  if (hasManifest) {
    if (seen.has(resolved)) return
    try {
      const result = await readPluginManifest(resolved)
      seen.add(resolved)
      packages.push({ manifest: result.manifest, manifestPath: result.manifestPath, manifestLocation: result.location, root: resolved, source })
    } catch (error) {
      const manifestPath = (await exists(path.join(resolved, '.claude-plugin', 'plugin.json')))
        ? path.join(resolved, '.claude-plugin', 'plugin.json')
        : path.join(resolved, '.termagent-plugin', 'plugin.json')
      errors.push({ path: manifestPath, error: (error as Error).message })
    }
    return
  }

  let entries: any[]
  try {
    entries = await fs.readdir(resolved, { withFileTypes: true })
  } catch (error) {
    errors.push({ path: resolved, error: `Unable to inspect plugin directory: ${(error as Error).message}` })
    return
  }
  // Only inspect direct child directories. Marketplace/package roots are explicit;
  // recursive scanning would unexpectedly discover nested vendored packages.
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const child = path.join(resolved, entry.name)
    const childHasManifest = await exists(path.join(child, '.claude-plugin', 'plugin.json')) || await exists(path.join(child, '.termagent-plugin', 'plugin.json'))
    if (childHasManifest) await inspectCandidate(child, source, errors, packages, seen)
  }
}

export async function discoverPluginPackages(cwd: string, configured: string[] = []): Promise<{ packages: PluginPackage[]; errors: Array<{ path: string; error: string }> }> {
  const projectRoot = path.join(cwd, '.termagent', 'plugins')
  const userRoot = path.join(process.env.HOME || cwd, '.termagent', 'plugins')
  const candidates: Array<{ path: string; source: PluginPackage['source'] }> = [
    { path: projectRoot, source: 'project' },
    { path: userRoot, source: 'user' },
    ...configured.map(p => ({ path: path.resolve(cwd, p), source: 'configured' as const })),
  ]
  const packages: PluginPackage[] = []
  const errors: Array<{ path: string; error: string }> = []
  const seen = new Set<string>()
  for (const candidate of candidates) await inspectCandidate(candidate.path, candidate.source, errors, packages, seen)
  return { packages, errors }
}
