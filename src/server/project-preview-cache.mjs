import crypto from 'node:crypto'
import fs from 'node:fs/promises'

const schema = 'vigo.studio.preview.v1'
async function identity(storePath, request) {
  const stat = await fs.stat(storePath)
  return JSON.stringify([schema, stat.size, stat.mtimeMs, stat.ctimeMs, request])
}

/** Optional, source-matched display data. Missing/stale caches never require a City rebuild. */
export async function readProjectPreview(storePath, request, build) {
  const source = await identity(storePath, request)
  const scope = crypto.createHash('sha256').update(request.sourceScope || '').digest('hex').slice(0, 16)
  const file = `${storePath}.studio-preview-${scope}.json`
  try {
    const cached = JSON.parse(await fs.readFile(file, 'utf8'))
    if (cached.source === source && cached.preview?.mapPreview
      && Array.isArray(cached.preview.routeMetrics) && Array.isArray(cached.preview.stopMetrics)) return cached.preview
  } catch { /* A display cache is disposable; the prepared database is authoritative. */ }
  const preview = await build(request)
  if (!preview || source !== await identity(storePath, request)) return preview
  const temporary = `${file}.${crypto.randomUUID()}.tmp`
  try {
    await fs.writeFile(temporary, JSON.stringify({ source, preview }))
    await fs.rename(temporary, file)
  } catch { /* A read-only City still opens without a persistent display cache. */ }
  finally { await fs.rm(temporary, { force: true }).catch(() => {}) }
  return preview
}
