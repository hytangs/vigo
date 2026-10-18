import fs from 'node:fs/promises'
import path from 'node:path'

// Studio's saved scenarios for one City. A group is a remix: a named set of
// the City's timetables. A scenario runs on one group, optionally with planned
// service changes. This is Studio project metadata beside the City; the engine
// and prepared City formats never read it.
export const scenarioLibrarySchemaVersion = 'vigo.studio.scenarios.v1'
export const scenarioLibraryFileName = 'scenarios.json'

const limits = {
  bytes: 4_000_000,
  groups: 64,
  scenarios: 48,
  changes: 64,
  stops: 256,
  geometryPoints: 20_000,
  feedIds: 256,
}
const changeKinds = new Set(['add-line', 'enhance-line', 'change-line', 'remove-line'])
const writes = new Map()

function invalid(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode })
}

function text(value, label, maximum = 80) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) {
    throw invalid(`${label} must be text of at most ${maximum} characters.`)
  }
  return value
}

function identifier(value, label) {
  if (typeof value !== 'string' || !/^[\w.:-]{1,96}$/u.test(value)) throw invalid(`${label} is not a valid identifier.`)
  return value
}

function finite(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw invalid(`${label} must be a finite number.`)
  return value
}

function coordinate(value, label) {
  if (!Array.isArray(value) || value.length !== 2 || !value.every(Number.isFinite)
    || Math.abs(value[0]) > 180 || Math.abs(value[1]) > 90) throw invalid(`${label} must be a [longitude, latitude] pair.`)
  return [value[0], value[1]]
}

function line(value, label) {
  if (!Array.isArray(value) || value.length > limits.geometryPoints) throw invalid(`${label} has too many points.`)
  return value.map((point, index) => coordinate(point, `${label}[${index}]`))
}

function numbers(value, label) {
  if (!Array.isArray(value) || value.length > limits.stops) throw invalid(`${label} must be a short list of numbers.`)
  return value.map((entry, index) => finite(entry, `${label}[${index}]`))
}

function optional(source, key, read) {
  return source[key] === undefined ? {} : { [key]: read(source[key]) }
}

const stopKeys = ['stopId', 'baselineStopId', 'anchorBeforeStopId', 'anchorAfterStopId']
const stopIndexKeys = ['baselineStopIndex', 'anchorBeforeStopIndex', 'anchorAfterStopIndex']

function scenarioStop(value, label) {
  if (!value || typeof value !== 'object') throw invalid(`${label} must be an object.`)
  if (!['map', 'route'].includes(value.source)) throw invalid(`${label}.source must be map or route.`)
  if (value.editStatus !== undefined && !['baseline', 'added', 'inserted', 'replaced'].includes(value.editStatus)) {
    throw invalid(`${label}.editStatus is not recognized.`)
  }
  return {
    id: identifier(value.id, `${label}.id`),
    label: typeof value.label === 'string' ? value.label.slice(0, 160) : '',
    coordinate: coordinate(value.coordinate, `${label}.coordinate`),
    source: value.source,
    ...Object.fromEntries(stopKeys.filter(key => value[key] !== undefined).map(key => [key, text(value[key], `${label}.${key}`, 320)])),
    ...Object.fromEntries(stopIndexKeys.filter(key => value[key] !== undefined).map(key => [key, finite(value[key], `${label}.${key}`)])),
    ...optional(value, 'editStatus', status => status),
  }
}

function scenarioChange(value, label) {
  if (!value || typeof value !== 'object') throw invalid(`${label} must be an object.`)
  if (!changeKinds.has(value.kind)) throw invalid(`${label}.kind is not a recognized change.`)
  if (!Array.isArray(value.stops) || value.stops.length > limits.stops) throw invalid(`${label}.stops is limited to ${limits.stops} stops.`)
  const enumeration = (allowed) => (entry) => {
    if (!allowed.includes(entry)) throw invalid(`${label} has an unrecognized option ${String(entry)}.`)
    return entry
  }
  return {
    id: identifier(value.id, `${label}.id`),
    kind: value.kind,
    name: text(value.name, `${label}.name`, 120),
    ...optional(value, 'scheduleMode', enumeration(['preserve-trips', 'frequency'])),
    ...optional(value, 'routeId', entry => text(entry, `${label}.routeId`, 320)),
    ...optional(value, 'routeScope', enumeration(['pattern', 'edge', 'route'])),
    ...optional(value, 'timeModel', enumeration(['preserve-scheduled', 'infer-road', 'estimate-distance'])),
    ...optional(value, 'geometryMode', enumeration(['published-shape', 'auto-road', 'straight-line'])),
    ...optional(value, 'inferredGeometry', entry => line(entry, `${label}.inferredGeometry`)),
    ...optional(value, 'inferredGeometrySource', enumeration(['osm_drive', 'published_shape_fallback', 'hybrid'])),
    ...Object.fromEntries(['inferredFallbackSegmentCount', 'inferredPublishedShapeSegmentCount', 'inferredOsmSegmentCount']
      .filter(key => value[key] !== undefined).map(key => [key, finite(value[key], `${label}.${key}`)])),
    ...optional(value, 'inferredSegmentGeometry', entry => {
      if (!Array.isArray(entry) || entry.length > limits.stops) throw invalid(`${label}.inferredSegmentGeometry is too long.`)
      return entry.map((segment, index) => line(segment, `${label}.inferredSegmentGeometry[${index}]`))
    }),
    ...optional(value, 'inferredSegmentDistanceKm', entry => numbers(entry, `${label}.inferredSegmentDistanceKm`)),
    ...optional(value, 'inferredSegmentRuntimeMinutes', entry => numbers(entry, `${label}.inferredSegmentRuntimeMinutes`)),
    // Road matching in flight cannot resume after a reload.
    ...(value.geometryStatus === undefined ? {} : { geometryStatus: value.geometryStatus === 'loading' ? 'idle' : enumeration(['idle', 'ready', 'error'])(value.geometryStatus) }),
    ...(typeof value.geometryError === 'string' && value.geometryStatus !== 'loading' ? { geometryError: value.geometryError.slice(0, 400) } : {}),
    stops: value.stops.map((stop, index) => scenarioStop(stop, `${label}.stops[${index}]`)),
    headwayMinutes: finite(value.headwayMinutes, `${label}.headwayMinutes`),
    averageSpeedKph: finite(value.averageSpeedKph, `${label}.averageSpeedKph`),
    startMinutes: finite(value.startMinutes, `${label}.startMinutes`),
    endMinutes: finite(value.endMinutes, `${label}.endMinutes`),
    bidirectional: value.bidirectional === true,
  }
}

function unique(entries, label) {
  if (new Set(entries.map(entry => entry.id)).size !== entries.length) throw invalid(`${label} contain a repeated id.`)
  return entries
}

/** Validates and normalizes a library. Unknown fields are dropped. */
export function normalizeScenarioLibrary(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid('A scenario library must be an object.')
  if (value.schemaVersion !== undefined && value.schemaVersion !== scenarioLibrarySchemaVersion) {
    throw invalid(`Unsupported scenario library ${String(value.schemaVersion)}.`)
  }
  if (!Array.isArray(value.groups) || value.groups.length > limits.groups) throw invalid(`A City keeps at most ${limits.groups} groups.`)
  if (!Array.isArray(value.scenarios) || value.scenarios.length > limits.scenarios) throw invalid(`A City keeps at most ${limits.scenarios} scenarios.`)
  const groups = unique(value.groups.map((group, index) => {
    const label = `groups[${index}]`
    if (!group || typeof group !== 'object' || !Array.isArray(group.feedIds) || group.feedIds.length > limits.feedIds) {
      throw invalid(`${label} must list at most ${limits.feedIds} timetables.`)
    }
    return {
      id: identifier(group.id, `${label}.id`),
      name: text(group.name, `${label}.name`),
      feedIds: [...new Set(group.feedIds.map((feedId, feedIndex) => text(feedId, `${label}.feedIds[${feedIndex}]`, 160)))],
    }
  }), 'Groups')
  const scenarios = unique(value.scenarios.map((scenario, index) => {
    const label = `scenarios[${index}]`
    if (!scenario || typeof scenario !== 'object') throw invalid(`${label} must be an object.`)
    if (!Array.isArray(scenario.changes) || scenario.changes.length > limits.changes) {
      throw invalid(`${label} keeps at most ${limits.changes} changes.`)
    }
    return {
      id: identifier(scenario.id, `${label}.id`),
      name: text(scenario.name, `${label}.name`),
      // A missing group stays missing; a run never widens to the whole City.
      groupId: typeof scenario.groupId === 'string' ? scenario.groupId.slice(0, 96) : '',
      changes: unique(scenario.changes.map((change, changeIndex) => scenarioChange(change, `${label}.changes[${changeIndex}]`)), `${label} changes`),
      ...(typeof scenario.updatedAt === 'string' ? { updatedAt: scenario.updatedAt.slice(0, 40) } : {}),
    }
  }), 'Scenarios')
  return {
    schemaVersion: scenarioLibrarySchemaVersion,
    revision: Number.isSafeInteger(value.revision) && value.revision >= 0 ? value.revision : 0,
    ...(typeof value.updatedAt === 'string' ? { updatedAt: value.updatedAt.slice(0, 40) } : {}),
    groups,
    scenarios,
  }
}

export function scenarioLibraryPath(metaDirectory) {
  return path.join(metaDirectory, scenarioLibraryFileName)
}

/** Reads the saved library; `library` is null when the City has none yet. */
export async function readScenarioLibrary(metaDirectory) {
  let text
  try {
    text = await fs.readFile(scenarioLibraryPath(metaDirectory), 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return { library: null, revision: 0 }
    throw error
  }
  try {
    const library = normalizeScenarioLibrary(JSON.parse(text))
    return { library, revision: library.revision }
  } catch {
    throw invalid('Saved scenarios could not be read. The file has been kept unchanged.', 500)
  }
}

/**
 * Replaces the library when `baseRevision` matches the saved one. Writes for
 * one City are serialized and atomic, so two windows cannot interleave.
 */
export async function writeScenarioLibrary(metaDirectory, value, baseRevision, writeJsonAtomic) {
  if (!Number.isSafeInteger(baseRevision) || baseRevision < 0) throw invalid('baseRevision must be the revision this edit started from.')
  const file = scenarioLibraryPath(metaDirectory)
  const previous = writes.get(file) ?? Promise.resolve()
  const run = previous.catch(() => {}).then(async () => {
    const current = await readScenarioLibrary(metaDirectory)
    if (current.revision !== baseRevision) {
      throw Object.assign(invalid('Scenarios changed in another window. Reload them before saving again.', 409), { library: current.library, revision: current.revision })
    }
    const library = normalizeScenarioLibrary({ ...value, revision: baseRevision + 1, updatedAt: new Date().toISOString() })
    if (Buffer.byteLength(JSON.stringify(library)) > limits.bytes) throw invalid('Saved scenarios exceed the 4 MB limit.', 413)
    await writeJsonAtomic(file, library, { pretty: false })
    return { library, revision: library.revision }
  })
  writes.set(file, run)
  try {
    return await run
  } finally {
    if (writes.get(file) === run) writes.delete(file)
  }
}
