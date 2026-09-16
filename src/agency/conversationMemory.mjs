// Working context is disposable; the notebook remains the full conversation.
// Keep a contiguous recent tail so an expired/omitted turn cannot resurrect an
// older clarification. Limits are characters, not claims about model tokens.
export function workingConversation(history, now) {
  const retained = []
  let size = 0
  for (let index = history.length - 1; index >= 0 && retained.length < 4; index--) {
    const item = history[index]
    if (item.privateContext) break
    const observedAt = Date.parse(item.observedAt)
    if (Number.isFinite(now) && Number.isFinite(observedAt) && now - observedAt > 30 * 60_000) break
    const recent = retained.length < 2
    const entry = { ...item, answer: String(item.answer ?? '').slice(0, recent ? 2000 : 600),
      findings: recent ? item.findings : undefined, requests: recent ? item.requests : undefined,
      pendingJourney: retained.length === 0 ? item.pendingJourney : undefined }
    const length = JSON.stringify(entry).length
    if (size + length > 24_000) {
      entry.findings = undefined
      entry.requests = undefined
      if (size + JSON.stringify(entry).length > 24_000) break
    }
    size += JSON.stringify(entry).length
    retained.unshift(entry)
  }
  return retained
}
