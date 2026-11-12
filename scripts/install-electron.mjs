import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { downloadArtifact } from '@electron/get'
import { electronDownload } from './lib/electron-download.mjs'

const root = path.resolve(import.meta.dirname, '..')
const electron = path.join(root, 'node_modules/electron')
const { version } = JSON.parse(fs.readFileSync(path.join(electron, 'package.json')))
// Populate the official downloader's cache, retaining the checksum supplied by
// the locked Electron npm package. Its normal installer then uses those bytes.
// Release downloads fail transiently on CI hosts; try three times.
for (let attempt = 1; ; attempt += 1) {
  try {
    await downloadArtifact({
      version, artifactName: 'electron', platform: process.platform, arch: process.arch, ...electronDownload,
    })
    break
  } catch (error) {
    if (attempt === 3) throw error
    console.error(`Electron download failed (${error instanceof Error ? error.message : error}); retrying.`)
    await new Promise(resolve => setTimeout(resolve, 2000 * attempt))
  }
}
execFileSync(process.execPath, [path.join(electron, 'install.js')], { stdio: 'inherit' })
