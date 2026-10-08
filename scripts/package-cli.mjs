#!/usr/bin/env node
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import JSZip from 'jszip'
import { rustRoutingTarget } from './lib/rust-routing-targets.mjs'
import { auditPackageFiles } from './lib/package-audit.mjs'
import { engineNotices } from './lib/engine-notices.mjs'
import { publishArtifacts } from './lib/package-publication.mjs'

const run = promisify(execFile)
const root = path.resolve(import.meta.dirname, '..')
if (process.argv.length !== 2) throw new Error('Usage: package-cli.mjs')
const metadata = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'))
const target = rustRoutingTarget(process.platform, process.arch)
if (!target) throw new Error('No native CLI package target for this OS/CPU.')
const output = path.resolve(process.env.VIGO_CLI_RELEASE_DIR || path.join(root, 'release', 'cli'))
const name = `VIGO-CLI-${metadata.version}-${process.platform}-${process.arch}`
const runtime = path.join(output, `runtime-${process.platform}-${process.arch}`)
await fs.mkdir(output, { recursive: true })
const staging = await fs.mkdtemp(path.join(output, '.cli-stage-'))
const archive = path.join(output, `${name}.zip`)
const temporaryZip = path.join(staging, 'archive.next')
const payload = path.join(staging, 'payload')
const hash = data => crypto.createHash('sha256').update(data).digest('hex')
try {
  await fs.mkdir(payload)
  for (const [source, destination] of [
    ['public/vigo.mjs', 'vigo.mjs'],
    ['native/vigo-routing-kernel/vigo-routing-kernel.node', 'vigo-routing-kernel.node'],
    ['LICENSE', 'LICENSE'], ['NOTICE', 'NOTICE'],
    ['native/vigo-routing-kernel/vendor/cch/LICENSE', 'CCH-LICENSE'],
    ['native/vigo-routing-kernel/vendor/cch/NOTICE', 'CCH-NOTICE'],
    ['docs/guides/cli-only.md', 'README.md'],
  ]) await fs.copyFile(path.join(root, source), path.join(payload, destination))
  // The extracted README has no adjacent source documentation tree.
  const readmePath = path.join(payload, 'README.md')
  const readme = await fs.readFile(readmePath, 'utf8')
  await fs.writeFile(readmePath, readme.replace(/\]\(([^)]+)\)/gu, (match, target) => {
    if (/^(?:[a-z][\w+.-]*:|\/\/|#)/iu.test(target)) return match
    const reference = path.posix.normalize(`docs/guides/${target}`)
    if (reference.startsWith('../') || reference.startsWith('/')) throw new Error('README link escapes the repository')
    return `](https://github.com/hytangs/vigo/blob/main/${reference})`
  }))
  await fs.chmod(path.join(payload, 'vigo.mjs'), 0o755)
  await fs.writeFile(path.join(payload, 'THIRD-PARTY-NOTICES'), await engineNotices(root, target.targetTriple))
  const env = { ...process.env, VIGO_NATIVE_ROUTING_KERNEL: path.join(payload, 'vigo-routing-kernel.node'), NODE_PATH: '' }
  const capabilities = JSON.parse((await run(process.execPath, [path.join(payload, 'vigo.mjs'), 'capabilities'], { cwd: payload, env })).stdout)
  if (capabilities.productVersion !== metadata.version
    || !['route', 'matrix', 'reach'].every(id => capabilities.queries.some(query => query.id === id && query.resident))
    || !capabilities.publicCliCommands.includes('stream')) {
    throw new Error('The staged CLI is stale or lacks resident routing. Run npm run build:cli-runtime.')
  }
  // Actually load the copied binary; capabilities alone can run without it.
  await run(process.execPath, ['--input-type=module', '-e',
    'import {createRequire} from "node:module";const b=createRequire(import.meta.url)(process.env.VIGO_NATIVE_ROUTING_KERNEL);if(typeof b.TimetableKernel!=="function")throw Error("Missing TimetableKernel")'], { cwd: payload, env })
  const files = {}
  for (const file of (await fs.readdir(payload)).sort()) {
    const contents = await fs.readFile(path.join(payload, file))
    files[file] = { bytes: contents.length, sha256: hash(contents) }
  }
  let sourceCommit = null, sourceDirty = null
  try {
    sourceCommit = (await run('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim()
    sourceDirty = Boolean((await run('git', ['status', '--porcelain'], { cwd: root })).stdout.trim())
  } catch { /* Source archives need not have a Git checkout. */ }
  await fs.writeFile(path.join(payload, 'manifest.json'), `${JSON.stringify({
    schemaVersion: 'vigo.cli.package.v1', productVersion: metadata.version,
    apiVersion: capabilities.apiVersion, platform: process.platform, architecture: process.arch,
    rustTarget: target.targetTriple, nodeMinimum: '24.18.0', builtAt: new Date().toISOString(),
    sourceCommit, sourceDirty, interfaces: ['cli', 'resident-ndjson'],
    excluded: ['studio', 'python-wrapper', 'city-data', 'node-runtime', 'source', 'tests', 'http'], files,
  }, null, 2)}\n`)
  const audit = await auditPackageFiles(payload, { forbiddenRoots: [root] })
  const zip = new JSZip()
  for (const file of (await fs.readdir(payload)).sort()) zip.file(`${name}/${file}`, await fs.readFile(path.join(payload, file)), {
    date: new Date('1980-01-01T00:00:00Z'), unixPermissions: file.endsWith('.mjs') ? 0o100755 : 0o100644,
  })
  const data = await zip.generateAsync({ type: 'nodebuffer', platform: 'UNIX', compression: 'DEFLATE', compressionOptions: { level: 9 } })
  await fs.writeFile(temporaryZip, data)
  const temporaryChecksum = path.join(staging, 'checksum.next')
  await fs.writeFile(temporaryChecksum, `${hash(data)}  ${path.basename(archive)}\n`)
  await publishArtifacts([[payload, runtime], [temporaryZip, archive],
    [temporaryChecksum, `${archive}.sha256`]], path.join(staging, 'previous'))
  if (process.env.GITHUB_OUTPUT) await fs.appendFile(process.env.GITHUB_OUTPUT, `archive-path=${archive}\n`)
  console.log(JSON.stringify({ status: 'packaged', archive, runtime, platform: process.platform,
    architecture: process.arch, zipBytes: data.length, payloadBytes: audit.bytes, files: audit.files,
    nodeIncluded: false, studioIncluded: false, pythonIncluded: false, httpIncluded: false, sourceDirty }, null, 2))
} finally { await fs.rm(staging, { recursive: true, force: true }) }
