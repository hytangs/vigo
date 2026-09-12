import { access, mkdir, readFile, rm } from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { studioPaths } from './lib/studio-paths.mjs'

const execFileAsync = promisify(execFile)
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const packageJson = JSON.parse(await readFile(path.join(repositoryRoot, 'package.json'), 'utf8'))
const releaseRoot = process.env.VIGO_RELEASE_ROOT
  ? path.resolve(process.env.VIGO_RELEASE_ROOT)
  : path.join(repositoryRoot, 'release')
const packaged = studioPaths(releaseRoot, packageJson.version)
const appBundle = packaged.application
const archivePath = packaged.archive

await access(appBundle, constants.R_OK).catch(() => {
  throw new Error('Missing VIGO Studio package. Run npm run package:studio first.')
})
await mkdir(releaseRoot, { recursive: true })
await rm(archivePath, { force: true })
if (process.platform === 'darwin') await execFileAsync('/usr/bin/ditto', [
  '-c',
  '-k',
  '--sequesterRsrc',
  '--keepParent',
  appBundle,
  archivePath,
])
else if (process.platform === 'linux') await execFileAsync('tar', [
  '-czf', archivePath, '-C', path.dirname(appBundle), path.basename(appBundle),
])
else await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
  'Compress-Archive -LiteralPath $env:VIGO_ARCHIVE_SOURCE -DestinationPath $env:VIGO_ARCHIVE_DESTINATION -CompressionLevel Optimal',
], { env: { ...process.env, VIGO_ARCHIVE_SOURCE: appBundle, VIGO_ARCHIVE_DESTINATION: archivePath } })
console.log(archivePath)
