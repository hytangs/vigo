/**
 * Studio's single way to retire routing: `withRetiredRouting({ files, cities },
 * mutate)` replaces or removes routing files with both runtimes fenced off
 * them. Every native City and preparation worker reading one of `files`, and
 * every City and store at or beneath one of `cities` (a City root, retired as
 * that City even before it is first published), stops; once their processes
 * have exited `mutate` runs. Requests for them meanwhile (new, waiting or
 * interrupted) wait without failing and run on the new files once `mutate`
 * settles, also when it throws. If a process outlives the retirement deadline
 * nothing is replaced and the call rejects.
 */
export function createRetiredRouting(nativeRuntime, routeWorkerPool) {
  async function retain({ files = [], cities = [] }, holdMs) {
    const options = holdMs === undefined ? { hold: true } : { hold: true, holdMs }
    const fences = await Promise.allSettled([
      ...files.flatMap(file => [nativeRuntime.retire(file, options), routeWorkerPool.retire(file, options)]),
      ...cities.flatMap(root => [nativeRuntime.retireCity(root, options), routeWorkerPool.retire(root, options)]),
    ])
    let released = false
    const release = () => {
      if (released) return
      released = true
      for (const fence of fences) if (fence.status === 'fulfilled') fence.value()
    }
    const failure = fences.find(fence => fence.status === 'rejected')
    if (failure) {
      release()
      throw failure.reason
    }
    return release
  }
  async function withRetiredRouting(scope, mutate = async () => {}) {
    const release = await retain(scope)
    try {
      return await mutate()
    } finally {
      release()
    }
  }
  /**
   * Hold the fence for work that outlives one call, such as an import that
   * rewrites the files in place for minutes: resolves to an idempotent
   * release the owner must call on every way the work ends. It has no hold
   * limit, so nothing reopens the files before the owner is done.
   */
  withRetiredRouting.retain = scope => retain(scope, Infinity)
  return withRetiredRouting
}
