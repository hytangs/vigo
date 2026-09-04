import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  createCityStagingDirectory,
  publishCity,
  validateCityDirectory,
} from '../src/city.mjs'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vigo-city-'))
const output = path.join(root, 'city-x')

function writePackage(directory, marker) {
  fs.mkdirSync(path.join(directory, 'routing'), { recursive: true })
  fs.mkdirSync(path.join(directory, 'osm'), { recursive: true })
  fs.writeFileSync(path.join(directory, 'routing', 'project.sqlite'), `routing-${marker}`)
  fs.writeFileSync(path.join(directory, 'osm', 'street-index.sqlite'), `street-${marker}`)
  fs.writeFileSync(path.join(directory, 'network.json'), JSON.stringify({
    schemaVersion: 'vigo.city.v1',
    marker,
  }))
}

try {
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

  const staged = createCityStagingDirectory(output)
  writePackage(staged, 'new')
  publishCity(staged, output, { replace: true })
  assert.equal(validateCityDirectory(output).marker, 'new')
  assert.equal(fs.readFileSync(path.join(output, 'routing', 'project.sqlite'), 'utf8'), 'routing-new')
  assert.equal(fs.readFileSync(path.join(output, 'osm', 'street-index.sqlite'), 'utf8'), 'street-new')
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
