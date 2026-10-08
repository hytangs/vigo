import { useEffect, useRef, useState } from 'react'
import { ArrowUpRight, ChevronDown, Folder, Layers, Plus, X } from 'lucide-react'
import { cityReadiness } from '../../app/cityReadiness'
import { caseFeedSelection, type CityDataGroup, type CityDataGrouping } from '../../app/useCityDataGroups'
import { classNames, formatNumber, type VigoProject } from '../../domain'
import type { ScenarioDraft } from '../../reach'
import { CitySourceDelete } from '../CitySourceDelete'
import { FeedTables, ImportPanel, type CityImportProps } from './CitySources'

function GroupEditor({ group, project, cases, grouping, onClose }: {
  group: CityDataGroup; project: VigoProject; cases: ScenarioDraft[]; grouping: CityDataGrouping; onClose: () => void
}) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [name, setName] = useState(group.name)
  const [feedIds, setFeedIds] = useState(group.feedIds)
  const [removing, setRemoving] = useState(false)
  const existing = grouping.value.groups.some(entry => entry.id === group.id)
  const caseCount = cases.filter(entry => grouping.value.cases[entry.id] === group.id).length
  useEffect(() => { dialogRef.current?.showModal() }, [])
  return <dialog ref={dialogRef} className="city-group-dialog" onCancel={onClose} onClose={onClose} aria-labelledby="city-group-title">
    <form onSubmit={event => { event.preventDefault(); grouping.saveGroup(group.id, name, feedIds); onClose() }}>
      <header><h2 id="city-group-title">{removing ? 'Remove group?' : existing ? 'Edit group' : 'New group'}</h2>
        <button type="button" className="city-data-icon" aria-label="Close group editor" onClick={onClose}><X size={18} /></button></header>
      {removing ? <p>Timetable files stay in this City.{caseCount ? ` Choose a new group for ${caseCount === 1 ? 'its case' : `its ${caseCount} cases`} before running analysis.` : ''}</p> : <>
        <label className="city-group-name">Name<input autoFocus required maxLength={80} value={name} placeholder="e.g. Weekday service" onChange={event => setName(event.target.value)} /></label>
        <fieldset><legend>Timetables</legend>
          {project.feeds.map(feed => <label className="city-group-feed" key={feed.id}><input type="checkbox" checked={feedIds.includes(feed.id)} onChange={() => setFeedIds(current => current.includes(feed.id) ? current.filter(id => id !== feed.id) : [...current, feed.id])} /><span>{feed.name}</span></label>)}
          {feedIds.filter(id => !project.feeds.some(feed => feed.id === id)).map(id => <label className="city-group-feed city-data-warning" key={id}><input type="checkbox" checked onChange={() => setFeedIds(current => current.filter(value => value !== id))} /><span>Removed timetable · {id}</span></label>)}
          {!project.feeds.length ? <p>Add GTFS files to this City first.</p> : null}
        </fieldset>
        <p className="city-data-note">Cases in this group use these timetables together.</p>
      </>}
      <footer>
        {existing ? <button type="button" className="city-data-remove" onClick={() => {
          if (removing) { grouping.removeGroup(group.id); onClose() } else setRemoving(true)
        }}>{removing ? 'Remove group' : 'Remove…'}</button> : <span />}
        <div><button type="button" className="button button-secondary" onClick={removing ? () => setRemoving(false) : onClose}>{removing ? 'Back' : 'Cancel'}</button>
          {!removing ? <button type="submit" className="button button-primary" disabled={!name.trim()}>Save group</button> : null}</div>
      </footer>
    </form>
  </dialog>
}

type CityDataSourcesProps = Omit<CityImportProps, 'staticFeeds'> & {
  project: VigoProject
  grouping: CityDataGrouping
  cases: ScenarioDraft[]
  deletingDisabled: boolean
  onSourceDeleted: (project: VigoProject) => void
  onAddCase: (groupId: string) => void
  onRenameCase: (id: string, name: string) => void
  onOpenCase: (id: string) => void
}

export function CityDataSources({ project, grouping, cases, deletingDisabled, onSourceDeleted, onAddCase, onRenameCase, onOpenCase, ...importProps }: CityDataSourcesProps) {
  const [view, setView] = useState<'feeds' | 'cases'>('feeds')
  const [filter, setFilter] = useState('')
  const [editor, setEditor] = useState<CityDataGroup | null>(null)
  const { groups } = grouping.value
  const selected = groups.find(group => group.id === filter)
  const feeds = project.feeds.filter(feed => !selected || selected.feedIds.includes(feed.id))
  const filteredCases = cases.filter(entry => !selected || grouping.value.cases[entry.id] === selected.id)
  const readiness = cityReadiness(project)
  return <div className="city-data-library">
    {readiness.state !== 'ready' ? <div className="city-data-topline"><span className="city-data-state">{readiness.label}</span></div> : null}
    {grouping.error ? <p className="city-data-error" role="alert">{grouping.error} <button type="button" onClick={grouping.retry}>Retry</button></p> : null}
    <div className="city-data-groups" aria-label="Feed groups">
      <div className="city-group-filters" role="group" aria-label="Filter by group">
        <button type="button" aria-pressed={!selected} onClick={() => setFilter('')}>All data</button>
        {groups.map(group => <button key={group.id} type="button" aria-pressed={group.id === selected?.id} onClick={() => setFilter(group.id)}><Folder size={14} />{group.name}</button>)}
      </div>
      <button type="button" className="city-data-text-action" disabled={grouping.readFailed || groups.length >= 64} onClick={() => setEditor({ id: crypto.randomUUID(), name: '', feedIds: [] })}><Plus size={15} />New group</button>
    </div>
    <ImportPanel {...importProps} staticFeeds={project.feeds} library={chooseGtfs => <section className="city-data-list-panel" aria-label="Timetables and cases">
      <header className="city-data-toolbar">
        <div className="city-data-switch" role="group" aria-label="Show data">
          <button type="button" aria-pressed={view === 'feeds'} onClick={() => setView('feeds')}>Timetables <small>{feeds.length}</small></button>
          <button type="button" aria-pressed={view === 'cases'} onClick={() => setView('cases')}>Cases <small>{filteredCases.length}</small></button>
        </div>
        <div className="city-data-actions">
          {selected ? <button type="button" className="city-data-text-action" disabled={grouping.readFailed} onClick={() => setEditor(selected)}>Edit group</button> : null}
          {view === 'feeds' ? <button type="button" className="button button-secondary" onClick={chooseGtfs} disabled={importProps.isImporting}><Plus size={15} />Add GTFS</button>
            : <button type="button" className="button button-secondary" disabled={grouping.readFailed || cases.length >= 6 || !groups.length} onClick={() => onAddCase(selected?.id ?? groups[0].id)}><Plus size={15} />Add case</button>}
        </div>
      </header>
      {view === 'feeds' ? <div className="city-feed-list">
        {feeds.map(feed => {
          const memberships = groups.filter(group => group.feedIds.includes(feed.id))
          const state = feed.routingStore?.routingEligibility === 'unsupported' ? 'Unsupported data'
            : feed.routingStore?.status === 'ready' ? 'Ready' : feed.routingStore?.status === 'failed' ? 'Needs attention' : 'Preparing'
          return <details className="city-feed-entry" key={feed.id}>
            <summary><span className="city-data-row-icon"><Layers size={18} /></span><span className="city-feed-copy"><strong>{feed.name}</strong>
              <small>{memberships.length ? memberships.map(group => group.name).join(' · ') : 'No group'}</small></span>
              <span className={classNames('city-feed-state', state === 'Ready' && 'is-ready')}>{state}</span><ChevronDown size={16} /></summary>
            <div className="city-feed-detail">
              <div className="city-feed-metadata"><span>{formatNumber(feed.routeCount)} routes · {formatNumber(feed.stopCount)} stops · {formatNumber(feed.tripCount)} trips</span>
                <CitySourceDelete projectId={project.id} kind="gtfs" feedId={feed.id} name={feed.name} disabled={deletingDisabled} onDeleted={onSourceDeleted} /></div>
              <fieldset className="city-feed-memberships"><legend>Groups</legend>{groups.map(group => <label key={group.id}><input type="checkbox" checked={group.feedIds.includes(feed.id)} disabled={grouping.readFailed} onChange={() => grouping.toggleFeed(group.id, feed.id)} />{group.name}</label>)}</fieldset>
              {feed.warnings.length ? <details className="city-feed-inspection"><summary>Source notes · {feed.warnings.length}</summary><ul>{feed.warnings.map((warning, index) => <li key={index}>{warning.message}</li>)}</ul></details> : null}
              <details className="city-feed-inspection"><summary>Inspect tables</summary><FeedTables activeFeed={feed} /></details>
            </div>
          </details>
        })}
        {!feeds.length ? <div className="city-data-empty"><Layers size={24} /><p>{selected ? 'No timetables in this group.' : 'Add your first timetable.'}</p>
          <button type="button" className="city-data-text-action" disabled={grouping.readFailed || importProps.isImporting} onClick={selected ? () => setEditor(selected) : chooseGtfs}>{selected ? 'Choose timetables' : 'Add GTFS'}</button></div> : null}
      </div> : <div className="city-case-list">
        {filteredCases.map(entry => {
          const selection = caseFeedSelection(grouping.value, entry.id, project)
          return <div className="city-case-entry" key={entry.id}>
            <span className="city-data-row-icon"><Folder size={18} /></span>
            <div className="city-case-copy"><input aria-label={`Case name: ${entry.name}`} maxLength={80} value={entry.name} onChange={event => onRenameCase(entry.id, event.target.value)} onBlur={() => { if (!entry.name.trim()) onRenameCase(entry.id, 'Untitled case') }} />
              <small className={selection.error ? 'city-data-warning' : undefined}>{selection.error || `${selection.feedIds.length} timetable${selection.feedIds.length === 1 ? '' : 's'} · ${entry.interventions.length ? `${entry.interventions.length} change${entry.interventions.length === 1 ? '' : 's'}` : 'No changes'}`}</small></div>
            <select aria-label={`Feed group for ${entry.name}`} value={selection.group?.id ?? ''} disabled={grouping.readFailed} onChange={event => grouping.assignCase(entry.id, event.target.value)}>
              <option value="" disabled>Choose group</option>{groups.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}</select>
            <button type="button" className="city-data-icon" aria-label={`Open ${entry.name}`} title="Open case" onClick={() => onOpenCase(entry.id)}><ArrowUpRight size={19} /></button>
          </div>
        })}
        {!filteredCases.length ? <div className="city-data-empty"><Folder size={24} /><p>No cases in this group.</p><button type="button" className="city-data-text-action" disabled={grouping.readFailed || cases.length >= 6 || !groups.length} onClick={() => onAddCase(selected?.id ?? groups[0].id)}>Add case</button></div> : null}
      </div>}
    </section>} />
    {editor ? <GroupEditor key={editor.id} group={editor} project={project} cases={cases} grouping={grouping} onClose={() => setEditor(null)} /> : null}
  </div>
}
