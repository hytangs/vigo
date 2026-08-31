import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const productionTargets = [
  'server',
  'src',
  'native/vigo-routing-kernel/src',
  'scripts/vigo-cli.ts',
  'scripts/build-cli.mjs',
  'scripts/package-macos-app.mjs',
]
const sourceExtensions = new Set(['.cjs', '.js', '.jsx', '.mjs', '.rs', '.ts', '.tsx'])

// Keep this list intentionally narrow. An entry needs a production reason, not
// merely a desire to silence the guard. Prefer moving fixture-specific values to
// scripts/tests over adding an exception here.
const allowlist = [
  // { file: 'src/example.ts', rule: 'agency-or-place-name', line: 1, reason: 'User-visible standards citation.' },
]

const rules = [
  {
    id: 'absolute-posix-home',
    description: 'developer-specific POSIX home path',
    pattern: /\/(?:Users|home)\/[A-Za-z0-9._-]+(?:\/|\b)/gu,
  },
  {
    id: 'absolute-windows-home',
    description: 'developer-specific Windows home path',
    pattern: /\b[A-Za-z]:\\Users\\[^\\\s'"`]+(?:\\|\b)/gu,
  },
]

async function sourceFiles(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true })
  const files = []
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const absolute = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await sourceFiles(absolute))
    else if (entry.isFile() && sourceExtensions.has(path.extname(entry.name))) files.push(absolute)
  }
  return files
}

function isAllowed(finding) {
  return allowlist.some((entry) => (
    entry.file === finding.file
    && entry.rule === finding.rule
    && (entry.line == null || entry.line === finding.line)
  ))
}

const files = (await Promise.all(productionTargets.map(async (target) => {
  const absolute = path.join(repoRoot, target)
  try {
    const stats = await fs.stat(absolute)
    if (stats.isDirectory()) return await sourceFiles(absolute)
    if (stats.isFile() && sourceExtensions.has(path.extname(absolute))) return [absolute]
    return []
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
}))).flat()

const findings = []
for (const absolute of files) {
  const relative = path.relative(repoRoot, absolute).split(path.sep).join('/')
  const lines = (await fs.readFile(absolute, 'utf8')).split(/\r?\n/u)
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    for (const rule of rules) {
      rule.pattern.lastIndex = 0
      for (const match of lines[lineIndex].matchAll(rule.pattern)) {
        findings.push({
          file: relative,
          line: lineIndex + 1,
          column: (match.index ?? 0) + 1,
          rule: rule.id,
          description: rule.description,
          match: match[0],
        })
      }
    }
  }
}

const allowedFindings = findings.filter(isAllowed)
const violations = findings.filter((finding) => !isAllowed(finding))
const staleAllowlist = allowlist.filter((entry) => !allowedFindings.some((finding) => (
  entry.file === finding.file
  && entry.rule === finding.rule
  && (entry.line == null || entry.line === finding.line)
)))

if (violations.length || staleAllowlist.length) {
  for (const finding of violations) {
    console.error(`${finding.file}:${finding.line}:${finding.column} ${finding.rule}: ${JSON.stringify(finding.match)}`)
  }
  for (const entry of staleAllowlist) {
    console.error(`Stale hardcoding allowlist entry: ${entry.file}:${entry.line ?? '*'} ${entry.rule} (${entry.reason})`)
  }
}

assert.equal(violations.length, 0, 'Production code contains agency-, place-, or machine-specific hardcoding.')
assert.equal(staleAllowlist.length, 0, 'The hardcoding allowlist contains stale entries.')

console.log(JSON.stringify({
  schemaVersion: 'vigo.production-hardcoding-check.v1',
  status: 'pass',
  targets: productionTargets,
  filesScanned: files.length,
  rules: rules.map(({ id, description }) => ({ id, description })),
  allowlistEntries: allowlist.length,
  allowedFindings: allowedFindings.length,
  violations: 0,
}))
