import { type ReactNode } from 'react'
import { classNames } from '../domain'
import { activityStatusMeta, type ActivityStatus } from '../app/status'

const statusClassNames: Record<ActivityStatus, string> = {
  idle: 'is-idle',
  preparing: 'is-preparing',
  ready: 'is-ready',
  stale: 'is-stale',
  blocked: 'is-blocked',
  error: 'is-error',
  cancelled: 'is-cancelled',
}

export function VigoBrandMark() {
  return (
    <span className="vigo-brand-mark" aria-hidden="true">
      <img className="vigo-brand-mark-source is-light" src="/vigo-mark-transparent.png" alt="" />
      <img className="vigo-brand-mark-source is-dark" src="/vigo-mark-dark.png" alt="" />
    </span>
  )
}

export function IconButton({
  children,
  label,
  active,
  onClick,
  disabled,
}: {
  children: ReactNode
  label: string
  active?: boolean
  onClick?: () => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      className={classNames('icon-button', active && 'is-active')}
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  )
}

export function StatusBadge({
  status,
  label,
  title,
}: {
  status: ActivityStatus
  label?: string
  title?: string
}) {
  const meta = activityStatusMeta(status)
  return (
    <span
      className={classNames('status-badge', statusClassNames[status])}
      data-status={status}
      title={title}
    >
      {label ?? meta.label}
    </span>
  )
}

export function ResultMetric({
  value,
  label,
  detail,
}: {
  value: ReactNode
  label: ReactNode
  detail?: ReactNode
}) {
  return (
    <div className="result-metric">
      <strong>{value}</strong>
      <span>{label}</span>
      {detail ? <small>{detail}</small> : null}
    </div>
  )
}
