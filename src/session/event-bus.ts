import type { DurableEventEnvelope, LiveEventEnvelope } from '../protocol/types.js'

type Wake = {
  dirty: boolean
  waiter?: () => void
  closed: boolean
  live: LiveEventEnvelope[]
  liveOverflowed: boolean
}

const MAX_PENDING_LIVE_EVENTS = 128

/**
 * Runtime-owned session event hub.
 *
 * Durable events are only wakeups: readers replay the append-only session log
 * by sequence. Live events are deliberately ephemeral and bounded per client;
 * durable completion events remain the recovery mechanism if a slow client
 * cannot consume every transient delta.
 */
export class SessionEventBus {
  private readonly subscribers = new Map<string, Set<Wake>>()

  subscribe(sessionId: string) {
    const wake: Wake = { dirty: false, closed: false, live: [], liveOverflowed: false }
    let set = this.subscribers.get(sessionId)
    if (!set) {
      set = new Set()
      this.subscribers.set(sessionId, set)
    }
    set.add(wake)

    const signal = () => {
      wake.dirty = true
      wake.waiter?.()
    }

    return {
      waitForChange: async (timeoutMs?: number): Promise<boolean> => {
        if (wake.closed) return false
        if (wake.dirty) {
          wake.dirty = false
          return true
        }
        return await new Promise<boolean>((resolve) => {
          let timer: ReturnType<typeof setTimeout> | undefined
          const finish = (changed: boolean) => {
            if (wake.waiter === onSignal) wake.waiter = undefined
            if (timer) clearTimeout(timer)
            resolve(changed && !wake.closed)
          }
          const onSignal = () => {
            wake.dirty = false
            finish(true)
          }
          wake.waiter = onSignal
          if (Number.isFinite(timeoutMs) && Number(timeoutMs) > 0) {
            timer = setTimeout(() => finish(false), Math.max(1, Number(timeoutMs)))
          }
        })
      },
      /** Drain buffered transient frames and report when older frames were dropped. */
      drainLiveWithGap: (): { events: LiveEventEnvelope[]; overflowed: boolean } => {
        const result = { events: wake.live, overflowed: wake.liveOverflowed }
        wake.live = []
        wake.liveOverflowed = false
        return result
      },
      /** Backwards-compatible frame-only drain. */
      drainLive: (): LiveEventEnvelope[] => {
        const result = wake.live
        wake.live = []
        wake.liveOverflowed = false
        return result
      },
      close: () => {
        if (wake.closed) return
        wake.closed = true
        wake.live = []
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

  publishLive(event: LiveEventEnvelope): void {
    const current = this.subscribers.get(event.sessionId)
    if (!current) return
    for (const wake of current) {
      if (wake.closed) continue

      const previous = wake.live.at(-1)
      const previousPayload = previous?.payload && typeof previous.payload === 'object'
        ? previous.payload as Record<string, unknown>
        : undefined
      const nextPayload = event.payload && typeof event.payload === 'object'
        ? event.payload as Record<string, unknown>
        : undefined
      const canCoalesce = previous && previous.kind === event.kind
        && (event.kind === 'session.text.delta' || event.kind === 'session.reasoning.delta')
        && previousPayload?.streamId === nextPayload?.streamId
        && typeof previousPayload?.delta === 'string'
        && typeof nextPayload?.delta === 'string'

      if (canCoalesce) {
        wake.live[wake.live.length - 1] = {
          ...event,
          payload: { ...nextPayload, delta: String(previousPayload!.delta) + String(nextPayload!.delta) },
        }
      } else {
        if (wake.live.length >= MAX_PENDING_LIVE_EVENTS) {
          wake.live.shift()
          wake.liveOverflowed = true
        }
        wake.live.push(event)
      }

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
