import fs from 'node:fs'
import path from 'node:path'
import { cityCaseFeedIds } from './gtfs/source-selection.mjs'
import { validateCityDirectory } from '../city.mjs'
import { validateWheelchairRequest, wheelchairDescriptionFor, wheelchairProfile } from './wheelchair-policy.mjs'

// A separately compiled City keeps inaccessible edges out of every search stage.
// Never fall back to the ordinary graph when the requested profile is missing.
export function studioWheelchairSelection(projectDirectory, project, request) {
  if (request.wheelchair !== undefined && typeof request.wheelchair !== 'boolean') {
    throw Object.assign(new Error('wheelchair must be boolean'), { statusCode: 400 })
  }
  if (request.wheelchairAccessible !== undefined) {
    throw Object.assign(new Error('Use wheelchair, not wheelchairAccessible'), { statusCode: 400 })
  }
  if (!request.wheelchair) return null
  try {
    validateWheelchairRequest(wheelchairProfile, request)
    if (request.departNow || request.waypoints?.length || request.scenarioKey) {
      throw new Error('Wheelchair routing requires the scheduled City timetable without via points or scenarios.')
    }
  } catch (error) { throw Object.assign(error, { statusCode: 400 }) }
  const directory = path.join(projectDirectory, 'wheelchair')
  const unavailable = message => Object.assign(new Error(message), { statusCode: 409, code: 'wheelchair_profile_unavailable' })
  if (!fs.existsSync(path.join(directory, 'network.json'))) {
    throw unavailable('This City has no prepared wheelchair network. Prepare one from the same timetable and streets before using wheelchair routing. No ordinary route was substituted.')
  }
  let manifest
  try { manifest = validateCityDirectory(directory) } catch (error) {
    throw unavailable(`The wheelchair network is incomplete: ${error.message}`)
  }
  if (manifest.accessibility?.profile !== wheelchairProfile) throw unavailable('The prepared network is not a wheelchair profile.')
  // Match the selected network, never the union of alternative City feeds.
  const selectedIds = cityCaseFeedIds(project, request)
  const selectedId = selectedIds?.length === 1 ? selectedIds[0]
    : !selectedIds ? (request.feedId && request.feedId !== '__project__' ? request.feedId : project.defaultRoutingFeedId ?? (project.feeds?.length === 1 ? project.feeds[0].id : null)) : null
  const feed = project.feeds?.find(candidate => candidate.id === selectedId)
  const gtfs = manifest.sources?.gtfs
  const fingerprint = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
  if (!feed || gtfs?.length !== 1
    || !fingerprint(gtfs?.[0]?.sha256) || !fingerprint(manifest.sources?.osm?.sha256)
    || gtfs[0].sha256 !== feed.routingStore?.sourceFingerprint
    || manifest.sources?.osm?.sha256 !== project.osmStreetIndex?.sourceFingerprint) {
    throw unavailable('The wheelchair network must match the selected network’s timetable and streets. Rebuild the wheelchair network after changing sources.')
  }
  return { feed, storePath: path.join(directory, 'routing', 'project.sqlite'),
    streetPath: path.join(directory, 'osm', 'street-index.sqlite'), accessibility: manifest.accessibility }
}

// Capability discovery uses the same source and profile checks as routing.
export function studioWheelchairAvailability(directory, project, request) {
  try {
    studioWheelchairSelection(directory, project, { ...request, wheelchair: true, routingDataMode: 'scheduled', departNow: false })
    return { available: true }
  } catch (error) {
    if (error.statusCode === 400 || error.code === 'wheelchair_profile_unavailable') return { available: false, reason: error.message }
    throw error
  }
}

// Describe the prepared network's own street evidence. Networks prepared
// before street evidence was recorded used only wheelchair=yes ways.
export function studioWheelchairAccessibility(projectDirectory) {
  try {
    const { accessibility } = JSON.parse(fs.readFileSync(path.join(projectDirectory, 'wheelchair', 'network.json'), 'utf8'))
    if (accessibility?.profile) return accessibility.streetEvidence ? accessibility : wheelchairDescriptionFor('verified')
  } catch {}
  return wheelchairDescriptionFor('inferred')
}
