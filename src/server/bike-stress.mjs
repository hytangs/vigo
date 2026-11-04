// An OSM estimate, not observed safety or the full Mineta LTS methodology.
// The road-class/speed/lane rules follow Conveyal's published R5 labeler;
// direction-specific facilities require explicit direction or driving-side data.
const norm = value => String(value ?? '').trim().toLowerCase()
const forwardOnly = new Set(['yes', '1', 'true'])
const bothDirections = new Set(['no', '0', 'false'])

// Shared by comfort, stress, and contraflow access. Values retain the existing
// edge encoding: 0 none, 1 lane/shared, 2 track. Unknown side direction earns
// only a modest comfort preference; it cannot lower LTS or authorize access.
// https://wiki.openstreetmap.org/wiki/Key:cycleway:right:oneway
export function bikeFacility(tags, direction, comfort = false) {
  const kind = value => value === 'track' || value === 'opposite_track' ? 2
    : value === 'lane' || value === 'opposite_lane' || (comfort && value === 'shared_lane') ? 1 : 0
  const specific = norm(tags[`cycleway:${direction}`])
  if (specific) return kind(specific)
  const roadOne = norm(tags.oneway) || (norm(tags.junction) === 'roundabout' ? 'yes' : '')
  const flow = roadOne === '-1' ? 'backward' : forwardOnly.has(roadOne) ? 'forward' : null
  const opposite = roadOne === '-1' ? 'forward' : 'backward'
  const generic = norm(tags.cycleway), both = norm(tags['cycleway:both'])
  if (!both && !norm(tags['cycleway:left']) && !norm(tags['cycleway:right'])) {
    const mapped = generic.startsWith('opposite') ? opposite : flow
    return !mapped || direction === mapped ? kind(generic) : 0
  }
  let facility = 0
  for (const side of ['left', 'right']) {
    const value = norm(tags[`cycleway:${side}`] ?? tags['cycleway:both'] ?? tags.cycleway)
    const level = kind(value)
    if (!level) continue
    const one = norm(tags[`cycleway:${side}:oneway`] ?? tags['cycleway:both:oneway'])
    let mapped
    if (bothDirections.has(one)) mapped = null
    else if (forwardOnly.has(one)) mapped = 'forward'
    else if (one === '-1') mapped = 'backward'
    else if (one) continue // Unknown explicit directions are not guessed.
    else if (value.startsWith('opposite')) mapped = opposite
    else if (flow) mapped = flow
    else if (['left','right'].includes(norm(tags.driving_side))) {
      mapped = side === norm(tags.driving_side) ? 'forward' : 'backward'
    } else if (both && !norm(tags['cycleway:left']) && !norm(tags['cycleway:right'])
      && !tags['cycleway:left:oneway'] && !tags['cycleway:right:oneway']) mapped = null
    else {
      if (comfort) facility = Math.max(facility, 1)
      continue
    }
    if (!mapped || direction === mapped) facility = Math.max(facility, level)
  }
  return facility
}

// Bits 0..2 contain LTS 1..4. Bit 4 marks an explicit override during build,
// so intersection propagation cannot overwrite supplied LTS. It is removed
// before publication. The writer adds bit 3 for permitted bicycle pushing.
export function bikeStress(tags, direction, allowsCars) {
  const supplied = tags[`lts:${direction}`] ?? tags.lts
  if (supplied != null) {
    const level = Number(supplied)
    if (!String(supplied).trim() || !Number.isInteger(level) || level < 1 || level > 4) {
      throw new Error(`Bicycle lts must be an integer from 1 to 4; received ${String(supplied)}`)
    }
    return level | 16
  }
  const highway = norm(tags.highway)
  if (!allowsCars) return 1
  const parsed = /^(\d+(?:\.\d+)?)\s*(km\/h|kmh|kph|mph|knots)?$/.exec(norm(tags[`maxspeed:${direction}`] ?? tags.maxspeed))
  const speed = parsed ? Number(parsed[1]) * (parsed[2] === 'mph' ? 1.609344 : parsed[2] === 'knots' ? 1.852 : 1) : NaN
  const rawLanes = norm(tags.lanes)
  const lanes = /^[1-9]\d*$/.test(rawLanes) ? Number(rawLanes) : Infinity
  // Explicit high speed or many lanes overrides a low-traffic class default.
  if (['residential','living_street','service'].includes(highway)
    && !(speed > 40.25) && (lanes <= 3 || !Number.isFinite(lanes))) return 1
  const smallSlow = speed <= 40.25 && (lanes <= 3 || !Number.isFinite(lanes))
  const hasLane = bikeFacility(tags,direction) > 0
  if (['unclassified','tertiary','tertiary_link'].includes(highway)) {
    return hasLane || smallSlow || (lanes <= 3 && Number.isNaN(speed)) ? 2 : 3
  }
  return hasLane ? (smallSlow ? 2 : 3) : 4
}
