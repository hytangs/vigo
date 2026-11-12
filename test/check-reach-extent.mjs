// Drive and bicycle Reach squares hold every point their time budget can
// reach, so a surface never ends at the square's edge.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { transformWithOxc } from 'vite'
import { supportedReachRasterSizes } from '../src/capabilities.mjs'

const source = new URL('../src/app/reachExtent.ts', import.meta.url)
const code = (await transformWithOxc(await readFile(source, 'utf8'), source.pathname, { target: 'es2022' })).code
const { reachExtent, maximumReachRadiusKm } = await import(`data:text/javascript,${encodeURIComponent(code)}`)

const bike = speedKph => ({ profile: 'balanced', speedKph })
for (const minutes of [5, 15, 30, 45, 60, 78.75, 120, 240]) {
  for (const speedKph of [10, 18, 30, 40]) {
    // Cycling reaches at most ×1.24 its speed downhill, never above 45 km/h.
    const area = reachExtent('bike', minutes, bike(speedKph))
    assert(area.radiusKm >= Math.min(maximumReachRadiusKm, minutes / 60 * Math.min(45, speedKph * 1.24)), JSON.stringify({ minutes, speedKph, area }))
    assert(supportedReachRasterSizes.includes(area.rasterSize) && area.rasterSize <= 48, JSON.stringify(area))
  }
  // Driving reaches at most the 140 km/h road-speed cap.
  const drive = reachExtent('drive', minutes, bike(18))
  assert(drive.radiusKm >= Math.min(maximumReachRadiusKm, minutes / 60 * 140), JSON.stringify({ minutes, drive }))
  assert(supportedReachRasterSizes.includes(drive.rasterSize) && drive.rasterSize <= 128, JSON.stringify(drive))
}
// The screenshot case: 78.75 minutes at 18 km/h reaches well past 8 km.
assert.deepEqual(reachExtent('bike', 78.75, bike(18)), { radiusKm: 29.4, rasterSize: 48, cellMeters: 1225 })
// Short budgets keep fine cells; long ones grow cells, not the cut-off.
assert.deepEqual(reachExtent('bike', 15, bike(18)), { radiusKm: 5.7, rasterSize: 48, cellMeters: 238 })
// Every grid is one Reach accepts: 12.75 minutes needs 30 cells and uses 48.
assert.deepEqual(reachExtent('bike', 12.75, bike(18)), { radiusKm: 4.8, rasterSize: 48, cellMeters: 200 })
for (let minutes = 1; minutes <= 240; minutes += 0.25) {
  for (const mode of ['drive', 'bike']) {
    assert(supportedReachRasterSizes.includes(reachExtent(mode, minutes, bike(18)).rasterSize), `${mode} ${minutes}`)
  }
}
assert.deepEqual(reachExtent('drive', 30, bike(18)), { radiusKm: 70.1, rasterSize: 128, cellMeters: 1095 })
assert.equal(reachExtent('drive', 240, bike(18)).radiusKm, maximumReachRadiusKm)
assert.equal(reachExtent('bike', 1, bike(5)).radiusKm, 1)

console.log('Reach extent passed: drive and bicycle squares hold every point the budget reaches, with bounded grids.')
