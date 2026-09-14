export const briefingIntervals = [15, 30, 60]
export function briefingPreferences(value = {}) {
  if (!briefingIntervals.includes(value.intervalMinutes) || typeof value.automatic !== 'boolean') throw Object.assign(new Error('Choose a 15, 30, or 60 minute briefing interval and whether to update automatically.'), { statusCode: 400 })
  return { intervalMinutes: value.intervalMinutes, automatic: value.automatic }
}
export const defaultBriefingPreferences = Object.freeze({ intervalMinutes: 15, automatic: true })

export function briefingStatus(entry, preferences, now, scheduleIdentity) {
  const answer = entry?.answer
  const assessed = Date.parse(answer?.generatedAt)
  const refreshAt = Number.isFinite(assessed) ? assessed + preferences.intervalMinutes * 60000 : null
  const compatible = answer?.diagnosis?.version === 1 && answer.scheduleIdentity === scheduleIdentity
  return { preferences, refreshAt: refreshAt === null ? null : new Date(refreshAt).toISOString(),
    current: Boolean(compatible && refreshAt > now && assessed <= now),
    due: !compatible || refreshAt === null || refreshAt <= now || assessed > now }
}
