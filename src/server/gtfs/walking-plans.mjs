const serviceAccessAnchorCache = new Map()

// The coordinator clears anchor profiles with the store that owns them.
export function clearServiceAccessAnchors(resolvedStorePath) {
  if (resolvedStorePath === undefined) {
    serviceAccessAnchorCache.clear()
    return
  }
  for (const key of serviceAccessAnchorCache.keys()) {
    if (key.startsWith(`${resolvedStorePath}\u0000`)) serviceAccessAnchorCache.delete(key)
  }
}
