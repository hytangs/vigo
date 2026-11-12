import path from 'node:path'
import { disposeNationalOsmStore } from '../../src/server/national-osm-store.mjs'
import { runCityCompilerSync } from '../../src/server/runtime/city-compiler.mjs'

// Checks that hand-write a source street store prepare its runtime snapshots
// with the `vigo` compiler, as every City and Studio import does.

/** The pedestrian snapshot: `{ ready, accelerated, reason, snapshotStatus, nodeCount, edgeCount, ... }`. */
export function buildWalkSnapshot(storePath) {
  disposeNationalOsmStore(storePath)
  return runCityCompilerSync('_build-walk-store', [`--street-store=${path.resolve(storePath)}`], { label: 'Walk snapshot' })
}

/** The driving snapshot; `native` also builds its drive CCH. */
export function buildDriveSnapshot(storePath, { native = false } = {}) {
  disposeNationalOsmStore(storePath)
  return runCityCompilerSync('_build-drive-store', [
    `--street-store=${path.resolve(storePath)}`, ...(native ? ['--native'] : []),
  ], { label: 'Drive snapshot' })
}
