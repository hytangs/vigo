import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { parseArguments, enabled } from '../src/cli/arguments.mjs'
import { readJsonObject, writeOutputFile } from '../src/cli/io.mjs'
import { publicCliCommands } from '../src/capabilities.mjs'

const root = path.resolve(import.meta.dirname, '..')
const cli = process.env.VIGO_CLI_PATH ? path.resolve(process.env.VIGO_CLI_PATH) : path.join(root, 'public/vigo.mjs')
const executable = cli.endsWith('.mjs') ? process.execPath : cli
const prefix = cli.endsWith('.mjs') ? [cli] : []
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'vigo-cli-interface-'))
const invoke = (args, input) => spawnSync(executable, [...prefix, ...args], {
  encoding: 'utf8', cwd: temporary, input, timeout: 15_000,
})
const fails = (args, expected, input) => {
  const result = invoke(args, input)
  assert.equal(result.status, 2, JSON.stringify({ args, ...result }))
  assert.equal(result.stdout, '', 'Errors must not corrupt stdout')
  assert.match(result.stderr, expected)
  assert(result.stderr.trim().split('\n').length <= 3, result.stderr)
  assert(!result.stderr.includes('at file:'), 'Do not expose a Node stack for a user error')
}

try {
  for (const args of [[], ['--help'], ['-h'], ['help']]) {
    const result = invoke(args)
    assert.equal(result.status, 0)
    assert.equal(result.stderr, '')
    for (const command of publicCliCommands) assert(result.stdout.includes(`vigo ${command}`))
    assert(!result.stdout.includes('_route-stream'))
  }
  assert.equal(invoke(['-V']).stdout, invoke(['--version']).stdout)
  for (const command of publicCliCommands) {
    const help = invoke([command, '--help'])
    assert.equal(help.status, 0, help.stderr)
    assert.equal(help.stdout, invoke(['help', command]).stdout)
    assert.equal(help.stdout, invoke([command, '-h']).stdout)
    assert(help.stdout.includes(`vigo ${command}`))
    if (command !== 'build') assert(!help.stdout.includes('--gtfs PATH'))
    if (command !== 'reach') assert(!help.stdout.includes('--raster-size'))
    assert.equal(help.stdout.includes('--data-mode'), command === 'route', 'Only Route advertises realtime routing.')
  }
  assert(invoke(['--city', 'unused', '-h']).stdout.includes('vigo route'))
  const parsed = parseArguments(['build', '--replace', '--gtfs', 'east.zip', '--gtfs=west.zip', '--osm=map.pbf', '--output', 'city with spaces'])
  assert.deepEqual(parsed.args.get('gtfs'), ['east.zip', 'west.zip'])
  assert.equal(parsed.args.get('output')[0], 'city with spaces')
  assert.equal(enabled(parsed.args, 'replace'), true)
  assert.equal(enabled(parseArguments(['build', '--replace=false']).args, 'replace'), false)
  assert.equal(parseArguments(['route', '--max-walk', '-1']).args.get('max-walk')[0], '-1')
  assert.equal(parseArguments(['route', '--request', '-']).args.get('request')[0], '-')
  assert.equal(parseArguments(['route', '--data-mode=realtime']).args.get('data-mode')[0], 'realtime')
  assert.equal(parseArguments(['inspect', '--city=-leading-path']).args.get('city')[0], '-leading-path')

  for (const [args, expected] of [
    [['capabilities', '--typo'], /Unknown option: --typo/u],
    [['capabilities', 'ignored'], /Unexpected argument/u],
    [['capabilities', '--city', 'unused'], /not an option for capabilities/u],
    [['--version', '--typo'], /Unknown option/u],
    [['constructor', '--help'], /Unknown command/u],
    [['inspect', '--city'], /requires a value/u],
    [['inspect', '--city='], /requires a non-empty value/u],
    [['inspect', '--city', 'a', '--city', 'b'], /only be supplied once/u],
    [['inspect', '-x'], /Unknown option/u],
    [['inspect', '--help=false'], /does not take a value/u],
    [['build', '--replace=maybe'], /expects true or false/u],
    [['route', '--city=x', '--request=x', '--input=x'], /not both/u],
    [['route', '--city=x', '--request=x'], /requires --service-date/u],
    [['route', '--city=x', '--input=x', '--output=-'], /require an --output file/u],
    [['route', '--city=x', '--input=x', '--output=x', '--mode=drive'], /CSV batches support transit only/u],
    [['route', '--routing-preference=fastest'], /--objective=earliest_arrival/u],
    [['reach', '--radius=2'], /--extent-radius/u],
    [['reach', '--horizon=30'], /not an option for reach/u],
    [['reach', '--data-mode=realtime'], /not an option for reach/u],
    [['matrix', '--data-mode=realtime'], /not an option for matrix/u],
    [['build', '--gtfs=x', '--osm=x', '--output=-'], /City output directory/u],
    [['help', 'route', 'extra'], /Unexpected argument/u],
    [['route', '--', '--help'], /Unexpected argument/u],
  ]) fails(args, expected)

  const requestArgs = command => [command, '--city=unused', '--service-date=2026-09-14', '--request=-']
  for (const command of ['route', 'matrix', 'reach']) {
    for (const invalid of ['', 'not JSON', '{"secret":"do-not-repeat",']) {
      fails(requestArgs(command), /not valid JSON \(standard input\)/u, invalid)
      assert(!invoke(requestArgs(command), invalid).stderr.includes('do-not-repeat'))
    }
    for (const invalid of ['null', '[]', 'true', '42']) fails(requestArgs(command), /must be one JSON object/u, invalid)
  }
  fails(requestArgs('route'), /16 MiB input limit/u, ' '.repeat(16 * 1024 * 1024 + 1))
  const bom = path.join(temporary, 'bom.json')
  fs.writeFileSync(bom, '\uFEFF{"origin":"站点"}')
  assert.deepEqual(await readJsonObject(bom, 'request'), { origin: '站点' })
  await assert.rejects(readJsonObject(temporary, 'request'), /must be a file/u)

  const before = path.join(temporary, 'before.json')
  const after = path.join(temporary, 'after.json')
  fs.writeFileSync(before, JSON.stringify({ kind: 'route', result: { status: 'ready', durationMinutes: 12, transfers: 0 } }))
  fs.writeFileSync(after, JSON.stringify({ kind: 'route', result: { status: 'ready', durationMinutes: 9, transfers: 0 } }))
  const comparison = ['compare', '--before', before, '--after', after]
  const output = path.join(temporary, 'saved result.json')
  fs.writeFileSync(output, 'previous result', { mode: 0o600 })
  const result = invoke([...comparison, '--output', output])
  assert.equal(result.status, 0, result.stderr)
  assert.equal(JSON.parse(result.stdout).change.durationChangeMinutes, -3)
  assert.equal(fs.readFileSync(output, 'utf8'), result.stdout)
  if (process.platform !== 'win32') assert.equal(fs.statSync(output).mode & 0o777, 0o600)
  assert.equal(invoke([...comparison, '--output=-']).stdout, result.stdout)
  assert(!fs.existsSync(path.join(temporary, '-')))
  const directory = path.join(temporary, 'keep-directory')
  fs.mkdirSync(directory)
  fs.writeFileSync(path.join(directory, 'keep.txt'), 'original')
  fails([...comparison, '--output', directory], /VIGO compare:/u)
  assert.equal(fs.readFileSync(path.join(directory, 'keep.txt'), 'utf8'), 'original')
  assert(!fs.readdirSync(temporary).some(name => name.startsWith('.vigo-result-')))
  if (process.platform !== 'win32') {
    const link = path.join(temporary, 'linked-result.json')
    fs.symlinkSync(output, link)
    writeOutputFile(link, 'updated')
    assert(fs.lstatSync(link).isSymbolicLink())
    assert.equal(fs.readFileSync(output, 'utf8'), 'updated')
    fs.chmodSync(output, 0o640)
    const previousMask = process.umask(0o077)
    try { writeOutputFile(output, 'updated again') } finally { process.umask(previousMask) }
    assert.equal(fs.statSync(output).mode & 0o777, 0o640, 'An existing mode survives a different umask')
    const broken = path.join(temporary, 'broken-link.json')
    fs.symlinkSync(path.join(temporary, 'missing.json'), broken)
    assert.throws(() => writeOutputFile(broken, 'replacement'))
    assert(fs.lstatSync(broken).isSymbolicLink(), 'A broken symlink must not be replaced with an unrelated file')
  }

  const producer = spawn(executable, [...prefix, ...requestArgs('route')], { cwd: temporary })
  let inputError = ''
  producer.stderr.setEncoding('utf8').on('data', chunk => { inputError += chunk })
  producer.stdin.write('{"origin":')
  const finishInput = setTimeout(() => producer.stdin.end('"A","destination":"B"}'), 150)
  const [inputCode] = await once(producer, 'close')
  clearTimeout(finishInput)
  assert.equal(inputCode, 2)
  assert(inputError.includes('City'), inputError)
  assert(!inputError.includes('JSON'), 'A slow producer must be read through EOF before parsing')

  const child = spawn(executable, [...prefix, 'capabilities'], { stdio: ['ignore', 'pipe', 'pipe'] })
  let diagnostics = ''
  child.stderr.setEncoding('utf8').on('data', chunk => { diagnostics += chunk })
  child.stdout.destroy()
  const [code] = await once(child, 'close')
  assert.equal(code, 0, diagnostics)
  assert.equal(diagnostics, '')
  console.log('CLI interface passed: scoped help, strict arguments, stdin validation, atomic output, permissions, and closed pipes.')
} finally {
  fs.rmSync(temporary, { recursive: true, force: true })
}
