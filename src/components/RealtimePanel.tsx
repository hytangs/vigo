import { useEffect, useState } from 'react'
import { AlertTriangle, Radio, RefreshCw } from 'lucide-react'
import { classNames, formatNumber, type RealtimeSnapshot } from '../domain'
import {
  mbtaRealtimeFeeds,
  realtimeRefreshMs,
  realtimeRequestFromFields,
  type RealtimeFeedFields,
  type RealtimeInspectRequest,
} from '../app/realtime'

function fieldsFromRequest(request: RealtimeInspectRequest | null): RealtimeFeedFields {
  if (!request) return { vehicles: '', tripUpdates: '', alerts: '' }
  if ('url' in request) return { vehicles: request.url, tripUpdates: '', alerts: '' }
  return { vehicles: request.urls.vehicles, tripUpdates: request.urls.tripUpdates ?? '', alerts: request.urls.alerts ?? '' }
}

function sourceName(snapshot: RealtimeSnapshot | null) {
  const urls = snapshot?.sourceUrls ?? (snapshot?.sourceUrl ? [snapshot.sourceUrl] : [])
  const hosts = [...new Set(urls.flatMap((value) => {
    try { return [new URL(value).hostname] } catch { return [] }
  }))]
  if (hosts.length === 1 && hosts[0] === 'cdn.mbta.com') return 'MBTA · Boston'
  return hosts.join(', ') || 'GTFS Realtime'
}

export function RealtimePanel({ snapshot, request, message, loading, onConnect, onDisconnect }: {
  snapshot: RealtimeSnapshot | null
  request: RealtimeInspectRequest | null
  message: string
  loading: boolean
  onConnect: (request: RealtimeInspectRequest) => void
  onDisconnect: () => void
}) {
  const [fields, setFields] = useState(() => fieldsFromRequest(request))
  const [validationError, setValidationError] = useState('')
  useEffect(() => {
    if (request) setFields(fieldsFromRequest(request))
  }, [request])
  const error = validationError || message
  const stale = snapshot?.freshness?.status === 'stale'
  const status = loading ? 'Connecting…'
    : error ? (snapshot ? 'Refresh failed' : 'Connection failed')
      : stale ? 'Stale feed'
        : snapshot ? 'Connected' : 'Not connected'
  const usingMbta = Object.entries(mbtaRealtimeFeeds).every(([key, url]) => fields[key as keyof RealtimeFeedFields] === url)

  return (
    <section className="realtime-panel" aria-label="Live data">
      <header className="realtime-heading">
        <div><Radio size={16} /><strong>Live data</strong></div>
        <span className={classNames('realtime-status', snapshot && !error && !stale && 'is-connected', (error || stale) && 'needs-attention')} role="status">
          <i aria-hidden="true" />{status}
        </span>
      </header>
      <p className="realtime-description">Vehicle locations, trip updates, and service alerts.</p>

      {snapshot ? (
        <div className="realtime-connection">
          <strong>{sourceName(snapshot)}</strong>
          <dl className="realtime-counts">
            <div><dt>Vehicles</dt><dd>{formatNumber(snapshot.counts.vehicles)}</dd></div>
            <div><dt>Trip updates</dt><dd>{formatNumber(snapshot.counts.tripUpdates)}</dd></div>
            <div><dt>Alerts</dt><dd>{formatNumber(snapshot.counts.alerts)}</dd></div>
          </dl>
          <p>Last received <time dateTime={snapshot.fetchedAt}>{new Date(snapshot.fetchedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time> · Refreshes every {realtimeRefreshMs / 1_000}s</p>
          {stale ? <p className="realtime-warning">The feed is stale{typeof snapshot.freshness?.ageSeconds === 'number' ? ` (${Math.round(snapshot.freshness.ageSeconds)}s old)` : ''}. Vehicle locations may be out of date.</p> : null}
          {snapshot.freshness?.status === 'unknown' ? <p>Feed age unavailable.</p> : null}
        </div>
      ) : null}

      <form onSubmit={(event) => {
        event.preventDefault()
        if (loading) return
        try {
          const nextRequest = realtimeRequestFromFields(fields)
          setValidationError('')
          onConnect(nextRequest)
        } catch (nextError) {
          setValidationError(nextError instanceof Error ? nextError.message : 'Check the feed URLs.')
        }
      }}>
        <div className="realtime-preset">
          <span>Quick setup</span>
          <button type="button" aria-pressed={usingMbta} disabled={loading} onClick={() => {
            setFields({ ...mbtaRealtimeFeeds })
            setValidationError('')
          }}>MBTA · Boston</button>
        </div>
        <fieldset className="realtime-fields" aria-label="Live feed URLs" disabled={loading}>
          <label>
            <span>Vehicle positions <small>or viewer link</small></span>
            <input aria-label="Vehicle positions or viewer URL" type="text" inputMode="url" autoComplete="off" spellCheck={false} value={fields.vehicles} placeholder="https://…/VehiclePositions.pb" required onChange={(event) => { setFields({ ...fields, vehicles: event.target.value }); setValidationError('') }} />
          </label>
          <label>
            <span>Trip updates <small>optional</small></span>
            <input aria-label="Trip updates URL" type="url" autoComplete="off" spellCheck={false} value={fields.tripUpdates} placeholder="https://…/TripUpdates.pb" onChange={(event) => { setFields({ ...fields, tripUpdates: event.target.value }); setValidationError('') }} />
          </label>
          <label>
            <span>Service alerts <small>optional</small></span>
            <input aria-label="Service alerts URL" type="url" autoComplete="off" spellCheck={false} value={fields.alerts} placeholder="https://…/Alerts.pb" onChange={(event) => { setFields({ ...fields, alerts: event.target.value }); setValidationError('') }} />
          </label>
        </fieldset>
        {error ? (
          <div className="realtime-error" role="alert">
            <AlertTriangle size={15} />
            <div>{error}{snapshot ? <p>The last received data remains visible.</p> : null}</div>
          </div>
        ) : null}
        <div className="realtime-actions">
          <button className="button button-primary" type="submit" disabled={loading || !fields.vehicles.trim()}>
            {snapshot ? <RefreshCw size={14} /> : <Radio size={14} />}
            {loading ? 'Connecting…' : error ? 'Retry connection' : snapshot ? 'Update connection' : 'Connect live'}
          </button>
          {snapshot ? <button className="button button-secondary" type="button" onClick={() => { setValidationError(''); onDisconnect() }}>Disconnect</button> : null}
        </div>
      </form>
    </section>
  )
}
