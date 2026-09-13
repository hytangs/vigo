import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const docsRoot = path.join(root, 'docs')

function repositoryPath(relativePath) {
  const absolutePath = path.resolve(root, relativePath)
  const relative = path.relative(root, absolutePath)
  assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative))
  return absolutePath
}

function read(relativePath) {
  return fs.readFileSync(repositoryPath(relativePath), 'utf8')
}

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name)
    return entry.isDirectory() ? walk(entryPath) : [entryPath]
  })
}

const packageJson = JSON.parse(read('package.json'))
const packageLock = JSON.parse(read('package-lock.json'))
assert.equal(packageJson.version, '0.3.2')
assert.equal(packageLock.version, packageJson.version)
assert.equal(packageLock.packages?.['']?.version, packageJson.version)
assert.equal(packageJson.license, 'Apache-2.0')

const requiredFiles = [
  'README.md', '.github/CONTRIBUTING.md', 'LICENSE', 'NOTICE',
  'docs/README.md', 'docs/concepts.md', 'docs/quickstart.md',
  'docs/studio.md', 'docs/programmatic.md', 'docs/routing.md', 'docs/matrix.md',
  'docs/reach.md', 'docs/scenarios.md', 'docs/performance.md',
  'docs/gtfs-visualizer.md', 'docs/street-routing.md',
  'docs/gtfs-support-matrix.md', 'docs/known-routing-limitations.md',
  'docs/guides/use-cases.md', 'docs/guides/algorithms.md',
  'docs/development/architecture.md',
  'docs/developer-guide/VIGO-0.3.2-Developer-Guide.tex',
  'docs/developer-guide/vigo-developer-guide.sty',
  'scripts/build-developer-guide.mjs',
]
for (const relativePath of requiredFiles) {
  assert(fs.existsSync(repositoryPath(relativePath)), `Missing documentation: ${relativePath}`)
}

const removedFiles = [
  'docs/accessibility.md', 'docs/local-http-api.md', 'docs/vigo-cli.md',
  'docs/routing-contract.md', 'docs/scenario-analysis-architecture.md',
  'docs/cache-provenance.md', 'docs/tutorials',
  'docs/api-guide', 'scripts/build-api-guide.mjs',
]
for (const relativePath of removedFiles) {
  assert(!fs.existsSync(repositoryPath(relativePath)), `Removed product concept returned: ${relativePath}`)
}

const readme = `${read('README.md')}\n${read('docs/foundation.md')}`
for (const statement of ['Turn city transport data into answers.', 'City → Scenario → Query → Result', 'Route', 'Matrix', 'Reach']) {
  assert(readme.includes(statement), `README is missing: ${statement}`)
}

assert.equal(packageJson.scripts?.['docs:developer-guide'], 'node scripts/build-developer-guide.mjs')
assert.equal(packageJson.scripts?.['docs:api-guide'], undefined)

const developerGuide = read('docs/developer-guide/VIGO-0.3.2-Developer-Guide.tex')
const programmaticGuide = read('docs/programmatic.md')
const developerGuideSource = `${developerGuide}\n${read('docs/developer-guide/vigo-developer-guide.sty')}`
for (const statement of [
  'VIGO 0.3.2 Developer Guide',
  'City $\\longrightarrow$ Scenario?',
  'Every computation returns a Result, not a naked travel time.',
  'Compare is not a fourth Query.',
  '\\section{Command-line reference}',
]) {
  assert(developerGuideSource.includes(statement), `Developer Guide is missing: ${statement}`)
}
for (const removedSurface of ['\\vigotitlepage', '\\tableofcontents', '\\section{VIGO Studio}']) {
  assert(!developerGuide.includes(removedSurface), `Developer Guide retained legacy surface: ${removedSurface}`)
}
assert(!programmaticGuide.includes('Context.run(query)'), 'Programmatic guide retained the obsolete Context API.')
assert(!developerGuide.includes('Context.run(query)'), 'Developer Guide retained the obsolete Context API.')
assert(!/python|VigoError|InvalidQuery|UnsupportedQuery/iu.test(developerGuideSource), 'Python reference belongs in vigo-py.')

const markdownFiles = [repositoryPath('README.md'), repositoryPath('.github/CONTRIBUTING.md'), ...walk(docsRoot).filter((file) => file.endsWith('.md'))]
const forbidden = [
  /```python/iu, /\b(?:city|scenario)\.supports\(/u, /\bone-to-many\b/iu, /\bisochrone\b/iu,
  /\baccessibility analysis\b/iu, /\bbuild-network\b/iu,
  /\broute-ndjson\b/iu, /\bprepare command\b/iu, /\/(?:Users|Volumes)\//u,
]
let linkCount = 0
for (const markdownPath of markdownFiles) {
  const source = fs.readFileSync(markdownPath, 'utf8')
  const displayPath = path.relative(root, markdownPath)
  for (const pattern of forbidden) assert(!pattern.test(source), `${displayPath} contains removed product language.`)
  for (const match of source.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/gu)) {
    let target = match[1].trim()
    if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1)
    target = target.split(/\s+["']/u, 1)[0]
    if (!target || target.startsWith('#') || /^(?:https?:|mailto:)/iu.test(target)) continue
    const fileTarget = decodeURIComponent(target.split('#', 1)[0].split('?', 1)[0])
    if (!fileTarget) continue
    const absoluteTarget = path.resolve(path.dirname(markdownPath), fileTarget)
    assert(fs.existsSync(absoluteTarget), `${displayPath} has a broken link: ${target}`)
    linkCount += 1
  }
}

console.log(JSON.stringify({ status: 'passed', markdownFiles: markdownFiles.length, checkedLocalLinks: linkCount }, null, 2))
