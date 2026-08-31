import type {
  RoutingCommand,
  RoutingTimePreference,
  RoutingTravelMode,
} from './routingModel'

function compactLabel(value: string) {
  return value.trim().replace(/\s+/g, ' ')
}

export function parseRoutingCommand(query: string): RoutingCommand | null {
  let value = compactLabel(query)
  const lower = value.toLowerCase()
  if (/\b(bike|biking|cycle|cycling)\b/.test(lower)) return null
  const mode: RoutingTravelMode = /\b(drive|driving|car)\b/.test(lower)
    ? 'drive'
    : /\b(walk|walking|foot)\b/.test(lower)
      ? 'walk'
      : 'transit'
  const timeMatch = /\b(arrive(?:\s+by|\s+at)?|depart(?:\s+at)?|leave(?:\s+at)?|at|@)\s+(\d{1,2}):(\d{2})\b/i.exec(value)
  const timePreference: RoutingTimePreference | undefined = timeMatch?.[1]?.toLowerCase().startsWith('arrive') ? 'arrive' : timeMatch ? 'depart' : undefined
  const hours = Number(timeMatch?.[2])
  const minutes = Number(timeMatch?.[3])
  const departMinutes = Number.isFinite(hours) && Number.isFinite(minutes) && hours >= 0 && hours <= 29 && minutes >= 0 && minutes < 60
    ? hours * 60 + minutes
    : undefined

  if (timeMatch) value = compactLabel(`${value.slice(0, timeMatch.index)} ${value.slice(timeMatch.index + timeMatch[0].length)}`)
  value = compactLabel(value.replace(/\b(route|plan|navigate|directions|transit|bus|rail|train|walk|walking|foot|drive|driving|car)\b/gi, ' '))

  value = value.replace(/^from\s+/i, '')
  const locationTexts = value
    .split(/\s+(?:to|->|→)\s+/i)
    .map(compactLabel)
  if (locationTexts.length < 2 || locationTexts.length > 8 || locationTexts.some((label) => label.length < 2)) {
    return null
  }
  const originText = locationTexts[0]
  const destinationText = locationTexts.at(-1)!
  const waypointTexts = locationTexts.slice(1, -1)
  return {
    originText,
    waypointTexts,
    destinationText,
    locationTexts,
    departMinutes,
    timePreference,
    mode,
  }
}

