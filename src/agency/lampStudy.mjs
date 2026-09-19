import fs from 'node:fs/promises'
import path from 'node:path'

// The study belongs to the selected City's agency directory. A model cannot
// choose a file path, public URL, shell command, or another City's dataset.
export async function readLampStudy(directory, { routeIds = [], limit = 16 } = {}) {
  if (!directory) return { status: 'not_installed', message: 'City research storage is unavailable.' }
  const file = path.join(directory, 'lamp', 'study.json')
  let stat
  try { stat = await fs.stat(file) } catch (error) {
    if (error.code === 'ENOENT') return { status: 'not_installed', message: 'No LAMP running-time study has been prepared for this City.' }
    throw error
  }
  if (stat.size > 8_000_000) throw new Error('The saved LAMP study exceeds the supported report size.')
  const study = JSON.parse(await fs.readFile(file, 'utf8'))
  if (study.version !== 1 || !Array.isArray(study.segments) || !Array.isArray(study.routes) || !study.comparison || !study.range) throw new Error('The saved running-time study is incomplete.')
  const routes = study.routes.filter(row => !routeIds.length || routeIds.includes(row.routeId))
  const segments = study.segments.filter(row => !routeIds.length || routeIds.includes(row.routeId))
    .sort((a, b) => b.historical.maeSeconds - a.historical.maeSeconds)
  return { status: routes.length ? 'available' : 'route_not_covered', dataset: study.dataset, generatedAt: study.generatedAt, range: study.range,
    studyId: study.studyId, evaluationFile: study.evaluationFile, sourceManifest: study.sources,
    comparisonScope: 'Entire study, before route filtering', comparison: study.comparison, routes, days: study.days,
    rows: segments.slice(0, limit).map(row => ({ route: row.routeId, direction: row.directionId, from_stop: row.fromName, to_stop: row.toName, historical_seconds: row.predictedSeconds,
      scheduled_seconds: row.scheduledSeconds, held_out_cases: row.historical.cases, historical_mae_seconds: row.historical.maeSeconds, timetable_mae_seconds: row.scheduled.maeSeconds })),
    totalSegments: segments.length, showingSegments: Math.min(limit, segments.length), method: study.method, limits: study.limits,
    sources: [study.sources.index, study.sources.archiveCatalog, study.sources.dictionary], filters: study.filters,
    trainingDates: study.trainingDates, testDates: study.testDates }
}
