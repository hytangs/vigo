import { feedIdentity, quietMapLabel } from './presentation'

import {
  Activity,
  Database,
  Download,
  FileArchive,
  Navigation2,
  RefreshCw,
  TableProperties,
  XCircle,
  type LucideIcon,
} from 'lucide-react'
import { useRef, type DragEvent, type ReactNode } from 'react'
import { requestDesktopGtfsFile, requestDesktopOsmFile } from '../../app/desktopBridge'
import { bundleFeed, bundleFeedId, getTableProfiles, hasOperationsData, requiredTableNames } from '../../app/projectState'
import { type RealtimeInspectRequest } from '../../app/realtime'
import { statusFromJobStatus, statusFromStoreStatus, type ActivityStatus } from '../../app/status'
import type { JobRecord } from '../../domain'
import { classNames, formatNumber, type FeedSummary, type RealtimeSnapshot, type VigoProject } from '../../domain'
import { CitySourceDelete } from '../CitySourceDelete'
import { RealtimePanel } from '../RealtimePanel'
import { StatusBadge } from '../UiPrimitives'

const readinessStateClasses: Record<ActivityStatus, string> = {
  idle: 'state-idle',
  preparing: 'state-preparing',
  ready: 'state-ready',
  stale: 'state-stale',
  blocked: 'state-blocked',
  error: 'state-error',
  cancelled: 'state-cancelled',
}

export function ImportPanel({
  staticFeeds,
  osmDelete,
  isImporting,
  isOsmImporting,
  gtfsJob,
  osmJob,
  importMessage,
  osmStreetReady,
  osmStreetMessage,
  realtimeSnapshot,
  realtimeMessage,
  realtimeRequest,
  isRealtimeLoading,
  onFiles,
  onNationalGtfsPath,
  onNationalOsmPath,
  onOsmFiles,
  onConnectRealtime,
  onDisconnectRealtime,
  onCancelGtfs,
  onRetryGtfs,
  onCancelOsm,
  onRetryOsm,
}: {
  staticFeeds: VigoProject['feeds']
  osmDelete?: ReactNode
  isImporting: boolean
  isOsmImporting: boolean
  gtfsJob?: JobRecord
  osmJob?: JobRecord
  importMessage: string
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
}) {
  const fileRef = useRef<HTMLInputElement | null>(null)
  const osmFileRef = useRef<HTMLInputElement | null>(null)
  const chooseGtfs = () => {
    if (!requestDesktopGtfsFile(onNationalGtfsPath)) fileRef.current?.click()
  }
  const chooseOsm = () => {
    if (!requestDesktopOsmFile(onNationalOsmPath)) osmFileRef.current?.click()
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault()
    if (!isImporting && event.dataTransfer.files.length) onFiles(event.dataTransfer.files)
  }

  return (
    <section className="surface-panel import-panel" aria-label="Feed import">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">Import</span>
          <h2>Add data</h2>
        </div>
      </div>

      <div
        className={classNames('drop-zone', isImporting && 'is-working')}
        onDragOver={(event) => event.preventDefault()}
        onDrop={handleDrop}
        onClick={() => {
          if (!isImporting) chooseGtfs()
        }}
        onKeyDown={(event) => {
          if (isImporting || (event.key !== 'Enter' && event.key !== ' ')) return
          event.preventDefault()
          chooseGtfs()
        }}
        role="button"
        tabIndex={0}
        aria-disabled={isImporting}
      >
        <input
          ref={fileRef}
          onClick={(event) => event.stopPropagation()}
          hidden
          type="file"
          accept=".zip,application/zip"
          onChange={(event) => {
            if (event.currentTarget.files) onFiles(event.currentTarget.files)
            event.currentTarget.value = ''
          }}
        />
        <FileArchive size={22} />
        <div>
          <strong>{isImporting ? 'Importing GTFS…' : 'Add GTFS'}</strong>
          <span>{importMessage || 'Choose or drop a GTFS ZIP from any city'}</span>
        </div>
        {isImporting ? (
          <button type="button" className="import-job-action" onClick={(event) => { event.stopPropagation(); onCancelGtfs() }}>
            <XCircle size={14} />
            Cancel
          </button>
        ) : gtfsJob?.status === 'failed' || gtfsJob?.status === 'cancelled' ? (
          <button type="button" className="import-job-action" onClick={(event) => { event.stopPropagation(); onRetryGtfs() }}>
            <RefreshCw size={14} />
            Retry
          </button>
        ) : null}
      </div>

      <div className={classNames('osm-import-strip', osmStreetReady && 'has-osm')}>
        <button type="button" onClick={chooseOsm} disabled={isOsmImporting}>
          <Navigation2 size={15} />
          <span>
            <strong>{isOsmImporting ? 'Indexing OSM…' : osmStreetReady ? 'OSM indexed' : 'OSM streets'}</strong>
            <small>{osmStreetMessage || (osmStreetReady ? 'SQLite street index ready' : 'OSM PBF')}</small>
          </span>
        </button>
        {isOsmImporting ? (
          <button type="button" className="import-job-action" onClick={onCancelOsm}>
            <XCircle size={14} />
            Cancel
          </button>
        ) : osmJob?.status === 'failed' || osmJob?.status === 'cancelled' ? (
          <button type="button" className="import-job-action" onClick={onRetryOsm}>
            <RefreshCw size={14} />
            Retry
          </button>
        ) : null}
        {osmDelete}
        <input
          ref={osmFileRef}
          hidden
          type="file"
          accept=".osm.pbf,.pbf,application/octet-stream"
          onChange={(event) => {
            if (event.currentTarget.files) onOsmFiles(event.currentTarget.files)
            event.currentTarget.value = ''
          }}
        />
      </div>

      <RealtimePanel
        staticFeeds={staticFeeds}
        snapshot={realtimeSnapshot}
        request={realtimeRequest}
        message={realtimeMessage}
        loading={isRealtimeLoading}
        onConnect={onConnectRealtime}
        onDisconnect={onDisconnectRealtime}
      />

      <section className="network-import-example" aria-label="Boston example files">
        <h3>Try Boston</h3>
        <p>Download these example files, then add them above.</p>
        <div>
          <a href="https://cdn.mbta.com/MBTA_GTFS.zip" target="_blank" rel="noopener noreferrer" download="MBTA_GTFS.zip"><Download size={16} aria-hidden="true" /><span>MBTA timetable <small>GTFS ZIP · routes, stops and schedules</small></span></a>
          <a href="https://drive.google.com/uc?export=download&amp;id=1EiCPazDU8PNi2-swpe9poI2C5tOuJ-q7" target="_blank" rel="noopener noreferrer"><Download size={16} aria-hidden="true" /><span>Boston streets <small>boston.pbf · walking and driving network</small></span></a>
        </div>
        <small>Google Drive may ask you to confirm the PBF download. <a href="https://drive.google.com/file/d/1EiCPazDU8PNi2-swpe9poI2C5tOuJ-q7/view?usp=share_link" target="_blank" rel="noopener noreferrer">View source file</a></small>
      </section>
    </section>
  )
}

export function DataReadinessRail({
  project,
  activeFeed,
}: {
  project: VigoProject
  activeFeed: FeedSummary
}) {
  const tableProfiles = getTableProfiles(activeFeed)
  const requiredProfiles = tableProfiles.filter((profile) => profile.role === 'required')
  const requiredPresent = requiredProfiles.filter((profile) => profile.present).length
  const readyFeedStores = project.feeds.filter((feed) => feed.routingStore?.status === 'ready')
  const routingStore = activeFeed.source === 'bundle' ? project.routingStore : activeFeed.routingStore
  const bundleStoresReady = activeFeed.source === 'bundle' && project.feeds.length > 0 && readyFeedStores.length === project.feeds.length
  const timetableReady = routingStore?.status === 'ready' || bundleStoresReady
  const timetableBuilding = routingStore?.status === 'building' || project.feeds.some((feed) => feed.routingStore?.status === 'building')
  const indexedConnections = routingStore?.status === 'ready'
    ? routingStore.connectionCount
    : readyFeedStores.reduce((sum, feed) => sum + (feed.routingStore?.connectionCount ?? 0), 0)
  const streetStore = project.osmStreetIndex
  const timetableStatus: ActivityStatus = timetableReady
    ? 'ready'
    : timetableBuilding
      ? 'preparing'
      : 'blocked'
  const steps: Array<{
    label: string
    value: string
    detail: string
    state: ActivityStatus
    icon: LucideIcon
  }> = [
    {
      label: 'Source',
      value: `${project.feeds.length} feed${project.feeds.length === 1 ? '' : 's'}`,
      detail: activeFeed.source === 'bundle' ? 'City sources' : activeFeed.name,
      state: project.feeds.length ? 'ready' : 'blocked',
      icon: FileArchive,
    },
    {
      label: 'Tables',
      value: `${requiredPresent}/${requiredProfiles.length || requiredTableNames.length} core`,
      detail: requiredPresent === requiredProfiles.length && requiredProfiles.length ? 'Required GTFS ready' : 'Required files need review',
      state: requiredPresent === requiredProfiles.length && requiredProfiles.length ? 'ready' : 'blocked',
      icon: TableProperties,
    },
    {
      label: 'Timetable',
      value: timetableReady ? 'SQLite ready' : timetableBuilding ? 'Indexing' : 'Needs index',
      detail: timetableReady
        ? `${formatNumber(indexedConnections)} connections`
        : timetableBuilding
          ? 'Building local routing store'
          : 'No ready routing store',
      state: timetableStatus,
      icon: Database,
    },
    {
      label: 'Streets',
      value: streetStore?.status === 'ready' ? 'OSM ready' : streetStore?.status === 'building' ? 'Indexing' : 'Required',
      detail: streetStore?.status === 'ready'
        ? `${formatNumber(streetStore.edgeCount)} directed edges`
        : streetStore?.status === 'building'
          ? 'Building local street network'
          : 'Add OSM for street access',
      state: statusFromStoreStatus(streetStore?.status),
      icon: Navigation2,
    },
  ]

  return (
    <section className="data-readiness-rail" aria-label="Data readiness pipeline">
      {steps.map((step, index) => {
        const Icon = step.icon
        return (
          <div key={step.label} className={classNames('data-readiness-step', readinessStateClasses[step.state])}>
            <span className="data-readiness-index" aria-hidden="true">{index + 1}</span>
            <Icon size={15} aria-hidden="true" />
            <span>
              <small>{step.label}</small>
              <strong>{step.value}</strong>
              <em>{step.detail}</em>
            </span>
          </div>
        )
      })}
    </section>
  )
}

export function BundlePanel({
  deletingDisabled,
  onSourceDeleted,
  project,
  activeFeedId,
  activeFeed,
  onSelectFeed,
}: {
  deletingDisabled: boolean
  onSourceDeleted: (city: VigoProject) => void
  project: VigoProject
  activeFeedId: string
  activeFeed: FeedSummary
  onSelectFeed: (id: string) => void
}) {
  const bundle = bundleFeed(project)

  return (
    <section className="surface-panel bundle-panel" aria-label="City GTFS sources">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">Bundle</span>
          <h2>{project.feeds.length} feed{project.feeds.length === 1 ? '' : 's'}</h2>
        </div>
        <Database size={16} />
      </div>

      <div className="bundle-summary">
        <div><span>{formatNumber(bundle.routeCount)}</span><small>routes</small></div>
        <div><span>{formatNumber(bundle.stopCount)}</span><small>stops</small></div>
        <div><span>{formatNumber(bundle.tripCount)}</span><small>trips</small></div>
      </div>

      <div className="bundle-feed-list">
        <button
          type="button"
          className={classNames('bundle-feed-row', activeFeedId === bundleFeedId && 'is-selected')}
          onClick={() => onSelectFeed(bundleFeedId)}
        >
          <span>
            <strong>Bundle</strong>
            <small>{project.routingStore?.status === 'ready' ? 'City timetable ready' : 'All GTFS in this City'}</small>
          </span>
          <b title={`${bundle.warnings.length} recorded findings`}>{formatNumber(bundle.warnings.length)}</b>
        </button>
        {project.feeds.map((feed) => {
          return (
            <div key={feed.id} className="bundle-source-row">
              <button
                type="button"
                className={classNames('bundle-feed-row', activeFeedId === feed.id && 'is-selected')}
                onClick={() => onSelectFeed(feed.id)}
              >
                <span>
                  <strong>{feed.name}</strong>
                  <small>{feed.routingStore?.status === 'ready' ? 'SQLite ready' : feedIdentity(project.feeds, feed).detail}</small>
                </span>
                <b title={`${feed.warnings.length} recorded findings`}>{formatNumber(feed.warnings.length)}</b>
              </button>
              <CitySourceDelete projectId={project.id} kind="gtfs" feedId={feed.id} name={feed.name} disabled={deletingDisabled} onDeleted={onSourceDeleted} />
            </div>
          )
        })}
      </div>

      <div className="bundle-active">
        <span>{activeFeed.source === 'bundle' ? 'Scope' : 'Feed'}</span>
        <strong>{activeFeed.name}</strong>
      </div>
    </section>
  )
}

function CitySourceStatus({
  icon,
  title,
  detail,
  ready,
  working,
  missingLabel,
  status,
  onChoose,
}: {
  icon: ReactNode
  title: string
  detail: string
  ready: boolean
  working: boolean
  missingLabel: string
  status: ActivityStatus
  onChoose: () => void
}) {
  return (
    <button type="button" onClick={onChoose} disabled={working} className={classNames('surface-source-status', ready && 'is-ready', working && 'is-working')}>
      <span className="surface-source-status-icon">{icon}</span>
      <span className="surface-source-status-copy">
        <strong>{title}</strong>
        <small>{detail}</small>
      </span>
      <StatusBadge status={status} label={ready ? 'Ready' : working ? 'Preparing' : missingLabel} />
    </button>
  )
}

export function EmptyOperationsStart({
  project,
  onOpenNetwork,
  osmStreetReady,
  isImporting,
  isOsmImporting,
  gtfsJob,
  osmJob,
  importMessage,
  osmStreetMessage,
  realtimeSnapshot,
  realtimeMessage,
  realtimeRequest,
  isRealtimeLoading,
  onFiles,
  onNationalGtfsPath,
  onNationalOsmPath,
  onOsmFiles,
  onConnectRealtime,
  onDisconnectRealtime,
  onCancelGtfs,
  onRetryGtfs,
  onCancelOsm,
  onRetryOsm,
}: {
  project: VigoProject
  onOpenNetwork: () => void
  osmStreetReady: boolean
  isImporting: boolean
  isOsmImporting: boolean
  gtfsJob?: JobRecord
  osmJob?: JobRecord
  importMessage: string
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
}) {
  const intakeRef = useRef<HTMLDivElement | null>(null)
  const gtfsReady = hasOperationsData(project)
  const gtfsDetail = isImporting
    ? importMessage || 'Building the local timetable index…'
    : gtfsReady ? 'Timetable indexed and ready' : 'Add a GTFS ZIP to load routes and schedules'
  const osmDetail = osmStreetReady
    ? `${formatNumber(project.osmStreetIndex?.edgeCount ?? 0)} walk edges indexed locally`
    : isOsmImporting
      ? osmStreetMessage || 'Building the local street network…'
      : 'Add an OSM PBF to enable street access'

  return (
    <div ref={intakeRef} className="workbench empty-workbench empty-intake">
      <section className="surface-source-intake" aria-labelledby="surface-source-intake-title">
        <div className="surface-source-intake-copy">
          <span className="eyebrow">City data</span>
          <h1 id="surface-source-intake-title">Build {quietMapLabel(project.name)}</h1>
          <p>Import a GTFS timetable from any city. Add streets and live feeds below.</p>
        </div>

        <div className="surface-source-statuses" aria-label="City sources">
          <CitySourceStatus
            icon={<FileArchive size={18} />}
            onChoose={() => intakeRef.current?.querySelector<HTMLElement>('.drop-zone')?.click()}
            title="GTFS timetable"
            detail={gtfsDetail}
            ready={gtfsReady}
            working={isImporting}
            missingLabel="Required"
            status={statusFromJobStatus(gtfsJob?.status ?? (isImporting ? 'running' : gtfsReady ? 'complete' : 'missing'))}
          />
          <CitySourceStatus
            icon={<Navigation2 size={18} />}
            onChoose={() => intakeRef.current?.querySelector<HTMLButtonElement>('.osm-import-strip button')?.click()}
            title="OSM street network"
            detail={osmDetail}
            ready={osmStreetReady}
            working={isOsmImporting}
            missingLabel="Required"
            status={statusFromJobStatus(osmJob?.status ?? (osmStreetReady ? 'complete' : isOsmImporting ? 'running' : 'idle'))}
          />
        </div>

        <p className="surface-source-hint">
          GTFS supplies scheduled transit. OSM is required for full functionality, including walking and driving routes.
        </p>

        <button type="button" className="button button-primary" disabled={!gtfsReady || isImporting || isOsmImporting} onClick={onOpenNetwork}>Open network</button>

        <ImportPanel
          staticFeeds={project.feeds}
          isImporting={isImporting}
          isOsmImporting={isOsmImporting}
          gtfsJob={gtfsJob}
          osmJob={osmJob}
          importMessage={importMessage}
          osmStreetReady={osmStreetReady}
          osmStreetMessage={osmStreetMessage}
          realtimeSnapshot={realtimeSnapshot}
          realtimeMessage={realtimeMessage}
          realtimeRequest={realtimeRequest}
          isRealtimeLoading={isRealtimeLoading}
          onFiles={onFiles}
          onNationalGtfsPath={onNationalGtfsPath}
          onNationalOsmPath={onNationalOsmPath}
          onOsmFiles={onOsmFiles}
          onConnectRealtime={onConnectRealtime}
          onDisconnectRealtime={onDisconnectRealtime}
          onCancelGtfs={onCancelGtfs}
          onRetryGtfs={onRetryGtfs}
          onCancelOsm={onCancelOsm}
          onRetryOsm={onRetryOsm}
        />
      </section>
    </div>
  )
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
          <span className="eyebrow">Source table inventory</span>
          <h2>{requiredPresent === requiredTables.length && requiredTables.length ? 'Core tables ready' : `${requiredTables.length - requiredPresent} core missing`}</h2>
          <p>{requiredPresent}/{requiredTables.length} required · {optionalPresent}/{optionalTables.length} optional · schema and row counts, not raw records</p>
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
