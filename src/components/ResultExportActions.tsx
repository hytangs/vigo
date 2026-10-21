import { Check, Download } from 'lucide-react'
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { downloadText } from '../app/download'
import type { ResultExportFormat, ResultFile } from '../app/resultExports'

const formatChoices: Record<ResultExportFormat, { name: string; detail: string }> = {
  json: { name: 'JSON', detail: 'Full record' },
  geojson: { name: 'GeoJSON', detail: 'Map geometry' },
  csv: { name: 'CSV', detail: 'Spreadsheet' },
  md: { name: 'Markdown', detail: 'Readable itinerary' },
}

/** One download button. Its menu names each format, and says why one is unavailable. */
export function ResultExportActions({ label, formats = ['json', 'geojson', 'csv'], disabled = false, unavailable = {}, resultKey, onExport }: {
  label: string
  formats?: ResultExportFormat[]
  disabled?: boolean
  unavailable?: Partial<Record<ResultExportFormat, string>>
  resultKey?: unknown
  onExport: (format: ResultExportFormat) => ResultFile
}) {
  const [open, setOpen] = useState(false)
  const [feedback, setFeedback] = useState<{ error?: boolean; text: string; resultKey: unknown } | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const id = useId()
  useEffect(() => { setFeedback(null) }, [resultKey, disabled])
  useEffect(() => { if (disabled) setOpen(false) }, [disabled])
  useEffect(() => {
    if (!open) return
    root.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus()
    const close = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false) }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [open])
  useEffect(() => {
    if (!confirmed) return
    const timer = window.setTimeout(() => setConfirmed(false), 1600)
    return () => window.clearTimeout(timer)
  }, [confirmed])
  const currentFeedback = feedback?.resultKey === resultKey && !disabled ? feedback : null

  function save(format: ResultExportFormat) {
    setOpen(false)
    trigger.current?.focus()
    try {
      const result = onExport(format)
      downloadText(result.name, result.text, result.type)
      setFeedback({ text: `Download started: ${result.name}`, resultKey })
      setConfirmed(true)
    } catch (error) {
      setFeedback({ error: true, text: error instanceof Error ? error.message : 'Could not prepare this download. Try again.', resultKey })
    }
  }

  function moveFocus(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape' || event.key === 'Tab') {
      if (event.key === 'Escape') event.preventDefault()
      setOpen(false)
      trigger.current?.focus()
      return
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')]
    const index = items.indexOf(document.activeElement as HTMLButtonElement)
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
      : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
    items[next]?.focus()
  }

  return <div className="result-export-actions" role="group" aria-label={label} ref={root}>
    <button ref={trigger} type="button" className="kit-icon-button result-export-trigger" disabled={disabled}
      aria-label={label} title={disabled ? `${label} when the result is complete` : label}
      aria-haspopup="menu" aria-expanded={open} aria-controls={open ? `${id}-menu` : undefined}
      aria-describedby={currentFeedback ? `${id}-feedback` : undefined}
      onClick={() => setOpen(value => !value)}
      onKeyDown={event => { if (event.key === 'ArrowDown' && !open) { event.preventDefault(); setOpen(true) } }}>
      {confirmed ? <Check size={15} aria-hidden="true" /> : <Download size={15} aria-hidden="true" />}
    </button>
    {open ? <div id={`${id}-menu`} className="result-export-menu" role="menu" aria-label={`${label} format`} onKeyDown={moveFocus}>
      {formats.map(format => {
        const reason = unavailable[format]
        return <button key={format} type="button" role="menuitem" data-format={format} disabled={Boolean(reason)}
          aria-label={`${label} as ${format.toUpperCase()}`} title={reason} onClick={() => save(format)}>
          <strong>{formatChoices[format].name}</strong>
          <small>{reason || formatChoices[format].detail}</small>
        </button>
      })}
    </div> : null}
    {currentFeedback ? <small id={`${id}-feedback`} className={currentFeedback.error ? 'result-export-feedback is-error' : 'result-export-feedback'}
      role={currentFeedback.error ? 'alert' : 'status'}>{currentFeedback.text}</small> : null}
  </div>
}
