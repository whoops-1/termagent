export type HitTarget = {
  id: string
  x: number
  y: number
  width: number
  height?: number
  priority?: number
  disabled?: boolean
  allowWhileBusy?: boolean
  onActivate?: () => void | Promise<void>
}

export type HitDispatchOptions = {
  busy?: boolean
}

/** Semantic interaction registry. Rendering registers intent, input dispatches
 * coordinates into intent. This keeps mouse/touch behavior independent from
 * ANSI strings and leaves room for future Web/VS Code clients. */
export class HitTargetRegistry {
  private targets: HitTarget[] = []

  clear() { this.targets = [] }

  register(target: HitTarget) {
    if (target.width <= 0 || (target.height ?? 1) <= 0) return
    this.targets.push({ ...target })
  }

  registerMany(targets: readonly HitTarget[]) {
    for (const target of targets) this.register(target)
  }

  list() { return this.targets.map(target => ({ ...target })) }

  hitTest(x: number, y: number, options: HitDispatchOptions = {}) {
    let best: HitTarget | undefined
    for (const target of this.targets) {
      if (target.disabled) continue
      if (options.busy && !target.allowWhileBusy) continue
      const height = Math.max(1, target.height ?? 1)
      if (x < target.x || x >= target.x + target.width || y < target.y || y >= target.y + height) continue
      if (!best || (target.priority ?? 0) >= (best.priority ?? 0)) best = target
    }
    return best
  }

  async dispatch(x: number, y: number, options: HitDispatchOptions = {}) {
    const target = this.hitTest(x, y, options)
    if (!target) return false
    await target.onActivate?.()
    return true
  }
}
