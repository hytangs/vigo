import { quietMapLabel } from './presentation'
import { Activity, ChevronDown, Download, FileArchive, Navigation2, Radio, RefreshCw, TableProperties, XCircle } from 'lucide-react'
import { useRef, type DragEvent, type ReactNode } from 'react'
import { requestDesktopGtfsFile, requestDesktopOsmFile } from '../../app/desktopBridge'
import { getTableProfiles, hasOperationsData } from '../../app/projectState'
import type { RealtimeInspectRequest } from '../../app/realtime'
import { classNames, formatNumber, type FeedSummary, type JobRecord, type RealtimeSnapshot, type VigoProject } from '../../domain'
import { RealtimePanel } from '../RealtimePanel'

export type CityImportProps = {
  staticFeeds: VigoProject['feeds']
  osmDelete?: ReactNode
  isImporting: boolean
  isOsmImporting: boolean
  gtfsJob?: JobRecord
  osmJob?: JobRecord
  importMessage: string
  gtfsError?: string
  osmError?: string
  osmStreetReady: boolean
  osmStreetMessage: string
  realtimeSnapshot: RealtimeSnapshot | null
  realtimeMessage: string
  realtimeRequest: RealtimeInspectRequest | null
  isRealtimeLoading: boolean
  onFiles: (files: FileList | File[]) => void
  onNationalGtfsPath: (path: string) => void
  onNationalOsmPath: (path: string) => void
  onOsmFiles: (files: FileList | File[]) => void
  onConnectRealtime: (request: RealtimeInspectRequest) => void
  onDisconnectRealtime: () => void
  onCancelGtfs: () => void
  onRetryGtfs: () => void
  onCancelOsm: () => void
  onRetryOsm: () => void
}

export function ImportPanel(props: CityImportProps & { library?: (chooseGtfs: () => void) => ReactNode }) {
  const { staticFeeds, osmDelete, isImporting, isOsmImporting, gtfsJob, osmJob, importMessage, gtfsError, osmError,
    osmStreetReady, osmStreetMessage, realtimeSnapshot, realtimeMessage, realtimeRequest, isRealtimeLoading,
    onFiles, onNationalGtfsPath, onNationalOsmPath, onOsmFiles, onConnectRealtime, onDisconnectRealtime,
    onCancelGtfs, onRetryGtfs, onCancelOsm, onRetryOsm, library } = props
  const fileRef = useRef<HTMLInputElement>(null)
  const osmFileRef = useRef<HTMLInputElement>(null)
  const chooseGtfs = () => { if (!isImporting && !requestDesktopGtfsFile(onNationalGtfsPath)) fileRef.current?.click() }
  const chooseOsm = () => { if (!isOsmImporting && !requestDesktopOsmFile(onNationalOsmPath)) osmFileRef.current?.click() }
  const gtfsFailed = gtfsJob?.status === 'failed' || gtfsJob?.status === 'cancelled'
  const osmFailed = osmJob?.status === 'failed' || osmJob?.status === 'cancelled'
  const liveAttention = Boolean(realtimeMessage || realtimeSnapshot?.feeds?.some(feed => feed.error)
    || (realtimeSnapshot && realtimeSnapshot.freshness?.status !== 'fresh'))
  const liveLabel = isRealtimeLoading ? 'Connecting…' : liveAttention ? 'Needs attention' : realtimeSnapshot ? 'Connected' : 'Optional'
  function handleDrop(event: DragEvent<HTMLElement>) {
    event.preventDefault()
    if (!isImporting && event.dataTransfer.files.length) onFiles(event.dataTransfer.files)
  }
  return <section className="import-panel city-data-import" aria-label="City sources" onDragOver={event => event.preventDefault()} onDrop={handleDrop}>
    <input ref={fileRef} hidden type="file" accept=".zip,application/zip" onChange={event => {
      if (event.currentTarget.files) onFiles(event.currentTarget.files)
      event.currentTarget.value = ''
    }} />
    {library ? library(chooseGtfs) : <button type="button" className={classNames('drop-zone', isImporting && 'is-working')} onClick={chooseGtfs} disabled={isImporting}>
      <FileArchive size={22} /><span><strong>Add timetable</strong><span>Choose or drop a GTFS ZIP</span></span>
    </button>}
    {isImporting || gtfsFailed || gtfsError ? <div className="city-import-status" role="status">
      <span>{gtfsError || importMessage || (isImporting ? 'Preparing timetable…' : 'Timetable preparation did not finish.')}</span>
      <button type="button" className="import-job-action" onClick={isImporting ? onCancelGtfs : gtfsError ? chooseGtfs : onRetryGtfs}>
        {isImporting ? <XCircle size={14} /> : <RefreshCw size={14} />}{isImporting ? 'Cancel' : gtfsError ? 'Choose file' : 'Retry'}
      </button>
    </div> : null}
    <section className="city-shared-data" aria-label="Shared City data">
      <div className={classNames('osm-import-strip', osmStreetReady && 'has-osm')}>
        <Navigation2 size={19} aria-hidden="true" />
        <span className="city-shared-copy"><strong>Street network</strong><small>{isOsmImporting ? 'Preparing…' : osmFailed || osmError ? 'Needs attention' : osmStreetReady ? 'Shared by all groups' : 'Add an OSM PBF'}</small></span>
        <button type="button" onClick={chooseOsm} disabled={isOsmImporting}>{osmStreetReady ? 'Replace' : 'Add streets'}</button>
        {osmDelete}
        <input ref={osmFileRef} hidden type="file" accept=".osm.pbf,.pbf,application/octet-stream" onChange={event => {
          if (event.currentTarget.files) onOsmFiles(event.currentTarget.files)
          event.currentTarget.value = ''
        }} />
      </div>
      {isOsmImporting || osmFailed || osmError ? <div className="city-import-status" role="status"><span>{osmError || osmStreetMessage || 'Preparing street network…'}</span>
        <button type="button" className="import-job-action" onClick={isOsmImporting ? onCancelOsm : osmError ? chooseOsm : onRetryOsm}>
          {isOsmImporting ? <XCircle size={14} /> : <RefreshCw size={14} />}{isOsmImporting ? 'Cancel' : osmError ? 'Choose file' : 'Retry'}
        </button>
      </div> : null}
      <details className="city-live-disclosure">
        <summary><Radio size={19} aria-hidden="true" /><span>Live updates</span><small className={liveAttention ? 'city-data-warning' : undefined}>{liveLabel}</small><ChevronDown size={16} /></summary>
        <RealtimePanel staticFeeds={staticFeeds} snapshot={realtimeSnapshot} request={realtimeRequest} message={realtimeMessage}
          loading={isRealtimeLoading} onConnect={onConnectRealtime} onDisconnect={onDisconnectRealtime} />
      </details>
    </section>
    {!staticFeeds.length ? <details className="city-example-disclosure"><summary>Start with Boston <ChevronDown size={14} /></summary>
      <section className="network-import-example" aria-label="Boston example files">
        <p>Download, then add the files above.</p>
        <div>
          <a href="https://cdn.mbta.com/MBTA_GTFS.zip" target="_blank" rel="noopener noreferrer" download="MBTA_GTFS.zip"><Download size={16} /><span>MBTA timetable <small>GTFS ZIP</small></span></a>
          <a href="https://drive.google.com/uc?export=download&amp;id=1EiCPazDU8PNi2-swpe9poI2C5tOuJ-q7" target="_blank" rel="noopener noreferrer"><Download size={16} /><span>Boston streets <small>OSM PBF</small></span></a>
        </div>
      </section>
    </details> : null}
  </section>
}

export function EmptyOperationsStart({ project, onOpenNetwork, ...props }: Omit<CityImportProps, 'staticFeeds'> & { project: VigoProject; onOpenNetwork: () => void }) {
  return <div className="workbench empty-workbench empty-intake">
    <section className="surface-source-intake" aria-labelledby="surface-source-intake-title">
      <div className="surface-source-intake-copy"><span className="eyebrow">City data</span>
        <h1 id="surface-source-intake-title">Set up {quietMapLabel(project.name)}</h1>
        <p>Add a timetable and a street network to begin.</p>
      </div>
      <ImportPanel {...props} staticFeeds={project.feeds} />
      {hasOperationsData(project) ? <button type="button" className="button button-primary" disabled={props.isImporting || props.isOsmImporting} onClick={onOpenNetwork}>Open network</button> : null}
    </section>
  </div>
}

export function FeedTables({
  activeFeed,
}: {
  activeFeed: FeedSummary
}) {
  const tableProfiles = getTableProfiles(activeFeed)
  const requiredTables = tableProfiles.filter((profile) => profile.role === 'required')
  const optionalTables = tableProfiles.filter((profile) => profile.role === 'optional')
  const requiredPresent = requiredTables.filter((profile) => profile.present).length
  const optionalPresent = optionalTables.filter((profile) => profile.present).length
  const tidesSignals = activeFeed.tides?.signals ?? []

  return (
    <section className="surface-panel feed-table-panel" aria-label="Source table inventory">
      <div className="panel-heading">
        <div>
          <h2>Tables</h2>
          <p>{requiredPresent}/{requiredTables.length} required · {optionalPresent}/{optionalTables.length} optional</p>
        </div>
        <TableProperties size={16} />
      </div>

      <div className="feed-table-list" role="list">
        {tableProfiles.map((profile) => (
          <div
            key={profile.name}
            className={classNames('feed-table-row', !profile.present && 'is-missing', profile.name.startsWith('TIDES') && 'is-tides')}
            role="listitem"
          >
            <span>
              <strong>{profile.name}</strong>
              <small>{profile.fields.length ? profile.fields.slice(0, 4).join(', ') : profile.present ? 'profiled' : 'not present'}</small>
            </span>
            <span className="feed-table-status">
              <em>{profile.role}</em>
              <b>{profile.present ? formatNumber(profile.rowCount) : 'Not in feed'}</b>
            </span>
          </div>
        ))}
      </div>

      {tidesSignals.length ? (
        <div className="tides-signal-strip">
          <Activity size={14} />
          <span>{tidesSignals.slice(0, 3).join(' / ')}</span>
        </div>
      ) : null}
    </section>
  )
}
