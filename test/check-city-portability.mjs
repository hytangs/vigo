import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import JSZip from 'jszip'
import { writeCliFixtureInputs } from './helpers/cli-fixture-inputs.mjs'
import { prepareNativeRoutingKernel } from '../src/server/native-routing-kernel.mjs'
import { prepareNationalOsmDriveStore, disposeNationalOsmStore } from '../src/server/national-osm-store.mjs'
import { prepareNationalGtfsRoutingContext, disposeAllNationalGtfsStores } from '../src/server/national-gtfs-store.mjs'
import { processFixtureDirectory } from './helpers/fixture-process.mjs'

const root = await processFixtureDirectory(import.meta.url, 'vigo-portable-')
const cli = process.env.VIGO_TEST_CLI ?? path.resolve(import.meta.dirname, '../public/vigo.mjs')
const executable = process.env.VIGO_TEST_EXECUTABLE ?? process.execPath
const run = (args) => JSON.parse(execFileSync(executable, [cli, ...args], { encoding: 'utf8', timeout: 120_000 }))
const date = '2026-07-15'
const files = (directory) => fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
  const file = path.join(directory, entry.name)
  return entry.isDirectory() ? files(file) : [file]
})
function answer(value) {
  if (Array.isArray(value)) return value.map(answer)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== 'diagnostics' && key !== 'timing' && !key.endsWith('Ms'))
    .map(([key, item]) => [key, answer(item)]))
}
function routes(city) {
  return ['transit', 'walk', 'drive'].map((mode) => {
    const request = path.join(root, 'request.json')
    fs.writeFileSync(request, JSON.stringify({ origin: { coordinate: [-77.05, 38.9] }, destination: { coordinate: [-77.03, 38.91] } }))
    const result = run(['route', `--city=${city}`, `--request=${request}`, `--mode=${mode}`, '--time=07:55', `--service-date=${date}`, '--max-walk=0.2'])
    assert.equal(result.status, 'ready', `${mode} route must be usable`)
    const { id: _localPlanId, ...plan } = result.result
    return answer(plan)
  })
}
function preparedFiles(city) {
  return Object.fromEntries(files(city).filter((file) => /\.(?:bin|structure|metric)$|\.manifest\.json$/u.test(file))
    .map((file) => [path.relative(city, file), fs.readFileSync(file)]))
}
async function produce() {
  const inputs = await writeCliFixtureInputs(root)
  const city = path.join(root, 'city')
  run(['build', `--gtfs=${inputs.gtfsPath}`, `--osm=${inputs.osmPath}`, `--output=${city}`])
  const expected = routes(city)
  const zip = new JSZip()
  for (const file of files(city)) zip.file(`city/${path.relative(city, file).split(path.sep).join('/')}`, fs.readFileSync(file))
  zip.file('expected.json', JSON.stringify(expected))
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}
async function consume(bytes, index) {
  const archive = await JSZip.loadAsync(bytes)
  const directory = path.join(root, `extracted-${index}`)
  for (const entry of Object.values(archive.files)) {
    if (entry.dir) continue
    const file = path.join(directory, entry.name)
    assert(!path.relative(directory, file).startsWith('..'))
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, await entry.async('nodebuffer'))
    // Deliberately discard source timestamps, including nanosecond precision.
    fs.utimesSync(file, new Date('2001-01-01'), new Date('2001-01-01'))
  }
  const city = path.join(directory, 'city')
  const retained = preparedFiles(city)
  const street = path.join(city, 'osm', 'street-index.sqlite')
  assert.equal(prepareNativeRoutingKernel(street).streetCch.ready, true)
  assert.equal(prepareNationalOsmDriveStore(street).ready, true)
  const context = prepareNationalGtfsRoutingContext(path.join(city, 'routing', 'project.sqlite'), { serviceDate: date, serviceDay: 'weekday' })
  assert.equal(context.activeServiceKernel.persistenceState, 'loaded')
  assert.equal(context.accessMaterialization.persistenceState, 'loaded')
  disposeAllNationalGtfsStores()
  disposeNationalOsmStore(street)
  assert.deepEqual(routes(city), JSON.parse(fs.readFileSync(path.join(directory, 'expected.json'), 'utf8')))
  assert.deepEqual(preparedFiles(city), retained, 'Copied City must reuse every prepared artifact without rebuilding or rewriting it')
}
async function timestampNamedArchive(bytes) {
  const zip = await JSZip.loadAsync(bytes)
  for (const entry of Object.values(zip.files)) {
    if (!entry.name.endsWith('.manifest.json')) continue
    const manifest = JSON.parse(await entry.async('string'))
    const directory = entry.name.slice(0, entry.name.lastIndexOf('/') + 1)
    const oldPrefix = entry.name.slice(directory.length, -'.manifest.json'.length)
    const prefix = `${manifest.source.file}.${manifest.format}.${manifest.source.bytes}-946684800000000000`
    for (const record of [manifest.structure, ...Object.values(manifest.metrics)]) {
      const oldName = directory + record.file
      record.file = prefix + record.file.slice(oldPrefix.length)
      zip.file(directory + record.file, await zip.file(oldName).async('nodebuffer'))
      zip.remove(oldName)
    }
    zip.remove(entry.name)
    zip.file(`${directory}${prefix}.manifest.json`, JSON.stringify(manifest))
  }
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}
try {
  if (process.argv[2] === '--read') {
    const inputs = files(path.resolve(process.argv[3])).filter((file) => file.endsWith('.zip'))
    assert(inputs.length, 'No producer City archives supplied')
    for (const [index, file] of inputs.entries()) await consume(fs.readFileSync(file), index)
    console.log(`Reused ${inputs.length} foreign City archives on ${process.platform}:${process.arch}.`)
  } else {
    const archive = await produce()
    await consume(archive, 0)
    await consume(await timestampNamedArchive(archive), 1)
    if (process.argv[2] === '--write') {
      const output = path.resolve(process.argv[3])
      fs.mkdirSync(path.dirname(output), { recursive: true })
      fs.writeFileSync(output, archive)
    }
    console.log(`City archive, prepared-state reuse and Route parity passed on ${process.platform}:${process.arch}.`)
  }
} finally {
  disposeAllNationalGtfsStores()
}
