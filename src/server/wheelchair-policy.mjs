// This profile describes source constraints, not a survey or live facility check.
// The profile fixes transit semantics: unknown vehicle and boarding
// accessibility is excluded. Street evidence is chosen at preparation:
// `inferred` can use ordinary pedestrian ways without a surface or wheelchair tag;
// `verified` uses only ways tagged wheelchair=yes, which is sparse in most cities.
export const wheelchairProfile = 'wheelchair-strict-v1'
export const wheelchairStreetPolicies = Object.freeze({
  inferred: 'inferred-step-free-v1',
  verified: 'wheelchair-yes-only',
})
export function wheelchairStreetPolicy(value = 'inferred') {
  if (!Object.hasOwn(wheelchairStreetPolicies, value)) throw new Error('--wheelchair-streets must be inferred or verified')
  return value
}
export function wheelchairDescriptionFor(streets = 'inferred') {
  wheelchairStreetPolicy(streets)
  return Object.freeze({
    profile: wheelchairProfile, unknownData: 'exclude',
    streetEvidence: wheelchairStreetPolicies[streets],
    stationPaths: 'published-wheelchair-time-or-dimensioned-step-free',
    minimumWidthMeters: 0.9, maximumSlope: 0.083,
    limitations: Object.freeze([
      'Unknown vehicle and boarding accessibility is excluded; coverage may be sparse.',
      streets === 'verified'
        ? 'Unknown street accessibility is excluded; only ways tagged wheelchair=yes are used.'
        : 'Inferred streets can lack wheelchair or surface tags. An explicit wheelchair=yes overrides surface and trail filters; mapped dimensions and some barriers are still checked.',
      'Coordinate attachments are geometric; door-to-street access is not verified.',
      'Elevator outages, temporary obstructions and individual chair dimensions are not modeled.',
    ]),
  })
}
export const wheelchairDescription = wheelchairDescriptionFor('inferred')
export const wheelchairLimitations = wheelchairDescription.limitations
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
  for (const field of ['stair_count', 'max_slope', 'min_width', 'wheelchair_traversal_time', 'wheelchair_length']) {
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
  // Some feeds publish wheelchair distance instead of wheelchair time. Accept
  // that positive accessibility evidence, using the same 4.8 km/h cost as other
  // prepared pedestrian paths. It cannot override stairs, slope or width bans.
  const wheelchairLength = suppliedNumber(row.wheelchair_length)
  if (wheelchairLength != null) return wheelchairLength > 0 && mode !== 5
    ? Math.ceil(wheelchairLength / (4.8 / 3.6)) : null
  // Missing dimensions cannot establish a usable walkway, gate or elevator.
  if (width == null || (mode !== 5 && slope == null)) return null
  const time = suppliedNumber(row.traversal_time)
  if (time != null && time > 0) return time
  return null
}

// Surfaces and trail grades on which a wheelchair cannot be assumed to pass.
const roughSurfaces = new Set(['unpaved', 'gravel', 'fine_gravel', 'pebblestone', 'dirt', 'earth', 'ground', 'grass',
  'grass_paver', 'mud', 'sand', 'woodchips', 'rock', 'stone', 'cobblestone', 'unhewn_cobblestone', 'sett', 'stepping_stones', 'snow', 'ice', 'salt'])
const roughSmoothness = new Set(['bad', 'very_bad', 'horrible', 'very_horrible', 'impassable'])
const pavedSurfaces = new Set(['paved', 'asphalt', 'concrete', 'concrete:plates', 'concrete:lanes', 'paving_stones', 'metal', 'wood', 'rubber', 'tartan', 'chipseal'])
// Barriers a wheelchair normally passes; anything else needs wheelchair=yes.
const passableBarriers = new Set(['gate', 'bollard', 'lift_gate', 'swing_gate', 'sliding_gate', 'entrance', 'height_restrictor', 'no'])

export function wheelchairWayAllowed(tags, streets = 'inferred') {
  const access = tag(tags.wheelchair)
  if (tag(tags['wheelchair:conditional'])) return false
  if (['steps', 'construction', 'proposed'].includes(tag(tags.highway))) return false
  if (tag(tags.conveying) && tag(tags.conveying) !== 'no') return false
  if (access !== 'yes') {
    if (streets !== 'inferred' || ['no', 'limited'].includes(access)) return false
    const surface = tag(tags.surface)
    if (roughSurfaces.has(surface) || roughSmoothness.has(tag(tags.smoothness))) return false
    if (tag(tags.sac_scale) && tag(tags.sac_scale) !== 'hiking') return false
    // Paths and tracks are paved only when the map says so.
    if (['path', 'track', 'bridleway'].includes(tag(tags.highway)) && !pavedSurfaces.has(surface)) return false
  }
  return wheelchairNodeAllowed(tags, streets)
}

function metricLength(value) {
  const match = tag(value).match(/^([\d.]+)\s*(m|cm|mm)?$/)
  if (!match || !Number.isFinite(Number(match[1]))) return null
  return Number(match[1]) * ({ m: 1, cm: .01, mm: .001 }[match[2] ?? 'm'])
}

export function wheelchairNodeAllowed(tags, streets = 'inferred') {
  if (['no', 'limited'].includes(tag(tags.wheelchair)) || tag(tags['wheelchair:conditional'])) return false
  if (tag(tags.highway) === 'steps' || ['raised', 'yes'].includes(tag(tags.kerb))) return false
  // A mapped kerb is passable only when it is recorded as lowered or flush.
  if (tag(tags.barrier) === 'kerb' && !['lowered', 'flush', 'no'].includes(tag(tags.kerb))) {
    if (tag(tags.wheelchair) !== 'yes') return false
  }
  if (tag(tags['kerb:height'])) {
    const height = metricLength(tags['kerb:height'])
    if (height == null || height > 0.03) return false
  }
  if (['stile', 'turnstile', 'full-height_turnstile', 'kissing_gate', 'wall', 'fence'].includes(tag(tags.barrier))) return false
  // Ordinary untagged geometry vertices inherit the way; tagged obstacles do
  // not. Inferred streets also pass ordinary unlocked gates and bollards.
  const barrier = tag(tags.barrier)
  const passable = streets === 'inferred' && passableBarriers.has(barrier) && tag(tags.locked) !== 'yes'
  const lowered = streets === 'inferred' && barrier === 'kerb'
  if ((barrier && barrier !== 'no' && !lowered && !passable) || tag(tags.highway) === 'elevator') {
    if (tag(tags.wheelchair) !== 'yes') return false
  }
  const width = metricLength(tags.width)
  if (tag(tags.width) && (width == null || width < 0.9)) return false
  const incline = tag(tags.incline)
  if (incline && incline !== '0' && incline !== '0%') {
    const percent = Number(incline.slice(0, -1))
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)%$/.test(incline)
      || !Number.isFinite(percent) || Math.abs(percent) > 8.3) return false
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
