export type WorkspaceStatus =
  | 'idle'
  | 'preparing'
  | 'ready'
  | 'stale'
  | 'blocked'
  | 'error'
  | 'cancelled'

export type WorkspaceStatusTone = 'neutral' | 'progress' | 'positive' | 'warning' | 'danger'

export type WorkspaceStatusMeta = {
  label: string
  tone: WorkspaceStatusTone
}

const statusMeta: Record<WorkspaceStatus, WorkspaceStatusMeta> = {
  idle: { label: 'Not ready', tone: 'neutral' },
  preparing: { label: 'Preparing', tone: 'progress' },
  ready: { label: 'Ready', tone: 'positive' },
  stale: { label: 'Rebuild required', tone: 'warning' },
  blocked: { label: 'Blocked', tone: 'warning' },
  error: { label: 'Error', tone: 'danger' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
}

export function workspaceStatusMeta(status: WorkspaceStatus): WorkspaceStatusMeta {
  return statusMeta[status]
}

/** Normalize backend, job, and routing vocabulary before it reaches the UI. */
export function normalizeWorkspaceStatus(value: unknown): WorkspaceStatus {
  switch (String(value ?? '').trim().toLowerCase()) {
    case 'queued':
    case 'running':
    case 'building':
    case 'indexing':
    case 'loading':
    case 'preparing':
      return 'preparing'
    case 'complete':
    case 'completed':
    case 'indexed':
    case 'ready':
      return 'ready'
    case 'stale':
    case 'outdated':
    case 'needs-rebuild':
    case 'rebuild-required':
      return 'stale'
    case 'blocked':
    case 'missing':
    case 'required':
    case 'unsupported':
      return 'blocked'
    case 'cancelled':
    case 'canceled':
      return 'cancelled'
    case 'failed':
    case 'error':
    case 'unavailable':
      return 'error'
    case 'idle':
    case 'empty':
    case 'not-started':
    case '':
      return 'idle'
    default:
      return 'idle'
  }
}

export function statusFromJobStatus(value: unknown): WorkspaceStatus {
  return normalizeWorkspaceStatus(value)
}

export function statusFromStoreStatus(value: unknown): WorkspaceStatus {
  return normalizeWorkspaceStatus(value)
}
