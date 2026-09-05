import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vigo-compare-'))
const cli = path.resolve(import.meta.dirname, '../public/vigo.mjs')
function compare(before, after) {
  const files = [before, after].map((result, index) => {
    const file = path.join(directory, `${index}.json`)
    fs.writeFileSync(file, JSON.stringify(result))
    return file
  })
  const result = spawnSync(process.execPath, [cli, 'compare', `--before=${files[0]}`, `--after=${files[1]}`], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr)
  return JSON.parse(result.stdout).change
}
const reach = (values, bounds = [0, 0, 1, 1], width = 2, height = 2) => ({
  kind: 'reach', surface: { values, bounds, width, height },
})
try {
  const change = compare(reach([null, 10, 0, null]), reach([20, null, 0, null]))
  assert.equal(change.comparableCells, 1, 'Unreachable cells must not become zero-minute trips.')
  assert.equal(change.meanChangeMinutes, 0)
  assert.equal(change.newlyReachableCells, 1)
  assert.equal(change.noLongerReachableCells, 1)
  assert.throws(() => compare(reach([1, 2, 3, 4]), reach([1, 2, 3, 4], [1, 1, 2, 2])), /same grid/)
  assert.throws(() => compare(reach([1, 2, 3, 4]), reach([1, 2, 3, 4], [0, 0, 1, 1], 1, 4)), /same grid/)
  const row = (originId, destinationId, durationMinutes) => ({
    originId, destinationId, durationMinutes, status: durationMinutes === null ? 'blocked' : 'ready',
  })
  const matrix = compare(
    { kind: 'matrix', rows: [row('a:b', 'c', null), row('a', 'b:c', 10)] },
    { kind: 'matrix', rows: [row('a:b', 'c', 5), row('a', 'b:c', 8)] },
  )
  assert.equal(matrix.comparablePairs, 1, 'Distinct point IDs must not collide at colon separators.')
  assert.equal(matrix.meanChangeMinutes, -2)
  assert.equal(matrix.newlyReachablePairs, 1)
  const route = compare(
    { kind: 'route', result: { status: 'blocked', durationMinutes: null, transfers: null } },
    { kind: 'route', result: { status: 'ready', durationMinutes: 10, transfers: 1 } },
  )
  assert.equal(route.durationChangeMinutes, null)
  assert.equal(route.transferChange, null)
  console.log('Result comparison preserves missing travel times and grid identity.')
} finally {
  fs.rmSync(directory, { recursive: true, force: true })
}
