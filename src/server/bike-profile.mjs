// Bicycle permissions are independent of foot and motor-vehicle permissions.
// These portable defaults are conservative on pedestrian-only facilities;
// explicit bicycle tags override generic vehicle/access tags.
import { compileBikeTurnWindows, compileWeeklyValues } from './bike-conditions.mjs'
import { bikeFacility, bikeStress } from './bike-stress.mjs'

const norm = value => String(value ?? '').trim().toLowerCase()
const allowed = new Set(['yes', 'designated', 'official', 'permissive', 'destination', 'optional_sidepath'])
const denied = new Set(['no', 'private', 'agricultural', 'forestry', 'customers', 'delivery', 'use_sidepath'])
const roads = new Set(['cycleway', 'residential', 'living_street', 'unclassified', 'service',
  'tertiary', 'tertiary_link', 'secondary', 'secondary_link', 'primary', 'primary_link', 'trunk', 'trunk_link', 'track', 'path'])

function access(tags, direction) {
  for (const key of ['bicycle', 'vehicle', 'access']) {
    const value = norm(direction ? tags[`${key}:${direction}`] ?? tags[key] : tags[key])
    if (value) return value
  }
  return ''
}

function conditionalAccess(tags, direction) {
  for (const mode of ['bicycle', 'vehicle', 'access']) for (const key of [`${mode}:${direction}`, mode]) {
    if (tags[`${key}:conditional`]) return true
    if (norm(tags[key])) return false
  }
  return false
}

export function bikeDirections(tags) {
  const highway = norm(tags.highway)
  const bicycle = norm(tags.bicycle)
  const explicit = [bicycle, norm(tags['bicycle:forward']), norm(tags['bicycle:backward'])].some(value => allowed.has(value) || value === 'dismount')
  if (!highway || ['construction', 'proposed', 'abandoned', 'razed'].includes(highway)
    || norm(tags.area) === 'yes'
    || (!roads.has(highway) && !explicit)
    || (norm(tags.motorroad) === 'yes' && !explicit)
    || ['impassable', 'very_horrible'].includes(norm(tags.smoothness))) {
    return { forward: false, backward: false }
  }
  // No time-dependent permissions are guessed. A more specific unconditional
  // bicycle permission still overrides a generic conditional restriction.
  if (tags['oneway:bicycle:conditional']
    || (tags['oneway:bicycle'] == null && tags['oneway:conditional'])) {
    return { forward: false, backward: false }
  }
  let one = norm(tags['oneway:bicycle'] ?? tags.oneway)
  if (!one && norm(tags.junction) === 'roundabout') one = 'yes'
  if (['reversible', 'alternating'].includes(one)) return { forward: false, backward: false }
  let forward = one !== '-1'
  let backward = !['yes', '1', 'true'].includes(one)
  // Explicit lanes/tracks can carry bicycles against motor traffic. Keep
  // the unmarked legacy opposite exception, but do not infer access from a
  // shared lane or an ambiguous physical side.
  if (tags['oneway:bicycle'] == null) {
    const unmarkedOpposite = [tags.cycleway, tags['cycleway:left'], tags['cycleway:right'], tags['cycleway:both']]
      .some(value => norm(value) === 'opposite')
    forward ||= unmarkedOpposite || bikeFacility(tags, 'forward') > 0
    backward ||= unmarkedOpposite || bikeFacility(tags, 'backward') > 0
  }
  if (tags['oneway:bicycle'] == null) {
    if (allowed.has(norm(tags['bicycle:forward']))) forward = true
    if (allowed.has(norm(tags['bicycle:backward']))) backward = true
  }
  if (denied.has(access(tags, 'forward'))) forward = false
  if (denied.has(access(tags, 'backward'))) backward = false
  for (const direction of ['forward', 'backward']) {
    const specific = norm(tags[`bicycle:${direction}`] ?? tags.bicycle)
    const conditional = conditionalAccess(tags, direction)
    const foot = norm(tags[`foot:${direction}`] ?? tags.foot)
    const footConditional = tags[`foot:${direction}:conditional`]
      || (tags[`foot:${direction}`] == null && tags['foot:conditional'])
    const explicitDirection = allowed.has(specific) || specific === 'dismount'
    if (conditional || ((!roads.has(highway) || norm(tags.motorroad) === 'yes') && !explicitDirection)
      || ((specific === 'dismount' || highway === 'steps') && (denied.has(foot) || footConditional))) {
      if (direction === 'forward') forward = false
      else backward = false
    }
  }
  return { forward, backward }
}

export function bikeNodeAllowed(tags) {
  const permit = access(tags)
  if (denied.has(permit) || ['yes','true','1'].includes(norm(tags.locked))
    || tags['locked:conditional'] || tags['bicycle:conditional']
    || (tags.opening_hours && norm(tags.opening_hours) !== '24/7')) return false
  if (allowed.has(norm(tags.bicycle)) || norm(tags.bicycle) === 'dismount') return true
  if (tags['access:conditional'] || tags['vehicle:conditional']) return false
  // Movable gates inherit the permitted way's access, as in the pedestrian
  // profile. Private/locked/conditional gates remain excluded above.
  return !['wall', 'fence', 'retaining_wall', 'block', 'jersey_barrier', 'stile', 'turnstile', 'full-height_turnstile', 'kissing_gate'].includes(norm(tags.barrier))
    || allowed.has(permit)
}

// A single 32-bit word per directed edge: class, facility, surface, dismount,
// signed mapped incline, and motor speed. No raw OSM tag strings at runtime.
export function bikeAttributes(tags, direction) {
  const highway = norm(tags.highway)
  const roadClass = highway === 'cycleway' ? 0
    : ['path', 'footway', 'pedestrian', 'steps', 'bridleway'].includes(highway) ? 1
      : highway === 'living_street' ? 2
        : ['residential', 'service', 'unclassified'].includes(highway) ? 3
          : highway.startsWith('tertiary') ? 4
            : highway.startsWith('secondary') ? 5 : highway === 'track' ? 7 : 6
  const facility = highway === 'cycleway' ? 2 : bikeFacility(tags, direction, true)
  const surface = norm(tags.surface)
  const roughness = ['sand', 'mud', 'deep_gravel'].includes(surface) ? 3
    : ['gravel', 'ground', 'dirt', 'earth', 'grass', 'unpaved', 'cobblestone', 'sett'].includes(surface) ? 2
      : ['compacted', 'fine_gravel', 'paving_stones', 'pebblestone'].includes(surface) ? 1
        : !surface && highway === 'track' ? 2 : 0
  const dismount = norm(tags[`bicycle:${direction}`] ?? tags.bicycle) === 'dismount' || highway === 'steps'
  const rawIncline = norm(tags.incline)
  let incline = /^[-+]?\d+(\.\d+)?%?$/.test(rawIncline) ? Number(rawIncline.replace('%', ''))
    : rawIncline === 'up' ? 8 : rawIncline === 'down' ? -8 : 0
  if (direction === 'backward') incline = -incline
  incline = Math.round(Math.max(-30, Math.min(30, incline))) + 30
  const rawSpeed = norm(tags[`maxspeed:${direction}`] ?? tags.maxspeed)
  const parsedSpeed = /^(\d+(\.\d+)?)\s*(mph|km\/h|kph)?$/.exec(rawSpeed)
  const speed = parsedSpeed ? Number(parsedSpeed[1]) * (parsedSpeed[3] === 'mph' ? 1.609344 : 1)
    : [15, 15, 10, 30, 50, 60, 80, 20][roadClass]
  return roadClass | (facility << 3) | (roughness << 5) | (Number(dismount) << 7)
    | (incline << 8) | (Math.round(Math.min(140, speed)) << 14)
    | (Number(access(tags, direction) === 'destination') << 22)
}

// Resolve supported conditional tags at their weekly change points, then use
// the ordinary permission/attribute rules. Keep unknown conditions present so
// those same rules remain conservative, including mode/direction precedence.
export function bikeWayWindows(tags, stressFor) {
  const schedules = []
  const keys = ['oneway', 'oneway:bicycle']
  for (const mode of ['access', 'vehicle', 'bicycle', 'foot']) keys.push(mode, `${mode}:forward`, `${mode}:backward`)
  for (const key of keys) {
    if (!tags[`${key}:conditional`]) continue
    const accepts = key.startsWith('oneway')
      ? value => ['yes', '1', 'true', 'no', '0', 'false', '-1', 'reversible', 'alternating'].includes(value)
      : value => allowed.has(value) || denied.has(value) || value === 'dismount'
    const values = compileWeeklyValues(norm(tags[key]), norm(tags[`${key}:conditional`]), accepts)
    if (values) schedules.push({key, values})
  }
  if (!schedules.length) return []
  const boundaries = [...new Set([0, 10080, ...schedules.flatMap(s => [...s.values.values()].flat(2))])].sort((a, b) => a - b)
  const baseline = bikeDirections(tags)
  const result = new Map()
  for (let i = 0; i + 1 < boundaries.length; i++) {
    const start = boundaries[i], end = boundaries[i + 1], resolved = {...tags}
    for (const {key, values} of schedules) {
      delete resolved[`${key}:conditional`]
      const value = [...values].find(([, spans]) => spans.some(([a,b]) => a <= start && start < b))[0]
      if (value) resolved[key] = value
      else delete resolved[key]
    }
    const permissions = bikeDirections(resolved)
    for (const direction of ['forward', 'backward']) {
      if (!permissions[direction]) continue
      const attributes = bikeAttributes(resolved, direction)
      const stress = stressFor?.(resolved, direction)
      const key = `${direction}:${attributes}:${stress ?? ''}`
      if (!result.has(key)) result.set(key, {direction, attributes, ...(stressFor ? {stress} : {}), intervals: []})
      const intervals = result.get(key).intervals, last = intervals.at(-1)
      if (last?.[1] === start) last[1] = end
      else intervals.push([start, end])
    }
  }
  const variants = [...result.values()]
  // Omit a direction only if its entire week equals its unconditional edge.
  // Otherwise retain baseline periods too, and the writer omits that static
  // edge so a cheap unconditional variant cannot mask a timed cost change.
  const timed = variants.filter(v => !(baseline[v.direction]
    && v.attributes === bikeAttributes(tags, v.direction)
    && (!stressFor || v.stress === stressFor(tags, v.direction))
    && v.intervals.length === 1 && v.intervals[0][0] === 0 && v.intervals[0][1] === 10080))
  return timed.some(v => v.intervals.length > 256) ? [] : timed
}

export function createBikeWriter(db, { carAllowed = () => false, walkableWay = () => false,
  walkableNode = () => false, walkingDirections = () => ({forward:false,backward:false}) } = {}) {
  db.exec(`
    CREATE TABLE bike_nodes(node_id INTEGER PRIMARY KEY, lon_e7 INTEGER NOT NULL, lat_e7 INTEGER NOT NULL);
    CREATE TABLE bike_edges(from_node INTEGER NOT NULL, to_node INTEGER NOT NULL, distance_cm INTEGER NOT NULL, way_id INTEGER NOT NULL, attributes INTEGER NOT NULL, stress INTEGER NOT NULL);
    CREATE TEMP TABLE bike_junction_stress(node_id INTEGER PRIMARY KEY, level INTEGER NOT NULL DEFAULT 1,
      highest_way INTEGER NOT NULL DEFAULT 0, other_level INTEGER NOT NULL DEFAULT 1,
      signal INTEGER NOT NULL DEFAULT 0, walk INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE bike_turns(via_node INTEGER NOT NULL, from_way INTEGER NOT NULL, to_way INTEGER NOT NULL, only_turn INTEGER NOT NULL);
    CREATE TABLE bike_way_turns(from_way INTEGER NOT NULL, via_ways TEXT NOT NULL, to_way INTEGER NOT NULL, only_turn INTEGER NOT NULL);
  `)
  const node = db.prepare('INSERT OR IGNORE INTO bike_nodes VALUES(?,?,?)')
  const edge = db.prepare('INSERT INTO bike_edges VALUES(?,?,?,?,?,?)')
  // Keep only the two highest stresses from distinct ways. An edge must not
  // inherit its own road's opposite-direction stress at every shape vertex.
  const junction = db.prepare(`INSERT INTO bike_junction_stress(node_id,level,highest_way) VALUES(?,?,?)
    ON CONFLICT(node_id) DO UPDATE SET
      other_level=CASE WHEN highest_way=excluded.highest_way THEN other_level
        ELSE max(other_level,min(level,excluded.level)) END,
      highest_way=CASE WHEN excluded.level>level THEN excluded.highest_way ELSE highest_way END,
      level=max(level,excluded.level)`)
  const nodePermission = db.prepare(`INSERT INTO bike_junction_stress(node_id,signal,walk) VALUES(?,?,?)
    ON CONFLICT(node_id) DO UPDATE SET signal=max(signal,excluded.signal),walk=min(walk,excluded.walk)`)
  const turn = db.prepare('INSERT INTO bike_turns VALUES(?,?,?,?)')
  const wayTurn = db.prepare('INSERT INTO bike_way_turns VALUES(?,?,?,?)')
  let timedEdge, edgeWindow
  const edgeSchedules = new Map()
  let timedEdgeCount = 0, edgeWindowCount = 0
  function edgeSchedule(intervals) {
    const key = JSON.stringify(intervals)
    if (edgeSchedules.has(key)) return edgeSchedules.get(key)
    if (!timedEdge) {
      db.exec(`CREATE TABLE bike_timed_edges(from_node INTEGER NOT NULL, to_node INTEGER NOT NULL, distance_cm INTEGER NOT NULL, way_id INTEGER NOT NULL, attributes INTEGER NOT NULL, window_id INTEGER NOT NULL, stress INTEGER NOT NULL);
        CREATE TABLE bike_edge_windows(window_id INTEGER NOT NULL, start_minute INTEGER NOT NULL, end_minute INTEGER NOT NULL);`)
      timedEdge = db.prepare('INSERT INTO bike_timed_edges VALUES(?,?,?,?,?,?,?)')
      edgeWindow = db.prepare('INSERT INTO bike_edge_windows VALUES(?,?,?)')
    }
    const id = edgeSchedules.size + 1
    edgeSchedules.set(key, id)
    for (const [start,end] of intervals) { edgeWindow.run(id,start,end); edgeWindowCount++ }
    return id
  }
  let turnWindow
  let timedWindowCount = 0
  function windows(kind, inserted, intervals) {
    if (!intervals || (intervals.length === 1 && intervals[0][0] === 0 && intervals[0][1] === 10080)) return
    if (!turnWindow) {
      db.exec('CREATE TABLE bike_turn_windows(turn_table INTEGER NOT NULL, turn_row INTEGER NOT NULL, start_minute INTEGER NOT NULL, end_minute INTEGER NOT NULL);')
      turnWindow = db.prepare('INSERT INTO bike_turn_windows VALUES(?,?,?,?)')
    }
    for (const [start, end] of intervals) { turnWindow.run(kind, inserted.lastInsertRowid, start, end); timedWindowCount++ }
  }
  const blocked = new Set()
  let edgeCount = 0, unsupportedRestrictions = 0, conditionalRestrictions = 0
  return {
    node(id, tags) {
      if (!bikeNodeAllowed(tags)) blocked.add(id)
      const signal = norm(tags.highway) === 'traffic_signals' || norm(tags.crossing) === 'traffic_signals'
      const walk = walkableNode(tags)
      if (signal || !walk) nodePermission.run(id,Number(signal),Number(walk))
    },
    way(id, tags, refs, getNode) {
      const stressFor = (resolved, direction) => {
        const level = bikeStress(resolved,direction,carAllowed(resolved))
        const foot = {...resolved,foot:resolved[`foot:${direction}`] ?? resolved.foot}
        const walk = !resolved['foot:conditional'] && !resolved[`foot:${direction}:conditional`]
          && !(norm(resolved.motorroad)==='yes' && !allowed.has(norm(foot.foot)))
          && walkableWay(foot,refs) && walkingDirections(resolved)[direction]
        return level | (Number(walk) << 3)
      }
      const stress = {forward:stressFor(tags,'forward'),backward:stressFor(tags,'backward')}
      // Compute junction stresses from original road values before modifying
      // any edge. This prevents high stress spreading recursively downstream.
      // Non-cyclable motor roads still matter where they share an OSM node.
      const level = Math.max(stress.forward & 7,stress.backward & 7)
      if (tags.highway && norm(tags.area) !== 'yes' && level > 1) {
        for (const ref of refs) junction.run(ref,level,id)
      }
      const directions = bikeDirections(tags)
      const timed = bikeWayWindows(tags, stressFor)
      for (const variant of timed) directions[variant.direction] = false
      if (!directions.forward && !directions.backward && !timed.length) return
      const forward = bikeAttributes(tags, 'forward'), backward = bikeAttributes(tags, 'backward')
      let previous
      for (const id2 of refs) {
        const point = blocked.has(id2) ? null : getNode.get(id2)
        if (previous && point) {
          const rad = Math.PI / 180
          const a = Math.sin((point.lat - previous.lat) * rad / 2) ** 2
            + Math.cos(previous.lat * rad) * Math.cos(point.lat * rad) * Math.sin((point.lon - previous.lon) * rad / 2) ** 2
          // Round upward by less than a centimetre: tiny sub-centimetre OSM
          // segments must not weaken the global geometric A* lower bound.
          const cm = Math.ceil(2 * 6371008.8 * Math.asin(Math.min(1, Math.sqrt(a))) * 100)
          if (cm > 0 && cm <= 0xffffffff) {
            node.run(previous.id, Math.round(previous.lon * 1e7), Math.round(previous.lat * 1e7))
            node.run(id2, Math.round(point.lon * 1e7), Math.round(point.lat * 1e7))
            if (directions.forward) { edge.run(previous.id, id2, cm, id, forward, stress.forward); edgeCount++ }
            if (directions.backward) { edge.run(id2, previous.id, cm, id, backward, stress.backward); edgeCount++ }
            for (const variant of timed) {
              const [from,to] = variant.direction === 'forward' ? [previous.id,id2] : [id2,previous.id]
              variant.window ??= edgeSchedule(variant.intervals)
              timedEdge.run(from,to,cm,id,variant.attributes,variant.window,variant.stress)
              timedEdgeCount++
            }
          }
        }
        previous = point ? { id: id2, ...point } : null
      }
    },
    relation(relation, tags, strings) {
      if (norm(tags.type) !== 'restriction') return
      const except = norm(tags.except).split(';').map(v => v.trim()).includes('bicycle')
      const specific = tags['restriction:bicycle']
      const specificConditional = norm(tags['restriction:bicycle:conditional'])
      if (specific == null && !specificConditional && except) return
      // A conditional bicycle exception does not erase the general base rule
      // when its condition is false. An explicit bicycle base does override it.
      const rule = norm(specific ?? (!except ? tags.restriction : ''))
      const genericConditional = specific == null && !except ? norm(tags['restriction:conditional']) : ''
      const conditional = specificConditional || genericConditional
      // Two transportation-mode levels need separate conditional precedence.
      // Until compiled together, keep their recognized restrictions conservative.
      const combined = specificConditional && genericConditional
      const text = combined ? `${genericConditional}; ${specificConditional}` : conditional
      // Conservatively apply each conditional turn at all times. Never infer
      // that a clock-dependent prohibition is inactive from a static graph.
      const conditionalRules = [...text.matchAll(/\b(no_[a-z_]+|only_[a-z_]+)\s*@/g)].map(match => match[1])
      conditionalRestrictions += conditionalRules.length
      const compiled = combined ? null : compileBikeTurnWindows(rule, conditional)
      const rules = compiled ? [...compiled.keys()] : [...new Set([rule, ...conditionalRules])].filter(rule => rule.startsWith('no_') || rule.startsWith('only_'))
      if (!rules.length) return
      const members = relation.refs.map((id, i) => ({ id, role: relation.roles[i], type: relation.types[i] }))
      const from = members.filter(m => strings[m.role] === 'from' && m.type === 1)
      const to = members.filter(m => strings[m.role] === 'to' && m.type === 1)
      const via = members.filter(m => strings[m.role] === 'via')
      if (!from.length || !to.length || !via.length || from.length * to.length > 256) { unsupportedRestrictions++; return }
      for (const rule of rules) {
        if ((from.length > 1 && rule !== 'no_entry') || (to.length > 1 && rule !== 'no_exit')) { unsupportedRestrictions++; continue }
        for (const source of from) for (const target of to) {
          if (via.every(m => m.type === 1) && via.length <= 16) {
            const only = rule.startsWith('only_')
            const inserted = wayTurn.run(source.id, JSON.stringify(via.map(m => m.id)), target.id,
              Number(only) | (only && conditionalRules.includes(rule) ? 2 : 0))
            windows(1, inserted, compiled?.get(rule))
          } else if (via.length === 1 && via[0].type === 0) {
            const same = source.id === target.id
            const movement = same && rule.endsWith('u_turn') ? 2 : same && rule.endsWith('straight_on') ? 4 : 0
            const only = rule.startsWith('only_')
            const inserted = turn.run(via[0].id, source.id, target.id,
              Number(only) | movement | (only && conditionalRules.includes(rule) ? 8 : 0))
            windows(0, inserted, compiled?.get(rule))
          } else { unsupportedRestrictions++ }
        }
      }
    },
    finish() {
      for (const table of ['bike_edges',...(timedEdge ? ['bike_timed_edges'] : [])]) {
        db.exec(`UPDATE ${table} SET stress =
          (CASE WHEN (stress & 16) != 0 THEN stress & 7 ELSE max(stress & 7,
            coalesce((SELECT CASE WHEN signal!=0 THEN 1 WHEN highest_way=way_id THEN other_level ELSE level END
              FROM bike_junction_stress WHERE node_id=from_node),1),
            coalesce((SELECT CASE WHEN signal!=0 THEN 1 WHEN highest_way=way_id THEN other_level ELSE level END
              FROM bike_junction_stress WHERE node_id=to_node),1)) END)
          | (CASE WHEN coalesce((SELECT walk FROM bike_junction_stress WHERE node_id=from_node),1)=1
            AND coalesce((SELECT walk FROM bike_junction_stress WHERE node_id=to_node),1)=1 THEN stress & 8 ELSE 0 END)`)
      }
      db.exec('DROP TABLE bike_junction_stress; CREATE INDEX bike_edges_from ON bike_edges(from_node);')
      return { bikeProfileVersion: 1, bikeStressVersion: 1, bikeEdgeCount: edgeCount,
        bikeNodeCount: Number(db.prepare('SELECT count(*) AS n FROM bike_nodes').get().n),
        bikeUnsupportedRestrictionCount: unsupportedRestrictions, bikeConditionalRestrictionCount: conditionalRestrictions,
        ...(edgeSchedules.size ? { bikeEdgeWindowVersion: 1, bikeTimedEdgeCount: timedEdgeCount, bikeEdgeWindowCount: edgeWindowCount } : {}),
        ...(timedWindowCount ? { bikeTurnWindowVersion: 1, bikeTimedTurnWindowCount: timedWindowCount } : {}) }
    },
  }
}
