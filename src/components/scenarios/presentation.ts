import { Ban, GitBranchPlus, Hexagon, Spline, TrainTrack, type LucideIcon } from 'lucide-react'
import type { CityDataGroup } from '../../app/cityDataGroups'
import { baselineGroupId } from '../../app/scenarioLibrary'
import type { ScenarioChangeKind, ScenarioDraft } from '../../reach'

/** How each kind of change reads in the panel. Chrome stays neutral. */
export const scenarioChangeKinds: ReadonlyArray<{
  kind: ScenarioChangeKind
  label: string
  verb: string
  detail: string
  icon: LucideIcon
}> = [
  { kind: 'add-line', label: 'New line', verb: 'New line', detail: 'Draw stops; follow roads or a rail curve', icon: Spline },
  { kind: 'change-line', label: 'Rerouted line', verb: 'Reroute a line', detail: 'Move, add or drop stops on a route', icon: GitBranchPlus },
  { kind: 'enhance-line', label: 'More service', verb: 'Add service', detail: 'Run a route more often', icon: TrainTrack },
  { kind: 'remove-line', label: 'Removed line', verb: 'Remove a line', detail: 'Take a route or branch out', icon: Ban },
  { kind: 'flex-zone', label: 'Flex zone', verb: 'Flex zone', detail: 'An on-demand service area', icon: Hexagon },
]

/**
 * The map draws the edited change in the interface signal and everything
 * else quietly, so the eye lands on one thing.
 */
export const scenarioSketchColor = '#cde67c'

export const scenarioChangeKind = (kind: ScenarioChangeKind) => scenarioChangeKinds.find((entry) => entry.kind === kind) ?? scenarioChangeKinds[0]

export const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`

/** "2 timetables · 3 changes" for a saved scenario. */
export function scenarioSummary(scenario: ScenarioDraft, groups: CityDataGroup[]) {
  const group = groups.find((entry) => entry.id === scenario.groupId)
  const timetables = group ? plural(group.feedIds.length, 'timetable') : 'No timetables'
  const changes = scenario.interventions.length ? plural(scenario.interventions.length, 'change') : group?.id === baselineGroupId ? 'as published' : 'no changes'
  return `${timetables} · ${changes}`
}

export function scenarioFlexZoneCount(scenario: ScenarioDraft | undefined) {
  return scenario?.interventions.filter((change) => change.kind === 'flex-zone').length ?? 0
}

export function serviceTimeLabel(minutes: number) {
  const day = Math.floor(minutes / (24 * 60))
  const normalized = minutes % (24 * 60)
  return `${String(Math.floor(normalized / 60)).padStart(2, '0')}:${String(normalized % 60).padStart(2, '0')}${day ? ` +${day}d` : ''}`
}
