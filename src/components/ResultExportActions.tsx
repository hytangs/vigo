import { Download } from 'lucide-react'
import { useEffect, useId, useState } from 'react'
import { downloadText } from '../app/download'
import type { ResultExportFormat, ResultFile } from '../app/resultExports'

const formatLabels: Record<ResultExportFormat, string> = {
  json: 'JSON · full record', geojson: 'GeoJSON · map geometry', csv: 'CSV · spreadsheet', md: 'Markdown · itinerary',
}

export function ResultExportActions({ label, buttonLabel = 'Save', formats = ['json', 'geojson', 'csv'], disabled = false, unavailable = {}, resultKey, onExport }: {
  label: string
  buttonLabel?: string
  formats?: ResultExportFormat[]
  disabled?: boolean
  unavailable?: Partial<Record<ResultExportFormat, string>>
  resultKey?: unknown
  onExport: (format: ResultExportFormat) => ResultFile
}) {
  const [format, setFormat] = useState<ResultExportFormat>(formats[0])
  const [feedback, setFeedback] = useState<{ error?: boolean; text: string; resultKey: unknown } | null>(null)
  const messageId = useId()
  useEffect(() => { setFeedback(null) }, [resultKey, disabled])
  const selected = formats.includes(format) ? format : formats[0]
  const reason = unavailable[selected]
  const currentFeedback = feedback?.resultKey === resultKey && !disabled ? feedback : null

  function save() {
    if (disabled || reason) return
    try {
      const result = onExport(selected)
      downloadText(result.name, result.text, result.type)
      setFeedback({ text: `Download started: ${result.name}`, resultKey })
    } catch (error) {
      setFeedback({ error: true, text: error instanceof Error ? error.message : 'Could not prepare this download. Try again.', resultKey })
    }
  }

  return <div className="result-export-actions" role="group" aria-label={label}>
    <div className="result-export-controls">
      <select aria-label={`${label} format`} value={selected} disabled={disabled}
        aria-describedby={reason || currentFeedback ? messageId : undefined}
        onChange={event => { setFormat(event.target.value as ResultExportFormat); setFeedback(null) }}>
        {formats.map(value => <option key={value} value={value}>{formatLabels[value]}</option>)}
      </select>
      <button type="button" disabled={disabled || Boolean(reason)} title={reason}
        aria-label={`${label} as ${selected.toUpperCase()}`} onClick={save}>
        <Download size={13} aria-hidden="true" />{buttonLabel}
      </button>
    </div>
    {reason || currentFeedback ? <small id={messageId} className={currentFeedback?.error ? 'is-error' : undefined}
      role={currentFeedback?.error ? 'alert' : 'status'}>{reason || currentFeedback?.text}</small> : null}
  </div>
}
