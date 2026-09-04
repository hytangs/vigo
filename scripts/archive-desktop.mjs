import { access, mkdir, readFile, rm } from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const packageJson = JSON.parse(await readFile(path.join(repositoryRoot, 'package.json'), 'utf8'))
const releaseRoot = process.env.VIGO_RELEASE_ROOT
  ? path.resolve(process.env.VIGO_RELEASE_ROOT)
  : path.join(repositoryRoot, 'release')
const architecture = process.arch === 'arm64' ? 'arm64' : 'x64'
const appBundle = path.join(releaseRoot, `VIGO Studio-darwin-${architecture}`, 'VIGO Studio.app')
const archivePath = path.join(releaseRoot, `VIGO-Studio-${packageJson.version}-mac-${architecture}.zip`)

await access(appBundle, constants.R_OK).catch(() => {
  throw new Error('Missing VIGO Studio.app. Run npm run package:studio first.')
})
await mkdir(releaseRoot, { recursive: true })
await rm(archivePath, { force: true })
await execFileAsync('/usr/bin/ditto', [
  '-c',
  '-k',
  '--sequesterRsrc',
  '--keepParent',
  appBundle,
  archivePath,
])
console.log(archivePath)
