const navigationCookie = 'vigo_navigation_v1'
const cookieMaxAgeSeconds = 60 * 60 * 24 * 365

export type NavigationMemory = {
  lastProjectId: string
  lastRouteByProject: Record<string, string>
  recentSearchIds: string[]
}

const emptyNavigationMemory: NavigationMemory = {
  lastProjectId: '',
  lastRouteByProject: {},
  recentSearchIds: [],
}

export function readNavigationMemory(): NavigationMemory {
  if (typeof document === 'undefined') return emptyNavigationMemory

  const encoded = document.cookie
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${navigationCookie}=`))
    ?.slice(navigationCookie.length + 1)

  if (!encoded) return emptyNavigationMemory

  try {
    const parsed = JSON.parse(decodeURIComponent(encoded)) as Partial<NavigationMemory>
    return {
      lastProjectId: typeof parsed.lastProjectId === 'string' ? parsed.lastProjectId : '',
      lastRouteByProject: parsed.lastRouteByProject && typeof parsed.lastRouteByProject === 'object'
        ? Object.fromEntries(Object.entries(parsed.lastRouteByProject).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
        : {},
      recentSearchIds: Array.isArray(parsed.recentSearchIds)
        ? parsed.recentSearchIds.filter((value): value is string => typeof value === 'string').slice(0, 6)
        : [],
    }
  } catch {
    return emptyNavigationMemory
  }
}

function writeNavigationMemory(memory: NavigationMemory) {
  if (typeof document === 'undefined') return
  document.cookie = `${navigationCookie}=${encodeURIComponent(JSON.stringify(memory))}; Path=/; Max-Age=${cookieMaxAgeSeconds}; SameSite=Strict`
}

export function rememberProject(projectId: string) {
  const current = readNavigationMemory()
  const next = { ...current, lastProjectId: projectId }
  writeNavigationMemory(next)
  return next
}

export function rememberRoute(projectId: string, routeId: string) {
  const current = readNavigationMemory()
  const lastRouteByProject = { ...current.lastRouteByProject }
  if (routeId) lastRouteByProject[projectId] = routeId
  else delete lastRouteByProject[projectId]
  const next = { ...current, lastProjectId: projectId, lastRouteByProject }
  writeNavigationMemory(next)
  return next
}

export function rememberSearchResult(resultId: string) {
  const current = readNavigationMemory()
  const next = {
    ...current,
    recentSearchIds: [resultId, ...current.recentSearchIds.filter((id) => id !== resultId)].slice(0, 6),
  }
  writeNavigationMemory(next)
  return next
}
