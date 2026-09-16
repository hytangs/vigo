import type { GtfsRouteAnalysis } from './gtfsAnalysis'

export type NetworkScheduleResult = { feedId: string; analysis: GtfsRouteAnalysis }
// Keep one copy of each pattern, stop and segment per feed while collecting a day.
export function createScheduleCollection() {
  const feeds = new Map<string, { base: GtfsRouteAnalysis; routes: Map<string, GtfsRouteAnalysis['routes'][number]>; stops: Map<string, GtfsRouteAnalysis['stops'][number]>; pairs: Map<string, GtfsRouteAnalysis['stopPairs'][number]> }>()
  return {
    add({ feedId, analysis }: NetworkScheduleResult) {
      let feed = feeds.get(feedId)
      if (!feed) {
        feed = { base: { ...analysis, routes: [], stops: [], stopPairs: [] }, routes: new Map(), stops: new Map(), pairs: new Map() }
        feeds.set(feedId, feed)
      }
      for (const route of analysis.routes) feed.routes.set(route.id, route)
      for (const stop of analysis.stops) {
        const old = feed.stops.get(stop.id)
        feed.stops.set(stop.id, old ? { ...old, ...stop, routes: [...new Set([...old.routes, ...stop.routes])], tripCount: Math.max(old.tripCount, stop.tripCount), transferScore: Math.max(old.transferScore, stop.transferScore) } : stop)
      }
      for (const pair of analysis.stopPairs) feed.pairs.set(pair.id, pair)
    },
    finish(): NetworkScheduleResult[] {
      const results = [...feeds].map(([feedId, feed]) => ({ feedId, analysis: { ...feed.base, routes: [...feed.routes.values()], stops: [...feed.stops.values()], stopPairs: [...feed.pairs.values()] } }))
      feeds.clear()
      return results
    },
  }
}
