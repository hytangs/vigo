export const briefingIntervals = [15, 30, 60]
export function briefingPreferences(value = {}) {
  if (!briefingIntervals.includes(value.intervalMinutes) || typeof value.automatic !== 'boolean') throw Object.assign(new Error('Choose a 15, 30, or 60 minute briefing interval and whether to update automatically.'), { statusCode: 400 })
  return { intervalMinutes: value.intervalMinutes, automatic: value.automatic }
}
export const defaultBriefingPreferences = Object.freeze({ intervalMinutes: 15, automatic: true })

export function briefingRefreshAt(answer, preferences) {
  const assessed = Date.parse(answer?.generatedAt)
  if (!Number.isFinite(assessed)) return null
  const interval = assessed + preferences.intervalMinutes * 60000
  const service = answer?.diagnosis?.serviceContext
  const next = service?.phase === 'between_runs' ? Date.parse(service.nextScheduledTripAt) : NaN
  // A saved overnight assessment must expire when scheduled work begins,
  // even when the operator chose a longer update interval.
  return Number.isFinite(next) && next > assessed ? Math.min(interval, next) : interval
}

export function briefingStatus(entry, preferences, now, scheduleIdentity) {
  const answer = entry?.answer
  const assessed = Date.parse(answer?.generatedAt)
  const refreshAt = briefingRefreshAt(answer, preferences)
  const compatible = answer?.diagnosis?.version === 2 && answer.scheduleIdentity === scheduleIdentity
  return { preferences, refreshAt: refreshAt === null ? null : new Date(refreshAt).toISOString(),
    current: Boolean(compatible && refreshAt > now && assessed <= now),
    due: !compatible || refreshAt === null || refreshAt <= now || assessed > now }
}
