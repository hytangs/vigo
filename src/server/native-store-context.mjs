import { DatabaseSync } from 'node:sqlite'
import { currentStreetStoreStorageIdentity, routingSemanticsFromMetadata, sqliteStoreStatSignature } from './gtfs/store-metadata.mjs'
import { readerBusyTimeoutMs } from './sqlite-readers.mjs'

// What Studio's plans report about a routing store: its zone and data semantics.
const nativeStoreContextCache = new Map()

export function nativeStoreContext(storePath, streetPath) {
  const streetIdentity = streetPath ? currentStreetStoreStorageIdentity(streetPath) : null
  const key = `${storePath}\u0000${sqliteStoreStatSignature(storePath)}\u0000${streetIdentity ?? ''}`
  const cached = nativeStoreContextCache.get(key)
  if (cached) return cached
  const db = new DatabaseSync(storePath, { readOnly: true, timeout: readerBusyTimeoutMs })
  let context
  try {
    const metadata = Object.fromEntries(db.prepare('SELECT key, value FROM metadata').all().map(({ key: name, value }) => {
      try { return [name, JSON.parse(value)] } catch { return [name, value] }
    }))
    const permissions = db.prepare("SELECT 1 AS ready FROM sqlite_master WHERE type = 'table' AND name = 'connection_permissions'").get()
    const { routingDataSemantics } = routingSemanticsFromMetadata(metadata, permissions?.ready === 1)
    context = {
      timeZone: metadata.agencyTimezones?.[0] || 'UTC',
      staticTimetableIdentity: String(routingDataSemantics.sourceFingerprint ?? ''),
      streetIdentity,
      dataSemantics: Object.fromEntries(['blockingFeatures', 'limitations', 'sourceFingerprint', 'transferSemanticsVersion']
        .filter(name => routingDataSemantics[name] !== undefined).map(name => [name, routingDataSemantics[name]])),
    }
  } finally {
    db.close()
  }
  for (const retained of nativeStoreContextCache.keys()) {
    if (retained.startsWith(`${storePath}\u0000`)) nativeStoreContextCache.delete(retained)
  }
  nativeStoreContextCache.set(key, context)
  return context
}

