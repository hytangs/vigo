import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { writeCliFixtureInputs } from './helpers/cli-fixture-inputs.mjs'
import { buildNationalGtfsStore } from '../src/server/national-gtfs-store.mjs'
import { buildNationalOsmStore, compactNationalOsmRuntimeStore, disposeNationalOsmStore } from '../src/server/national-osm-store.mjs'
import {
  createCityStagingDirectory,
  publishCity,
  recoverCityPublication,
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
  fs.rmSync(incomplete, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })

  const outdated = createCityStagingDirectory(output)
  writePackage(outdated, 'outdated')
  const oldRouting = new DatabaseSync(path.join(outdated, 'routing/project.sqlite'))
  oldRouting.prepare('UPDATE metadata SET value=? WHERE key=?').run('"vigo.routing.transfers.v2"', 'transferSemanticsVersion')
  oldRouting.close()
  assert.throws(() => publishCity(outdated, output, { replace: true }), /Transfer semantics/)
  assert.equal(validateCityDirectory(output).marker, 'old')
  fs.rmSync(outdated, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })

  // Upgrades must reject old formats before moving the working City.
  for (const format of ['manifest', 'routing']) {
    const candidate = createCityStagingDirectory(output)
    writePackage(candidate, 'unsupported')
    if (format === 'manifest') {
      fs.writeFileSync(path.join(candidate, 'network.json'), JSON.stringify({ schemaVersion: 'vigo.city.v0' }))
    } else {
      const db = new DatabaseSync(path.join(candidate, 'routing/project.sqlite'))
      db.prepare('UPDATE metadata SET value=? WHERE key=?').run('"vigo.routing.store.v3"', 'schemaVersion')
      db.close()
    }
    const before = fs.readFileSync(path.join(output, 'network.json'))
    assert.throws(() => publishCity(candidate, output, { replace: true }), /[Rr]ebuild/)
    assert.deepEqual(fs.readFileSync(path.join(output, 'network.json')), before)
    assert.equal(validateCityDirectory(output).marker, 'old')
    fs.rmSync(candidate, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  }

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

  const leftovers = (role = '') => fs.readdirSync(root).filter(name => name.startsWith(`.city-x.vigo-${role}`))
  const crashPublication = (crashAt, marker) => {
    const result = spawnSync(process.execPath, [
      path.join(import.meta.dirname, 'helpers/city-publish-crash.mjs'), template, output, marker, crashAt,
    ], { encoding: 'utf8' })
    // Windows reports no signal; the process still ends without finishing publication.
    if (process.platform === 'win32') assert.notEqual(result.status, 0, result.stderr)
    else assert.equal(result.signal, 'SIGKILL', result.stderr)
  }

  // A crash between the two renames loses the path but neither City.
  crashPublication('between-renames', 'interrupted')
  assert(!fs.existsSync(output))
  assert.equal(leftovers('previous').length, 1)
  assert.equal(leftovers('building').length, 1)
  assert.deepEqual(recoverCityPublication(output), { restored: true, removed: 1, kept: 0 })
  assert.equal(validateCityDirectory(output).marker, 'new')
  assert.deepEqual(leftovers(), [])

  // Once the new City holds the path, the replacement is finished, not undone.
  crashPublication('after-publish', 'second')
  assert.equal(validateCityDirectory(output).marker, 'second')
  assert.equal(leftovers('previous').length, 1)
  assert.deepEqual(recoverCityPublication(output), { restored: false, removed: 1, kept: 0 })
  assert.equal(validateCityDirectory(output).marker, 'second')
  assert.deepEqual(leftovers(), [])

  // A copy that is partly deleted is never restored, even with the path empty.
  crashPublication('during-removal', 'third')
  assert.deepEqual(leftovers('previous'), [])
  assert.equal(leftovers('removing').length, 1)
  const thirdCity = `${output}.saved`
  fs.renameSync(output, thirdCity)
  assert.deepEqual(recoverCityPublication(output), { restored: false, removed: 1, kept: 0 })
  assert(!fs.existsSync(output))
  assert.deepEqual(leftovers(), [])
  fs.renameSync(thirdCity, output)

  // An old copy is deleted only once a valid City holds the path.
  crashPublication('after-publish', 'fourth')
  const manifestPath = path.join(output, 'network.json')
  const manifest = fs.readFileSync(manifestPath)
  fs.rmSync(manifestPath)
  const warn = console.warn
  console.warn = () => {}
  assert.deepEqual(recoverCityPublication(output), { restored: false, removed: 0, kept: 1 })
  console.warn = warn
  assert.equal(leftovers('previous').length, 1)
  fs.writeFileSync(manifestPath, manifest)
  assert.deepEqual(recoverCityPublication(output), { restored: false, removed: 1, kept: 0 })

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
  const { pid: goneOwner } = spawnSync(process.execPath, ['-e', ''])
  fs.mkdirSync(path.join(root, `.city-x.vigo-building-${goneOwner}-1`))
  assert.deepEqual(recoverCityPublication(output), { restored: false, removed: 1, kept: 0 })
  assert.deepEqual(recoverCityPublication(path.join(root, 'missing/parent/city')), { restored: false, removed: 0, kept: 0 })

  // Data reaches the disk before the rename, and the rename before the old City goes.
  const nestedOutput = path.join(root, 'new-parent/nested/city-y')
  const steps = []
  const opened = new Map()
  const real = { openSync: fs.openSync, closeSync: fs.closeSync, fsyncSync: fs.fsyncSync, renameSync: fs.renameSync, rmSync: fs.rmSync }
  fs.openSync = (target, ...rest) => {
    const handle = real.openSync(target, ...rest)
    opened.set(handle, String(target))
    return handle
  }
  fs.fsyncSync = (handle) => {
    real.fsyncSync(handle)
    steps.push(['flush', opened.get(handle)])
  }
  fs.renameSync = (from, to) => {
    real.renameSync(from, to)
    steps.push(['rename', from, to])
  }
  fs.rmSync = (target, options) => {
    steps.push(['remove', String(target)])
    real.rmSync(target, options)
  }
  try {
    const first = createCityStagingDirectory(nestedOutput)
    // Windows has no flushable directory handle, so only files are flushed there.
    for (const directory of process.platform === 'win32' ? [] : [path.dirname(nestedOutput), path.join(root, 'new-parent'), root]) {
      assert(steps.some(([kind, target]) => kind === 'flush' && target === directory), `New ancestor not flushed: ${directory}`)
    }
    writePackage(first, 'first')
    publishCity(first, nestedOutput)
    const second = createCityStagingDirectory(nestedOutput)
    writePackage(second, 'second')
    fs.linkSync(path.join(second, 'network.json'), path.join(second, 'network-link.json'))
    steps.length = 0
    publishCity(second, nestedOutput, { replace: true })
  } finally {
    Object.assign(fs, real)
  }
  const firstRename = steps.findIndex(([kind]) => kind === 'rename')
  const [, , publishedTo] = steps[firstRename + 1]
  assert.equal(publishedTo, nestedOutput)
  const flushedBeforeRename = steps.slice(0, firstRename).map(([, target]) => path.basename(target))
  for (const name of ['project.sqlite', 'street-index.sqlite', ...(process.platform === 'win32' ? [] : ['routing', 'osm'])]) assert(flushedBeforeRename.includes(name), `${name} not flushed before publication`)
  assert.equal(
    flushedBeforeRename.filter(name => name === 'network.json' || name === 'network-link.json').length,
    1,
    'Hard links to one file need one flush.',
  )
  const removal = steps.findIndex(([kind, target]) => kind === 'remove' && target.includes('.vigo-removing-'))
  const parentFlush = steps.findIndex(([kind, target], index) => index > firstRename + 1 && kind === 'flush' && target === path.dirname(nestedOutput))
  if (process.platform !== 'win32') assert(parentFlush !== -1 && parentFlush < removal, 'The new path must be on disk before the old City is removed.')

  console.log('Atomic City publication passed.')
} finally {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
}
