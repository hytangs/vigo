function routeModeBand(routeType) {
  const value = numeric(routeType, 3)
  if (value <= 2) return 'rail'
  if (value === 3) return 'bus'
  return 'other'
}

import { haversineKm } from '../geometry-utils.mjs'
import { numeric, timingMilliseconds } from '../number-utils.mjs'

const stopAccessSpatialCellDegrees = 0.01

function isHeavyRailRouteType(routeType) {
  const value = numeric(routeType, 3)
  return value === 1 || value === 2 || (value >= 100 && value < 200) || (value >= 400 && value < 500)
}

function stopAccessCellKey(latitudeCell, longitudeCell) {
  return `${latitudeCell}:${longitudeCell}`
}

export function buildStopAccessIndex(db, stopRecords, stationMembers) {
  const startedAt = performance.now()
  const hasStopModes = Boolean(db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='stop_modes'").get())
  if (!hasStopModes) {
    return {
      ready: false,
      reason: 'stop_modes_absent',
      strategy: 'resident_stop_access_index_required',
      cellDegrees: stopAccessSpatialCellDegrees,
      anchorCount: 0,
      profiledAnchorCount: 0,
      cellCount: 0,
      modeRowCount: 0,
      estimatedBytes: 0,
      buildMs: Number((performance.now() - startedAt).toFixed(3)),
      queryCount: 0,
      queryMs: 0,
    }
  }
  const rawDeparturesByStop = new Map()
  let modeRowCount = 0
  for (const row of db.prepare('SELECT stop_id, route_type, departure_count FROM stop_modes ORDER BY stop_id, route_type').iterate()) {
    const stopId = String(row.stop_id)
    const routeType = numeric(row.route_type, 3)
    const departures = Math.max(0, numeric(row.departure_count, 0))
    const routeDepartures = rawDeparturesByStop.get(stopId) ?? new Map()
    routeDepartures.set(routeType, (routeDepartures.get(routeType) ?? 0) + departures)
    rawDeparturesByStop.set(stopId, routeDepartures)
    modeRowCount += 1
  }
  const departureServiceStopIds = new Set()
  const arrivalServiceStopIds = new Set()
  const directServiceStopIds = new Set()
  let roleRowCount = 0
  for (const row of db.prepare(`
    SELECT stop_id, can_board, can_alight
    FROM stop_access_roles
    ORDER BY stop_id
  `).iterate()) {
    const stopId = String(row.stop_id)
    const parentStation = String(stopRecords.get(stopId)?.parent_station ?? '').trim()
    if (row.can_board === 1) {
      directServiceStopIds.add(stopId)
      departureServiceStopIds.add(stopId)
      if (parentStation) departureServiceStopIds.add(parentStation)
    }
    if (row.can_alight === 1) {
      directServiceStopIds.add(stopId)
      arrivalServiceStopIds.add(stopId)
      if (parentStation) arrivalServiceStopIds.add(parentStation)
    }
    roleRowCount += 1
  }

  const createProfile = (routeDepartureMap, sampleCount) => {
    const routeDepartures = [...routeDepartureMap]
      .map(([routeType, departures]) => ({ routeType, departures }))
      .sort((left, right) => left.routeType - right.routeType)
    const departureCount = routeDepartures.reduce((sum, entry) => sum + entry.departures, 0)
    const profile = { routeDepartures, departureCount, sampleCount }
    profile.routeTypes = profile.routeDepartures.map((entry) => entry.routeType)
    profile.modes = ['rail', 'bus', 'other'].filter((mode) => profile.routeTypes.some((routeType) => routeModeBand(routeType) === mode))
    profile.hasHeavyRail = profile.routeTypes.some(isHeavyRailRouteType)
    return Object.freeze(profile)
  }
  const profilesByStop = new Map()
  const directProfilesByStop = new Map()
  for (const [stopId, routeDepartures] of rawDeparturesByStop) {
    const directDepartureCount = [...routeDepartures.values()].reduce((sum, departures) => sum + departures, 0)
    directProfilesByStop.set(stopId, createProfile(routeDepartures, Math.min(12, directDepartureCount)))
  }
  for (const stop of stopRecords.values()) {
    const direct = rawDeparturesByStop.get(stop.stop_id) ?? new Map()
    const routeDepartures = new Map(direct)
    const directDepartureCount = [...direct.values()].reduce((sum, departures) => sum + departures, 0)
    let sampleCount = Math.min(12, directDepartureCount)
    if (numeric(stop.location_type, 0) === 1) {
      const memberDepartures = new Map()
      let memberSampleCount = 0
      for (const memberId of stationMembers.get(stop.stop_id) ?? []) {
        if (memberId === stop.stop_id) continue
        const member = rawDeparturesByStop.get(memberId)
        if (!member) continue
        const memberTotal = [...member.values()].reduce((sum, departures) => sum + departures, 0)
        memberSampleCount += Math.min(12, memberTotal)
        for (const [routeType, departures] of member) {
          memberDepartures.set(routeType, (memberDepartures.get(routeType) ?? 0) + departures)
        }
      }
      if (memberDepartures.size) {
        // Platform rows and their parent aggregate may describe the same
        // departures. Max preserves the signal without counting service twice.
        for (const [routeType, departures] of memberDepartures) {
          routeDepartures.set(routeType, Math.max(routeDepartures.get(routeType) ?? 0, departures))
        }
        sampleCount = Math.max(memberSampleCount, Math.min(12, directDepartureCount))
      }
    }
    if (routeDepartures.size) profilesByStop.set(stop.stop_id, createProfile(routeDepartures, sampleCount))
  }

  const anchors = []
  const cells = new Map()
  for (const stop of stopRecords.values()) {
    if (!Number.isFinite(stop.lat) || !Number.isFinite(stop.lon)) continue
    if (numeric(stop.location_type, 0) !== 1 && stop.parent_station !== null && stop.parent_station !== undefined && stop.parent_station !== '') continue
    const anchor = Object.freeze(stop)
    anchors.push(anchor)
    const latitudeCell = Math.floor(anchor.lat / stopAccessSpatialCellDegrees)
    const longitudeCell = Math.floor(anchor.lon / stopAccessSpatialCellDegrees)
    const key = stopAccessCellKey(latitudeCell, longitudeCell)
    const entries = cells.get(key) ?? []
    entries.push(anchor)
    cells.set(key, entries)
  }
  anchors.sort((left, right) => String(left.stop_id).localeCompare(String(right.stop_id)))
  for (const entries of cells.values()) entries.sort((left, right) => String(left.stop_id).localeCompare(String(right.stop_id)))
  const estimatedBytes = anchors.length * 96 + modeRowCount * 40 + roleRowCount * 24 + cells.size * 64
  return {
    ready: true,
    reason: 'ready',
    strategy: 'immutable_grid_persisted_exact_stop_roles',
    cellDegrees: stopAccessSpatialCellDegrees,
    anchors,
    cells,
    profilesByStop,
    directProfilesByStop,
    directServiceStopIds,
    departureServiceStopIds,
    arrivalServiceStopIds,
    anchorCount: anchors.length,
    profiledAnchorCount: anchors.reduce((count, anchor) => count + (profilesByStop.has(anchor.stop_id) ? 1 : 0), 0),
    cellCount: cells.size,
    modeRowCount,
    roleRowCount,
    estimatedBytes,
    buildMs: Number((performance.now() - startedAt).toFixed(3)),
    queryCount: 0,
    queryMs: 0,
  }
}

export function stopAccessIndexDiagnostics(store) {
  const index = store.stopAccessIndex
  return {
    ready: index.ready,
    reason: index.reason,
    strategy: index.strategy,
    cellDegrees: index.cellDegrees,
    anchorCount: index.anchorCount,
    profiledAnchorCount: index.profiledAnchorCount,
    cellCount: index.cellCount,
    modeRowCount: index.modeRowCount,
    estimatedBytes: index.estimatedBytes,
    buildMs: index.buildMs,
    queryCount: index.queryCount,
    queryMs: timingMilliseconds(index.queryMs),
  }
}

export function sampledAnchorServiceProfile(store, anchor) {
  return store.stopAccessIndex.profilesByStop?.get(anchor.stop_id) ?? {
    modes: [], routeTypes: [], routeDepartures: [], hasHeavyRail: false, sampleCount: 0, departureCount: 0,
  }
}

function compareAccessDistance(left, right) {
  return left.distanceKm - right.distanceKm || String(left.stop_id).localeCompare(String(right.stop_id))
}

function expandAccessAnchors(store, anchors, limit = Number.POSITIVE_INFINITY) {
  const expanded = new Map()
  for (const anchor of anchors) {
    if (expanded.size >= limit) break
    const memberIds = anchor.location_type === 1 && (anchor.distanceKm <= 0.02 || anchor.expandServiceMembers)
      ? (store.stationMembers.get(anchor.stop_id) ?? [anchor.stop_id])
      : [anchor.stop_id]
    for (const stopId of memberIds) {
      const member = store.stopRecords.get(stopId)
      if (!member) continue
      if (!expanded.has(member.stop_id) && expanded.size >= limit) break
      expanded.set(member.stop_id, {
        ...member,
        distanceKm: anchor.distanceKm,
        accessPriority: anchor.accessPriority,
        expandServiceMembers: anchor.expandServiceMembers,
      })
    }
  }
  return [...expanded.values()].sort(compareAccessDistance)
}

function nearbyIndexedAccessAnchors(index, coordinate, maxWalkKm, options = {}) {
  const latDelta = maxWalkKm / 110.574
  const lonDelta = maxWalkKm / Math.max(1, 111.32 * Math.cos(coordinate[1] * Math.PI / 180))
  const minimumLatitude = coordinate[1] - latDelta
  const maximumLatitude = coordinate[1] + latDelta
  const minimumLongitude = coordinate[0] - lonDelta
  const maximumLongitude = coordinate[0] + lonDelta
  const limit = Number.isFinite(options.limit) ? Math.max(1, Math.floor(options.limit)) : Number.POSITIVE_INFINITY
  const bounded = []
  for (let latitudeCell = Math.floor(minimumLatitude / index.cellDegrees); latitudeCell <= Math.floor(maximumLatitude / index.cellDegrees); latitudeCell += 1) {
    for (let longitudeCell = Math.floor(minimumLongitude / index.cellDegrees); longitudeCell <= Math.floor(maximumLongitude / index.cellDegrees); longitudeCell += 1) {
      for (const anchor of index.cells.get(stopAccessCellKey(latitudeCell, longitudeCell)) ?? []) {
        if (anchor.lat < minimumLatitude || anchor.lat > maximumLatitude || anchor.lon < minimumLongitude || anchor.lon > maximumLongitude) continue
        const distanceKm = haversineKm(coordinate, [anchor.lon, anchor.lat])
        if (Number.isFinite(limit) && distanceKm > maxWalkKm) continue
        bounded.push({ ...anchor, distanceKm })
        if (Number.isFinite(limit) && bounded.length >= limit * 2) {
          bounded.sort(compareAccessDistance)
          bounded.length = limit
        }
      }
    }
  }
  bounded.sort(compareAccessDistance)
  if (Number.isFinite(limit) && bounded.length > limit) bounded.length = limit
  return { bounded, nearby: bounded.filter((anchor) => anchor.distanceKm <= maxWalkKm) }
}

export function nearestStopsFromIndex(store, coordinate, maxWalkKm, limit = 12) {
  const startedAt = performance.now()
  const index = store.stopAccessIndex
  const { bounded, nearby } = nearbyIndexedAccessAnchors(index, coordinate, maxWalkKm)
  const anchorMap = new Map(nearby.slice(0, limit).map((stop) => [stop.stop_id, stop]))
  const profiled = nearby.slice(0, 256)
    .map((anchor) => ({ anchor, profile: sampledAnchorServiceProfile(store, anchor) }))
    .filter(({ profile }) => profile.sampleCount > 0)
    .sort((left, right) => (
      right.profile.sampleCount - left.profile.sampleCount
      || compareAccessDistance(left.anchor, right.anchor)
    ))
  const retained = new Map()
  for (const candidate of profiled.slice(0, 4)) retained.set(candidate.anchor.stop_id, candidate)
  const priorityModesByStop = new Map()
  const primaryHeavyRail = profiled.find(({ anchor, profile }) => anchor.location_type === 1 && profile.hasHeavyRail)
    ?? profiled.find(({ profile }) => profile.hasHeavyRail)
  for (const mode of ['rail', 'bus', 'other']) {
    const candidate = mode === 'rail'
      ? primaryHeavyRail ?? profiled.find(({ profile }) => profile.modes.includes(mode))
      : profiled.find(({ profile }) => profile.modes.includes(mode))
    if (!candidate) continue
    retained.set(candidate.anchor.stop_id, candidate)
    const modes = priorityModesByStop.get(candidate.anchor.stop_id) ?? []
    modes.push(mode)
    priorityModesByStop.set(candidate.anchor.stop_id, modes)
  }
  const primaryRailStopId = primaryHeavyRail?.anchor.stop_id
    ?? profiled.find(({ profile }) => profile.modes.includes('rail'))?.anchor.stop_id
  for (const { anchor } of retained.values()) {
    const priorityModes = priorityModesByStop.get(anchor.stop_id)
    anchorMap.set(anchor.stop_id, {
      ...anchor,
      accessPriority: priorityModes?.length ? `sampled-${priorityModes.join('-')}:${anchor.stop_id}` : undefined,
      expandServiceMembers: anchor.stop_id === primaryRailStopId,
    })
  }

  // A map point is an access area, not a request to bind to one station.
  // Keep every heavy-rail station inside the physical walk radius in the
  // street target set. Dense bus stops can otherwise consume the crow-flight
  // shortlist before OSM routing sees a station entrance at all.
  for (const anchor of nearby) {
    if (numeric(anchor.location_type, 0) !== 1) continue
    const profile = sampledAnchorServiceProfile(store, anchor)
    if (!profile.hasHeavyRail) continue
    anchorMap.set(anchor.stop_id, {
      ...anchor,
      accessPriority: `sampled-rail-station:${anchor.stop_id}`,
      expandServiceMembers: true,
    })
  }

  const squaredDistance = (anchor) => (anchor.lat - coordinate[1]) ** 2 + (anchor.lon - coordinate[0]) ** 2
  for (const [minimumType, maximumType] of [[0, 2], [3, 3], [4, 99]]) {
    const rows = []
    for (const anchor of bounded) {
      const profile = index.directProfilesByStop.get(anchor.stop_id)
      for (const entry of profile?.routeDepartures ?? []) {
        if (entry.routeType >= minimumType && entry.routeType <= maximumType) rows.push({ anchor, ...entry })
      }
    }
    rows.sort((left, right) => (
      squaredDistance(left.anchor) - squaredDistance(right.anchor)
      || right.departures - left.departures
      || String(left.anchor.stop_id).localeCompare(String(right.anchor.stop_id))
      || left.routeType - right.routeType
    ))
    for (const { anchor } of rows.slice(0, 6)) {
      if (anchor.distanceKm > maxWalkKm) continue
      const existing = anchorMap.get(anchor.stop_id)
      anchorMap.set(anchor.stop_id, {
        ...anchor,
        accessPriority: existing?.accessPriority,
        expandServiceMembers: existing?.expandServiceMembers,
      })
    }
  }

  const serviceCandidates = bounded
    .filter((anchor) => (index.directProfilesByStop.get(anchor.stop_id)?.departureCount ?? 0) > 0)
    .sort((left, right) => (
      (index.directProfilesByStop.get(right.stop_id)?.departureCount ?? 0) - (index.directProfilesByStop.get(left.stop_id)?.departureCount ?? 0)
      || squaredDistance(left) - squaredDistance(right)
      || String(left.stop_id).localeCompare(String(right.stop_id))
    ))
    .slice(0, 6)
    .filter((anchor) => anchor.distanceKm <= maxWalkKm)
    .sort(compareAccessDistance)
  for (const anchor of serviceCandidates) {
    const existing = anchorMap.get(anchor.stop_id)
    anchorMap.set(anchor.stop_id, {
      ...anchor,
      accessPriority: existing?.accessPriority,
      expandServiceMembers: existing?.expandServiceMembers,
    })
  }
  const candidates = expandAccessAnchors(store, [...anchorMap.values()])
  index.queryCount += 1
  index.queryMs += performance.now() - startedAt
  return candidates
}

export function deferredStopAccessIndex() {
  return {
    ready: false,
    reason: 'deferred',
    strategy: 'deferred_until_coordinate_access',
    cellDegrees: stopAccessSpatialCellDegrees,
    anchors: [],
    cells: new Map(),
    profilesByStop: new Map(),
    directProfilesByStop: new Map(),
    directServiceStopIds: new Set(),
    departureServiceStopIds: new Set(),
    arrivalServiceStopIds: new Set(),
    anchorCount: 0,
    profiledAnchorCount: 0,
    cellCount: 0,
    modeRowCount: 0,
    roleRowCount: 0,
    estimatedBytes: 0,
    buildMs: 0,
    queryCount: 0,
    queryMs: 0,
  }
}
