/**
 * Small terminal selection model guided by TermAgent the reusable Select
 * component. It deliberately contains no renderer or platform-specific code.
 * The UI owns the model and decides how the focused option is painted.
 */
export type SelectOption<T extends string = string> = {
  value: T
  label: string
  description?: string
  key?: string
}

export type SelectAction<T extends string = string> =
  | { type: 'move'; index: number; value: T }
  | { type: 'submit'; index: number; value: T }
  | { type: 'cancel' }
  | null

export class SelectModel<T extends string = string> {
  private index = 0

  constructor(private readonly options: SelectOption<T>[]) {
    if (options.length === 0) throw new Error('SelectModel requires at least one option')
  }

  get selectedIndex() { return this.index }
  get selected() { return this.options[this.index]! }

  setSelected(index: number) {
    this.index = wrapIndex(index, this.options.length)
    return this.selected
  }

  move(delta: number) {
    if (!this.options.length) return this.selected
    this.index = wrapIndex(this.index + delta, this.options.length)
    return this.selected
  }

  handleKey(key: string): SelectAction<T> {
    if (key === 'up' || key === 'k') return this.moved(-1)
    if (key === 'down' || key === 'j') return this.moved(1)
    if (key === 'home') return this.movedTo(0)
    if (key === 'end') return this.movedTo(this.options.length - 1)
    if (key === 'enter' || key === ' ') return { type: 'submit', index: this.index, value: this.selected.value }
    if (key === 'escape' || key === 'ctrl+c') return { type: 'cancel' }

    const normalized = key.toLowerCase()
    const keyed = this.options.findIndex(option => option.key?.toLowerCase() === normalized)
    if (keyed >= 0) {
      this.index = keyed
      return { type: 'submit', index: keyed, value: this.selected.value }
    }

    return null
  }

  private moved(delta: number): SelectAction<T> {
    const previous = this.index
    this.move(delta)
    return previous === this.index ? null : { type: 'move', index: this.index, value: this.selected.value }
  }

  private movedTo(index: number): SelectAction<T> {
    const previous = this.index
    this.setSelected(index)
    return previous === this.index ? null : { type: 'move', index: this.index, value: this.selected.value }
  }
}

function wrapIndex(index: number, length: number) {
  if (length <= 0) return 0
  return ((index % length) + length) % length
}
