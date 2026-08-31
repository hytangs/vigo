#!/usr/bin/env node

import path from 'node:path'
import {
  applyCacheCleanup,
  planCacheCleanup,
  readCacheRetentionPolicy,
  repositoryRoot,
} from './lib/cache-retention.mjs'

const apply = process.argv.includes('--apply')
const check = process.argv.includes('--check')
if (apply && check) throw new Error('Choose either --apply or --check, not both.')

const scopeArgument = process.argv.find((argument) => argument.startsWith('--scope='))
const scopeValue = scopeArgument?.slice('--scope='.length) ?? 'all'
const scopeIds = scopeValue === 'all' ? null : scopeValue.split(',').map((value) => value.trim()).filter(Boolean)
const policy = readCacheRetentionPolicy(repositoryRoot)
const result = planCacheCleanup(policy, { root: repositoryRoot, scopeIds })

if (apply) applyCacheCleanup(result.plans, repositoryRoot)

const violations = result.budgets.filter((budget) => (
  budget.overBudget || budget.insufficientHeadroom
))
const report = {
  schemaVersion: 'vigo.cache-cleanup.v1',
  mode: apply ? 'apply' : check ? 'check' : 'dry-run',
  policy: path.relative(repositoryRoot, path.join(repositoryRoot, 'config', 'cache-retention-policy.json')),
  scopes: scopeIds ?? (policy.scopes ?? []).map((scope) => scope.id),
  plannedCount: result.plans.length,
  plannedBytes: result.plans.reduce((sum, plan) => sum + plan.bytes, 0),
  planned: result.plans.map((plan) => ({
    path: path.relative(repositoryRoot, plan.path),
    bytes: plan.bytes,
    lastModified: new Date(plan.mtimeMs).toISOString(),
    reason: plan.reason,
  })),
  budgets: result.budgets,
  violations,
}
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)

if ((check && (result.plans.length || violations.length)) || (apply && violations.length)) {
  process.exitCode = 1
}
