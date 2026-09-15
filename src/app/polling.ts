/** One request at a time, only while visible. Callers report their own errors. */
export function startPolling(
  read: (signal: AbortSignal) => Promise<unknown>,
  intervalMs: number,
  { immediate = true } = {},
) {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let pending: Promise<void> | null = null

  const refresh = (): Promise<void> => {
    if (controller.signal.aborted || document.hidden) return Promise.resolve()
    if (pending) return pending
    clearTimeout(timer)
    pending = Promise.resolve().then(() => {
      if (!controller.signal.aborted) return read(controller.signal)
    }).then(() => {}, () => {}).finally(() => {
      pending = null
      if (!controller.signal.aborted && !document.hidden) timer = setTimeout(refresh, intervalMs)
    })
    return pending
  }
  const onVisibility = () => {
    clearTimeout(timer)
    if (!document.hidden) void refresh()
  }
  document.addEventListener('visibilitychange', onVisibility)
  if (immediate) void refresh()
  else if (!document.hidden) timer = setTimeout(refresh, intervalMs)

  return {
    refresh,
    stop() {
      controller.abort()
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibility)
    },
  }
}
