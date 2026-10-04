import type { DurableEventEnvelope } from '../protocol/types.js'

type Wake = {
  dirty: boolean
  waiter?: () => void
  closed: boolean
}

/**
 * Runtime-owned durable session event publisher.
 *
 * The bus is deliberately a wakeup boundary rather than an event store. A
 * subscriber only records that its session became dirty; the session store
 * remains the source of truth and the consumer re-reads durable rows by
 * sequence. This keeps memory bounded and makes coalescing safe: one wake can
 * represent many commits because no durable event is held only in memory.
 */
export class SessionEventBus {
  private readonly subscribers = new Map<string, Set<Wake>>()

  subscribe(sessionId: string) {
    const wake: Wake = { dirty: false, closed: false }
    let set = this.subscribers.get(sessionId)
    if (!set) {
      set = new Set()
      this.subscribers.set(sessionId, set)
    }
    set.add(wake)

    return {
      waitForChange: async (): Promise<boolean> => {
        if (wake.closed) return false
        if (wake.dirty) {
          wake.dirty = false
          return true
        }
        return await new Promise<boolean>((resolve) => {
          wake.waiter = () => {
            wake.waiter = undefined
            if (wake.closed) {
              resolve(false)
              return
            }
            wake.dirty = false
            resolve(true)
          }
        })
      },
      close: () => {
        if (wake.closed) return
        wake.closed = true
        const current = this.subscribers.get(sessionId)
        current?.delete(wake)
        if (current && current.size === 0) this.subscribers.delete(sessionId)
        wake.waiter?.()
      },
    }
  }

  publishDurable(event: DurableEventEnvelope): void {
    const current = this.subscribers.get(event.sessionId)
    if (!current) return
    for (const wake of current) {
      if (wake.closed) continue
      wake.dirty = true
      wake.waiter?.()
    }
  }

  subscriberCount(sessionId?: string): number {
    if (sessionId !== undefined) return this.subscribers.get(sessionId)?.size ?? 0
    let total = 0
    for (const current of this.subscribers.values()) total += current.size
    return total
  }
}
