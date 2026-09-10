import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { writeCliFixtureInputs } from './helpers/cli-fixture-inputs.mjs'
import { buildNationalGtfsStore } from '../src/server/national-gtfs-store.mjs'
import { buildNationalOsmStore, compactNationalOsmRuntimeStore, disposeNationalOsmStore } from '../src/server/national-osm-store.mjs'
import {
  createCityStagingDirectory,
  publishCity,
  validateCityDirectory,
} from '../src/city.mjs'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vigo-city-'))
const output = path.join(root, 'city-x')
const template = path.join(root, 'template')

function writePackage(directory, marker) {
  fs.cpSync(template, directory, { recursive: true })
  fs.writeFileSync(path.join(directory, 'network.json'), JSON.stringify({
    schemaVersion: 'vigo.city.v1',
    marker,
  }))
}

try {
  const inputs = await writeCliFixtureInputs(root)
  await buildNationalGtfsStore({ zipPath: inputs.gtfsPath, outputPath: path.join(template, 'routing/project.sqlite') })
  const streetPath = path.join(template, 'osm/street-index.sqlite')
  await buildNationalOsmStore({ pbfPath: inputs.osmPath, outputPath: streetPath })
  compactNationalOsmRuntimeStore(streetPath, { requireDrive: true })
  disposeNationalOsmStore(streetPath)
  writePackage(output, 'old')
  const incomplete = createCityStagingDirectory(output)
  fs.mkdirSync(path.join(incomplete, 'routing'))
  fs.writeFileSync(path.join(incomplete, 'routing', 'project.sqlite'), 'partial')
  assert.throws(
    () => publishCity(incomplete, output, { replace: true }),
    /incomplete/,
  )
  assert.equal(validateCityDirectory(output).marker, 'old')
  fs.rmSync(incomplete, { recursive: true, force: true })

  const outdated = createCityStagingDirectory(output)
  writePackage(outdated, 'outdated')
  const oldRouting = new DatabaseSync(path.join(outdated, 'routing/project.sqlite'))
  oldRouting.prepare('UPDATE metadata SET value=? WHERE key=?').run('"vigo.routing.transfers.v2"', 'transferSemanticsVersion')
  oldRouting.close()
  assert.throws(() => publishCity(outdated, output, { replace: true }), /Transfer semantics/)
  assert.equal(validateCityDirectory(output).marker, 'old')
  fs.rmSync(outdated, { recursive: true, force: true })

  const staged = createCityStagingDirectory(output)
  writePackage(staged, 'new')
  publishCity(staged, output, { replace: true })
  assert.equal(validateCityDirectory(output).marker, 'new')
  assert.deepEqual(fs.readFileSync(path.join(output, 'routing', 'project.sqlite')), fs.readFileSync(path.join(template, 'routing', 'project.sqlite')))
  assert.deepEqual(fs.readFileSync(path.join(output, 'osm', 'street-index.sqlite')), fs.readFileSync(streetPath))
  assert(!fs.existsSync(staged), 'Published staging directory should become the City.')
  assert.equal(
    fs.readdirSync(root).filter((name) => name.includes('.vigo-previous-')).length,
    0,
    'Successful replacement should remove the previous City.',
  )
  console.log('Atomic City publication passed.')
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}
