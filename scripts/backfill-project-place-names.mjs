import fs from 'node:fs/promises'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { backfillPlaceNames } from '../src/server/place-names-backfill.mjs'

const { values } = parseArgs({ options: { city: { type: 'string' }, osm: { type: 'string' }, help: { type: 'boolean' } } })
if (values.help) {
  console.log('Usage: npm run backfill:project:places -- --city=/path/to/City --osm=/path/to/original.osm.pbf\nAdds optional street/area names without rebuilding routing data. The OSM source must match the City fingerprint.')
} else {
  if (!values.city || !values.osm) throw new Error('--city and --osm are required. Run with --help for usage.')
  const cityPath = path.resolve(values.city)
  const project = JSON.parse(await fs.readFile(path.join(cityPath, '.vigo', 'project.json'), 'utf8'))
  if (project.osmStreetIndex?.status !== 'ready') throw new Error('The City must have a ready street index.')
  const controller = new AbortController()
  const cancel = () => controller.abort(new Error('Place-name backfill cancelled.'))
  process.once('SIGINT', cancel)
  process.once('SIGTERM', cancel)
  let lastPhase
  try {
    const result = await backfillPlaceNames({
      streetPath: path.join(cityPath, '.vigo', 'osm', 'street-index.sqlite'),
      pbfPath: path.resolve(values.osm), signal: controller.signal,
      onProgress({ phase }) {
        if (phase !== lastPhase) { console.error(phase); lastPhase = phase }
      },
    })
    console.log(JSON.stringify(result, null, 2))
  } finally {
    process.removeListener('SIGINT', cancel)
    process.removeListener('SIGTERM', cancel)
  }
}
