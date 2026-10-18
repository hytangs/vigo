import type { VigoProject } from '../domain'

/** A remix of the City's networks: the timetables a scenario runs with. */
export type CityDataGroup = { id: string; name: string; feedIds: string[] }
export type CityDataGroups = { groups: CityDataGroup[]; cases: Record<string, string>; caseScope: string }

export type CityDataGrouping = {
  value: CityDataGroups
  error: string
  readFailed: boolean
  retry: () => void
  saveGroup: (id: string, name: string, feedIds?: string[]) => void
  removeGroup: (id: string) => void
  toggleFeed: (groupId: string, feedId: string) => void
  assignCase: (scenarioId: string, groupId: string) => void
}

export function caseFeedSelection(value: CityDataGroups, caseId: string, project: VigoProject) {
  const group = value.groups.find(entry => entry.id === value.cases[caseId])
  const feedIds = [...new Set(group?.feedIds ?? [])]
  const error = !group ? 'Choose a timetable group for this scenario in City data.'
    : !feedIds.length ? `Add a timetable to ${group.name} in City data.`
    : feedIds.some(id => !project.feeds.some(feed => feed.id === id)) ? `${group.name} contains a removed timetable. Update it in City data.`
    : feedIds.some(id => project.feeds.find(feed => feed.id === id)?.routingStore?.routingEligibility === 'unsupported') ? `${group.name} contains unsupported timetable data.`
    : feedIds.some(id => project.feeds.find(feed => feed.id === id)?.routingStore?.status !== 'ready') ? `Wait for the timetables in ${group.name} to finish preparing.`
    : ''
  return { group, feedIds, error }
}
