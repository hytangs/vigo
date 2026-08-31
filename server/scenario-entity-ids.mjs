const uiScopeDelimiter = '::'
const storeScopeDelimiter = '\u001f'

export function scenarioEntityReference(value) {
  const text = String(value ?? '').trim()
  const uiIndex = text.indexOf(uiScopeDelimiter)
  if (uiIndex > 0) {
    const scope = text.slice(0, uiIndex)
    const localId = text.slice(uiIndex + uiScopeDelimiter.length)
    return {
      scope,
      localId,
      storedId: localId ? `${scope}${storeScopeDelimiter}${localId}` : '',
    }
  }

  const storeIndex = text.indexOf(storeScopeDelimiter)
  if (storeIndex > 0) {
    return {
      scope: text.slice(0, storeIndex),
      localId: text.slice(storeIndex + storeScopeDelimiter.length),
      storedId: text,
    }
  }

  return { scope: '', localId: text, storedId: text }
}

export function scenarioEntityCandidates(value) {
  const reference = scenarioEntityReference(value)
  return [...new Set([reference.storedId, reference.localId].filter(Boolean))]
}

export function scenarioEntityMatches(candidate, requested) {
  const left = scenarioEntityReference(candidate)
  const right = scenarioEntityReference(requested)
  if (!left.localId || !right.localId || left.localId !== right.localId) return false
  return !left.scope || !right.scope || left.scope === right.scope
}
