import assert from 'node:assert/strict'
import path from 'node:path'
import { routeNationalGtfsMatrix } from '../../src/server/national-gtfs-store.mjs'

const cityPath = process.argv[2]
const expectedMinutes = Number(process.argv[3])

const scalarMatrixRequest = {
  origins: [{ coordinate: [-77.05, 38.9] }],
  destinations: [{ coordinate: [-77.03, 38.91] }],
  departMinutes: 475, serviceDate: '2026-07-15', maxWalkKm: 0.2,
  streetStorePath: path.join(cityPath, 'osm', 'street-index.sqlite'),
}
for (const matrixStrategy of ['shared', 'pairwise']) {
  const query = (options = {}) => routeNationalGtfsMatrix(path.join(cityPath, 'routing', 'project.sqlite'), {
    ...scalarMatrixRequest, matrixStrategy, ...options,
  })
  const walked = query()
  assert(Math.abs(walked.rows[0].durationMinutes - expectedMinutes) < 0.001)
  assert.equal(walked.diagnostics.directWalk.selectedPairs, 1)
  assert.equal(query({ allowLongWalk: false }).rows[0].durationMinutes, 35,
    'The explicit direct-walk limit must preserve the transit choice.')
  assert.equal(query({ horizonMinutes: 10 }).rows[0].status, 'blocked',
    'Direct walking must respect the Matrix horizon.')
  const noService = query({ serviceDate: '2027-07-15' })
  assert.equal(noService.rows[0].status, 'ready', 'An inactive timetable must not block a valid direct walk.')
  assert(Math.abs(noService.rows[0].durationMinutes - walked.rows[0].durationMinutes) < 0.001)
}
