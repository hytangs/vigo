#!/usr/bin/env node
// Each measured build gets a fresh process and output directory. No private inputs required.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(import.meta.dirname, '..')
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
function sourceTreeHash() {
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(file => file && fs.statSync(path.join(root, file), { throwIfNoEntry: false })?.isFile()).sort()
  return hash(files.map(file => `${file}\0${hash(fs.readFileSync(path.join(root, file)))}\n`).join(''))
}
if (process.argv[2] === '--worker') {
  const { buildNationalGtfsStore } = await import('../src/server/national-gtfs-store.mjs')
  const started = performance.now(), phases = {}, compilation = []
  let previous = started, phase = 'startup'
  const result = await buildNationalGtfsStore({ zipPath: process.argv[3], outputPath: process.argv[4],
    onProgress(event) {
      const now = performance.now()
      phases[phase] = (phases[phase] ?? 0) + now - previous
      phase = event.phase; previous = now
      if (event.compiler) compilation.push(event.compiler)
    },
  })
  phases[phase] = (phases[phase] ?? 0) + performance.now() - previous
  console.log(JSON.stringify({ buildWallMs: performance.now() - started, peakRssKiB: process.resourceUsage().maxRSS,
    connections: result.connectionCount, routingStoreBytes: result.bytes, phases, compilation }))
} else {
  const args = process.argv.slice(2), options = {}
  for (let i = 0; i < args.length; i += 2) {
    if (!['--gtfs', '--runs', '--trips', '--output'].includes(args[i]) || !args[i + 1]) {
      throw new Error('Usage: profile-gtfs-compiler.mjs [--gtfs ZIP] [--runs 3] [--trips 10000] [--output JSON]')
    }
    options[args[i].slice(2)] = args[i + 1]
  }
  const runs = Number(options.runs ?? 3), trips = Number(options.trips ?? 10000)
  if (!Number.isSafeInteger(runs) || runs < 1 || runs > 30 || !Number.isSafeInteger(trips) || trips < 1 || trips > 100000) throw new Error('Invalid profile bounds.')
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'vigo-compiler-profile-'))
  try {
    let zipPath = options.gtfs && path.resolve(options.gtfs)
    if (!zipPath) {
      const { default: JSZip } = await import('jszip')
      const zip = new JSZip(), stopCount = 20
      zip.file('agency.txt', 'agency_id,agency_name,agency_url,agency_timezone\nA,Fixture,https://example.com,America/New_York\n')
      zip.file('stops.txt', 'stop_id,stop_name,stop_lat,stop_lon\n' + Array.from({ length: stopCount }, (_, i) => `S${i},Stop ${i},38.9,${-77 + i * .01}\n`).join(''))
      zip.file('routes.txt', 'route_id,route_short_name,route_type\nR,R,3\n')
      zip.file('calendar_dates.txt', 'service_id,date,exception_type\nD,20261018,1\n')
      zip.file('trips.txt', 'route_id,service_id,trip_id\n' + Array.from({ length: trips }, (_, i) => `R,D,T${i}\n`).join(''))
      const rows = ['trip_id,stop_id,stop_sequence,arrival_time,departure_time\n']
      for (let trip = 0; trip < trips; trip++) for (let stop = 0; stop < stopCount; stop++) {
        const seconds = 8 * 3600 + trip % 3600 + stop * 120
        const clock = [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60].map(v => String(v).padStart(2, '0')).join(':')
        rows.push(`T${trip},S${stop},${stop},${clock},${clock}\n`)
      }
      zip.file('stop_times.txt', rows.join(''))
      zipPath = path.join(scratch, 'synthetic.zip')
      zip.forEach((_name, file) => { file.date = new Date('2000-01-01T00:00:00Z') })
      fs.writeFileSync(zipPath, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }))
    }
    const sourceTreeSha256 = sourceTreeHash()
    const nativeSha256 = hash(fs.readFileSync(path.join(root, 'crates/vigo-runtime/vigo-routing-kernel.node')))
    const samples = []
    for (let run = 0; run < runs; run++) {
      const started = performance.now()
      const value = JSON.parse(execFileSync(process.execPath, [fileURLToPath(import.meta.url), '--worker', zipPath, path.join(scratch, `${run}.sqlite`)], {
        cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
      }))
      if (value.compilation.length !== 1 || value.compilation[0].backend !== 'rust') throw new Error('Compiler profile did not observe the native connection compiler.')
      samples.push({ run, backend: 'rust', runnerWallMs: performance.now() - started, ...value })
    }
    if (sourceTreeHash() !== sourceTreeSha256 || hash(fs.readFileSync(path.join(root, 'crates/vigo-runtime/vigo-routing-kernel.node'))) !== nativeSha256) {
      throw new Error('Source tree or native library changed during profiling; discard these measurements and rerun.')
    }
    const report = { sourceTreeSha256, schema: 'vigo.compiler-profile.v1', sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
      trackedDiffSha256: hash(execFileSync('git', ['diff', 'HEAD'], { cwd: root })),
      nativeSha256,
      node: process.version, platform: process.platform, arch: process.arch,
      buildEnvironment: Object.fromEntries(['VIGO_BUILD_SQLITE_CACHE_KIB', 'RAYON_NUM_THREADS'].map(key => [key, process.env[key] ?? null])),
      input: { kind: options.gtfs ? 'supplied' : 'synthetic', sha256: hash(fs.readFileSync(zipPath)), bytes: fs.statSync(zipPath).size, ...(!options.gtfs ? { trips, stopsPerTrip: 20 } : {}) },
      boundaries: { buildWallMs: 'GTFS import through published routing store and static topology; no OSM, City sealing, or query',
        runnerWallMs: 'fresh worker process including startup, imports, build and JSON output',
        compilation: 'connection compilation including native binding and database handoff; excludes stop-time ordering',
        phases: 'wall intervals between progress phase events, not CPU samples',
        peakRssKiB: 'whole worker process high-water RSS including native code; not a stage-specific peak', cache: 'fresh process and output per sample; OS filesystem cache and other host workload uncontrolled' }, samples }
    const json = JSON.stringify(report, null, 2) + '\n'
    if (options.output) fs.writeFileSync(path.resolve(options.output), json)
    else process.stdout.write(json)
  } finally { fs.rmSync(scratch, { recursive: true, force: true }) }
}
