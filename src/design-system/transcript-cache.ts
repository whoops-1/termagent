export type TranscriptRenderCacheKey = string

export type TranscriptRenderResult<T> = {
  lines: T[]
  metadata?: unknown
}

type Cached<T> = {
  revision: number
  result: TranscriptRenderResult<T>
}

/**
 * Weakly keyed cache for immutable-or-versioned transcript entries.
 * The cache avoids redoing expensive message transforms for rows that
 * have not changed. TermAgent entries are mutable, so the caller supplies an
 * explicit revision that invalidates only the changed entry.
 */
export class TranscriptRenderCache<T> {
  private cache = new WeakMap<object, Map<TranscriptRenderCacheKey, Cached<T>>>()
  private hits = 0
  private misses = 0

  getOrRender(
    entry: object,
    key: TranscriptRenderCacheKey,
    revision: number,
    render: () => TranscriptRenderResult<T>,
  ): TranscriptRenderResult<T> {
    let byKey = this.cache.get(entry)
    if (!byKey) {
      byKey = new Map()
      this.cache.set(entry, byKey)
    }
    const cached = byKey.get(key)
    if (cached && cached.revision === revision) {
      this.hits++
      return cached.result
    }
    this.misses++
    const result = render()
    byKey.set(key, { revision, result })
    return result
  }

  clear() {
    this.cache = new WeakMap()
    this.hits = 0
    this.misses = 0
  }

  stats() { return { hits: this.hits, misses: this.misses } }
}
