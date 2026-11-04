// Compile the weekly subset of OSM conditional turn restrictions at import.
// Unsupported syntax returns null: the writer retains conservative restrictions.
// Intervals are half-open minutes in a Monday-first week, not UTC timestamps.
const week = 7 * 1440
const weekdays = ['mo', 'tu', 'we', 'th', 'fr', 'sa', 'su']

function clock(value, end) {
  const m = /^(\d{2}):(\d{2})$/.exec(value)
  if (!m) return null
  const hour = Number(m[1]), minute = Number(m[2])
  if (minute > 59 || hour > 24 || (hour === 24 && (!end || minute !== 0))) return null
  return hour * 60 + minute
}

function daySet(value) {
  if (!value) return weekdays.map((_, i) => i)
  const result = new Set()
  for (const part of value.split(',')) {
    const names = part.split('-'), first = weekdays.indexOf(names[0]), last = weekdays.indexOf(names.at(-1))
    if (names.length > 2 || first < 0 || last < 0) return null
    for (let d = first;; d = (d + 1) % 7) {
      result.add(d)
      if (d === last) break
    }
  }
  return [...result]
}

export function weeklyBikeCondition(input) {
  const value = String(input).trim().toLowerCase()
  if (value === '24/7') return [[0, week]]
  // Opening-hours semicolon rules can replace earlier rules for a whole day.
  // Do not interpret those as a union, especially for a permissive `none` rule.
  if (!value || value.length > 2048 || value.includes(';')) return null
  const intervals = []
  for (const part of value.split(';')) {
    const m = /^\s*((?:(?:mo|tu|we|th|fr|sa|su)(?:-(?:mo|tu|we|th|fr|sa|su))?)(?:,(?:mo|tu|we|th|fr|sa|su)(?:-(?:mo|tu|we|th|fr|sa|su))?)*)?(?:\s+|(?=\d))?((?:\d{2}:\d{2}-\d{2}:\d{2})(?:,\d{2}:\d{2}-\d{2}:\d{2})*)?\s*$/.exec(part)
    if (!m || (!m[1] && !m[2])) return null
    const days = daySet(m[1])
    if (!days) return null
    const times = m[2] ? m[2].split(',').map(t => t.split('-')) : [['00:00', '24:00']]
    for (const [a, b] of times) {
      const start = clock(a, false), end = clock(b, true)
      if (start == null || end == null || start === end) return null
      for (const d of days) {
        const low = d * 1440 + start, high = d * 1440 + end + (end < start ? 1440 : 0)
        if (high <= week) intervals.push([low, high])
        else intervals.push([low, week], [0, high - week])
      }
    }
    if (intervals.length > 128) return null
  }
  intervals.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const merged = []
  for (const [start, end] of intervals) {
    const last = merged.at(-1)
    if (last && start <= last[1]) last[1] = Math.max(last[1], end)
    else merged.push([start, end])
  }
  return merged
}

// A semicolon inside parentheses belongs to one opening-hours expression.
function clauses(input) {
  const parts = []; let depth = 0, start = 0
  for (let i = 0; i < input.length; i++) {
    if (input[i] === '(' && ++depth > 1) return null
    if (input[i] === ')' && --depth < 0) return null
    if (input[i] === ';' && depth === 0) { parts.push(input.slice(start, i)); start = i + 1 }
  }
  if (depth !== 0) return null
  parts.push(input.slice(start))
  return parts.length <= 32 ? parts : null
}

// Keep the empty base value: an inactive mode-specific exception inherits a
// less-specific tag rather than inventing a permission or direction.
export function compileWeeklyValues(base, conditional, accepts) {
  if (!conditional || conditional.length > 4096 || (base && !accepts(base))) return null
  const parts = clauses(conditional)
  if (!parts) return null
  const parsed = []
  for (const part of parts) {
    const match = /^\s*([a-z_0-9-]+)\s*@\s*(.*?)\s*$/.exec(part)
    if (!match || !accepts(match[1])) return null
    let expression = match[2]
    if (expression.startsWith('(') && expression.endsWith(')')) expression = expression.slice(1, -1)
    const intervals = weeklyBikeCondition(expression)
    if (!intervals) return null
    parsed.push({ rule: match[1], intervals })
  }
  const boundaries = [...new Set([0, week, ...parsed.flatMap(p => p.intervals.flat())])].sort((a, b) => a - b)
  const result = new Map()
  for (let i = 0; i + 1 < boundaries.length; i++) {
    const start = boundaries[i], end = boundaries[i + 1]
    let rule = base || ''
    // OSM: the last matching conditional value replaces the base value.
    for (const p of parsed) if (p.intervals.some(([a, b]) => a <= start && start < b)) rule = p.rule
    if (!result.has(rule)) result.set(rule, [])
    const intervals = result.get(rule), last = intervals.at(-1)
    if (last?.[1] === start) last[1] = end
    else intervals.push([start, end])
  }
  return [...result.values()].some(intervals => intervals.length > 256) ? null : result
}

export function compileBikeTurnWindows(base, conditional) {
  const result = compileWeeklyValues(base || 'none', conditional,
    value => value === 'none' || /^(?:no_|only_)[a-z_]+$/.test(value))
  result?.delete('none')
  return result
}
