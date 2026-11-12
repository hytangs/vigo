import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { writeCliFixtureInputs } from './helpers/cli-fixture-inputs.mjs'

const cli = process.env.VIGO_CLI_PATH ? path.resolve(process.env.VIGO_CLI_PATH) : path.resolve(import.meta.dirname, '../public/vigo.mjs')
const executable = cli.endsWith('.mjs') ? process.execPath : cli
const prefix = cli.endsWith('.mjs') ? [cli] : []
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vigo-city-interruption-'))
const output = path.join(root, 'city')
const leftovers = () => fs.readdirSync(root).filter(name => name.startsWith('.city.vigo-'))

async function waitFor(condition, label, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`)
    await delay(5)
  }
}

try {
  const { gtfsPath, osmPath } = await writeCliFixtureInputs(root)
  const buildArguments = [...prefix, 'build', `--gtfs=${gtfsPath}`, `--osm=${osmPath}`, `--output=${output}`]
  const startBuild = (...extra) => spawn(executable, [...buildArguments, ...extra], { stdio: ['ignore', 'ignore', 'ignore'] })
  const build = (...extra) => {
    const result = spawnSync(executable, [...buildArguments, ...extra], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    return result
  }
  const interruptBuild = async (signal, ...extra) => {
    const child = startBuild(...extra)
    const closed = once(child, 'close')
    await waitFor(() => leftovers().length > 0, 'the staging directory')
    child.kill(signal)
    return closed
  }

  // Windows ends a child without running its handlers, so only SIGKILL applies there.
  if (process.platform !== 'win32') {
    for (const signal of ['SIGINT', 'SIGTERM']) {
      const [code, received] = await interruptBuild(signal)
      assert.deepEqual([code, received], [null, signal], 'The build must report the signal that stopped it.')
      assert.deepEqual(leftovers(), [], `${signal} must remove the unpublished build.`)
      assert(!fs.existsSync(output), `${signal} must not publish a City.`)
    }
  }

  // An abandoned build is swept by the next one.
  await interruptBuild('SIGKILL')
  assert.equal(leftovers().length, 1, 'SIGKILL cannot clean up, so this test would otherwise prove nothing.')
  await delay(1_000) // Orphaned compilers exit when they notice the parent has gone.
  build()
  assert.deepEqual(leftovers(), [])
  const manifest = fs.readFileSync(path.join(output, 'network.json'))

  // An interrupted replacement keeps the published City.
  if (process.platform !== 'win32') {
    await interruptBuild('SIGTERM', '--replace')
    assert.deepEqual(leftovers(), [])
    assert.deepEqual(fs.readFileSync(path.join(output, 'network.json')), manifest)
  }

  // A query heals a City that lost its path between the two publishing renames.
  const { pid: goneOwner } = spawnSync(process.execPath, ['-e', ''])
  fs.renameSync(output, path.join(root, `.city.vigo-previous-${goneOwner}-1`))
  const inspected = spawnSync(executable, [...prefix, 'inspect', `--city=${output}`], { encoding: 'utf8' })
  assert.equal(inspected.status, 0, inspected.stderr)
  assert.match(inspected.stderr, /restored .* after an interrupted replacement/)
  assert.deepEqual(fs.readFileSync(path.join(output, 'network.json')), manifest)
  assert.deepEqual(leftovers(), [])

  // Without such a copy a missing City is still an ordinary error.
  const missing = spawnSync(executable, [...prefix, 'inspect', `--city=${path.join(root, 'absent')}`], { encoding: 'utf8' })
  assert.equal(missing.status, 2)
  assert.match(missing.stderr, /incomplete/)

  console.log('Interrupted City builds passed.')
} finally {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
}
