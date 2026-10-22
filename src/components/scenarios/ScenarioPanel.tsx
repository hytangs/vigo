import { memo, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { Copy, Navigation2, Plus, Radar, Trash2, TriangleAlert, X } from 'lucide-react'
import { maximumScenarioChanges, maximumScenarios } from '../../app/scenarioLibrary'
import { includeScenarioChange } from '../../state/scenarioEditor'
import { countRender } from '../../app/renderCounts'
import type { ScenarioSaveState } from '../../app/useScenarioLibrary'
import { classNames } from '../../domain'
import type { ScenarioChangeDraft, ScenarioChangeKind, ScenarioDraft } from '../../reach'
import { useStudio } from '../../state/hooks'
import { openAnalyzeView, openDataView, openPathfinderView } from '../../state/navigation'
import { routingNetwork } from '../../state/route'
import {
  addScenario,
  addScenarioChange,
  assignScenarioGroup,
  duplicateScenario,
  removeScenario,
  removeScenarioChange,
  renameScenario,
  scenarioRoutes,
  selectScenario,
  selectScenarioChange,
} from '../../state/scenarioEditor'
import { scenarioRequestFor } from '../../state/scenarioRequest'
import { activeCaseFeeds, activeScenario, activeScenarioChange, scenarioLibrary } from '../../state/scenarios'
import { selectedProject } from '../../state/scope'
import { ScenarioNetworkSettings } from '../ScenarioNetworkSettings'
import { ScenarioChangeEditor } from './ScenarioChangeEditor'
import { plural, scenarioChangeKind, scenarioChangeKinds, scenarioFlexZoneCount, scenarioSummary } from './presentation'

const saveLabels: Record<ScenarioSaveState, string> = { loading: 'Loading…', saved: 'Saved', unsaved: 'Edited', saving: 'Saving…', error: 'Not saved', unavailable: 'Not saved' }

/** Which saved scenario is open: one dropdown, its name and a summary. */
function ScenarioSwitcher({ scenario }: { scenario: ScenarioDraft }) {
  const library = useStudio(scenarioLibrary)
  const atLimit = library.scenarioDrafts.length >= maximumScenarios
  return <div className="scenario-switcher kit-group">
    <div className="scenario-switcher-row">
      <select value={scenario.id} aria-label="Scenario" onChange={(event) => selectScenario(event.currentTarget.value)}>
        {library.scenarioDrafts.map((entry) => <option key={entry.id} value={entry.id}>{entry.name || 'Untitled scenario'}</option>)}
      </select>
      <button type="button" className="kit-icon-button" onClick={() => addScenario()} disabled={atLimit} aria-label="New scenario" title="New scenario"><Plus size={15} aria-hidden="true" /></button>
      <button type="button" className="kit-icon-button" onClick={() => duplicateScenario(scenario.id)} disabled={atLimit} aria-label="Duplicate scenario" title="Duplicate"><Copy size={14} aria-hidden="true" /></button>
      <button type="button" className="kit-icon-button" onClick={() => removeScenario(scenario.id)} disabled={library.scenarioDrafts.length <= 1}
        aria-label="Delete scenario" title={library.scenarioDrafts.length <= 1 ? 'A City keeps at least one scenario.' : 'Delete'}><Trash2 size={14} aria-hidden="true" /></button>
    </div>
    <label className="scenario-name-row">
      <span>Name</span>
      <input type="text" value={scenario.name} maxLength={80} aria-label="Scenario name"
        onChange={(event) => renameScenario(scenario.id, event.currentTarget.value)}
        onBlur={(event) => { if (!event.currentTarget.value.trim()) renameScenario(scenario.id, 'Untitled scenario') }} />
    </label>
    <small className="scenario-switcher-summary">{scenarioSummary(scenario, library.grouping.value.groups)}</small>
  </div>
}

/** Which of the City's timetables the scenario combines. */
function ScenarioTimetables({ scenario }: { scenario: ScenarioDraft }) {
  const library = useStudio(scenarioLibrary)
  const project = useStudio(selectedProject)
  const groups = library.grouping.value.groups
  if (!project.feeds.length) return <p className="scenario-hint">Add a GTFS timetable in City data to use the original network.</p>
  return <>
    <ScenarioNetworkSettings scenarioId={scenario.id} />
    {groups.length > 1 ? <label className="reach-field">
      <span>Saved timetable set</span>
      <select value={scenario.groupId ?? ''} onChange={(event) => assignScenarioGroup(scenario.id, event.currentTarget.value)}>
        <option value="" disabled>Choose timetables</option>
        {groups.map((group) => <option key={group.id} value={group.id}>{group.name} · {plural(group.feedIds.length, 'timetable')}</option>)}
      </select>
    </label> : null}
  </>
}

/** "Add" opens a menu of change kinds, keyboard navigable like the export menu. */
function AddChangeMenu({ disabled }: { disabled: boolean }) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const id = useId()
  useEffect(() => {
    if (!open) return
    root.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus()
    const close = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false) }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [open])
  function choose(kind: ScenarioChangeKind) {
    setOpen(false)
    addScenarioChange(kind)
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
    const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
    const index = items.indexOf(document.activeElement as HTMLButtonElement)
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
      : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
    items[next]?.focus()
  }
  return <div className="result-export-actions" ref={root}>
    <button ref={trigger} type="button" className="kit-button scenario-add-trigger" disabled={disabled}
      title={disabled ? `A scenario holds at most ${maximumScenarioChanges} changes.` : 'Add a change'}
      aria-haspopup="menu" aria-expanded={open} aria-controls={open ? `${id}-menu` : undefined}
      onClick={() => setOpen((value) => !value)}
      onKeyDown={(event) => { if (event.key === 'ArrowDown' && !open) { event.preventDefault(); setOpen(true) } }}>
      <Plus size={14} aria-hidden="true" />Add
    </button>
    {open ? <div className="result-export-menu scenario-add-menu" id={`${id}-menu`} role="menu" aria-label="Add a change" onKeyDown={moveFocus}>
      {scenarioChangeKinds.map(({ kind, verb, detail, icon: Icon }) => <button key={kind} type="button" role="menuitem" onClick={() => choose(kind)}>
        <strong><Icon size={14} aria-hidden="true" />{verb}</strong>
        <small>{detail}</small>
      </button>)}
    </div> : null}
  </div>
}

function ChangeRow({ change, active }: { change: ScenarioChangeDraft; active: boolean }) {
  const library = useStudio(scenarioLibrary)
  const uses = library.scenarioDrafts.filter(scenario => scenario.interventions.some(entry => entry.id === change.id)).length
  const kind = scenarioChangeKind(change.kind)
  const routes = useStudio(scenarioRoutes)
  const route = change.routeId ? routes.find((entry) => entry.id === change.routeId || entry.patternId === change.routeId) : undefined
  const detail = change.kind === 'flex-zone' ? plural(change.stops.length, 'corner')
    : change.kind === 'add-line' ? `${plural(change.stops.length, 'stop')}${change.stops.length >= 2 ? ` · every ${change.headwayMinutes} min` : ''}`
      : route ? `${route.shortName || route.longName}${change.kind === 'enhance-line' ? ` · every ${change.headwayMinutes} min` : ''}` : 'Choose a route'
  const Icon = kind.icon
  return <article className={classNames('scenario-change', active && 'is-active')}>
    <div className="scenario-change-row">
      <button type="button" className="scenario-change-head" aria-expanded={active} onClick={() => selectScenarioChange(change.id)}>
        <span className="scenario-change-icon"><Icon size={14} aria-hidden="true" /></span>
        <strong>{change.name || kind.label}</strong>
        <small>{kind.label} · {detail}</small>
      </button>
      <button type="button" className="kit-icon-button scenario-change-remove" onClick={() => removeScenarioChange(change.id)}
        aria-label={`Remove ${change.name || kind.label} from this scenario`} title="Remove from this scenario; keep in change library"><X size={14} aria-hidden="true" /></button>
    </div>
    {active && uses > 1 ? <p className="scenario-shared-note">Shared by {uses} scenarios · edits update all</p> : null}
    {active ? <ScenarioChangeEditor change={change} /> : null}
  </article>
}

function ChangeLibrary({ scenario }: { scenario: ScenarioDraft }) {
  const library = useStudio(scenarioLibrary)
  if (!library.reusableChanges.length) return null
  return <details className="scenario-change-library">
    <summary>Change library <span>{library.reusableChanges.length}</span></summary>
    <div className="scenario-library-list">
      {library.reusableChanges.map(change => {
        const included = scenario.interventions.some(entry => entry.id === change.id)
        const uses = library.scenarioDrafts.filter(entry => entry.interventions.some(item => item.id === change.id))
        return <div className="scenario-library-row" key={change.id}>
          <label>
            <input type="checkbox" checked={included} aria-label={`Include ${change.name} in ${scenario.name}`}
              disabled={!included && scenario.interventions.length >= maximumScenarioChanges}
              onChange={() => included ? removeScenarioChange(change.id) : includeScenarioChange(change.id)} />
            <span><strong>{change.name}</strong><small>{scenarioChangeKind(change.kind).label} · {uses.length ? `${uses.length} scenario${uses.length === 1 ? '' : 's'}` : 'Not included'}</small></span>
          </label>
          <button type="button" className="kit-icon-button scenario-library-delete" disabled={uses.length > 0}
            aria-label={`Delete ${change.name} from library`}
            title={uses.length ? 'Remove from its scenarios before deleting the definition' : 'Delete unused change'}
            onClick={() => library.deleteReusableChange(change.id)}><Trash2 size={13} aria-hidden="true" /></button>
        </div>
      })}
    </div>
  </details>
}

/** Whether Route and Reach can run this scenario now, or what to finish first. */
function ScenarioReadiness({ scenario }: { scenario: ScenarioDraft }) {
  const feeds = useStudio(activeCaseFeeds)
  // The request depends on the loaded network as well as the scenario.
  const routes = useStudio(scenarioRoutes)
  const request = useMemo(() => scenarioRequestFor(scenario), [scenario, routes])
  const error = feeds.error || ('error' in request ? request.error : '')
  if (!error) return null
  return <p className="kit-notice is-warning"><TriangleAlert size={14} aria-hidden="true" /><span>{error}</span></p>
}

function ScenarioDetail({ scenario }: { scenario: ScenarioDraft }) {
  const change = useStudio(activeScenarioChange)
  const zones = scenarioFlexZoneCount(scenario)
  return <div className="scenario-detail">
    <ScenarioSwitcher scenario={scenario} />

    <section className="scenario-section" aria-label="Timetables">
      <div className="kit-section-title"><span>Timetables</span><button type="button" onClick={openDataView}>City data</button></div>
      <ScenarioTimetables scenario={scenario} />
    </section>

    <section className="scenario-section" aria-label="Changes">
      <div className="scenario-section-head">
        <span className="kit-section-title">Changes{scenario.interventions.length ? ` · ${scenario.interventions.length}` : ''}</span>
        <AddChangeMenu disabled={scenario.interventions.length >= maximumScenarioChanges} />
      </div>
      <ChangeLibrary scenario={scenario} />
      {scenario.interventions.length ? <div className="scenario-changes">
        {scenario.interventions.map((entry) => <ChangeRow key={entry.id} change={entry} active={entry.id === change?.id} />)}
      </div> : <p className="scenario-empty">This scenario runs its timetables as published. Include a saved change from the library, or add a new one.</p>}
      {zones ? <p className="scenario-hint">Flex zones carry riders door to door inside their outline during their hours, and connect to transit at stops inside.</p> : null}
    </section>
    <ScenarioReadiness scenario={scenario} />
  </div>
}

/** The Scenarios workspace panel: the City's saved networks and the one being edited. */
export const ScenarioPanel = memo(function ScenarioPanel() {
  countRender('ScenarioPanel')
  const library = useStudio(scenarioLibrary)
  const scenario = useStudio(activeScenario)
  const network = useStudio(routingNetwork)
  return <section className="scenario-workspace" aria-label="Scenarios">
    <header className="inspector-head scenario-head">
      <strong>Scenarios</strong>
      <span className="scenario-save-state" data-state={library.saveState} role="status">{saveLabels[library.saveState]}</span>
      {library.saveState === 'error' || library.saveState === 'unavailable' ? <button type="button" className="kit-text-button" onClick={library.retrySave}>Retry</button> : null}
    </header>
    <div className="scenario-body">
      {library.draftStorageError ? <p className="kit-notice is-error"><TriangleAlert size={14} aria-hidden="true" /><span>{library.draftStorageError}</span></p> : null}
      {scenario ? <ScenarioDetail scenario={scenario} /> : null}
    </div>
    {scenario ? <footer className="scenario-foot">
      <button type="button" className="kit-button" onClick={() => { network.onChange(scenario.id); openPathfinderView() }}><Navigation2 size={14} aria-hidden="true" />Route</button>
      <button type="button" className="kit-button is-primary" onClick={openAnalyzeView}><Radar size={14} aria-hidden="true" />Compare Reach</button>
    </footer> : null}
  </section>
})
