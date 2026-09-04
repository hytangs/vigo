import { formatNumber, type MapPreview, type VigoProject } from '../../domain'
import { routeListLabel } from '../../app/routePresentation'
import { findNetworkSearchHits, type NetworkSearchIndex } from '../../routingUi'

type SearchResultKind = 'route' | 'stop' | 'city' | 'command'
type SearchResultGroup = 'recent' | 'routes' | 'stops' | 'cities' | 'commands'

export type SearchResult = {
  id: string
  kind: SearchResultKind
  group: SearchResultGroup
  title: string
  subtitle: string
}

type SearchCommand = SearchResult & {
  keywords: string
}

type BuildSearchResultsOptions = {
  query: string
  preview: MapPreview
  networkSearchIndex: NetworkSearchIndex
  projects: VigoProject[]
  recentIds: string[]
}

export const searchGroupLabels: Record<SearchResultGroup, string> = {
  recent: 'Recent',
  routes: 'Services',
  stops: 'Stops',
  cities: 'Cities',
  commands: 'Actions',
}

const searchCommands: SearchCommand[] = [
  {
    id: 'command:routes',
    kind: 'command',
    group: 'commands',
    title: 'Explore network',
    subtitle: 'Browse services and stops',
    keywords: 'network service route atlas map browse explore',
  },
  {
    id: 'command:pathfinder',
    kind: 'command',
    group: 'commands',
    title: 'Plan a route',
    subtitle: 'Find an origin-to-destination journey',
    keywords: 'route trip journey directions pathfinder origin destination plan',
  },
  {
    id: 'command:analyze',
    kind: 'command',
    group: 'commands',
    title: 'Analyze Reach',
    subtitle: 'Compute Reach or compare Scenarios',
    keywords: 'reach scenario compare network analysis',
  },
  {
    id: 'command:data',
    kind: 'command',
    group: 'commands',
    title: 'Manage data',
    subtitle: 'Import and inspect GTFS or OSM',
    keywords: 'data gtfs osm import feed source manage',
  },
  {
    id: 'command:preferences',
    kind: 'command',
    group: 'commands',
    title: 'Settings',
    subtitle: 'Appearance and local runtime',
    keywords: 'settings preferences appearance theme runtime storage configure',
  },
  {
    id: 'command:cities',
    kind: 'command',
    group: 'commands',
    title: 'All Cities',
    subtitle: 'Open or manage Cities',
    keywords: 'cities switch manage all',
  },
]

function normalize(value: string) {
  return value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLocaleLowerCase()
    .trim()
    .replace(/\s+/g, ' ')
}

function commandResult(command: SearchCommand, group = command.group): SearchResult {
  const { keywords: _keywords, ...result } = command
  return { ...result, group }
}

function cityResult(project: VigoProject, group: SearchResultGroup = 'cities'): SearchResult {
  return {
    id: `city:${project.id}`,
    kind: 'city',
    group,
    title: project.name,
    subtitle: `${formatNumber(project.summary.routes)} services · ${project.region || 'Local City'}`,
  }
}

function routeResult(preview: MapPreview, id: string, group: SearchResultGroup): SearchResult | null {
  const route = preview.routes.find((item) => item.id === id)
  if (!route) return null
  return {
    id: `route:${route.id}`,
    kind: 'route',
    group,
    title: route.shortName,
    subtitle: routeListLabel(route),
  }
}

function stopResult(preview: MapPreview, id: string, group: SearchResultGroup): SearchResult | null {
  const stop = preview.stops.find((item) => item.id === id)
  if (!stop) return null
  const routeCount = stop.routes.length
  return {
    id: `stop:${stop.id}`,
    kind: 'stop',
    group,
    title: stop.name,
    subtitle: `${formatNumber(routeCount)} ${routeCount === 1 ? 'service' : 'services'}`,
  }
}

function recentResult(
  id: string,
  preview: MapPreview,
  projects: VigoProject[],
): SearchResult | null {
  const command = searchCommands.find((item) => item.id === id)
  if (command) return commandResult(command, 'recent')
  if (id.startsWith('route:')) return routeResult(preview, id.slice('route:'.length), 'recent')
  if (id.startsWith('stop:')) return stopResult(preview, id.slice('stop:'.length), 'recent')
  if (id.startsWith('city:')) {
    const city = projects.find((item) => item.id === id.slice('city:'.length))
    return city ? cityResult(city, 'recent') : null
  }
  return null
}

function cityMatchScore(project: VigoProject, query: string) {
  const fields = [project.name, project.region, project.id].map(normalize)
  if (fields.some((value) => value === query)) return 3
  if (fields.some((value) => value.startsWith(query))) return 2
  if (fields.some((value) => value.includes(query))) return 1
  return 0
}

function uniqueResults(results: SearchResult[]) {
  const seen = new Set<string>()
  return results.filter((result) => {
    if (seen.has(result.id)) return false
    seen.add(result.id)
    return true
  })
}

export function buildSearchResults({
  query,
  preview,
  networkSearchIndex,
  projects,
  recentIds,
}: BuildSearchResultsOptions): SearchResult[] {
  const normalizedQuery = normalize(query)

  if (!normalizedQuery) {
    const recent = recentIds.flatMap((id) => {
      const result = recentResult(id, preview, projects)
      return result ? [result] : []
    })
    return uniqueResults([
      ...recent,
      ...searchCommands.map((command) => commandResult(command)),
    ]).slice(0, 12)
  }

  const networkResults = findNetworkSearchHits(networkSearchIndex, normalizedQuery, 12).map<SearchResult>((hit) => ({
    id: hit.id,
    kind: hit.kind,
    group: hit.kind === 'route' ? 'routes' : 'stops',
    title: hit.title,
    subtitle: hit.subtitle,
  }))
  const routes = networkResults.filter((result) => result.kind === 'route')
  const stops = networkResults.filter((result) => result.kind === 'stop')
  const cities = projects
    .map((project) => ({ project, score: cityMatchScore(project, normalizedQuery) }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || left.project.name.localeCompare(right.project.name))
    .slice(0, 4)
    .map(({ project }) => cityResult(project))
  const commands = searchCommands
    .filter((command) => normalize(`${command.title} ${command.subtitle} ${command.keywords}`).includes(normalizedQuery))
    .map((command) => commandResult(command))

  return uniqueResults([...routes, ...stops, ...cities, ...commands]).slice(0, 16)
}
