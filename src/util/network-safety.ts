import dns from 'node:dns'
import { isIP } from 'node:net'

export type HostClass =
  | 'loopback'
  | 'link-local'
  | 'cgnat'
  | 'private'
  | 'reserved'
  | 'multicast'
  | 'unspecified'
  | 'public'
  | 'unknown'

const HOST_DANGER_ORDER: Record<HostClass, number> = {
  loopback: 8,
  unspecified: 7,
  'link-local': 6,
  reserved: 5,
  multicast: 4,
  cgnat: 3,
  private: 2,
  public: 0,
  unknown: 9,
}

function ipv4Octets(ip: string): number[] {
  const parts = ip.split('.')
  if (parts.length !== 4) return []
  const octets: number[] = []
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return []
    const value = Number(part)
    if (value > 255) return []
    octets.push(value)
  }
  return octets
}

function ipv6ToNormalized(ip: string): string {
  let host = ip.trim().toLowerCase()
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1)
  const zone = host.indexOf('%')
  if (zone >= 0) host = host.slice(0, zone)
  return host
}

export function hostClassOf(ip: string): HostClass {
  if (isIP(ip) === 4) {
    const octets = ipv4Octets(ip)
    if (octets.length !== 4) return 'unknown'
    const [a, b] = octets
    if (a === 0) return 'unspecified'
    if (a === 127) return 'loopback'
    if (a === 10) return 'private'
    if (a === 169 && b === 254) return 'link-local'
    if (a === 172 && b >= 16 && b <= 31) return 'private'
    if (a === 192 && b === 168) return 'private'
    if (a === 100 && b >= 64 && b <= 127) return 'cgnat'
    if (a === 192 && b === 0) return 'reserved'
    if (a === 192 && b === 0 && octets[2] === 2) return 'reserved'
    if (a === 198 && (b === 18 || b === 19)) return 'reserved'
    if (a === 198 && b === 51 && octets[2] === 100) return 'reserved'
    if (a === 203 && b === 0 && octets[2] === 113) return 'reserved'
    if (a >= 224 && a <= 239) return 'multicast'
    if (a >= 240) return 'reserved'
    return 'public'
  }
  if (isIP(ip) === 6) {
    const host = ipv6ToNormalized(ip)
    if (host === '::' || host === '0:0:0:0:0:0:0:0') return 'unspecified'
    if (host === '::1' || host === '0:0:0:0:0:0:0:1') return 'loopback'
    if (host.startsWith('fe80:') || host.startsWith('fe8:')) return 'link-local'
    if (host.startsWith('fec0:') || host.startsWith('fec:')) return 'reserved'
    if (host.startsWith('fc') || host.startsWith('fd')) return 'private'
    if (host.startsWith('ff')) return 'multicast'
    const mapped = host.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
    if (mapped) return hostClassOf(mapped[1]!)
    if (host.startsWith('64:ff9b:')) return 'reserved'
    return 'public'
  }
  return 'unknown'
}

function isPublicClass(hostClass: HostClass): boolean {
  return hostClass === 'public'
}

export async function resolveHostClass(host: string): Promise<HostClass> {
  if (isIP(host)) return hostClassOf(host)
  let addresses: string[] = []
  try {
    const result = await dns.promises.lookup(host, { all: true })
    addresses = result.map(entry => entry.address)
  } catch {
    return 'unknown'
  }
  if (!addresses.length) return 'unknown'
  let worst: HostClass = 'public'
  for (const address of addresses) {
    const hostClass = hostClassOf(address)
    if (HOST_DANGER_ORDER[hostClass]! > HOST_DANGER_ORDER[worst]!) worst = hostClass
  }
  return worst
}

export function assertPublicHttpTarget(raw: string): { url: URL; hostClass: HostClass } {
  let url: URL
  try {
    url = new URL(String(raw))
  } catch {
    throw new Error(`Invalid URL: ${raw}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Unsupported URL protocol: ${url.protocol}. Only http and https are allowed.`)
  }
  if (url.username || url.password) {
    throw new Error('URLs with embedded credentials are not allowed')
  }
  if (!url.hostname) throw new Error(`URL has no host: ${raw}`)
  if (url.port === '0') throw new Error('URL port 0 is not allowed')
  return { url, hostClass: 'public' }
}

export interface NetworkTargetDecision {
  ok: boolean
  reason?: string
  hostClass?: HostClass
  host?: string
}

export async function decideNetworkTarget(raw: string): Promise<NetworkTargetDecision> {
  let parsed: { url: URL; hostClass: HostClass }
  try {
    parsed = assertPublicHttpTarget(raw)
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
  const host = parsed.url.hostname
  let hostClass: HostClass
  try {
    hostClass = await resolveHostClass(host)
  } catch {
    return { ok: false, reason: `Could not resolve host: ${host}`, host }
  }
  if (!isPublicClass(hostClass)) {
    return {
      ok: false,
      reason: `Network target ${host} resolves to a non-public address class (${hostClass}) and is blocked`,
      hostClass,
      host,
    }
  }
  return { ok: true, hostClass, host }
}
