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
  return async function withRetiredRouting({ files = [], cities = [] }, mutate = async () => {}) {
    const fences = await Promise.allSettled([
      ...files.flatMap(file => [nativeRuntime.retire(file, { hold: true }), routeWorkerPool.retire(file, { hold: true })]),
      ...cities.flatMap(root => [nativeRuntime.retireCity(root, { hold: true }), routeWorkerPool.retire(root, { hold: true })]),
    ])
    try {
      const failure = fences.find(fence => fence.status === 'rejected')
      if (failure) throw failure.reason
      return await mutate()
    } finally {
      for (const fence of fences) if (fence.status === 'fulfilled') fence.value()
    }
  }
}
