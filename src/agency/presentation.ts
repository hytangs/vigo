import type { FeedState } from './types'

export function feedHealth(feeds: FeedState[], refreshFailed = false) {
  const current = feeds.filter(feed => feed.status === 'fresh').length
  if (refreshFailed) return { status: 'unavailable', label: 'Refresh failed' }
  if (!feeds.length) return { status: 'unavailable', label: 'Timetable only' }
  if (current === feeds.length) return { status: 'fresh', label: 'Feeds current' }
  return { status: current ? 'partial' : 'unavailable', label: current ? 'Partial live data' : 'Live data unavailable' }
}

export function feedAgeLabel(feed: FeedState) {
  if (feed.ageSeconds === null) return 'Time unknown'
  if (feed.ageSeconds < 0) return `Clock ahead ${Math.ceil(-feed.ageSeconds)}s`
  return `${Math.floor(feed.ageSeconds)}s old`
}

export function scheduleDeviation(scheduled: number | null, current: number | null) {
  if (scheduled === null || current === null) return null
  const delta = current - scheduled
  if (delta === 0) return 'Matches schedule'
  const amount = Math.abs(delta) < 60 ? `${Math.abs(delta)} sec` : `${(Math.abs(delta) / 60).toFixed(1).replace(/\.0$/, '')} min`
  return `${amount} ${delta < 0 ? 'early' : 'late'}`
}
