import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { searchStudioAddresses } from '../src/server/studio-address-search.mjs'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vigo-studio-search-'))
const calls = []
const fetcher = async url => {
  calls.push(url.searchParams.get('bbox'))
  return { ok: true, json: async () => ({ features: [
    { geometry: { type: 'Point', coordinates: [-71.1,42.35] }, properties: { name: 'Main Street', city: 'Boston' } },
    { geometry: { type: 'Point', coordinates: [-77.03,38.9] }, properties: { name: 'Main Street', city: 'Washington' } },
  ] }) }
}
const endpoint = 'https://studio-geocoder.example.test/'
async function snapshot(name, lon, lat) {
  const p = path.join(root, name)
  await fs.writeFile(`${p}.street-accelerator-v7.bin`, JSON.stringify({magic:'vigo.street.accelerator',version:7,
    spatialMinLon:lon,spatialMinLat:lat,spatialColumns:100,spatialRows:100,spatialCellDegrees:.002}).padEnd(4096,' '))
  return p
}
try {
  const boston = await snapshot('boston',-71.2,42.3), dc = await snapshot('dc',-77.1,38.8)
  const search = streetPath => searchStudioAddresses('Main Street', {streetPath,fetcher,endpoint})
  assert.deepEqual((await search(boston)).results.map(r=>r.detail),['Boston'])
  assert.deepEqual((await search(dc)).results.map(r=>r.detail),['Washington'],'Switching Cities must not reuse the previous region')
  assert.deepEqual(calls,['-71.2,42.3,-71,42.5','-77.1,38.8,-76.89999999999999,39'])
  await snapshot('boston',-77.1,38.8)
  assert.deepEqual((await search(boston)).results.map(r=>r.detail),['Washington'],'Replacing City coverage invalidates the bounds cache')
  const file = path.join(root,'transit.sqlite'), db = new DatabaseSync(file)
  db.exec('CREATE TABLE stops(lon REAL,lat REAL); INSERT INTO stops VALUES(-71.2,42.3),(-71,42.5),(NULL,NULL)');db.close()
  assert.deepEqual((await searchStudioAddresses('Main Street',{routingPaths:[file],fetcher,endpoint})).results.map(r=>r.detail),['Boston'],'Timetable-only Cities use stop coverage')
  await assert.rejects(searchStudioAddresses('Main Street',{fetcher,endpoint}),{statusCode:409},'Missing coverage must never produce a global search')
  const before=calls.length
  assert.deepEqual((await searchStudioAddresses('Offline place',{streetPath:dc,fetcher,endpoint,remote:false})).results,[])
  assert.equal(calls.length,before,'Offline mode does not contact the geocoder')
  console.log('Studio address search: City bounds, City switches, replacement, timetable fallback and offline checks passed.')
} finally { await fs.rm(root,{recursive:true,force:true}) }
