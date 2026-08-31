import fs from 'node:fs'
import path from 'node:path'

export const repositoryRoot = path.resolve(import.meta.dirname, '../..')

export function readCacheRetentionPolicy(root = repositoryRoot) {
  return JSON.parse(fs.readFileSync(
    path.join(root, 'config', 'cache-retention-policy.json'),
    'utf8',
  ))
}

export function isStrictDescendant(parentPath, childPath) {
  const relative = path.relative(path.resolve(parentPath), path.resolve(childPath))
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative)
}

export function resolveRepositoryPath(root, relativePath) {
  if (path.isAbsolute(relativePath)) {
    throw new Error(`Cache policy paths must be relative: ${relativePath}`)
  }
  const resolvedRoot = path.resolve(root)
  const resolvedPath = path.resolve(resolvedRoot, relativePath)
  if (!isStrictDescendant(resolvedRoot, resolvedPath)) {
    throw new Error(`Cache policy path escapes the repository root: ${relativePath}`)
  }
  return resolvedPath
}

export function directoryBytesSync(targetPath) {
  if (!fs.existsSync(targetPath)) return 0
  const stat = fs.lstatSync(targetPath)
  if (stat.isSymbolicLink()) return 0
  if (stat.isFile()) return stat.size
  if (!stat.isDirectory()) return 0
  let total = 0
  for (const entry of fs.readdirSync(targetPath, { withFileTypes: true })) {
    total += directoryBytesSync(path.join(targetPath, entry.name))
  }
  return total
}

function snapshotPath(targetPath) {
  if (!fs.existsSync(targetPath)) return null
  const stat = fs.lstatSync(targetPath)
  return {
    path: targetPath,
    bytes: directoryBytesSync(targetPath),
    mtimeMs: stat.mtimeMs,
    isDirectory: stat.isDirectory(),
  }
}

function immediateChildren(targetPath) {
  if (!fs.existsSync(targetPath) || !fs.statSync(targetPath).isDirectory()) return []
  return fs.readdirSync(targetPath, { withFileTypes: true })
    .map((entry) => snapshotPath(path.join(targetPath, entry.name)))
    .filter(Boolean)
}

function isAncestor(ancestorPath, descendantPath) {
  return ancestorPath === descendantPath || isStrictDescendant(ancestorPath, descendantPath)
}

function uniquePlans(plans) {
  const ordered = [...plans].sort((left, right) => (
    left.path.length - right.path.length || left.path.localeCompare(right.path)
  ))
  const selected = []
  for (const plan of ordered) {
    if (selected.some((existing) => isAncestor(existing.path, plan.path))) continue
    selected.push(plan)
  }
  return selected
}

function planRemoval(plans, candidate, reason) {
  if (!candidate) return
  plans.push({
    path: candidate.path,
    bytes: candidate.bytes,
    mtimeMs: candidate.mtimeMs,
    reason,
  })
}

function planScope(scope, root, now, plans) {
  const targetPath = resolveRepositoryPath(root, scope.path)
  if (scope.kind === 'retired-path') {
    planRemoval(plans, snapshotPath(targetPath), scope.reason)
    return
  }
  if (scope.kind === 'prune-children') {
    const keep = new Set(scope.keep ?? [])
    for (const child of immediateChildren(targetPath)) {
      if (!keep.has(path.basename(child.path))) planRemoval(plans, child, scope.reason)
    }
    return
  }
  if (scope.kind === 'ttl-root') {
    const target = snapshotPath(targetPath)
    const cutoff = now - Number(scope.maxAgeDays) * 24 * 60 * 60 * 1000
    if (target && target.mtimeMs < cutoff) planRemoval(plans, target, scope.reason)
    return
  }
  if (scope.kind !== 'ttl-and-budget') {
    throw new Error(`Unsupported cache-retention scope kind: ${scope.kind}`)
  }
  const children = immediateChildren(targetPath)
  const cutoff = now - Number(scope.maxAgeDays) * 24 * 60 * 60 * 1000
  const stale = children.filter((child) => child.mtimeMs < cutoff)
  for (const child of stale) planRemoval(plans, child, `${scope.reason} Older than ${scope.maxAgeDays} days.`)
  let remainingBytes = children.reduce((sum, child) => sum + child.bytes, 0)
    - stale.reduce((sum, child) => sum + child.bytes, 0)
  if (remainingBytes <= Number(scope.maxBytes)) return
  const stalePaths = new Set(stale.map((child) => child.path))
  for (const child of children
    .filter((candidate) => !stalePaths.has(candidate.path))
    .sort((left, right) => left.mtimeMs - right.mtimeMs || left.path.localeCompare(right.path))) {
    if (remainingBytes <= Number(scope.maxBytes)) break
    planRemoval(plans, child, `${scope.reason} Oldest entries removed to enforce the byte budget.`)
    remainingBytes -= child.bytes
  }
}

function budgetReport(budget, root, plans) {
  const targetPath = resolveRepositoryPath(root, budget.path)
  const currentBytes = directoryBytesSync(targetPath)
  const removedBytes = uniquePlans(plans)
    .filter((plan) => isAncestor(targetPath, plan.path))
    .reduce((sum, plan) => sum + plan.bytes, 0)
  const projectedBytes = Math.max(0, currentBytes - removedBytes)
  const maxBytes = Number(budget.maxBytes)
  const reserveBytes = Number(budget.reserveBytes ?? 0)
  return {
    id: budget.id,
    path: budget.path,
    currentBytes,
    projectedBytes,
    maxBytes,
    reserveBytes,
    overBudget: projectedBytes > maxBytes,
    insufficientHeadroom: projectedBytes + reserveBytes > maxBytes,
  }
}

export function planCacheCleanup(policy, {
  root = repositoryRoot,
  now = Date.now(),
  scopeIds = null,
} = {}) {
  const selectedScopeIds = scopeIds ? new Set(scopeIds) : null
  const scopes = (policy.scopes ?? []).filter((scope) => (
    !selectedScopeIds || selectedScopeIds.has(scope.id)
  ))
  if (selectedScopeIds) {
    const knownScopeIds = new Set((policy.scopes ?? []).map((scope) => scope.id))
    for (const scopeId of selectedScopeIds) {
      if (!knownScopeIds.has(scopeId)) throw new Error(`Unknown cache-retention scope: ${scopeId}`)
    }
  }
  const plans = []
  for (const scope of scopes) planScope(scope, root, now, plans)
  const unique = uniquePlans(plans)
  return {
    plans: unique,
    budgets: (policy.budgets ?? []).map((budget) => budgetReport(budget, root, unique)),
  }
}

export function applyCacheCleanup(plans, root = repositoryRoot) {
  for (const plan of uniquePlans(plans)) {
    const resolvedPath = path.resolve(plan.path)
    if (!isStrictDescendant(root, resolvedPath)) {
      throw new Error(`Refusing to remove a path outside the repository root: ${resolvedPath}`)
    }
    fs.rmSync(resolvedPath, { recursive: true, force: true })
  }
}
