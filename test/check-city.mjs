// The engine publishes Cities (its own tests cover rejected and interrupted
// publication). Queries through vigo.mjs finish what a crashed publication
// left, so this checks that recovery against the same on-disk states, and the
// engine's recovery and replacement end to end.
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { writeCliFixtureInputs } from './helpers/cli-fixture-inputs.mjs'
import { standaloneBinary } from './helpers/standalone-runtime.mjs'
import { recoverCityPublication, validateCityDirectory } from '../src/city.mjs'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vigo-city-'))
const output = path.join(root, 'city-x')
const template = path.join(root, 'template')
const hostTag = crypto.createHash('sha256').update(os.hostname()).digest('hex').slice(0, 8)

function writePackage(directory, marker) {
  fs.cpSync(template, directory, { recursive: true })
  fs.writeFileSync(path.join(directory, 'network.json'), JSON.stringify({
    schemaVersion: 'vigo.city.v1',
    marker,
  }))
}

try {
  const inputs = await writeCliFixtureInputs(root)
  const build = (...extra) => spawnSync(standaloneBinary, ['build', `--gtfs=${inputs.gtfsPath}`, `--osm=${inputs.osmPath}`, ...extra], { encoding: 'utf8' })
  const built = build(`--output=${template}`)
  assert.equal(built.status, 0, built.stderr)
  writePackage(output, 'new')

  const leftovers = (role = '') => fs.readdirSync(root).filter(name => name.startsWith(`.city-x.vigo-${role}`))
  // What a crash leaves: siblings owned by a process that is gone.
  const { pid: goneOwner } = spawnSync(process.execPath, ['-e', ''])
  const sibling = (role, createdAt) => path.join(root, `.city-x.vigo-${role}-${hostTag}-${goneOwner}-${createdAt}`)
  const warn = console.warn
  console.warn = () => {}
  try {
    // A crash between the two renames loses the path but neither City.
    fs.renameSync(output, sibling('previous', 1))
    writePackage(sibling('building', 2), 'interrupted')
    assert.deepEqual(recoverCityPublication(output), { restored: true, removed: 1, kept: 0 })
    assert.equal(validateCityDirectory(output).marker, 'new')
    assert.deepEqual(leftovers(), [])

    // Once the new City holds the path, the replacement is finished, not undone.
    fs.cpSync(output, sibling('previous', 3), { recursive: true })
    writePackage(output, 'second')
    assert.deepEqual(recoverCityPublication(output), { restored: false, removed: 1, kept: 0 })
    assert.equal(validateCityDirectory(output).marker, 'second')
    assert.deepEqual(leftovers(), [])

    // A copy that is partly deleted is never restored, even with the path empty.
    writePackage(sibling('removing', 4), 'partly-deleted')
    fs.rmSync(path.join(sibling('removing', 4), 'network.json'))
    const saved = `${output}.saved`
    fs.renameSync(output, saved)
    assert.deepEqual(recoverCityPublication(output), { restored: false, removed: 1, kept: 0 })
    assert(!fs.existsSync(output))
    assert.deepEqual(leftovers(), [])
    fs.renameSync(saved, output)

    // An old copy is deleted only once a valid City holds the path.
    fs.cpSync(output, sibling('previous', 5), { recursive: true })
    const manifestPath = path.join(output, 'network.json')
    const manifest = fs.readFileSync(manifestPath)
    fs.rmSync(manifestPath)
    assert.deepEqual(recoverCityPublication(output), { restored: false, removed: 0, kept: 1 })
    assert.equal(leftovers('previous').length, 1)
    fs.writeFileSync(manifestPath, manifest)
    assert.deepEqual(recoverCityPublication(output), { restored: false, removed: 1, kept: 0 })
  } finally {
    console.warn = warn
  }

  // Live owners, other hosts and unrelated names are all left alone.
  const untouched = [
    `.city-x.vigo-building-${process.pid}-1`,
    '.city-x.vigo-previous-00000000-1-1',
    '.city-x.vigo-building-not-an-owner',
    '.city-xy.vigo-building-99999999-1',
    '.city-x.vigo-previous-1.vigo-previous-2-3',
  ]
  for (const name of untouched) fs.mkdirSync(path.join(root, name))
  assert.deepEqual(recoverCityPublication(output), { restored: false, removed: 0, kept: 0 })
  for (const name of untouched) {
    assert(fs.existsSync(path.join(root, name)), name)
    fs.rmSync(path.join(root, name), { recursive: true })
  }

  // A build that older code abandoned is recognised without a host tag.
  fs.mkdirSync(path.join(root, `.city-x.vigo-building-${goneOwner}-1`))
  assert.deepEqual(recoverCityPublication(output), { restored: false, removed: 1, kept: 0 })
  assert.deepEqual(recoverCityPublication(path.join(root, 'missing/parent/city')), { restored: false, removed: 0, kept: 0 })

  // The engine finishes the same states before it builds: a City that lost its
  // path is restored first, so an unreplaced build still refuses to overwrite it.
  fs.renameSync(output, sibling('previous', 6))
  writePackage(sibling('building', 7), 'interrupted')
  const refused = build(`--output=${output}`)
  assert.equal(refused.status, 2, refused.stderr)
  assert.match(refused.stderr, /restored .* after an interrupted replacement/)
  assert.match(refused.stderr, /City already exists; pass --replace/)
  assert.equal(validateCityDirectory(output).marker, 'second')
  assert.deepEqual(leftovers(), [])

  // Replacement publishes the new City and removes the old copy.
  const replaced = build(`--output=${output}`, '--replace')
  assert.equal(replaced.status, 0, replaced.stderr)
  assert.equal(validateCityDirectory(output).schemaVersion, 'vigo.city.v1')
  assert.equal(validateCityDirectory(output).marker, undefined)
  assert.deepEqual(leftovers(), [])

  console.log('Atomic City publication passed.')
} finally {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
}
