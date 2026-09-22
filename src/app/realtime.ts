export type RealtimeInspectRequest =
  | { url: string }
  | {
      urls: {
        vehicles: string
        tripUpdates?: string
        alerts?: string
      }
    }

// Keep automatic feed-driven route recalculation and workspace refreshes unobtrusive.
export const realtimeRefreshMs = 60_000
export type RealtimeFeedFields = { vehicles: string; tripUpdates: string; alerts: string }

export const mbtaRealtimeFeeds: RealtimeFeedFields = {
  vehicles: 'https://cdn.mbta.com/realtime/VehiclePositions.pb',
  tripUpdates: 'https://cdn.mbta.com/realtime/TripUpdates.pb',
  alerts: 'https://cdn.mbta.com/realtime/Alerts.pb',
}

export function realtimeRequestFromFields(fields: RealtimeFeedFields): RealtimeInspectRequest {
  if (!fields.tripUpdates.trim() && !fields.alerts.trim()) return realtimeInspectRequest(fields.vehicles)
  function feedUrl(value: string, label: string) {
    try {
      const url = new URL(value.trim())
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error()
      if (url.hostname === 'viz.rt.gtfs.zone') throw new Error()
      return url.toString()
    } catch {
      throw new Error(`Enter a valid HTTP or HTTPS URL for ${label}.`)
    }
  }
  return {
    urls: {
      vehicles: feedUrl(fields.vehicles, 'vehicle positions'),
      ...(fields.tripUpdates.trim() ? { tripUpdates: feedUrl(fields.tripUpdates, 'trip updates') } : {}),
      ...(fields.alerts.trim() ? { alerts: feedUrl(fields.alerts, 'service alerts') } : {}),
    },
  }
}

function realtimeInspectRequest(sourceText: string): RealtimeInspectRequest {
  const urls = (sourceText.match(/https?:\/\/[^\s<>"']+/gi) ?? [])
    .map((value) => value.replace(/[),;\]]+$/, ''))
  if (!urls.length) throw new Error('Enter a valid GTFS-RT URL.')

  const parsed = urls.map((value) => {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('GTFS-RT URLs must use HTTP or HTTPS.')
    return { value, pathname: url.pathname.toLowerCase() }
  })
  if (parsed.length === 1) return { url: parsed[0].value }

  const feedSet: { vehicles?: string; tripUpdates?: string; alerts?: string } = {}
  for (const source of parsed) {
    const kind = source.pathname.endsWith('/vehiclepositions.pb')
      ? 'vehicles'
      : source.pathname.endsWith('/tripupdates.pb')
        ? 'tripUpdates'
        : source.pathname.endsWith('/alerts.pb')
          ? 'alerts'
          : undefined
    if (!kind) throw new Error('For multiple feeds, use VehiclePositions.pb, TripUpdates.pb, and Alerts.pb URLs.')
    if (feedSet[kind]) throw new Error(`Duplicate ${kind} GTFS-RT URL.`)
    feedSet[kind] = source.value
  }
  if (!feedSet.vehicles) throw new Error('A VehiclePositions.pb URL is required for live map locations.')

  return { urls: { vehicles: feedSet.vehicles, tripUpdates: feedSet.tripUpdates, alerts: feedSet.alerts } }
}
