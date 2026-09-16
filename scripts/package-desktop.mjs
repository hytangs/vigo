import { packager } from '@electron/packager'
import { constants } from 'node:fs'
import { access, copyFile, cp, lstat, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { studioPaths } from './lib/studio-paths.mjs'
import { auditPackageFiles } from './lib/package-audit.mjs'

const execFileAsync = promisify(execFile)
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const packageJson = JSON.parse(await readFile(path.join(repositoryRoot, 'package.json'), 'utf8'))
const electronVersion = String(packageJson.devDependencies?.electron ?? '').replace(/^[^\d]*/u, '')
const stagingRoot = path.join(repositoryRoot, 'temp', 'studio-package')
const applicationRoot = path.join(stagingRoot, 'app')
const releaseRoot = process.env.VIGO_RELEASE_ROOT
  ? path.resolve(process.env.VIGO_RELEASE_ROOT)
  : path.join(repositoryRoot, 'release')
const serverRoot = path.join(applicationRoot, 'server')
const packaged = studioPaths(releaseRoot, packageJson.version)

if (!electronVersion) throw new Error('package.json must pin an Electron development dependency.')
await assertFile(path.join(repositoryRoot, 'public', 'index.html'), 'Missing built Studio. Run npm run build first.')
await assertFile(path.join(repositoryRoot, 'public', 'vigo.mjs'), 'Missing built VIGO CLI. Run npm run build first.')
await assertFile(
  path.join(repositoryRoot, 'native', 'vigo-routing-kernel', 'vigo-routing-kernel.node'),
  'Missing VIGO routing kernel. Run npm run build first.',
)
await assertFile(path.join(repositoryRoot, 'public', 'main.mjs'), 'Missing Electron main process.')
await assertFile(path.join(repositoryRoot, 'public', 'preload.cjs'), 'Missing Electron preload.')

await rm(stagingRoot, { force: true, recursive: true })
try {
  await mkdir(applicationRoot, { recursive: true })
  const publicFiles = ['index.html', 'main.mjs', 'preload.cjs', 'vigo.mjs', 'assets', 'agency-skills',
    'favicon.png', 'vigo-mark-dark.png', 'vigo-mark-transparent.png', 'icons/VIGOIcon.png']
  const copies = await Promise.allSettled([
    ...publicFiles.map(async name => {
      const destination = path.join(applicationRoot, 'public', name)
      await mkdir(path.dirname(destination), { recursive: true })
      await cp(path.join(repositoryRoot, 'public', name), destination, { mode: constants.COPYFILE_FICLONE, recursive: true })
    }),
    copyFile(path.join(repositoryRoot, 'LICENSE'), path.join(applicationRoot, 'LICENSE')),
    copyFile(path.join(repositoryRoot, 'NOTICE'), path.join(applicationRoot, 'NOTICE')),
  ])
  // Wait for every copy before cleanup, including when one source is missing.
  const failedCopy = copies.find(result => result.status === 'rejected')
  if (failedCopy) throw failedCopy.reason

  await writeFile(path.join(applicationRoot, 'package.json'), `${JSON.stringify({
    name: 'vigo-agency',
    productName: 'VIGO Agency',
    author: 'VIGO contributors',
    version: packageJson.version,
    private: true,
    type: 'module',
    main: packageJson.main,
  }, null, 2)}\n`)

  await bundleEngine()
  await auditPackageFiles(applicationRoot, { forbiddenRoots: [repositoryRoot] })
  await mkdir(releaseRoot, { recursive: true })
  const applicationPaths = await packager({
    dir: applicationRoot,
    name: 'VIGO Agency',
    platform: process.platform,
    arch: process.arch,
    out: releaseRoot,
    overwrite: true,
    prune: false,
    asar: false,
    electronVersion,
    icon: path.join(repositoryRoot, 'public', 'icons', process.platform === 'darwin' ? 'VIGO.icns' : process.platform === 'win32' ? 'VIGO.ico' : 'VIGOIcon.png'),
    appBundleId: 'app.vigo.agency',
    appCategoryType: 'public.app-category.productivity',
    appVersion: packageJson.version,
    buildVersion: packageJson.version,
    extendInfo: {
      CFBundleDisplayName: 'VIGO Agency',
      LSMinimumSystemVersion: '13.5',
      NSDocumentsFolderUsageDescription: 'VIGO Agency reads and updates the City folders you choose.',
    },
  })

  if (applicationPaths.length !== 1) {
    throw new Error(`Electron packaging returned ${applicationPaths.length} application paths.`)
  }
  await assertFile(packaged.executable, 'Packaged Studio executable is missing.')
  if (process.platform === 'darwin') {
    await execFileAsync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', packaged.application])
    await execFileAsync('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', packaged.application])
  }

  const bytes = await directoryBytes(packaged.application)
  console.log(JSON.stringify({
    status: 'packaged',
    product: 'VIGO Agency',
    version: packageJson.version,
    electron: electronVersion,
    architecture: process.arch,
    transport: 'memory',
    localPort: false,
    bytes,
    platform: process.platform,
    application: packaged.application,
  }, null, 2))
} finally {
  await rm(stagingRoot, { force: true, recursive: true })
}

async function bundleEngine() {
  await mkdir(serverRoot, { recursive: true })
  await cp(path.join(repositoryRoot, 'artifacts', 'replay', 'holding-v1'), path.join(serverRoot, 'replay', 'holding-v1'), { recursive: true })
  const rolldown = path.join(repositoryRoot, 'node_modules', 'rolldown', 'bin', 'cli.mjs')
  await assertFile(rolldown, 'Missing Rolldown. Run npm install first.')
  const bundle = (input, args) => execFileAsync(process.execPath, [rolldown, input, ...args, '--format', 'esm', '--platform', 'node'], {
    cwd: repositoryRoot,
    maxBuffer: 16 * 1024 * 1024,
  })

  await bundle(path.join(repositoryRoot, 'src', 'server', 'vigo-api.mjs'), [
    '--dir', serverRoot,
    '--entryFileNames', 'vigo-api.mjs',
    '--chunkFileNames', 'api-[name].mjs',
  ])
  await bundle(path.join(repositoryRoot, 'src', 'server', 'agency-sql-worker.mjs'), [
    '--file', path.join(serverRoot, 'agency-sql-worker.mjs'),
  ])
  await bundle(path.join(repositoryRoot, 'src', 'server', 'national-gtfs-worker.mjs'), [
    '--file', path.join(serverRoot, 'national-gtfs-worker.mjs'),
  ])
  await bundle(path.join(repositoryRoot, 'src', 'server', 'national-osm-worker.mjs'), [
    '--file', path.join(serverRoot, 'national-osm-worker.mjs'),
  ])
  await bundle(path.join(repositoryRoot, 'src', 'server', 'national-route-worker.mjs'), [
    '--dir', serverRoot,
    '--entryFileNames', 'national-route-worker.mjs',
    '--chunkFileNames', 'route-[name].mjs',
  ])
  await copyFile(
    path.join(repositoryRoot, 'native', 'vigo-routing-kernel', 'vigo-routing-kernel.node'),
    path.join(serverRoot, 'vigo-routing-kernel.node'),
    constants.COPYFILE_FICLONE,
  )
}

async function assertFile(filePath, message) {
  try {
    await access(filePath, constants.R_OK)
    const fileStats = await stat(filePath)
    if (fileStats.isFile()) return
  } catch {
    // The single error below keeps packaging failures concise.
  }
  throw new Error(message)
}

async function directoryBytes(root) {
  let total = 0
  for (const name of await readdir(root)) {
    const entry = path.join(root, name)
    const entryStats = await lstat(entry)
    if (entryStats.isSymbolicLink()) {
      total += entryStats.size
      continue
    }
    if (entryStats.isDirectory()) total += await directoryBytes(entry)
    else if (entryStats.isFile()) total += entryStats.size
  }
  return total
}
