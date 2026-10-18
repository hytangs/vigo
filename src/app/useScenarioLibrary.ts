import { type SetStateAction, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { VigoProject } from '../domain'
import type { ScenarioDraft } from '../reach'
import {
  initialScenarioLibrary,
  libraryFromSaved,
  loadScenarioLibrary,
  maximumScenarios,
  migrateLocalScenarioData,
  saveScenarioLibrary,
  ScenarioLibraryConflict,
  type ScenarioLibrary,
} from './scenarioLibrary'
import type { CityDataGrouping, CityDataGroups } from './cityDataGroups'

export type ScenarioSaveState = 'loading' | 'saved' | 'unsaved' | 'saving' | 'error' | 'unavailable'

type State = {
  projectId: string
  library: ScenarioLibrary
  revision: number
  /** `unavailable`: the saved copy could not be read, so edits stay in this window and nothing is written over it. */
  status: 'loading' | 'ready' | 'unavailable'
  dirty: boolean
  version: number
  saving: boolean
  error: string
  activeScenarioId: string
  activeChangeId: string
}

const saveDelayMs = 450
const retryDelayMs = 4_000
// Saves written while leaving a City; returning to it waits for them first.
const leavingSaves = new Map<string, Promise<unknown>>()

function selectionKey(projectId: string) {
  return `vigo.scenario-selection.v1:${projectId}`
}

function readSelection(projectId: string) {
  try {
    const value = JSON.parse(window.localStorage.getItem(selectionKey(projectId)) ?? '{}')
    return { scenarioId: typeof value.scenarioId === 'string' ? value.scenarioId : '', changeId: typeof value.changeId === 'string' ? value.changeId : '' }
  } catch { return { scenarioId: '', changeId: '' } }
}

function initialState(project: VigoProject): State {
  const selection = readSelection(project.id)
  return {
    projectId: project.id,
    library: initialScenarioLibrary(project),
    revision: 0,
    status: 'loading',
    dirty: false,
    version: 0,
    saving: false,
    error: '',
    activeScenarioId: selection.scenarioId,
    activeChangeId: selection.changeId,
  }
}

function resolve<T>(action: SetStateAction<T>, previous: T) {
  return typeof action === 'function' ? (action as (value: T) => T)(previous) : action
}

/**
 * One City's saved scenarios and timetable groups. The City folder holds the
 * saved copy (`.vigo/scenarios.json`); edits apply at once and save shortly
 * after, and a copy changed in another window is never overwritten.
 */
export function useScenarioLibrary(project: VigoProject) {
  const projectId = project.id
  const [stored, setState] = useState(() => initialState(project))
  const state = stored.projectId === projectId ? stored : initialState(project)
  const stateRef = useRef(state)
  stateRef.current = state
  // The stored state, which still holds the previous City while switching away from it.
  const storedRef = useRef(stored)
  storedRef.current = stored
  const projectRef = useRef(project)
  projectRef.current = project
  const [reloadToken, setReloadToken] = useState(0)
  // The save in flight, resolving to the revision it wrote.
  const inflight = useRef<Promise<number> | null>(null)

  useLayoutEffect(() => {
    if (stored.projectId !== projectId) setState(initialState(project))
  }, [project, projectId, stored.projectId])

  useEffect(() => {
    const controller = new AbortController()
    const settled = leavingSaves.get(projectId) ?? Promise.resolve()
    settled.catch(() => {}).then(() => loadScenarioLibrary(projectId, controller.signal)).then(({ library, revision }) => {
      setState(current => {
        if (current.projectId !== projectId) return current
        if (library) {
          return { ...current, library: libraryFromSaved(library), revision, status: 'ready', dirty: false, error: '' }
        }
        // Nothing saved yet: carry over this browser's older drafts once.
        const migrated = migrateLocalScenarioData(projectRef.current)
        return { ...current, library: migrated ?? current.library, revision, status: 'ready', dirty: current.dirty || Boolean(migrated), error: '' }
      })
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return
      setState(current => current.projectId !== projectId ? current : {
        ...current,
        status: 'unavailable',
        error: `${error instanceof Error ? error.message : 'Saved scenarios could not be loaded.'} Changes stay in this window until they load.`,
      })
    })
    return () => {
      controller.abort()
      // Leaving the City: write pending edits even if the page is closing,
      // after any save already in flight.
      const pending = storedRef.current
      if (pending.projectId === projectId && pending.dirty && pending.status === 'ready') {
        const after = pending.saving && inflight.current ? inflight.current : Promise.resolve(pending.revision)
        const save = after.then((revision) => saveScenarioLibrary(projectId, pending.library, revision, true)).catch(() => {})
        leavingSaves.set(projectId, save)
        void save.then(() => { if (leavingSaves.get(projectId) === save) leavingSaves.delete(projectId) })
      }
    }
  }, [projectId, reloadToken])

  const flush = useCallback(async () => {
    const snapshot = stateRef.current
    if (!snapshot.dirty || snapshot.status !== 'ready' || snapshot.saving) return
    setState(current => current.projectId === snapshot.projectId ? { ...current, saving: true } : current)
    try {
      const request = saveScenarioLibrary(snapshot.projectId, snapshot.library, snapshot.revision).then((result) => result.revision)
      inflight.current = request
      const revision = await request
      setState(current => current.projectId !== snapshot.projectId ? current : {
        ...current, revision, saving: false, error: '', dirty: current.version !== snapshot.version,
      })
    } catch (error) {
      setState(current => {
        if (current.projectId !== snapshot.projectId) return current
        if (error instanceof ScenarioLibraryConflict) {
          return {
            ...current,
            saving: false,
            dirty: false,
            revision: error.revision,
            library: error.library ? libraryFromSaved(error.library) : current.library,
            error: 'Scenarios changed in another window. Showing the latest saved copy.',
          }
        }
        return { ...current, saving: false, error: `${error instanceof Error ? error.message : 'Scenarios could not be saved.'} Retrying shortly.` }
      })
    }
  }, [])

  useEffect(() => {
    if (!state.dirty || state.status !== 'ready' || state.saving) return
    const timer = window.setTimeout(() => void flush(), state.error ? retryDelayMs : saveDelayMs)
    return () => window.clearTimeout(timer)
  }, [flush, state.dirty, state.status, state.saving, state.version, state.error])

  useEffect(() => {
    const onHide = () => {
      const pending = stateRef.current
      if (pending.dirty && pending.status === 'ready' && !pending.saving) {
        void saveScenarioLibrary(pending.projectId, pending.library, pending.revision, true).catch(() => {})
      }
    }
    window.addEventListener('pagehide', onHide)
    return () => window.removeEventListener('pagehide', onHide)
  }, [])

  useEffect(() => {
    try {
      window.localStorage.setItem(selectionKey(projectId), JSON.stringify({ scenarioId: state.activeScenarioId, changeId: state.activeChangeId }))
    } catch { /* Selection is a convenience. */ }
  }, [projectId, state.activeScenarioId, state.activeChangeId])

  // Callbacks bound to an earlier City never edit the City now selected.
  const update = useCallback((change: (library: ScenarioLibrary) => ScenarioLibrary) => {
    setState(current => {
      if (current.projectId !== projectId) return current
      const library = change(current.library)
      return library === current.library ? current : { ...current, library, dirty: true, version: current.version + 1 }
    })
  }, [projectId])
  const select = useCallback((field: 'activeScenarioId' | 'activeChangeId', action: SetStateAction<string>) => {
    setState(current => current.projectId !== projectId ? current : { ...current, [field]: resolve(action, current[field]) })
  }, [projectId])

  const scenarios = state.library.scenarios
  const activeScenario = scenarios.find(entry => entry.id === state.activeScenarioId) ?? scenarios[0]
  const activeScenarioId = activeScenario?.id ?? ''
  const activeScenarioChangeId = activeScenario?.interventions.some(change => change.id === state.activeChangeId) ? state.activeChangeId : ''

  const groups = state.library.groups
  const groupingValue = useMemo<CityDataGroups>(() => ({
    groups,
    cases: Object.fromEntries(scenarios.map(entry => [entry.id, entry.groupId ?? ''])),
    caseScope: projectId,
  }), [groups, scenarios, projectId])

  const saveState: ScenarioSaveState = state.status === 'loading' ? 'loading'
    : state.status === 'unavailable' ? 'unavailable'
      : state.saving ? 'saving'
        : state.error ? 'error'
          : state.dirty ? 'unsaved' : 'saved'
  const retry = useCallback(() => {
    if (stateRef.current.status === 'unavailable') setReloadToken(token => token + 1)
    else void flush()
  }, [flush])

  const grouping = useMemo<CityDataGrouping>(() => ({
    value: groupingValue,
    error: state.error,
    // Editing stays available; an unreadable saved copy is protected by not saving.
    readFailed: false,
    retry,
    saveGroup: (id: string, name: string, feedIds?: string[]) => {
      if (!name.trim()) return
      update(library => ({
        ...library,
        groups: library.groups.some(group => group.id === id)
          ? library.groups.map(group => group.id === id ? { ...group, name: name.trim().slice(0, 80), feedIds: feedIds ?? group.feedIds } : group)
          : library.groups.length < 64 ? [...library.groups, { id, name: name.trim().slice(0, 80), feedIds: feedIds ?? [] }] : library.groups,
      }))
    },
    removeGroup: (id: string) => update(library => ({ ...library, groups: library.groups.filter(group => group.id !== id) })),
    toggleFeed: (groupId: string, feedId: string) => update(library => ({
      ...library,
      groups: library.groups.map(group => group.id !== groupId ? group : {
        ...group,
        feedIds: group.feedIds.includes(feedId) ? group.feedIds.filter(id => id !== feedId) : [...group.feedIds, feedId],
      }),
    })),
    assignCase: (scenarioId: string, groupId: string) => update(library => ({
      ...library,
      scenarios: library.scenarios.map(entry => entry.id === scenarioId ? { ...entry, groupId } : entry),
    })),
  }), [groupingValue, retry, state.error, update])

  return {
    scenarioDrafts: scenarios,
    setScenarioDrafts: useCallback((action: SetStateAction<ScenarioDraft[]>) => update(library => {
      const next = resolve(action, library.scenarios)
      return next === library.scenarios ? library : { ...library, scenarios: next.slice(0, maximumScenarios) }
    }), [update]),
    activeScenarioId,
    setActiveScenarioId: useCallback((action: SetStateAction<string>) => select('activeScenarioId', action), [select]),
    activeScenarioChangeId,
    setActiveScenarioChangeId: useCallback((action: SetStateAction<string>) => select('activeChangeId', action), [select]),
    draftStorageError: state.status === 'unavailable' ? state.error : '',
    grouping,
    saveState,
    retrySave: retry,
  }
}

export type ScenarioLibraryState = ReturnType<typeof useScenarioLibrary>
