import path from 'node:path'
import { startCityCompiler } from './runtime/city-compiler.mjs'

/**
 * Add only the optional place-name tables to an existing street store; never
 * rebuild or replace routing data. The `vigo` executable reads the PBF twice,
 * requires both passes to match the store's source fingerprint, and commits
 * the tables and their receipt in one transaction, so a failure or
 * cancellation leaves the City unchanged. A complete index is left as it is.
 */
export async function backfillPlaceNames({ streetPath, pbfPath, signal, onProgress }) {
  signal?.throwIfAborted()
  const { child, outcome } = startCityCompiler('_backfill-place-names', [
    `--street-store=${path.resolve(streetPath)}`,
    `--osm=${path.resolve(pbfPath)}`,
    '--progress=json',
  ], { label: 'Place-name backfill', onProgress })
  const stop = () => child.kill()
  signal?.addEventListener('abort', stop, { once: true })
  try {
    const settled = await outcome
    if (settled.error) {
      signal?.throwIfAborted()
      throw settled.error
    }
    return settled.result
  } finally {
    signal?.removeEventListener('abort', stop)
  }
}
