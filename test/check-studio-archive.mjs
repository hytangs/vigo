import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import JSZip from 'jszip'
import { studioPaths } from '../scripts/lib/studio-paths.mjs'

const repositoryRoot = path.resolve(import.meta.dirname, '..')
const version = JSON.parse(readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8')).version
const root = mkdtempSync(path.join(os.tmpdir(), 'vigo archive '))
try {
  const releaseRoot = path.join(root, 'release files')
  for (const [platform, architecture, suffix] of [
    ['darwin', 'arm64', 'mac-arm64.zip'],
    ['darwin', 'x64', 'mac-x64.zip'],
    ['linux', 'arm64', 'linux-arm64.tar.gz'],
    ['linux', 'x64', 'linux-x64.tar.gz'],
    ['win32', 'x64', 'windows-x64.zip'],
  ]) {
    assert.equal(path.basename(studioPaths(releaseRoot, version, platform, architecture).archive), `VIGO-Studio-${version}-${suffix}`)
  }
  const packaged = studioPaths(releaseRoot, version)
  const outputFile = path.join(root, 'github-output')
  const env = { ...process.env, VIGO_RELEASE_ROOT: releaseRoot, GITHUB_OUTPUT: outputFile }
  const command = path.join(repositoryRoot, 'scripts/archive-desktop.mjs')
  const run = () => execFileSync(process.execPath, [command], { cwd: root, env, encoding: 'utf8', timeout: 60_000 })

  // Exercise the real OS archiver and CI output, without building Electron first.
  mkdirSync(packaged.application, { recursive: true })
  writeFileSync(path.join(packaged.application, 'fixture.txt'), 'first archive')
  run()
  assert.equal(readFileSync(outputFile, 'utf8'), `archive-path=${packaged.archive}\n`)
  assert(existsSync(packaged.archive), 'The path passed to the uploader must exist')

  // A retry must replace the archive, including its contents.
  writeFileSync(path.join(packaged.application, 'fixture.txt'), 'replacement archive')
  writeFileSync(outputFile, '')
  run()
  const entry = `${path.basename(packaged.application)}/fixture.txt`
  if (process.platform === 'linux') {
    assert.equal(execFileSync('tar', ['-xOzf', packaged.archive, entry], { encoding: 'utf8' }), 'replacement archive')
  } else {
    const zip = await JSZip.loadAsync(readFileSync(packaged.archive))
    assert.equal(await zip.file(entry)?.async('string'), 'replacement archive')
  }
  assert.equal(readFileSync(outputFile, 'utf8'), `archive-path=${packaged.archive}\n`)

  // Missing input must not emit a stale path to an earlier successful archive.
  rmSync(packaged.application, { recursive: true })
  writeFileSync(outputFile, '')
  const missing = spawnSync(process.execPath, [command], { cwd: root, env, encoding: 'utf8', timeout: 60_000 })
  assert.notEqual(missing.status, 0)
  assert.match(missing.stderr, /Missing VIGO Studio package/)
  assert.equal(readFileSync(outputFile, 'utf8'), '')

  const workflow = readFileSync(path.join(repositoryRoot, '.github/workflows/release-check.yml'), 'utf8')
  assert.match(workflow, /id: package\s+run: npm run release:studio/u)
  assert.match(workflow, /path: \$\{\{ steps\.package\.outputs\.archive-path \}\}/u)
  console.log(`Studio archive creation, replacement, and upload path passed on ${process.platform}:${process.arch}.`)
} finally {
  rmSync(root, { recursive: true, force: true })
}
