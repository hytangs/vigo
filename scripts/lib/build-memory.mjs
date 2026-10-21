import os from 'node:os'

const GiB = 1024 ** 3

// Node's libuv-backed limits account for Linux cgroups, including containers.
// Zero means unknown. Available memory also catches pressure on larger hosts.
export function buildMemoryEnvironment(env = process.env, {
  total = os.totalmem(),
  constrained = process.constrainedMemory?.() ?? 0,
  available = process.availableMemory?.() ?? 0,
} = {}, report = console.error) {
  const mode = env.VIGO_BUILD_MEMORY ?? 'auto'
  if (!['auto', 'low', 'full'].includes(mode)) {
    throw new Error('VIGO_BUILD_MEMORY must be auto, low, or full')
  }
  const limits = [total, constrained, available].filter(n => Number.isFinite(n) && n > 0)
  const budget = limits.length ? Math.min(...limits) : undefined
  const low = mode === 'low' || (mode === 'auto' && budget !== undefined && budget <= 4 * GiB)
  if (!low) return { ...env }
  report(`[vigo build] Low-memory compilation${budget === undefined ? '' : ` (${(budget / GiB).toFixed(2)} GiB available/limited)`}: one job, 16 codegen units, LTO disabled. Runtime performance may differ; VIGO_BUILD_MEMORY=full restores the release profile.`)
  return {
    ...env,
    CARGO_BUILD_JOBS: '1',
    CARGO_INCREMENTAL: '0',
    CARGO_PROFILE_RELEASE_LTO: 'false',
    CARGO_PROFILE_RELEASE_CODEGEN_UNITS: '16',
    CARGO_PROFILE_RELEASE_DEBUG: '0',
  }
}
