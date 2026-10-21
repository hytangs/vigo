import { RefreshCw, X } from 'lucide-react'

export function ImportJobAction({ running, label, onClick }: { running: boolean; label: string; onClick: () => void }) {
  return <button type="button" className="import-job-action" onClick={onClick}
    aria-label={label} title={label}
    style={running ? { width: 32, minWidth: 32, height: 32, padding: 0, flex: '0 0 32px' } : { flexShrink: 0, whiteSpace: 'nowrap' }}>
    {running ? <X size={16} aria-hidden="true" /> : <><RefreshCw size={14} aria-hidden="true" />{label}</>}
  </button>
}
