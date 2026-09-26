import { useEffect, useState } from 'react'
import { AlertTriangle, Plus, Radio, RefreshCw, X } from 'lucide-react'
import { classNames, formatNumber, type RealtimeSnapshot } from '../domain'
import { maximumRealtimeSources, mbtaRealtimeSources, realtimeRefreshMs, realtimeRequestFromSources, realtimeSources,
  type RealtimeSource, type RealtimeInspectRequest } from '../app/realtime'

function fieldsFromRequest(request: RealtimeInspectRequest | null): RealtimeSource[] {
  if (request) { try { return realtimeSources(request) } catch { /* Invalid saved URLs remain disconnected. */ } }
  return [{ url: '', kind: 'feed' }]
}

function sourceName(url: string) {
  try { return new URL(url).hostname } catch { return 'GTFS Realtime' }
}

export function RealtimePanel({ snapshot, request, staticFeeds = [], message, loading, onConnect, onDisconnect }: {
  snapshot: RealtimeSnapshot | null
  request: RealtimeInspectRequest | null
  staticFeeds?: Array<{ id: string; name: string }>
  message: string
  loading: boolean
  onConnect: (request: RealtimeInspectRequest) => void
  onDisconnect: () => void
}) {
  const [sources, setSources] = useState(() => fieldsFromRequest(request))
  const [validationError, setValidationError] = useState('')
  useEffect(() => { if (request) setSources(fieldsFromRequest(request)) }, [request])
  const error = validationError || message
  const stale = snapshot?.freshness?.status === 'stale'
  const failed = snapshot?.feeds?.filter(feed => feed.error).length ?? 0
  const allFailed = failed > 0 && failed === snapshot?.feeds?.length
  const status = loading ? 'Connecting…' : allFailed ? 'Connection failed' : failed ? 'Some feeds failed'
    : error ? 'Refresh failed' : stale ? 'Stale feed' : snapshot?.freshness?.status === 'unknown' ? 'Feed age unknown'
      : snapshot ? 'Connected' : 'Not connected'
  function changeSource(index: number, update: Partial<RealtimeSource>) {
    setSources(current => current.map((source, i) => i === index ? { ...source, ...update } : source))
    setValidationError('')
  }

  return (
    <section className="realtime-panel" aria-label="Live data">
      <header className="realtime-heading">
        <div><Radio size={16} /><strong>GTFS-RT live feeds</strong></div>
        <span className={classNames('realtime-status', snapshot?.freshness?.status === 'fresh' && !error && !failed && 'is-connected', Boolean(error || stale || failed) && 'needs-attention')} role="status">
          <i aria-hidden="true" />{status}
        </span>
      </header>
      <p className="realtime-description">Connect trip predictions, vehicle positions, or alerts. Match each endpoint to its timetable when combining agencies.</p>
      {snapshot ? (
        <div className="realtime-connection">
          <dl className="realtime-counts">
            <div><dt>Vehicles</dt><dd>{formatNumber(snapshot.counts.vehicles)}</dd></div>
            <div><dt>Trip updates</dt><dd>{formatNumber(snapshot.counts.tripUpdates)}</dd></div>
            <div><dt>Alerts</dt><dd>{formatNumber(snapshot.counts.alerts)}</dd></div>
          </dl>
          <p>Last received <time dateTime={snapshot.fetchedAt}>{new Date(snapshot.fetchedAt).toLocaleTimeString()}</time> · Checks every {realtimeRefreshMs / 1_000}s while open</p>
          <details className="realtime-feed-health"><summary>Feed status ({snapshot.feeds?.length ?? 1})</summary>
            {snapshot.feeds?.map((feed, index) => <p key={index} className={feed.error || feed.freshness?.status === 'stale' ? 'realtime-warning' : undefined}>
              <strong>{staticFeeds.find(source => source.id === feed.sourceScope)?.name ?? sourceName(feed.sourceUrl)}</strong>
              {' · '}{feed.kind === 'tripUpdates' ? 'Trip updates' : feed.kind === 'vehicles' ? 'Vehicles' : feed.kind === 'alerts' ? 'Alerts' : 'Combined feed'}
              {' · '}{feed.error || (feed.freshness?.status === 'fresh' ? 'Fresh' : feed.freshness?.status === 'stale' ? 'Stale' : 'Age unknown')}
            </p>)}
          </details>
        </div>
      ) : null}
      <form onSubmit={event => {
        event.preventDefault()
        if (loading) return
        try {
          if (staticFeeds.length > 1 && sources.some(source => !source.sourceScope)) throw new Error('Choose the matching timetable for every live feed.')
          const nextRequest = realtimeRequestFromSources(sources)
          setValidationError(''); onConnect(nextRequest)
        } catch (nextError) { setValidationError(nextError instanceof Error ? nextError.message : 'Check the feed URLs.') }
      }}>
        <div className="realtime-preset"><span>Quick setup </span><button type="button" disabled={loading} onClick={() => {
          setSources(mbtaRealtimeSources.map(source => ({ ...source, ...(staticFeeds.length === 1 ? { sourceScope: staticFeeds[0].id } : {}) })))
          setValidationError('')
        }}>MBTA · Boston</button></div>
        {sources.map((source, index) => <fieldset className="realtime-fields" key={index} disabled={loading} aria-label={`Live feed ${index + 1}`}>
          <legend>Feed {index + 1}</legend>
          <label><span>GTFS-RT URL</span><input aria-label={`GTFS-RT URL ${index + 1}`} type="url" autoComplete="off" spellCheck={false} value={source.url} placeholder="https://…/TripUpdates.pb" required onChange={event => changeSource(index, { url: event.target.value })} /></label>
          <div className="realtime-feed-options">
            <label><span>Contains</span><select value={source.kind ?? 'feed'} aria-label={`Feed type ${index + 1}`} onChange={event => changeSource(index, { kind: event.target.value as RealtimeSource['kind'] })}>
              <option value="feed">Combined / automatic</option><option value="tripUpdates">Trip updates</option><option value="vehicles">Vehicle positions</option><option value="alerts">Service alerts</option>
            </select></label>
            {staticFeeds.length > 0 ? <label><span>Timetable</span><select aria-label={`Timetable ${index + 1}`} value={source.sourceScope ?? ''} required={staticFeeds.length > 1} onChange={event => changeSource(index, { sourceScope: event.target.value || undefined })}>
              <option value="">{staticFeeds.length === 1 ? 'Automatic' : 'Choose timetable'}</option>
              {staticFeeds.map(feed => <option key={feed.id} value={feed.id}>{feed.name}</option>)}
            </select></label> : null}
            {sources.length > 1 ? <button className="button button-secondary" type="button" aria-label={`Remove live feed ${index + 1}`} onClick={() => setSources(current => current.filter((_, i) => i !== index))}><X size={14} /></button> : null}
          </div>
        </fieldset>)}
        <button className="button button-secondary" type="button" disabled={loading || sources.length >= maximumRealtimeSources} onClick={() => setSources(current => [...current, { url: '', kind: 'feed' }])}><Plus size={14} />Add feed</button>
        {error ? <div className="realtime-error" role="alert"><AlertTriangle size={15} /><div>{error}</div></div> : null}
        <div className="realtime-actions">
          <button className="button button-primary" type="submit" disabled={loading || sources.some(source => !source.url.trim())}>
            {snapshot ? <RefreshCw size={14} /> : <Radio size={14} />}{loading ? 'Connecting…' : snapshot ? 'Update connection' : 'Connect live'}
          </button>
          {snapshot ? <button className="button button-secondary" type="button" onClick={() => { setValidationError(''); onDisconnect() }}>Disconnect</button> : null}
        </div>
      </form>
    </section>
  )
}
