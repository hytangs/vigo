import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { downloadReleaseAsset } from './github-release-asset.mjs'

const require = createRequire(import.meta.url)
const electron = path.dirname(require.resolve('electron/package.json'))
const { version } = JSON.parse(fs.readFileSync(path.join(electron, 'package.json')))
const checksums = JSON.parse(fs.readFileSync(path.join(electron, 'checksums.json')))

// Share the locked package's checksum set between installation and packaging.
// Otherwise Packager re-fetches remote checksums even for a cached archive.
export const electronDownload = {
  checksums,
  downloader: { download: (_url, destination) => {
    const name = `electron-v${version}-${process.platform}-${process.arch}.zip`
    return downloadReleaseAsset({ repository: 'electron/electron', tag: `v${version}`,
      name, destination, sha256: checksums[name] })
  } },
}
