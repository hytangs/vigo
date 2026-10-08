import type { VigoProject } from '../domain'

export function cityReadiness(project: VigoProject) {
  const stores = project.routingStore ? [project.routingStore] : project.feeds.map(feed => feed.routingStore)
  const transitReady = stores.length > 0 && stores.every(store => store?.status === 'ready')
  const streetsReady = project.osmStreetIndex?.status === 'ready'
  const unsupported = stores.some(store => store?.routingEligibility === 'unsupported')
  const preparing = project.jobs.some(job => job.status === 'running' || job.status === 'queued')
    || stores.some(store => store?.status === 'building') || project.osmStreetIndex?.status === 'building'
  const failed = stores.some(store => store?.status === 'failed') || project.osmStreetIndex?.status === 'failed'
  if (preparing) return { state: 'preparing', label: 'Preparing', detail: 'View preparation', transitReady, streetsReady } as const
  if (failed || unsupported) return { state: 'attention', label: 'Needs attention', detail: 'Review City data', transitReady, streetsReady } as const
  if (transitReady && project.feeds.length > 1 && !project.routingStore) return { state: 'setup', label: 'Set up', detail: 'Combine timetables', transitReady, streetsReady } as const
  if (transitReady && streetsReady) return { state: 'ready', label: 'Prepared', detail: 'Open network', transitReady, streetsReady } as const
  return { state: 'setup', label: 'Set up', detail: transitReady ? 'Add street data' : 'Add timetable data', transitReady, streetsReady } as const
}
