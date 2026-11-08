import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

// GitHub's release API and public download URLs can fail independently. Both
// paths must return the same pinned bytes before replacing a local artifact.
export async function downloadReleaseAsset({ repository, tag, name, destination, sha256 }, fetcher = fetch) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !/^[\w.-]+$/.test(name) || !/^[a-f0-9]{64}$/.test(sha256)) {
    throw new Error('Invalid pinned release asset')
  }
  const api = `https://api.github.com/repos/${repository}/releases`
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN
  const headers = { Accept: 'application/vnd.github+json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }
  const temporary = `${destination}.download-${process.pid}`
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  const errors = []
  for (const source of ['api', 'public']) {
    try {
      let url = `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${name}`
      let downloadHeaders = {}
      if (source === 'api') {
        const metadata = await fetcher(`${api}/tags/${encodeURIComponent(tag)}`, { headers, signal: AbortSignal.timeout(30000) })
        if (!metadata.ok) throw new Error(`Release metadata returned HTTP ${metadata.status}`)
        const asset = (await metadata.json()).assets?.find(item => item.name === name)
        if (!asset || !Number.isSafeInteger(asset.id)) throw new Error('Release asset is missing')
        url = `${api}/assets/${asset.id}`
        downloadHeaders = { ...headers, Accept: 'application/octet-stream' }
      }
      const response = await fetcher(url, { headers: downloadHeaders, signal: AbortSignal.timeout(180000) })
      if (!response.ok || !response.body) throw new Error(`Asset download returned HTTP ${response.status}`)
      const hash = crypto.createHash('sha256')
      await pipeline(Readable.fromWeb(response.body), new Transform({
        transform(chunk, _encoding, callback) { hash.update(chunk); callback(null, chunk) },
      }), fs.createWriteStream(temporary))
      if (hash.digest('hex') !== sha256) throw new Error('Release asset checksum mismatch; pinned hash was not changed')
      fs.renameSync(temporary, destination)
      return destination
    } catch (error) {
      errors.push(`${source}: ${error.message}`)
    } finally {
      fs.rmSync(temporary, { force: true })
    }
  }
  throw new Error(`Cannot download verified ${name}: ${errors.join('; ')}`)
}
