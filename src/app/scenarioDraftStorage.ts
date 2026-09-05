import type { VigoProject } from '../domain'
import type { ScenarioDraft } from '../reach'

export type StoredScenarios = {
  cases: ScenarioDraft[]
  activeCaseId: string
  activeChangeId: string
}

export function emptyScenarios(): StoredScenarios {
  return { cases: [{ id: 'case-a', name: 'Case A', interventions: [] }], activeCaseId: 'case-a', activeChangeId: '' }
}

export function scenarioStorageKey(project: VigoProject | undefined) {
  if (!project) return ''
  return `vigo.scenarios.v1:${JSON.stringify([
    project.storagePath,
    project.id,
    project.feeds.map((feed) => [feed.id, feed.importedAt]).sort(),
    project.routingStore?.builtAt ?? '',
    project.osmStreetIndex?.builtAt ?? '',
  ])}`
}

export function parseStoredScenarios(text: string | null): StoredScenarios {
  if (!text) return emptyScenarios()
  const unreadable = () => new Error('Saved Scenario drafts could not be read. The stored copy has been kept.')
  let value: StoredScenarios
  try { value = JSON.parse(text) as StoredScenarios } catch { throw unreadable() }
  const coordinate = (point: unknown) => Array.isArray(point) && point.length === 2 && point.every(Number.isFinite)
  const geometry = (points: unknown) => Array.isArray(points) && points.every(coordinate)
  const numbers = (values: unknown) => Array.isArray(values) && values.every(Number.isFinite)
  if (!Array.isArray(value?.cases) || !value.cases.length || value.cases.length > 6
    || new Set(value.cases.map((entry) => entry?.id)).size !== value.cases.length
    || !value.cases.every((entry) => typeof entry?.id === 'string' && typeof entry.name === 'string'
      && Array.isArray(entry.interventions)
      && new Set(entry.interventions.map((change) => change?.id)).size === entry.interventions.length
      && entry.interventions.every((change) => (
        typeof change?.id === 'string' && typeof change.name === 'string'
        && ['add-line', 'enhance-line', 'change-line', 'remove-line'].includes(change.kind)
        && [change.headwayMinutes, change.averageSpeedKph, change.startMinutes, change.endMinutes].every(Number.isFinite)
        && typeof change.bidirectional === 'boolean'
        && (change.inferredGeometry === undefined || geometry(change.inferredGeometry))
        && (change.inferredSegmentGeometry === undefined || (Array.isArray(change.inferredSegmentGeometry) && change.inferredSegmentGeometry.every(geometry)))
        && (change.inferredSegmentDistanceKm === undefined || numbers(change.inferredSegmentDistanceKm))
        && (change.inferredSegmentRuntimeMinutes === undefined || numbers(change.inferredSegmentRuntimeMinutes))
        && Array.isArray(change.stops) && change.stops.every((stop) => (
          typeof stop?.id === 'string' && typeof stop.label === 'string'
          && ['map', 'route'].includes(stop.source) && coordinate(stop.coordinate)
        ))
      )))) throw unreadable()
  const cases = value.cases.map((entry) => ({
    ...entry,
    interventions: entry.interventions.map((change) => change.geometryStatus === 'loading'
      ? { ...change, geometryStatus: 'idle' as const, geometryError: '' }
      : change),
  }))
  const activeCaseId = cases.some((entry) => entry.id === value.activeCaseId) ? value.activeCaseId : cases[0].id
  const activeCase = cases.find((entry) => entry.id === activeCaseId)!
  return {
    cases,
    activeCaseId,
    activeChangeId: activeCase.interventions.some((change) => change.id === value.activeChangeId) ? value.activeChangeId : '',
  }
}
