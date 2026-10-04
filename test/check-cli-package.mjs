import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import JSZip from 'jszip'
import { auditPackageFiles } from '../scripts/lib/package-audit.mjs'
import { publicCliCommands, vigoCapabilities } from '../src/capabilities.mjs'

const run = promisify(execFile)
const root = path.resolve(import.meta.dirname, '..')
const metadata = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'))
const node = process.env.VIGO_CLI_TEST_NODE || process.execPath
const name = `VIGO-CLI-${metadata.version}-${process.platform}-${process.arch}`
const output = path.resolve(process.env.VIGO_CLI_RELEASE_DIR || path.join(root, 'release', 'cli'))
const archive = path.join(output, `${name}.zip`)
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'vigo-cli-extracted-'))
const runtime = path.join(temporary, 'runtime with spaces')
const digest = data => crypto.createHash('sha256').update(data).digest('hex')
const env = { ...process.env, PATH: '', NODE_PATH: '', NODE_OPTIONS: '' }
for (const key of Object.keys(env)) if (key.startsWith('VIGO_')) delete env[key]

try {
  const bytes = await fs.readFile(archive)
  assert.equal((await fs.readFile(`${archive}.sha256`, 'utf8')).split(' ')[0], digest(bytes))
  // A generous regression budget: fail if assets or a runtime slip into the archive.
  assert(bytes.length < 8 * 1024 * 1024, 'CLI ZIP exceeded the 8 MiB budget.')
  const zip = await JSZip.loadAsync(bytes, { checkCRC32: true })
  const allowed = new Set(['vigo.mjs', 'vigo-routing-kernel.node', 'LICENSE', 'NOTICE',
    'CCH-LICENSE', 'CCH-NOTICE', 'THIRD-PARTY-NOTICES', 'README.md', 'manifest.json'])
  await fs.mkdir(runtime)
  const extracted = new Set()
  for (const entry of Object.values(zip.files)) {
    if (entry.dir) { assert.equal(entry.name, `${name}/`); continue }
    assert.equal(entry.name, `${name}/${path.posix.basename(entry.name)}`)
    const file = path.posix.basename(entry.name)
    assert(allowed.has(file), `Unexpected CLI payload file: ${file}`)
    assert.equal(Number(entry.unixPermissions) & 0o170000, 0o100000)
    await fs.writeFile(path.join(runtime, file), await entry.async('nodebuffer'))
    await fs.chmod(path.join(runtime, file), Number(entry.unixPermissions) & 0o777)
    extracted.add(file)
  }
  assert.deepEqual(extracted, allowed)
  const manifest = JSON.parse(await fs.readFile(path.join(runtime, 'manifest.json'), 'utf8'))
  assert.equal(manifest.schemaVersion, 'vigo.cli.package.v1')
  assert.equal(manifest.platform, process.platform)
  assert.equal(manifest.architecture, process.arch)
  assert.equal(manifest.productVersion, metadata.version)
  assert.deepEqual(manifest.interfaces, ['cli', 'resident-ndjson'])
  assert(manifest.excluded.includes('http'))
  assert.deepEqual(new Set(Object.keys(manifest.files)), new Set([...allowed].filter(file => file !== 'manifest.json')))
  for (const [file, expected] of Object.entries(manifest.files)) {
    const data = await fs.readFile(path.join(runtime, file))
    assert.equal(data.length, expected.bytes)
    assert.equal(digest(data), expected.sha256)
  }
  const audit = await auditPackageFiles(runtime, { forbiddenRoots: [root] })
  assert(audit.bytes < 16 * 1024 * 1024, 'Extracted CLI exceeded the 16 MiB budget.')
  const cli = path.join(runtime, 'vigo.mjs')
  const options = { cwd: temporary, env, timeout: 60000, maxBuffer: 16 * 1024 * 1024 }
  const capabilities = JSON.parse((await run(node, [cli, 'capabilities'], options)).stdout)
  assert.deepEqual(capabilities, vigoCapabilities(metadata.version), 'The slim package must retain every engine capability.')
  for (const command of publicCliCommands) {
    assert((await run(node, [cli, command, '--help'], options)).stdout.includes(`vigo ${command}`))
  }
  // Keep exercising the entire canonical contract, including GTFS/OSM builds,
  // all modes, realtime, matrices, scenarios, CSV, streaming, and comparisons.
  // The package runs with an empty PATH, outside the checkout, without npm.
  // Source-side inspection helpers use this same extracted native library.
  env.VIGO_CLI_PATH = cli
  env.VIGO_NATIVE_ROUTING_KERNEL = path.join(runtime, 'vigo-routing-kernel.node')
  for (const test of ['check-cli-interface.mjs', 'check-cli.mjs']) {
    try {
      const result = await run(node, [path.join(root, 'test', test)], { ...options, timeout: 600000 })
      process.stdout.write(result.stdout)
    } catch (error) {
      process.stderr.write(error.stderr || error.message)
      throw new Error(`${test} failed against the extracted CLI (exit ${error.code}).`)
    }
  }
  console.log(JSON.stringify({ status: 'passed', archive, node: (await run(node, ['--version'], options)).stdout.trim(),
    platform: process.platform, architecture: process.arch, zipBytes: bytes.length, payloadBytes: audit.bytes,
    files: audit.files, commands: publicCliCommands, isolatedRuntime: true }, null, 2))
} finally {
  await fs.rm(temporary, { recursive: true, force: true })
}
