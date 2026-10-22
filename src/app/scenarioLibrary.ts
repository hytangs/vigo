import type { VigoProject } from '../domain'
import type { ScenarioChangeDraft, ScenarioDraft } from '../reach'
import { parseStoredScenarios } from './scenarioDraftStorage'
import type { CityDataGroup } from './cityDataGroups'

/** The saved form of one City's scenarios, as `GET /api/projects/{id}/scenarios` returns it. */
export type SavedScenarioLibrary = {
  schemaVersion: 'vigo.studio.scenarios.v1'
  revision: number
  updatedAt?: string
  sharedChanges?: ScenarioChangeDraft[]
  groups: CityDataGroup[]
  scenarios: Array<{ id: string; name: string; groupId: string; changes: ScenarioChangeDraft[]; updatedAt?: string }>
}

/** What Studio edits: groups of timetables, and scenarios that run on a group. */
export type ScenarioLibrary = {
  sharedChanges?: ScenarioChangeDraft[]
  groups: CityDataGroup[]
  scenarios: ScenarioDraft[]
}

export const maximumScenarios = 24
/** Changes in one scenario: new, changed and removed lines and Flex zones. */
export const maximumScenarioChanges = 16
export const baselineGroupId = 'baseline'

export function newScenario(index: number, groupId: string): ScenarioDraft {
  return { id: `scenario-${crypto.randomUUID().slice(0, 8)}`, name: `Scenario ${index + 1}`, groupId, interventions: [] }
}

/** A new City starts with its whole timetable as the baseline group and one empty scenario. */
export function initialScenarioLibrary(project: Pick<VigoProject, 'feeds'>): ScenarioLibrary {
  return {
    groups: [{ id: baselineGroupId, name: 'Baseline', feedIds: project.feeds.map(feed => feed.id) }],
    scenarios: [{ id: 'case-a', name: 'Current network', groupId: baselineGroupId, interventions: [] }],
  }
}

/** A baseline created before the first GTFS import must inherit the City network.
 * Keep explicit nonempty selections and custom groups exactly as saved. */
export function recoverEmptyBaseline(library: ScenarioLibrary, project: Pick<VigoProject, 'feeds'>): ScenarioLibrary {
  if (!project.feeds.length || !library.groups.some(group => group.id === baselineGroupId && !group.feedIds.length)) return library
  return {
    ...library,
    groups: library.groups.map(group => group.id === baselineGroupId && !group.feedIds.length
      ? { ...group, feedIds: project.feeds.map(feed => feed.id) } : group),
  }
}

/** Definitions outlive scenario membership; older libraries migrate without copies. */
export function reusableChanges(library: ScenarioLibrary): ScenarioChangeDraft[] {
  const definitions = new Map((library.sharedChanges ?? []).map(change => [change.id, change]))
  for (const scenario of library.scenarios) for (const change of scenario.interventions) {
    if (!definitions.has(change.id)) definitions.set(change.id, change)
  }
  return [...definitions.values()]
}

/** Any edited definition is propagated to every scenario that includes its ID. */
export function assembleScenarioLibrary(library: ScenarioLibrary, scenarios: ScenarioDraft[]): ScenarioLibrary {
  const definitions = new Map(reusableChanges(library).map(change => [change.id, change]))
  for (const scenario of scenarios) for (const change of scenario.interventions) {
    const previous = library.scenarios.find(entry => entry.id === scenario.id)?.interventions.find(entry => entry.id === change.id)
    if (!definitions.has(change.id) || (previous && JSON.stringify(previous) !== JSON.stringify(change))) definitions.set(change.id, change)
  }
  return { ...library, sharedChanges: [...definitions.values()], scenarios: scenarios.map(scenario => ({
    ...scenario, interventions: scenario.interventions.map(change => definitions.get(change.id)!),
  })) }
}

/** Copy on write: editing one scenario must not alter another scenario or the baseline. */
export function updateScenarioNetwork(library: ScenarioLibrary, scenarioId: string, feedId: string, selected: boolean): ScenarioLibrary {
  const scenario = library.scenarios.find(entry => entry.id === scenarioId)
  const group = library.groups.find(entry => entry.id === scenario?.groupId)
  if (!scenario || !group || group.feedIds.includes(feedId) === selected) return library
  const feedIds = selected ? [...group.feedIds, feedId] : group.feedIds.filter(id => id !== feedId)
  if (!feedIds.length) return library
  const exclusive = group.id !== baselineGroupId && !library.scenarios.some(entry => entry.id !== scenarioId && entry.groupId === group.id)
  if (!exclusive && library.groups.length >= 64) return library
  let id = group.id
  if (!exclusive) {
    const base = `network-${scenarioId}`
    id = base
    for (let suffix = 2; library.groups.some(entry => entry.id === id); suffix++) id = `${base}-${suffix}`
  }
  const next = { id, name: exclusive ? group.name : `${scenario.name} network`.slice(0, 80), feedIds }
  return {
    ...library,
    groups: exclusive ? library.groups.map(entry => entry.id === id ? next : entry) : [...library.groups, next],
    scenarios: library.scenarios.map(entry => entry.id === scenarioId ? { ...entry, groupId: id } : entry),
  }
}

export function scenarioNetworkDiffers(groups: CityDataGroup[], groupId: string | undefined) {
  const baseline = groups.find(group => group.id === baselineGroupId)
  const selected = groups.find(group => group.id === groupId)
  return Boolean(baseline && selected && JSON.stringify([...new Set(baseline.feedIds)].sort()) !== JSON.stringify([...new Set(selected.feedIds)].sort()))
}

export function libraryFromSaved(saved: SavedScenarioLibrary): ScenarioLibrary {
  return {
    sharedChanges: saved.sharedChanges,
    groups: saved.groups.map(group => ({ ...group, feedIds: [...group.feedIds] })),
    scenarios: saved.scenarios.map(({ id, name, groupId, changes }) => ({ id, name: id === 'case-a' && name === 'Scenario A' && groupId === baselineGroupId && !changes.length ? 'Current network' : name, groupId, interventions: changes })),
  }
}

export function libraryToSaved(library: ScenarioLibrary) {
  return {
    schemaVersion: 'vigo.studio.scenarios.v1' as const,
    sharedChanges: reusableChanges(library).map(change => change.geometryStatus === 'loading' ? { ...change, geometryStatus: 'idle' as const, geometryError: '' } : change),
    groups: library.groups,
    scenarios: library.scenarios.map(({ id, name, groupId, interventions }) => ({
      id, name, groupId: groupId ?? '',
      // Road matching in flight restarts after a reload instead of hanging.
      changes: interventions.map(change => change.geometryStatus === 'loading'
        ? { ...change, geometryStatus: 'idle' as const, geometryError: '' }
        : change),
    })),
  }
}

/** True when a library holds anything worth keeping beyond the defaults. */
export function libraryHasWork(library: ScenarioLibrary) {
  return Boolean(library.sharedChanges?.length) || library.scenarios.some(scenario => scenario.interventions.length)
    || library.scenarios.length > 1
    || library.groups.length > 1
    || library.groups.some(group => group.id !== baselineGroupId)
}

function readLocal(key: string) {
  try { return window.localStorage.getItem(key) } catch { return null }
}

function localKeys(prefix: string) {
  try {
    return Array.from({ length: window.localStorage.length }, (_, index) => window.localStorage.key(index) ?? '')
      .filter(key => key.startsWith(prefix))
  } catch { return [] }
}

/**
 * Studio 0.5 kept scenario drafts and timetable groups in this browser's
 * storage, keyed by the City's import revision. Recover the newest copy for
 * this City so saved work moves into the City folder instead of vanishing.
 */
export function migrateLocalScenarioData(project: VigoProject): ScenarioLibrary | null {
  const identity = JSON.stringify([project.storagePath, project.id]).slice(0, -1)
  const draftKeys = localKeys(`vigo.scenarios.v1:${identity},`)
  let drafts: ScenarioDraft[] | null = null
  let draftScope = ''
  for (const key of draftKeys.reverse()) {
    try {
      const parsed = parseStoredScenarios(readLocal(key))
      if (!drafts || parsed.cases.some(entry => entry.interventions.length)) {
        drafts = parsed.cases
        draftScope = key
        if (parsed.cases.some(entry => entry.interventions.length)) break
      }
    } catch { /* A damaged copy stays where it is. */ }
  }
  let groups: CityDataGroup[] | null = null
  let assignments: Record<string, string> = {}
  try {
    const stored = JSON.parse(readLocal(`vigo.data-groups.v1:${JSON.stringify([project.storagePath, project.id])}`) ?? 'null')
    if (stored?.version === 1 && Array.isArray(stored.groups)) {
      groups = stored.groups.filter((group: CityDataGroup) => typeof group?.id === 'string' && typeof group.name === 'string'
        && group.name.trim() && Array.isArray(group.feedIds)).slice(0, 64)
      if (stored.caseScope === draftScope && stored.cases && typeof stored.cases === 'object') assignments = stored.cases
    }
  } catch { /* Keep the default group. */ }
  if (!drafts && !groups?.length) return null
  const initial = initialScenarioLibrary(project)
  const library: ScenarioLibrary = {
    groups: groups?.length ? groups : initial.groups,
    scenarios: (drafts ?? initial.scenarios).slice(0, maximumScenarios).map(entry => ({
      ...entry,
      groupId: assignments[entry.id] ?? (groups?.length ? groups[0].id : baselineGroupId),
    })),
  }
  return libraryHasWork(library) ? library : null
}

export async function loadScenarioLibrary(projectId: string, signal?: AbortSignal) {
  const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/scenarios`, { signal })
  const body = await response.json().catch(() => ({})) as { library?: SavedScenarioLibrary | null; revision?: number; error?: string }
  if (!response.ok) throw new Error(body.error || `Saved scenarios could not be loaded (${response.status}).`)
  return { library: body.library ?? null, revision: Number(body.revision ?? 0) }
}

export class ScenarioLibraryConflict extends Error {
  constructor(message: string, readonly library: SavedScenarioLibrary | null, readonly revision: number) { super(message) }
}

export async function saveScenarioLibrary(projectId: string, library: ScenarioLibrary, baseRevision: number, keepalive = false) {
  const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/scenarios`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ baseRevision, library: libraryToSaved(library) }),
    keepalive,
  })
  const body = await response.json().catch(() => ({})) as { library?: SavedScenarioLibrary | null; revision?: number; error?: string }
  if (response.status === 409) throw new ScenarioLibraryConflict(body.error || 'Scenarios changed in another window.', body.library ?? null, Number(body.revision ?? 0))
  if (!response.ok) throw new Error(body.error || `Scenarios could not be saved (${response.status}).`)
  return { revision: Number(body.revision ?? baseRevision + 1) }
}
