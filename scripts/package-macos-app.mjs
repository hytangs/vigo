import { access, chmod, copyFile, cp, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  assertPackagedRuntime,
  sha256File,
  sourceSnapshot,
  verifyBuildManifest,
  verifyCodeSignature,
  verifyStandaloneDistribution,
  writeBuildManifest,
} from './check-macos-release.mjs'

const execFileAsync = promisify(execFile)

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packageJson = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'))
const macosMinimumVersion = '13.5'
const bundledNodeRuntime = Object.freeze({
  version: 'v24.18.0',
  archiveName: 'node-v24.18.0-darwin-arm64.tar.gz',
  archiveSha256: 'e1a97e14c99c803e96c7339403282ea05a499c32f8d83defe9ef5ec66f979ed1',
  archiveUrl: 'https://nodejs.org/dist/v24.18.0/node-v24.18.0-darwin-arm64.tar.gz',
  extractedRoot: 'node-v24.18.0-darwin-arm64',
})
const releaseRoot = process.env.VIGO_RELEASE_ROOT
  ? resolve(process.env.VIGO_RELEASE_ROOT)
  : join(repoRoot, 'release')
const distributionName = 'VIGO-mac-arm64'
const distributionRoot = join(releaseRoot, distributionName)
const appBundle = join(distributionRoot, 'VIGO.app')
const contentsRoot = join(appBundle, 'Contents')
const macosRoot = join(contentsRoot, 'MacOS')
const resourcesRoot = join(contentsRoot, 'Resources')
const appResources = {
  app: join(resourcesRoot, 'app'),
  bin: join(resourcesRoot, 'bin'),
  lib: join(resourcesRoot, 'lib'),
  server: join(resourcesRoot, 'server'),
}

await assertFile(join(repoRoot, 'dist', 'index.html'), 'Missing dist/index.html. Run npm run build before packaging.')
await assertFile(join(repoRoot, 'dist-cli', 'vigo.mjs'), 'Missing dist-cli/vigo.mjs. Run npm run build before packaging.')
await assertFile(
  join(repoRoot, 'native', 'vigo-routing-kernel', 'vigo-routing-kernel.node'),
  'Missing Rust routing kernel. Run npm run build:rust-routing-kernel before packaging.',
)
await assertFile(join(repoRoot, 'scripts', 'macos', 'VigoApp.m'), 'Missing macOS app source.')
await assertFile(join(repoRoot, 'scripts', 'macos', 'VIGO.icns'), 'Missing macOS app icon. Run npm run icons:macos before packaging.')
await assertCommand('/usr/bin/clang', 'clang not found. Install Xcode Command Line Tools.')
await assertCommand('/usr/bin/vtool', 'vtool not found. Install Xcode Command Line Tools.')
const packagingSource = await sourceSnapshot(repoRoot)

await rm(distributionRoot, { recursive: true, force: true })
await mkdir(macosRoot, { recursive: true })
await mkdir(resourcesRoot, { recursive: true })

await compileNativeShell()
await writeInfoPlist()
await copyAppIcon()
await bundleServer()
await copyWebApp()
await copyNodeRuntime()
await bundleCli()
await writeDistributionReadme()
await copyLegalNotices()
await signEmbeddedRuntime()
await adHocSignApp()
await assertPackagedRuntime(appResources.server)
await verifyCodeSignature(appBundle)
const standalone = await verifyStandaloneDistribution({
  distributionRoot,
  expectedVersion: packageJson.version,
  forbiddenPaths: [repoRoot],
})
const { manifest } = await writeBuildManifest({
  repoRoot,
  distributionRoot,
  version: packageJson.version,
  source: packagingSource,
})
await verifyBuildManifest({ repoRoot, distributionRoot, version: packageJson.version })

console.log(`Packaged ${distributionName}`)
console.log(appBundle)
console.log(`Source hash: ${manifest.source.hash}`)
console.log(`Artifact hash: ${manifest.artifact.hash}`)
console.log(`Standalone runtime: ${standalone.nodeVersion}, macOS ${standalone.minimumSystemVersion}+, ${standalone.dylibCount} bundled dylibs, ${standalone.startupMs.toFixed(1)} ms clean startup`)

async function bundleServer() {
  await mkdir(appResources.server, { recursive: true })
  await writeFile(
    join(appResources.server, 'package.json'),
    `${JSON.stringify({ private: true, type: 'module' }, null, 2)}\n`,
  )

  const rolldownCli = join(repoRoot, 'node_modules', 'rolldown', 'bin', 'cli.mjs')
  await assertFile(rolldownCli, 'Missing Rolldown. Run npm install before packaging.')

  await execFileAsync(process.execPath, [
    rolldownCli,
    join(repoRoot, 'server', 'vigo-api.mjs'),
    '--file',
    join(appResources.server, 'vigo-server.mjs'),
    '--format',
    'esm',
    '--platform',
    'node',
  ], { cwd: repoRoot })

  await execFileAsync(process.execPath, [
    rolldownCli,
    join(repoRoot, 'server', 'national-gtfs-worker.mjs'),
    '--file',
    join(appResources.server, 'national-gtfs-worker.mjs'),
    '--format',
    'esm',
    '--platform',
    'node',
  ], { cwd: repoRoot })

  await execFileAsync(process.execPath, [
    rolldownCli,
    join(repoRoot, 'server', 'national-osm-worker.mjs'),
    '--file',
    join(appResources.server, 'national-osm-worker.mjs'),
    '--format',
    'esm',
    '--platform',
    'node',
  ], { cwd: repoRoot })

  await execFileAsync(process.execPath, [
    rolldownCli,
    join(repoRoot, 'server', 'national-route-worker.mjs'),
    '--dir',
    appResources.server,
    '--entryFileNames',
    'national-route-worker.mjs',
    '--chunkFileNames',
    'route-[name]-[hash].mjs',
    '--format',
    'esm',
    '--platform',
    'node',
  ], { cwd: repoRoot })

  await copyFile(
    join(repoRoot, 'native', 'vigo-routing-kernel', 'vigo-routing-kernel.node'),
    join(appResources.server, 'vigo-routing-kernel.node'),
    constants.COPYFILE_FICLONE,
  )
}

async function copyWebApp() {
  await cp(join(repoRoot, 'dist'), appResources.app, {
    mode: constants.COPYFILE_FICLONE,
    force: true,
    recursive: true,
    verbatimSymlinks: true,
  })
}

async function copyNodeRuntime() {
  await mkdir(appResources.bin, { recursive: true })
  await rm(appResources.lib, { recursive: true, force: true })
  await mkdir(appResources.lib, { recursive: true })
  const nodeTarget = join(appResources.bin, 'node')
  const archivePath = await ensureBundledNodeArchive()
  const extractionRoot = await mkdtemp(join(tmpdir(), 'vigo-node-runtime-'))

  try {
    await execFileAsync('/usr/bin/tar', [
      '-xzf',
      archivePath,
      '-C',
      extractionRoot,
      `${bundledNodeRuntime.extractedRoot}/bin/node`,
      `${bundledNodeRuntime.extractedRoot}/LICENSE`,
    ])
    const nodeSource = join(extractionRoot, bundledNodeRuntime.extractedRoot, 'bin', 'node')
    const nodeLicenseSource = join(extractionRoot, bundledNodeRuntime.extractedRoot, 'LICENSE')
    await assertFile(nodeSource, `Official Node archive is missing ${bundledNodeRuntime.extractedRoot}/bin/node.`)
    await assertFile(nodeLicenseSource, `Official Node archive is missing ${bundledNodeRuntime.extractedRoot}/LICENSE.`)
    const { stdout: nodeVersion } = await execFileAsync(nodeSource, ['--version'])
    if (nodeVersion.trim() !== bundledNodeRuntime.version) {
      throw new Error(`Official Node archive reports ${nodeVersion.trim()}, expected ${bundledNodeRuntime.version}.`)
    }
    await copyFile(nodeSource, nodeTarget, constants.COPYFILE_FICLONE)
    await chmod(nodeTarget, 0o755)
    await mkdir(join(distributionRoot, 'licenses'), { recursive: true })
    await copyFile(nodeLicenseSource, join(distributionRoot, 'licenses', 'nodejs-LICENSE'))
  } finally {
    await rm(extractionRoot, { recursive: true, force: true })
  }

  console.log(`Bundled official Node.js ${bundledNodeRuntime.version} LTS (${bundledNodeRuntime.archiveSha256}).`)
}

async function ensureBundledNodeArchive() {
  const suppliedArchive = String(process.env.VIGO_NODE_ARCHIVE ?? '').trim()
  if (suppliedArchive) {
    const archivePath = resolve(suppliedArchive)
    await assertFile(archivePath, `VIGO_NODE_ARCHIVE does not name a file: ${archivePath}`)
    await assertNodeArchiveHash(archivePath)
    return archivePath
  }

  const cacheRoot = join(repoRoot, 'temp', 'runtime-cache')
  const archivePath = join(cacheRoot, bundledNodeRuntime.archiveName)
  await mkdir(cacheRoot, { recursive: true })
  for (const entry of await readdir(cacheRoot)) {
    if (entry === bundledNodeRuntime.archiveName) continue
    if (!entry.startsWith('node-') || (!entry.endsWith('.tar.gz') && !entry.endsWith('.partial'))) continue
    await rm(join(cacheRoot, entry), { force: true })
  }
  if (await archiveMatchesExpectedHash(archivePath)) return archivePath

  await rm(archivePath, { force: true })
  const partialPath = `${archivePath}.${process.pid}.partial`
  await rm(partialPath, { force: true })
  const response = await fetch(bundledNodeRuntime.archiveUrl)
  if (!response.ok) {
    throw new Error(`Unable to download official Node runtime: HTTP ${response.status} ${response.statusText}.`)
  }
  await writeFile(partialPath, Buffer.from(await response.arrayBuffer()))
  try {
    await assertNodeArchiveHash(partialPath)
    await rename(partialPath, archivePath)
  } finally {
    await rm(partialPath, { force: true })
  }
  return archivePath
}

async function archiveMatchesExpectedHash(archivePath) {
  const archiveStats = await stat(archivePath).catch(() => null)
  if (!archiveStats?.isFile()) return false
  return await sha256File(archivePath) === bundledNodeRuntime.archiveSha256
}

async function assertNodeArchiveHash(archivePath) {
  const actualSha256 = await sha256File(archivePath)
  if (actualSha256 !== bundledNodeRuntime.archiveSha256) {
    throw new Error(`Node runtime archive hash mismatch: expected ${bundledNodeRuntime.archiveSha256}, received ${actualSha256}.`)
  }
}

async function bundleCli() {
  const bundledCli = join(appResources.bin, 'vigo.mjs')
  await copyFile(join(repoRoot, 'dist-cli', 'vigo.mjs'), bundledCli, constants.COPYFILE_FICLONE)
  await chmod(bundledCli, 0o755)

  const launcher = `#!/bin/sh
set -eu
release_root="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
export VIGO_NATIVE_ROUTING_KERNEL="$release_root/VIGO.app/Contents/Resources/server/vigo-routing-kernel.node"
exec "$release_root/VIGO.app/Contents/Resources/bin/node" \\
  "$release_root/VIGO.app/Contents/Resources/bin/vigo.mjs" "$@"
`
  const launcherPath = join(distributionRoot, 'vigo')
  await writeFile(launcherPath, launcher)
  await chmod(launcherPath, 0o755)
}

async function compileNativeShell() {
  await execFileAsync('/usr/bin/clang', [
    '-fobjc-arc',
    `-mmacosx-version-min=${macosMinimumVersion}`,
    join(repoRoot, 'scripts', 'macos', 'VigoApp.m'),
    '-framework',
    'Cocoa',
    '-framework',
    'WebKit',
    '-o',
    join(macosRoot, 'VIGO'),
  ], { cwd: repoRoot })
}

async function copyAppIcon() {
  await copyFile(
    join(repoRoot, 'scripts', 'macos', 'VIGO.icns'),
    join(resourcesRoot, 'VIGO.icns'),
    constants.COPYFILE_FICLONE,
  )
}

async function writeInfoPlist() {
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleDisplayName</key>
  <string>VIGO</string>
  <key>CFBundleExecutable</key>
  <string>VIGO</string>
  <key>CFBundleIdentifier</key>
  <string>local.vigo.app</string>
  <key>CFBundleIconFile</key>
  <string>VIGO</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>VIGO</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>${packageJson.version}</string>
  <key>CFBundleVersion</key>
  <string>${packageJson.version}</string>
  <key>LSApplicationCategoryType</key>
  <string>public.app-category.productivity</string>
  <key>LSMinimumSystemVersion</key>
  <string>${macosMinimumVersion}</string>
  <key>NSAppTransportSecurity</key>
  <dict>
    <key>NSAllowsLocalNetworking</key>
    <true/>
  </dict>
  <key>NSDocumentsFolderUsageDescription</key>
  <string>VIGO needs access to Documents to read and update your local VIGO project store.</string>
  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
`

  await writeFile(join(contentsRoot, 'Info.plist'), plist)
}

async function writeDistributionReadme() {
  const readme = `# VIGO ${packageJson.version} macOS Standalone

Double-click VIGO.app to run VIGO as a native macOS application.

System requirement: Apple silicon Mac running macOS ${macosMinimumVersion} or newer.

This distribution bundles:

- the built VIGO GTFS operations workbench
- the local VIGO API server
- the official Node.js ${bundledNodeRuntime.version} LTS arm64 runtime, verified by SHA-256
- the canonical VIGO routing CLI

External language bindings can integrate through the versioned CLI schemas.
This archive contains the VIGO engine and does not bundle a language-specific
client package.

CLI example:

./vigo route --store=/path/to/feed.sqlite --od=/path/to/od.csv --out=/path/to/routes.csv --json-out=/path/to/routes.json --service-date=2026-07-16

Raw network example:

./vigo build-network --osm-pbf=/path/to/region.osm.pbf --gtfs=/path/to/feed.zip --output-dir=/path/to/network

Direct bundled Node.js example:

./VIGO.app/Contents/Resources/bin/node ./VIGO.app/Contents/Resources/bin/vigo.mjs --help

The CLI accepts a VIGO GTFS SQLite store and optional VIGO OSM SQLite street
store. Put multiple ODs in one CSV so startup and active-service preparation
are paid once for the batch.

On first launch, choose a VIGO home folder or use the default:

~/Documents/Vigo Projects

GTFS ZIP import into SQLite, validation, scheduled projections, local OSM PBF
SQLite street indexes, routing, and the offline map canvas run locally. Remote
basemap tiles and GTFS-Realtime retrieval require network.

Release posture:

- local-first workspace storage
- private bundled API runtime
- exact timetable routing only for semantics declared supported in the product contract
- transit directions require exact schedule evidence
- ad-hoc signed macOS app bundle for local distribution
`

  await writeFile(join(distributionRoot, 'README.txt'), readme)
}

async function copyLegalNotices() {
  const licenseRoot = join(distributionRoot, 'licenses')
  await mkdir(licenseRoot, { recursive: true })
  await copyFile(join(repoRoot, 'LICENSE'), join(distributionRoot, 'LICENSE'))
  await copyFile(join(repoRoot, 'NOTICE'), join(distributionRoot, 'NOTICE'))
  await copyFile(
    join(repoRoot, 'native', 'vigo-routing-kernel', 'vendor', 'cch', 'LICENSE'),
    join(licenseRoot, 'cch-LICENSE'),
  )
  await copyFile(
    join(repoRoot, 'native', 'vigo-routing-kernel', 'vendor', 'cch', 'NOTICE'),
    join(licenseRoot, 'cch-NOTICE'),
  )

  const npmLicenseCount = await copyLicenseTree(
    join(repoRoot, 'node_modules'),
    join(licenseRoot, 'npm'),
  )
  if (npmLicenseCount === 0) throw new Error('No npm dependency license files were found after npm ci.')

  const cargo = String(process.env.VIGO_CARGO ?? '').trim()
    || join(homedir(), '.cargo', 'bin', process.platform === 'win32' ? 'cargo.exe' : 'cargo')
  const { stdout } = await execFileAsync(cargo, ['metadata', '--locked', '--format-version', '1'], {
    cwd: join(repoRoot, 'native', 'vigo-routing-kernel'),
    maxBuffer: 16 * 1024 * 1024,
  })
  const metadata = JSON.parse(stdout)
  let cargoLicenseCount = 0
  for (const dependency of metadata.packages) {
    if (dependency.name === 'vigo-routing-kernel') continue
    const packageRoot = dirname(dependency.manifest_path)
    const destination = join(licenseRoot, 'cargo', `${dependency.name}-${dependency.version}`)
    cargoLicenseCount += await copyRootLicenses(packageRoot, destination)
  }
  if (cargoLicenseCount === 0) throw new Error('No Cargo dependency license files were found after cargo build.')
}

function isLicenseFile(name) {
  return /^(?:license|licence|copying|notice)(?:[._-].*)?$/iu.test(name)
}

async function copyRootLicenses(sourceRoot, destinationRoot) {
  const entries = await readdir(sourceRoot, { withFileTypes: true })
  const licenses = entries.filter((entry) => entry.isFile() && isLicenseFile(entry.name))
  if (licenses.length) await mkdir(destinationRoot, { recursive: true })
  for (const entry of licenses) {
    await copyFile(join(sourceRoot, entry.name), join(destinationRoot, entry.name))
  }
  return licenses.length
}

async function copyLicenseTree(sourceRoot, destinationRoot, relativeRoot = '') {
  const entries = await readdir(join(sourceRoot, relativeRoot), { withFileTypes: true })
  let copied = 0
  for (const entry of entries) {
    const relative = join(relativeRoot, entry.name)
    if (entry.isDirectory()) {
      copied += await copyLicenseTree(sourceRoot, destinationRoot, relative)
    } else if (entry.isFile() && isLicenseFile(entry.name)) {
      const target = join(destinationRoot, relative)
      await mkdir(dirname(target), { recursive: true })
      await copyFile(join(sourceRoot, relative), target)
      copied += 1
    }
  }
  return copied
}

async function signEmbeddedRuntime() {
  const files = [
    join(appResources.bin, 'node'),
    join(appResources.server, 'vigo-routing-kernel.node'),
    ...await dylibFiles(appResources.lib),
  ]

  for (const filePath of files) {
    if (await hasValidCodeSignature(filePath)) continue
    await execFileAsync('/usr/bin/codesign', ['--force', '--sign', '-', filePath])
  }
}

async function hasValidCodeSignature(filePath) {
  try {
    await execFileAsync('/usr/bin/codesign', ['--verify', '--strict', filePath])
    return true
  } catch {
    return false
  }
}

async function dylibFiles(folder) {
  const entries = await readdir(folder, { withFileTypes: true })
  const files = []

  for (const entry of entries) {
    const entryPath = join(folder, entry.name)

    if (entry.isDirectory()) {
      files.push(...await dylibFiles(entryPath))
    } else if (entry.isFile() && entry.name.endsWith('.dylib')) {
      files.push(entryPath)
    }
  }

  return files
}

async function adHocSignApp() {
  await execFileAsync('/usr/bin/codesign', ['--force', '--sign', '-', appBundle])
}

async function assertFile(filePath, message) {
  try {
    const fileStats = await stat(filePath)
    if (fileStats.isFile()) return
  } catch {
    // Fall through to the thrown error below.
  }

  throw new Error(message)
}

async function assertCommand(commandPath, message) {
  try {
    await access(commandPath, constants.X_OK)
  } catch {
    throw new Error(message)
  }
}
