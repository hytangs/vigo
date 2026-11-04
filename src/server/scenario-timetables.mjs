// Portable timetable rows, shared by Studio persistence and query compilation.
const invalid = message => Object.assign(new Error(message), { statusCode: 400, code: 'invalid_scenario_timetable' })

export function normalizeTimetables(rows) {
  if (!Array.isArray(rows) || !rows.length || rows.length > 32) throw invalid('Timetables must contain 1 to 32 rows.')
  const ids = new Set()
  return rows.map(row => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw invalid('Each timetable must be an object.')
    const allowed = new Set(['id', 'startMinutes', 'endMinutes', 'headwayMinutes', 'daysOfWeek', 'exactTimes'])
    for (const key of Object.keys(row)) if (!allowed.has(key)) throw invalid(`Unknown timetable field: ${key}.`)
    if (typeof row.id !== 'string' || !row.id.trim() || Buffer.byteLength(row.id) > 160 || ids.has(row.id)) throw invalid('Timetable IDs must be unique and nonempty, up to 160 bytes.')
    ids.add(row.id)
    for (const [key, min, max] of [['startMinutes', 0, 4319], ['endMinutes', 0, 4319], ['headwayMinutes', 0.1, 1440]]) {
      if (typeof row[key] !== 'number' || !Number.isFinite(row[key]) || row[key] < min || row[key] > max) throw invalid(`${key} must be between ${min} and ${max}.`)
    }
    if (Math.round(row.endMinutes * 60) <= Math.round(row.startMinutes * 60)) throw invalid('Timetable end must be later than start by at least one second.')
    if (row.exactTimes !== undefined && typeof row.exactTimes !== 'boolean') throw invalid('exactTimes must be boolean.')
    const days = row.daysOfWeek
    if (days !== undefined && (!Array.isArray(days) || !days.length || days.length > 7 || new Set(days).size !== days.length || days.some(day => !Number.isInteger(day) || day < 1 || day > 7))) throw invalid('daysOfWeek must list distinct ISO weekdays, 1 (Monday) through 7 (Sunday).')
    return { id: row.id, startMinutes: row.startMinutes, endMinutes: row.endMinutes, headwayMinutes: row.headwayMinutes,
      ...(days === undefined ? {} : { daysOfWeek: [...days] }), ...(row.exactTimes === undefined ? {} : { exactTimes: row.exactTimes }) }
  })
}

export function activeTimetables(service, serviceDate) {
  if (!service.timetables) return [{ ...service, endExclusive: service.exactTimes === true }]
  // UTC is only used to read the ISO calendar weekday, never to shift trip times.
  const weekday = new Date(`${serviceDate}T12:00:00Z`).getUTCDay() || 7
  if (!/^\d{4}-\d{2}-\d{2}$/.test(serviceDate ?? '') || !Number.isFinite(new Date(`${serviceDate}T12:00:00Z`).getTime())) throw invalid('Timetable rows require an ISO serviceDate.')
  return service.timetables.filter(row => !row.daysOfWeek || row.daysOfWeek.includes(weekday))
    .map(row => ({ ...row, exactTimes: row.exactTimes ?? service.exactTimes ?? false, endExclusive: true }))
}
