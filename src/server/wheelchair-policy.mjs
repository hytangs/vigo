// This profile describes source constraints, not a survey or live facility check.
export const wheelchairProfile = 'wheelchair-strict-v1'
export const wheelchairLimitations = [
  'Unknown vehicle, boarding and street accessibility is excluded; coverage may be sparse.',
  'Coordinate attachments are geometric; door-to-street access is not verified.',
  'Elevator outages, temporary obstructions and individual chair dimensions are not modeled.',
]
export const wheelchairDescription = Object.freeze({
  profile: wheelchairProfile, unknownData: 'exclude',
  stationPaths: 'published-wheelchair-time-or-dimensioned-step-free',
  minimumWidthMeters: 0.9, maximumSlope: 0.083,
  limitations: wheelchairLimitations,
})
const tag = value => String(value ?? '').trim().toLowerCase()
const suppliedNumber = value => tag(value) !== '' && Number.isFinite(Number(value)) ? Number(value) : null

export function wheelchairBoardingValues(stops) {
  const resolved = new Map()
  for (const id of stops.keys()) {
    const chain = [], seen = new Set()
    let cursor = id, value = 0
    while (stops.has(cursor)) {
      if (resolved.has(cursor)) { value = resolved.get(cursor); break }
      if (seen.has(cursor)) throw new Error('Cyclic GTFS wheelchair boarding inheritance')
      seen.add(cursor)
      chain.push(cursor)
      const stop = stops.get(cursor)
      if (stop.boarding !== 0) { value = stop.boarding; break }
      cursor = stop.parent
    }
    for (const member of chain) resolved.set(member, value)
  }
  return resolved
}

export function wheelchairPathwaySeconds(row) {
  for (const field of ['stair_count', 'max_slope', 'min_width', 'wheelchair_traversal_time']) {
    if (tag(row[field]) !== '' && suppliedNumber(row[field]) == null) return null
  }
  const mode = Number(row.pathway_mode)
  // A wheelchair time must never override a contradictory physical barrier.
  if (![1, 5, 6, 7].includes(mode)) return null
  const stairs = suppliedNumber(row.stair_count)
  const slope = suppliedNumber(row.max_slope)
  const width = suppliedNumber(row.min_width)
  if ((stairs != null && stairs !== 0) || (slope != null && Math.abs(slope) > 0.083)
    || (width != null && width < 0.9)) return null
  const wheelchairTime = suppliedNumber(row.wheelchair_traversal_time)
  if (wheelchairTime != null) return wheelchairTime > 0 ? wheelchairTime : null
  // Missing dimensions cannot establish a usable walkway, gate or elevator.
  if (width == null || (mode !== 5 && slope == null)) return null
  const time = suppliedNumber(row.traversal_time)
  if (time != null && time > 0) return time
  return null
}

export function wheelchairWayAllowed(tags) {
  if (tag(tags.wheelchair) !== 'yes' || tag(tags['wheelchair:conditional'])) return false
  if (['steps', 'construction', 'proposed'].includes(tag(tags.highway))) return false
  if (tag(tags.conveying) && tag(tags.conveying) !== 'no') return false
  return wheelchairNodeAllowed(tags)
}

function metricLength(value) {
  const match = tag(value).match(/^([\d.]+)\s*(m|cm|mm)?$/)
  if (!match || !Number.isFinite(Number(match[1]))) return null
  return Number(match[1]) * ({ m: 1, cm: .01, mm: .001 }[match[2] ?? 'm'])
}

export function wheelchairNodeAllowed(tags) {
  if (['no', 'limited'].includes(tag(tags.wheelchair)) || tag(tags['wheelchair:conditional'])) return false
  if (tag(tags.highway) === 'steps' || ['raised', 'yes'].includes(tag(tags.kerb))) return false
  if (tag(tags['kerb:height'])) {
    const height = metricLength(tags['kerb:height'])
    if (height == null || height > 0.03) return false
  }
  if (['stile', 'turnstile', 'full-height_turnstile', 'kissing_gate', 'wall', 'fence'].includes(tag(tags.barrier))) return false
  // Ordinary untagged geometry vertices inherit the way; tagged obstacles do not.
  if ((tag(tags.barrier) && tag(tags.barrier) !== 'no') || tag(tags.highway) === 'elevator') {
    if (tag(tags.wheelchair) !== 'yes') return false
  }
  const width = metricLength(tags.width)
  if (tag(tags.width) && (width == null || width < 0.9)) return false
  const incline = tag(tags.incline)
  if (incline && incline !== '0' && incline !== '0%') {
    if (!/^[+-]?[\d.]+%$/.test(incline) || Math.abs(Number(incline.slice(0, -1))) > 8.3) return false
  }
  return true
}

export function validateWheelchairRequest(profile, request) {
  if (request.wheelchair !== undefined && typeof request.wheelchair !== 'boolean') throw new Error('wheelchair must be boolean')
  if (request.wheelchairAccessible !== undefined) throw new Error('Use wheelchair, not wheelchairAccessible')
  const active = profile === wheelchairProfile
  if (request.wheelchair === true && !active) throw new Error('Wheelchair routing requires a City built with --wheelchair')
  if (!active) return
  if (request.scenario != null) throw new Error('Wheelchair routing requires a prepared City; query-time scenario accessibility is not modeled')
  if (request.wheelchair === false) throw new Error('This wheelchair City cannot provide unrestricted routes')
  if (request.mode === 'drive') throw new Error('Wheelchair routing supports transit and walk, not drive')
  if ((request.routingDataMode ?? request.dataMode ?? 'scheduled') !== 'scheduled') throw new Error('Wheelchair routing currently requires scheduled service; live accessibility changes are not modeled')
}
