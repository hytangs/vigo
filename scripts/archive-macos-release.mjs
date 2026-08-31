import { cp, lstat, lutimes, mkdtemp, readFile, readdir, rm, stat, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  assertPackagedRuntime,
  buildManifestFileName,
  verifyBuildManifest,
  verifyChecksumFile,
  verifyCodeSignature,
  restoreAndVerifyStandaloneArchive,
  verifyZipArchive,
  writeChecksumFile,
} from './check-macos-release.mjs'

const execFileAsync = promisify(execFile)
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packageJson = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'))
const releaseRoot = process.env.VIGO_RELEASE_ROOT
  ? resolve(process.env.VIGO_RELEASE_ROOT)
  : join(repoRoot, 'release')
const distributionRoot = join(releaseRoot, 'VIGO-mac-arm64')
const appBundle = join(distributionRoot, 'VIGO.app')
const archiveName = `VIGO-${packageJson.version}-mac-arm64.zip`
const archivePath = join(releaseRoot, archiveName)
const checksumPath = `${archivePath}.sha256`

await assertDirectory(appBundle, 'Missing VIGO.app. Run npm run package:macos before archiving.')
await assertFile(join(distributionRoot, 'README.txt'), 'Missing release README.txt. Rebuild the macOS release.')
await assertFile(join(distributionRoot, 'vigo'), 'Missing packaged vigo CLI launcher. Rebuild the macOS release.')
await assertFile(join(distributionRoot, buildManifestFileName), 'Missing BUILD_MANIFEST.json. Rebuild the macOS release.')
const { manifest } = await verifyBuildManifest({
  repoRoot,
  distributionRoot,
  version: packageJson.version,
})
await assertPackagedRuntime(join(appBundle, 'Contents', 'Resources', 'server'))
await verifyCodeSignature(appBundle)

await rm(archivePath, { force: true })
await rm(checksumPath, { force: true })

const archiveStagingRoot = await mkdtemp(join(tmpdir(), 'vigo-release-archive-'))
try {
  const stagedDistributionRoot = join(archiveStagingRoot, 'VIGO-mac-arm64')
  await cp(distributionRoot, stagedDistributionRoot, {
    recursive: true,
    force: true,
    verbatimSymlinks: true,
  })
  const archiveTimestamp = normalizedArchiveTimestamp(manifest.generatedAt)
  await normalizeTreeTimestamps(stagedDistributionRoot, archiveTimestamp)
  await execFileAsync('/usr/bin/ditto', [
    '-c',
    '-k',
    '--norsrc',
    '--noextattr',
    '--noacl',
    '--noqtn',
    '--keepParent',
    stagedDistributionRoot,
    archivePath,
  ], { cwd: archiveStagingRoot })
} finally {
  await rm(archiveStagingRoot, { recursive: true, force: true })
}

const archive = await verifyZipArchive({ archivePath, distributionRoot })
const checksum = await writeChecksumFile(archivePath, checksumPath)
await verifyChecksumFile(archivePath, checksumPath)
const standalone = await restoreAndVerifyStandaloneArchive({
  archivePath,
  distributionRoot,
  expectedVersion: packageJson.version,
  forbiddenPaths: [repoRoot],
})

console.log(`Archived ${archiveName}`)
console.log(archivePath)
console.log(checksumPath)
console.log(`Archive entries: ${archive.entryCount}`)
console.log(`Source hash: ${manifest.source.hash}`)
console.log(`Artifact hash: ${manifest.artifact.hash}`)
console.log(`Archive SHA-256: ${checksum}`)
console.log(`Standalone ZIP runtime: ${standalone.nodeVersion}, macOS ${standalone.minimumSystemVersion}+, ${standalone.dylibCount} bundled dylibs, ${standalone.startupMs.toFixed(1)} ms clean startup`)

function normalizedArchiveTimestamp(value) {
  const parsed = new Date(value)
  const earliestZipTimestamp = new Date('1980-01-01T00:00:00.000Z')
  if (Number.isNaN(parsed.getTime()) || parsed < earliestZipTimestamp) return earliestZipTimestamp
  return parsed
}

async function normalizeTreeTimestamps(targetPath, timestamp) {
  const targetStats = await lstat(targetPath)
  if (targetStats.isDirectory()) {
    const entries = await readdir(targetPath)
    entries.sort((left, right) => left.localeCompare(right))
    for (const entry of entries) await normalizeTreeTimestamps(join(targetPath, entry), timestamp)
    await utimes(targetPath, timestamp, timestamp)
    return
  }
  if (targetStats.isSymbolicLink()) {
    await lutimes(targetPath, timestamp, timestamp)
    return
  }
  await utimes(targetPath, timestamp, timestamp)
}

async function assertDirectory(path, message) {
  const stats = await stat(path).catch(() => null)
  if (!stats?.isDirectory()) throw new Error(message)
}

async function assertFile(path, message) {
  const stats = await stat(path).catch(() => null)
  if (!stats?.isFile()) throw new Error(message)
}
