import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { createReadStream } from 'node:fs'
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { startInMemoryVigoApi } from './lib/in-memory-vigo-api.mjs'

const execFileAsync = promisify(execFile)

export const buildManifestFileName = 'BUILD_MANIFEST.json'
export const buildManifestSchemaVersion = 'vigo.build-manifest.v1'
export const releaseSourceInputs = Object.freeze([
  '.gitattributes',
  '.gitignore',
  'CONTRIBUTING.md',
  'LICENSE',
  'NOTICE',
  'README.md',
  'SECURITY.md',
  'config',
  'docs',
  'index.html',
  'native/vigo-routing-kernel/Cargo.lock',
  'native/vigo-routing-kernel/Cargo.toml',
  'native/vigo-routing-kernel/src',
  'native/vigo-routing-kernel/vendor/cch',
  'package-lock.json',
  'package.json',
  'public',
  'scripts',
  'server',
  'src',
  'tsconfig.json',
  'vite.config.ts',
])

function canonicalRelativePath(filePath) {
  return filePath.split(path.sep).join('/')
}

function modeString(mode) {
  return (mode & 0o777).toString(8).padStart(3, '0')
}

function hashText(value) {
  return createHash('sha256').update(value).digest('hex')
}

export async function sha256File(filePath) {
  const hash = createHash('sha256')
  const stream = createReadStream(filePath)
  for await (const chunk of stream) hash.update(chunk)
  return hash.digest('hex')
}

async function fileRecord(root, filePath) {
  const fileStats = await lstat(filePath)
  const relativePath = canonicalRelativePath(path.relative(root, filePath))
  if (fileStats.isSymbolicLink()) {
    const target = await readlink(filePath)
    return {
      path: relativePath,
      type: 'symlink',
      mode: modeString(fileStats.mode),
      bytes: Buffer.byteLength(target),
      sha256: hashText(target),
      target,
    }
  }
  if (!fileStats.isFile()) return null
  return {
    path: relativePath,
    type: 'file',
    mode: modeString(fileStats.mode),
    bytes: fileStats.size,
    sha256: await sha256File(filePath),
  }
}

async function collectPathRecords(root, filePath, records, excludedRelativePaths) {
  const fileStats = await lstat(filePath).catch(() => null)
  if (!fileStats) return
  // Finder may create this host-local metadata file while a release directory
  // is being inspected. It is not part of the product artifact and must not
  // make otherwise identical package verification nondeterministic.
  if (path.basename(filePath) === '.DS_Store') return
  const relativePath = canonicalRelativePath(path.relative(root, filePath))
  if (excludedRelativePaths.has(relativePath)) return
  if (fileStats.isDirectory()) {
    const entries = await readdir(filePath, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      await collectPathRecords(root, path.join(filePath, entry.name), records, excludedRelativePaths)
    }
    return
  }
  const record = await fileRecord(root, filePath)
  if (record) records.set(record.path, record)
}

export async function collectTreeRecords(root, {
  inputs = ['.'],
  exclude = [],
} = {}) {
  const records = new Map()
  const excludedRelativePaths = new Set(exclude.map(canonicalRelativePath))
  for (const input of inputs) {
    const resolvedInput = path.resolve(root, input)
    const relativeInput = path.relative(root, resolvedInput)
    if (relativeInput.startsWith('..') || path.isAbsolute(relativeInput)) {
      throw new Error(`Manifest input escapes its root: ${input}`)
    }
    await collectPathRecords(root, resolvedInput, records, excludedRelativePaths)
  }
  return [...records.values()].sort((left, right) => left.path.localeCompare(right.path))
}

function snapshotHash(records) {
  return hashText(`${records.map((record) => JSON.stringify(record)).join('\n')}\n`)
}

async function reproducibleBuildTimestamp(repoRoot) {
  const sourceDateEpoch = Number(process.env.SOURCE_DATE_EPOCH)
  if (Number.isInteger(sourceDateEpoch) && sourceDateEpoch >= 0) {
    return new Date(sourceDateEpoch * 1_000).toISOString()
  }
  try {
    const { stdout } = await execFileAsync('git', ['log', '-1', '--format=%ct'], { cwd: repoRoot })
    const commitEpoch = Number(stdout.trim())
    if (Number.isInteger(commitEpoch) && commitEpoch >= 0) {
      return new Date(commitEpoch * 1_000).toISOString()
    }
  } catch {}
  // ZIP timestamps cannot represent dates before 1980. A fixed fallback keeps
  // fixture and source-archive builds reproducible when Git metadata is absent.
  return '1980-01-01T00:00:00.000Z'
}

export async function sourceSnapshot(repoRoot, inputs = releaseSourceInputs) {
  const records = await collectTreeRecords(repoRoot, { inputs })
  if (!records.length) throw new Error('Release source snapshot is empty.')
  return { hash: snapshotHash(records), files: records }
}

export async function artifactSnapshot(distributionRoot) {
  const records = await collectTreeRecords(distributionRoot, {
    exclude: [buildManifestFileName],
  })
  if (!records.length) throw new Error('Release artifact snapshot is empty.')
  return { hash: snapshotHash(records), files: records }
}

export async function writeBuildManifest({
  repoRoot,
  distributionRoot,
  version,
  sourceInputs = releaseSourceInputs,
  source: packagedSource,
}) {
  const source = packagedSource ?? await sourceSnapshot(repoRoot, sourceInputs)
  const artifact = await artifactSnapshot(distributionRoot)
  const manifest = {
    schemaVersion: buildManifestSchemaVersion,
    generatedAt: await reproducibleBuildTimestamp(repoRoot),
    product: 'VIGO',
    version,
    platform: 'macos',
    architecture: 'arm64',
    distribution: path.basename(distributionRoot),
    source: {
      inputs: [...sourceInputs],
      hash: source.hash,
      files: source.files,
    },
    artifact,
  }
  const manifestPath = path.join(distributionRoot, buildManifestFileName)
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  return { manifest, manifestPath }
}

function sameStringArray(left, right) {
  return Array.isArray(left)
    && left.length === right.length
    && left.every((value, index) => value === right[index])
}

export async function verifyBuildManifest({
  repoRoot,
  distributionRoot,
  version,
  sourceInputs = releaseSourceInputs,
}) {
  const manifestPath = path.join(distributionRoot, buildManifestFileName)
  const manifestText = await readFile(manifestPath, 'utf8').catch(() => {
    throw new Error(`Missing ${buildManifestFileName}. Rebuild the macOS release before archiving.`)
  })
  const manifest = JSON.parse(manifestText)
  if (manifest.schemaVersion !== buildManifestSchemaVersion) {
    throw new Error(`Unsupported build manifest schema: ${manifest.schemaVersion ?? 'missing'}`)
  }
  if (manifest.version !== version) {
    throw new Error(`Build manifest version ${manifest.version ?? 'missing'} does not match package version ${version}.`)
  }
  if (manifest.distribution !== path.basename(distributionRoot)) {
    throw new Error('Build manifest distribution name does not match the release folder.')
  }
  if (!sameStringArray(manifest.source?.inputs, [...sourceInputs])) {
    throw new Error('Build manifest source input contract is incomplete or has changed.')
  }

  const currentSource = await sourceSnapshot(repoRoot, sourceInputs)
  if (manifest.source?.hash !== currentSource.hash) {
    throw new Error(`Stale source: packaged ${manifest.source?.hash ?? 'missing'}, current ${currentSource.hash}. Rebuild the macOS release.`)
  }
  const currentArtifact = await artifactSnapshot(distributionRoot)
  if (manifest.artifact?.hash !== currentArtifact.hash) {
    throw new Error(`Stale artifact: packaged ${manifest.artifact?.hash ?? 'missing'}, current ${currentArtifact.hash}. Rebuild the macOS release.`)
  }
  return { manifest, manifestPath }
}

async function assertFile(filePath, message) {
  const fileStats = await stat(filePath).catch(() => null)
  if (!fileStats?.isFile()) throw new Error(message)
}

export async function assertPackagedRuntime(serverRoot) {
  const serverPath = path.join(serverRoot, 'vigo-server.mjs')
  const routeWorkerPath = path.join(serverRoot, 'national-route-worker.mjs')
  await assertFile(serverPath, 'Packaged server entry is missing.')
  await assertFile(routeWorkerPath, 'Packaged national-route-worker.mjs is missing.')
  const [serverSource, routeWorkerSource] = await Promise.all([
    readFile(serverPath, 'utf8'),
    readFile(routeWorkerPath, 'utf8'),
  ])
  for (const marker of ['national-route-worker.mjs', 'routingRuntime', 'transportLod']) {
    if (!serverSource.includes(marker)) {
      throw new Error(`Packaged vigo-server.mjs is missing required runtime marker: ${marker}`)
    }
  }
  for (const marker of ['routeNationalGtfsStore', 'routeNationalGtfsMatrix', 'searchNationalGtfsStops']) {
    if (!routeWorkerSource.includes(marker)) {
      throw new Error(`Packaged national-route-worker.mjs is missing required operation: ${marker}`)
    }
  }
  return { serverPath, routeWorkerPath }
}

export async function verifyCodeSignature(appBundle) {
  await execFileAsync('/usr/bin/codesign', [
    '--verify',
    '--deep',
    '--strict',
    '--verbose=4',
    appBundle,
  ])
}

const standaloneTextExtensions = new Set(['.css', '.html', '.js', '.json', '.mjs', '.plist', '.txt'])

function isInsidePath(parent, child) {
  const relative = path.relative(parent, child)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

async function standaloneTextFiles(root, current = root, files = []) {
  const entries = await readdir(current, { withFileTypes: true })
  for (const entry of entries) {
    const entryPath = path.join(current, entry.name)
    if (entry.isDirectory()) {
      await standaloneTextFiles(root, entryPath, files)
      continue
    }
    if (!entry.isFile()) continue
    if (standaloneTextExtensions.has(path.extname(entry.name)) || entry.name === 'vigo') {
      files.push(entryPath)
    }
  }
  return files
}

async function assertNoDevelopmentPathReferences(distributionRoot, forbiddenPaths) {
  const markers = forbiddenPaths
    .map((value) => String(value || '').trim())
    .filter(Boolean)
  if (!markers.length) return

  for (const filePath of await standaloneTextFiles(distributionRoot)) {
    const source = await readFile(filePath, 'utf8')
    for (const marker of markers) {
      if (source.includes(marker)) {
        throw new Error(`Standalone artifact leaks development path ${marker} in ${path.relative(distributionRoot, filePath)}.`)
      }
    }
  }
}

async function assertNoLegacyBrowserRouting(distributionRoot) {
  const forbiddenSignatures = [
    'vigo.osm.walk.v1',
    'OSM walk layer must be a GeoJSON FeatureCollection.',
    'exact_time_dependent_dijkstra',
    'osm_walk_graph_search',
    'static_transit_topology',
  ]

  for (const filePath of await standaloneTextFiles(distributionRoot)) {
    const source = await readFile(filePath, 'utf8')
    const signature = forbiddenSignatures.find((candidate) => source.includes(candidate))
    if (signature) {
      throw new Error(`Standalone artifact contains legacy browser-routing signature ${signature} in ${path.relative(distributionRoot, filePath)}.`)
    }
  }
}

async function assertBundledModuleClosure(resourcesRoot) {
  const moduleFiles = [
    path.join(resourcesRoot, 'bin', 'vigo.mjs'),
    ...((await readdir(path.join(resourcesRoot, 'server')))
      .filter((name) => name.endsWith('.mjs'))
      .map((name) => path.join(resourcesRoot, 'server', name))),
  ]

  for (const modulePath of moduleFiles) {
    const source = await readFile(modulePath, 'utf8')
    const imports = source.matchAll(/^import(?:\s+[\s\S]*?\s+from)?\s*["']([^"']+)["'];?$/gm)
    for (const match of imports) {
      if (match[1].startsWith('node:')) continue
      if (match[1].startsWith('.')) {
        const bundledDependency = path.resolve(path.dirname(modulePath), match[1])
        const relativeDependency = path.relative(resourcesRoot, bundledDependency)
        if (relativeDependency.startsWith('..') || path.isAbsolute(relativeDependency)) {
          throw new Error(`Packaged module ${path.basename(modulePath)} escapes the app resources with ${match[1]}.`)
        }
        await assertFile(
          bundledDependency,
          `Packaged module ${path.basename(modulePath)} is missing bundled dependency ${match[1]}.`,
        )
        continue
      }
      throw new Error(`Packaged module ${path.basename(modulePath)} retains external import ${match[1]}.`)
    }
  }
}

function linkedLibraryPath(filePath, dependency) {
  if (dependency.startsWith('@loader_path/')) {
    return path.resolve(path.dirname(filePath), dependency.slice('@loader_path/'.length))
  }
  if (dependency.startsWith('@executable_path/')) {
    return path.resolve(path.dirname(filePath), dependency.slice('@executable_path/'.length))
  }
  return ''
}

async function nativeRuntimeFiles(appBundle) {
  const resourcesRoot = path.join(appBundle, 'Contents', 'Resources')
  const libRoot = path.join(resourcesRoot, 'lib')
  const dylibs = (await readdir(libRoot))
    .filter((name) => name.endsWith('.dylib'))
    .sort()
    .map((name) => path.join(libRoot, name))
  return {
    dylibs,
    nativeFiles: [
      path.join(appBundle, 'Contents', 'MacOS', 'VIGO'),
      path.join(resourcesRoot, 'bin', 'node'),
      ...dylibs,
    ],
  }
}

function compareVersions(left, right) {
  const leftParts = String(left).split('.').map((part) => Number.parseInt(part, 10) || 0)
  const rightParts = String(right).split('.').map((part) => Number.parseInt(part, 10) || 0)
  const partCount = Math.max(leftParts.length, rightParts.length)
  for (let index = 0; index < partCount; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

export async function verifyNativeDeploymentTargets(appBundle) {
  const plistPath = path.join(appBundle, 'Contents', 'Info.plist')
  const { stdout: minimumVersionOutput } = await execFileAsync('/usr/libexec/PlistBuddy', [
    '-c',
    'Print :LSMinimumSystemVersion',
    plistPath,
  ])
  const minimumSystemVersion = minimumVersionOutput.trim()
  if (!/^\d+(?:\.\d+)*$/.test(minimumSystemVersion)) {
    throw new Error(`VIGO.app declares an invalid LSMinimumSystemVersion: ${minimumSystemVersion || 'missing'}.`)
  }

  const { nativeFiles } = await nativeRuntimeFiles(appBundle)
  const nativeTargets = []
  for (const filePath of nativeFiles) {
    await assertFile(filePath, `Standalone native runtime file is missing: ${filePath}`)
    const { stdout } = await execFileAsync('/usr/bin/vtool', ['-show-build', filePath])
    const minimumVersions = [...stdout.matchAll(/^\s*minos\s+(\d+(?:\.\d+)*)\s*$/gm)]
      .map((match) => match[1])
    if (!minimumVersions.length) {
      throw new Error(`Unable to read a macOS deployment target from ${filePath}.`)
    }
    const nativeMinimumVersion = minimumVersions.reduce((maximum, candidate) => (
      compareVersions(candidate, maximum) > 0 ? candidate : maximum
    ))
    if (compareVersions(nativeMinimumVersion, minimumSystemVersion) > 0) {
      throw new Error(
        `${path.relative(appBundle, filePath)} requires macOS ${nativeMinimumVersion}, ` +
        `but VIGO.app declares macOS ${minimumSystemVersion}.`,
      )
    }
    nativeTargets.push({
      path: path.relative(appBundle, filePath),
      minimumSystemVersion: nativeMinimumVersion,
    })
  }

  const maximumNativeMinimumVersion = nativeTargets
    .map((target) => target.minimumSystemVersion)
    .reduce((maximum, candidate) => (
      compareVersions(candidate, maximum) > 0 ? candidate : maximum
    ))
  return { minimumSystemVersion, maximumNativeMinimumVersion, nativeTargets }
}

export async function verifyNativeDependencyClosure(appBundle) {
  const { dylibs, nativeFiles } = await nativeRuntimeFiles(appBundle)

  for (const filePath of nativeFiles) {
    await assertFile(filePath, `Standalone native runtime file is missing: ${filePath}`)
    const { stdout } = await execFileAsync('/usr/bin/otool', ['-L', filePath])
    const dependencies = stdout
      .split('\n')
      .slice(1)
      .map((line) => line.trim().split(/\s+/)[0])
      .filter(Boolean)

    for (const dependency of dependencies) {
      if (dependency.startsWith('/System/') || dependency.startsWith('/usr/lib/')) continue
      const bundledPath = linkedLibraryPath(filePath, dependency)
      if (!bundledPath) {
        throw new Error(`Standalone native dependency is unresolved or external: ${dependency} (${path.basename(filePath)}).`)
      }
      if (!isInsidePath(appBundle, bundledPath)) {
        throw new Error(`Standalone native dependency escapes VIGO.app: ${dependency} (${path.basename(filePath)}).`)
      }
      await assertFile(bundledPath, `Standalone native dependency is missing: ${dependency} (${path.basename(filePath)}).`)
    }
  }

  for (const executablePath of nativeFiles.slice(0, 2)) {
    const { stdout } = await execFileAsync('/usr/bin/lipo', ['-archs', executablePath])
    if (!stdout.trim().split(/\s+/).includes('arm64')) {
      throw new Error(`Standalone executable is missing arm64 architecture: ${executablePath}`)
    }
  }

  return { nativeFileCount: nativeFiles.length, dylibCount: dylibs.length }
}

async function verifyStandaloneTree({
  distributionRoot,
  expectedVersion,
  forbiddenPaths = [],
}) {
  const appBundle = path.join(distributionRoot, 'VIGO.app')
  const resourcesRoot = path.join(appBundle, 'Contents', 'Resources')
  const nodePath = path.join(resourcesRoot, 'bin', 'node')
  const serverPath = path.join(resourcesRoot, 'server', 'vigo-server.mjs')
  const appRoot = path.join(resourcesRoot, 'app')
  const cliPath = path.join(distributionRoot, 'vigo')
  const nativeRoutingKernelPath = path.join(resourcesRoot, 'server', 'vigo-routing-kernel.node')
  const readmePath = path.join(distributionRoot, 'README.txt')

  await assertPackagedRuntime(path.join(resourcesRoot, 'server'))
  await assertFile(path.join(appRoot, 'index.html'), 'Standalone frontend entry is missing.')
  await assertFile(nodePath, 'Standalone bundled Node.js runtime is missing.')
  await assertFile(cliPath, 'Standalone CLI launcher is missing.')
  await assertFile(nativeRoutingKernelPath, 'Standalone Rust routing kernel is missing.')
  await assertFile(path.join(distributionRoot, 'LICENSE'), 'Standalone Apache-2.0 license is missing.')
  await assertFile(path.join(distributionRoot, 'NOTICE'), 'Standalone attribution notice is missing.')
  await assertFile(path.join(distributionRoot, 'licenses', 'nodejs-LICENSE'), 'Bundled Node.js license is missing.')
  await assertFile(path.join(distributionRoot, 'licenses', 'cch-LICENSE'), 'Vendored cch license is missing.')
  await assertFile(path.join(distributionRoot, 'licenses', 'cch-NOTICE'), 'Vendored cch notice is missing.')
  await verifyCodeSignature(appBundle)
  const nativeClosure = await verifyNativeDependencyClosure(appBundle)
  const nativeDeployment = await verifyNativeDeploymentTargets(appBundle)
  await assertBundledModuleClosure(resourcesRoot)
  await assertNoDevelopmentPathReferences(distributionRoot, forbiddenPaths)
  await assertNoLegacyBrowserRouting(distributionRoot)

  const readme = await readFile(readmePath, 'utf8')
  const cliLauncher = await readFile(cliPath, 'utf8')
  assert.match(
    cliLauncher,
    /VIGO_NATIVE_ROUTING_KERNEL=.*vigo-routing-kernel\.node/u,
    'Standalone CLI launcher must bind the packaged Rust routing kernel.',
  )
  assert.match(readme, /--store=\/path\/to\/feed\.sqlite/, 'Standalone README must document the SQLite routing store CLI.')
  assert.doesNotMatch(readme, /--feed=/, 'Standalone README must not document the removed JSON feed CLI.')

  const isolatedRoot = await mkdtemp(path.join(os.tmpdir(), 'vigo-clean-runtime-'))
  const homeRoot = path.join(isolatedRoot, 'home')
  const tempRoot = path.join(isolatedRoot, 'tmp')
  const projectRoot = path.join(homeRoot, 'Standalone Vigo Projects')
  await mkdir(homeRoot, { recursive: true })
  await mkdir(tempRoot, { recursive: true })

  const cleanEnvironment = {
    HOME: homeRoot,
    TMPDIR: tempRoot,
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    LANG: 'en_US.UTF-8',
    NODE_OPTIONS: '--use-bundled-ca',
    VIGO_DIST_DIR: appRoot,
  }
  const startedAt = performance.now()
  const runtime = await startInMemoryVigoApi({
    repositoryRoot: resourcesRoot,
    executable: nodePath,
    serverPath,
    workingDirectory: resourcesRoot,
    inheritEnvironment: false,
    environment: cleanEnvironment,
    startupTimeoutMs: 15_000,
    stopTimeoutMs: 2_000,
  })

  try {
    const origin = runtime.baseUrl
    const startupMs = performance.now() - startedAt
    const healthResponse = await runtime.fetch(new URL('/api/health', origin))
    assert.equal(healthResponse.status, 200, 'Standalone /api/health did not return HTTP 200.')
    const health = await healthResponse.json()
    assert.equal(health.ok, true)
    assert.equal(health.version, expectedVersion)
    assert.equal(health.config?.setupRequired, true, 'Fresh HOME must enter first-run setup.')
    assert.equal(health.offline?.bundledApp, true, 'Standalone server did not find its bundled frontend.')
    assert(isInsidePath(homeRoot, health.storageRoot), 'Fresh-home storage escaped the isolated HOME.')
    assert(isInsidePath(homeRoot, health.config?.configFile), 'Fresh-home config escaped the isolated HOME.')

    const setupResponse = await runtime.fetch(new URL('/api/config', origin), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ storageRoot: projectRoot }),
    })
    assert.equal(setupResponse.status, 200, 'Standalone first-run setup did not return HTTP 200.')
    const setup = await setupResponse.json()
    assert.equal(setup.config?.setupRequired, false, 'Standalone first-run setup did not persist.')
    assert.equal(setup.config?.storageRoot, projectRoot)
    assert.equal(setup.config?.offline?.storageWritable, true)

    const projectsResponse = await runtime.fetch(new URL('/api/projects', origin))
    assert.equal(projectsResponse.status, 200, 'Standalone project listing did not return HTTP 200.')
    const projects = await projectsResponse.json()
    assert(Array.isArray(projects.projects), 'Standalone project listing payload is invalid.')

    const rootResponse = await runtime.fetch(origin)
    assert.equal(rootResponse.status, 200, 'Standalone frontend did not return HTTP 200.')
    const rootHtml = await rootResponse.text()
    assert.match(rootHtml, /Visual Intelligence for GTFS Operations|<div id="root"><\/div>/)

    const [{ stdout: nodeVersion }, { stdout: cliVersion }, { stdout: cliHelp }] = await Promise.all([
      execFileAsync(nodePath, ['--version'], { cwd: isolatedRoot, env: cleanEnvironment }),
      execFileAsync(cliPath, ['--version'], { cwd: isolatedRoot, env: cleanEnvironment }),
      execFileAsync(cliPath, ['--help'], { cwd: isolatedRoot, env: cleanEnvironment }),
    ])
    assert.match(nodeVersion.trim(), /^v\d+\.\d+\.\d+$/)
    assert.equal(cliVersion.trim(), expectedVersion)
    assert.match(cliHelp, /vigo build-network/, 'Standalone CLI must compile GTFS/OSM inputs.')
    assert.match(cliHelp, /--json-out PATH/, 'Standalone CLI must expose full-fidelity JSON results.')
    assert.doesNotMatch(cliHelp, /--feed PATH/, 'Standalone CLI must not restore the removed legacy feed path.')

    return {
      ...nativeClosure,
      ...nativeDeployment,
      nodeVersion: nodeVersion.trim(),
      startupMs,
      setupRequired: health.config.setupRequired,
      frontendBytes: Buffer.byteLength(rootHtml),
    }
  } finally {
    await runtime.stop()
    await rm(isolatedRoot, { recursive: true, force: true })
  }
}

export async function verifyStandaloneDistribution({
  distributionRoot,
  expectedVersion,
  forbiddenPaths = [],
}) {
  // Native dependency closure, bundled-module closure, development-path scans,
  // and a clean HOME/TMP/PATH startup already prove that the distribution does
  // not reach back into the build tree. Avoiding a second byte-for-byte copy
  // removes ~114 MiB of transient I/O from every package build. ZIP validation
  // still extracts and starts an independent tree at archive time.
  return verifyStandaloneTree({
    distributionRoot,
    expectedVersion,
    forbiddenPaths,
  })
}

export async function restoreAndVerifyStandaloneArchive({
  archivePath,
  distributionRoot,
  expectedVersion,
  forbiddenPaths = [],
}) {
  const releaseRoot = path.dirname(distributionRoot)
  await rm(distributionRoot, { recursive: true, force: true })
  try {
    await execFileAsync('/usr/bin/ditto', ['-x', '-k', archivePath, releaseRoot])
  } catch (error) {
    await rm(distributionRoot, { recursive: true, force: true })
    throw error
  }
  return verifyStandaloneTree({
    distributionRoot,
    expectedVersion,
    forbiddenPaths,
  })
}

async function archiveEntries(archivePath) {
  const { stdout } = await execFileAsync('/usr/bin/unzip', ['-Z1', archivePath], {
    maxBuffer: 16 * 1024 * 1024,
  })
  return stdout
    .split('\n')
    .map((entry) => entry.trim())
    .filter(Boolean)
}

function archiveEntryHash(archivePath, entry) {
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/unzip', ['-p', archivePath, entry], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const hash = createHash('sha256')
    let stderr = ''
    child.stdout.on('data', (chunk) => hash.update(chunk))
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 16_384) stderr += chunk.toString()
    })
    child.once('error', reject)
    child.once('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Unable to read ${entry} from archive (exit ${code}): ${stderr.trim()}`))
        return
      }
      resolve(hash.digest('hex'))
    })
  })
}

export async function verifyZipArchive({ archivePath, distributionRoot }) {
  const distributionName = path.basename(distributionRoot)
  const expectedRecords = await collectTreeRecords(distributionRoot)
  const expectedEntries = expectedRecords.map((record) => `${distributionName}/${record.path}`)
  const entries = (await archiveEntries(archivePath))
    .filter((entry) => !entry.endsWith('/'))
    .filter((entry) => !entry.startsWith('__MACOSX/'))
    .filter((entry) => !entry.endsWith('/.DS_Store'))
  const expectedSet = new Set(expectedEntries)
  const actualSet = new Set(entries)
  if (actualSet.size !== entries.length) throw new Error('ZIP contains duplicate release file entries.')
  const missing = expectedEntries.filter((entry) => !actualSet.has(entry))
  const unexpected = entries.filter((entry) => !expectedSet.has(entry))
  if (missing.length || unexpected.length) {
    throw new Error(`ZIP entry mismatch. Missing: ${missing.join(', ') || 'none'}. Unexpected: ${unexpected.join(', ') || 'none'}.`)
  }

  for (const record of expectedRecords) {
    const entry = `${distributionName}/${record.path}`
    const archivedHash = await archiveEntryHash(archivePath, entry)
    if (archivedHash !== record.sha256) {
      throw new Error(`ZIP content hash mismatch for ${entry}.`)
    }
  }
  return { entryCount: entries.length, files: expectedRecords }
}

export async function writeChecksumFile(archivePath, checksumPath) {
  const checksum = await sha256File(archivePath)
  await writeFile(checksumPath, `${checksum}  ${path.basename(archivePath)}\n`)
  return checksum
}

export async function verifyChecksumFile(archivePath, checksumPath) {
  const checksumText = (await readFile(checksumPath, 'utf8')).trim()
  const match = /^([a-f0-9]{64})\s{2}(.+)$/.exec(checksumText)
  if (!match) throw new Error('Release checksum file has an invalid format.')
  if (match[2] !== path.basename(archivePath)) throw new Error('Release checksum names the wrong archive.')
  const actual = await sha256File(archivePath)
  if (actual !== match[1]) throw new Error(`Release checksum mismatch: expected ${match[1]}, actual ${actual}.`)
  return actual
}

async function selfTest() {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'vigo-release-check-'))
  const repoRoot = path.join(folder, 'repo')
  const distributionRoot = path.join(repoRoot, 'release', 'VIGO-mac-arm64')
  const appBundle = path.join(distributionRoot, 'VIGO.app')
  const runtimeRoot = path.join(appBundle, 'Contents', 'Resources', 'server')
  const archivePath = path.join(repoRoot, 'release', 'VIGO-fixture-mac-arm64.zip')
  const checksumPath = `${archivePath}.sha256`
  const sourceInputs = ['package.json', 'src']
  try {
    await mkdir(path.join(repoRoot, 'src'), { recursive: true })
    await mkdir(runtimeRoot, { recursive: true })
    await writeFile(path.join(repoRoot, 'package.json'), '{"version":"fixture"}\n')
    await writeFile(path.join(repoRoot, 'src', 'main.js'), 'export const fixture = true\n')
    await writeFile(path.join(appBundle, 'Contents', 'fixture.txt'), 'app\n')
    const serverFixture = 'const worker = "national-route-worker.mjs"; const health = "routingRuntime"; const atlas = "transportLod";\n'
    await writeFile(path.join(runtimeRoot, 'vigo-server.mjs'), serverFixture)
    await writeFile(path.join(runtimeRoot, 'national-route-worker.mjs'), 'routeNationalGtfsStore(); routeNationalGtfsMatrix(); searchNationalGtfsStops();\n')
    await writeFile(path.join(distributionRoot, 'README.txt'), 'fixture\n')
    await writeFile(path.join(distributionRoot, 'vigo'), '#!/bin/sh\nexit 0\n')
    await chmod(path.join(distributionRoot, 'vigo'), 0o755)

    await assertPackagedRuntime(runtimeRoot)
    await writeFile(path.join(runtimeRoot, 'vigo-server.mjs'), serverFixture.replace('transportLod', 'missing-atlas'))
    await assert.rejects(assertPackagedRuntime(runtimeRoot), /transportLod/)
    await writeFile(path.join(runtimeRoot, 'vigo-server.mjs'), serverFixture)
    await assert.rejects(verifyCodeSignature(appBundle))

    const { manifest } = await writeBuildManifest({
      repoRoot,
      distributionRoot,
      version: 'fixture',
      sourceInputs,
    })
    await verifyBuildManifest({ repoRoot, distributionRoot, version: 'fixture', sourceInputs })
    await writeFile(path.join(repoRoot, 'src', 'main.js'), 'export const fixture = false\n')
    await assert.rejects(
      verifyBuildManifest({ repoRoot, distributionRoot, version: 'fixture', sourceInputs }),
      /Stale source/,
    )
    await writeFile(path.join(repoRoot, 'src', 'main.js'), 'export const fixture = true\n')
    await verifyBuildManifest({ repoRoot, distributionRoot, version: 'fixture', sourceInputs })
    await writeFile(path.join(distributionRoot, 'README.txt'), 'changed fixture\n')
    await assert.rejects(
      verifyBuildManifest({ repoRoot, distributionRoot, version: 'fixture', sourceInputs }),
      /Stale artifact/,
    )
    await writeFile(path.join(distributionRoot, 'README.txt'), 'fixture\n')
    await verifyBuildManifest({ repoRoot, distributionRoot, version: 'fixture', sourceInputs })

    await execFileAsync('/usr/bin/ditto', [
      '-c',
      '-k',
      '--sequesterRsrc',
      '--keepParent',
      distributionRoot,
      archivePath,
    ], { cwd: path.dirname(distributionRoot) })
    const archive = await verifyZipArchive({ archivePath, distributionRoot })
    assert(archive.entryCount >= 4)
    await writeChecksumFile(archivePath, checksumPath)
    await verifyChecksumFile(archivePath, checksumPath)
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
  console.log('macOS release helper self-test passed.')
}

async function main() {
  if (process.argv.includes('--self-test')) {
    await selfTest()
    return
  }
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const packageJson = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8'))
  const releaseRoot = process.env.VIGO_RELEASE_ROOT
    ? path.resolve(process.env.VIGO_RELEASE_ROOT)
    : path.join(repoRoot, 'release')
  const distributionRoot = path.join(releaseRoot, 'VIGO-mac-arm64')
  const appBundle = path.join(distributionRoot, 'VIGO.app')
  const archivePath = path.join(releaseRoot, `VIGO-${packageJson.version}-mac-arm64.zip`)
  const checksumPath = `${archivePath}.sha256`
  const { manifest } = await verifyBuildManifest({
    repoRoot,
    distributionRoot,
    version: packageJson.version,
  })
  await assertPackagedRuntime(path.join(appBundle, 'Contents', 'Resources', 'server'))
  await verifyCodeSignature(appBundle)
  const archive = await verifyZipArchive({ archivePath, distributionRoot })
  await verifyChecksumFile(archivePath, checksumPath)
  // verifyZipArchive proves the checked distribution and archive contain the
  // same manifest-tracked bytes. Starting the restored distribution in place
  // avoids retaining a second 114 MiB extraction during routine verification.
  const standalone = await verifyStandaloneDistribution({
    distributionRoot,
    expectedVersion: packageJson.version,
    forbiddenPaths: [repoRoot],
  })
  console.log(`macOS release verified (${archive.entryCount} files, source ${manifest.source.hash}, artifact ${manifest.artifact.hash}).`)
  console.log(`Standalone ZIP runtime verified (${standalone.nodeVersion}, macOS ${standalone.minimumSystemVersion}+, ${standalone.dylibCount} bundled dylibs, ${standalone.startupMs.toFixed(1)} ms clean startup).`)
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : ''
if (import.meta.url === invokedPath) {
  await main()
}
