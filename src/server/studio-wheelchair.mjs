import fs from 'node:fs'
import path from 'node:path'
import { validateCityDirectory } from '../city.mjs'
import { validateWheelchairRequest, wheelchairProfile } from './wheelchair-policy.mjs'

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
    if (request.departNow || request.waypoints?.length || request.scenarioKey || request.feedIds?.length) {
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
  // Studio currently selects one imported feed; do not guess source namespaces.
  const gtfs = manifest.sources?.gtfs
  const fingerprint = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
  if (project.feeds?.length !== 1 || gtfs?.length !== 1
    || !fingerprint(gtfs?.[0]?.sha256) || !fingerprint(manifest.sources?.osm?.sha256)
    || (request.feedId && request.feedId !== project.feeds[0].id)
    || gtfs[0].sha256 !== project.feeds[0].routingStore?.sourceFingerprint
    || manifest.sources?.osm?.sha256 !== project.osmStreetIndex?.sourceFingerprint) {
    throw unavailable('The wheelchair network must match this single-feed City’s current timetable and streets. Rebuild the wheelchair network after changing sources.')
  }
  return { storePath: path.join(directory, 'routing', 'project.sqlite'),
    streetPath: path.join(directory, 'osm', 'street-index.sqlite'), accessibility: manifest.accessibility }
}
