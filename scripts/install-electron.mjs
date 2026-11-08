import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { downloadArtifact } from '@electron/get'
import { downloadReleaseAsset } from './lib/github-release-asset.mjs'

const root = path.resolve(import.meta.dirname, '..')
const electron = path.join(root, 'node_modules/electron')
const { version } = JSON.parse(fs.readFileSync(path.join(electron, 'package.json')))
const checksums = JSON.parse(fs.readFileSync(path.join(electron, 'checksums.json')))
const name = `electron-v${version}-${process.platform}-${process.arch}.zip`
// Populate the official downloader's cache, retaining the checksum supplied by
// the locked Electron npm package. Its normal installer then uses those bytes.
await downloadArtifact({
  version, artifactName: 'electron', platform: process.platform, arch: process.arch, checksums,
  downloader: { download: (_url, destination) => downloadReleaseAsset({
    repository: 'electron/electron', tag: `v${version}`, name, destination, sha256: checksums[name],
  }) },
})
execFileSync(process.execPath, [path.join(electron, 'install.js')], { stdio: 'inherit' })
