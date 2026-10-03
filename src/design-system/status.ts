export type UIStatus = 'pending' | 'working' | 'waiting' | 'done' | 'failed' | 'cancelled'

export type StatusDescriptor = {
  label: string
  marker: string
}

const STATUS: Readonly<Record<UIStatus, StatusDescriptor>> = {
  pending: { label: 'pending', marker: '[ ]' },
  working: { label: 'working', marker: '[>]' },
  waiting: { label: 'waiting', marker: '[!]' },
  done: { label: 'done', marker: '[x]' },
  failed: { label: 'failed', marker: '[!]' },
  cancelled: { label: 'cancelled', marker: '[~]' },
}

export function statusDescriptor(status: UIStatus) {
  return STATUS[status]
}

export function todoStatus(status: 'pending' | 'in_progress' | 'done'): UIStatus {
  if (status === 'done') return 'done'
  if (status === 'in_progress') return 'working'
  return 'pending'
}

export function toolStatus(options: { running?: boolean; waiting?: boolean; failed?: boolean }): UIStatus {
  if (options.failed) return 'failed'
  if (options.waiting) return 'waiting'
  if (options.running) return 'working'
  return 'done'
}

export function activityStatus(phase: string): UIStatus {
  switch (phase) {
    case 'permission':
    case 'question':
      return 'waiting'
    case 'done':
      return 'done'
    case 'error':
      return 'failed'
    case 'thinking':
    case 'reasoning':
    case 'writing':
    case 'tool':
    case 'retrying':
    case 'compacting':
      return 'working'
    default:
      return 'pending'
  }
}
