import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const docsRoot = path.join(root, 'docs')

function repositoryPath(relativePath) {
  const absolutePath = path.resolve(root, relativePath)
  const relative = path.relative(root, absolutePath)
  assert(
    relative && !relative.startsWith('..') && !path.isAbsolute(relative),
    `Path escapes the repository: ${relativePath}`,
  )
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

assert.equal(packageJson.version, '0.3.0', 'Public source version must be 0.3.0.')
assert.equal(packageLock.version, packageJson.version, 'package-lock version drifted.')
assert.equal(packageLock.packages?.['']?.version, packageJson.version, 'package-lock root version drifted.')
assert.equal(packageJson.license, 'Apache-2.0', 'package.json must declare Apache-2.0.')
assert(
  read('server/vigo-api.mjs').includes(`const appVersion = '${packageJson.version}'`),
  'Local API version drifted.',
)

const requiredFiles = [
  'README.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
  'LICENSE',
  'NOTICE',
  'docs/README.md',
  'docs/quickstart.md',
  'docs/gtfs-visualizer.md',
  'docs/routing.md',
  'docs/accessibility.md',
  'docs/guides/use-cases.md',
  'docs/guides/algorithms.md',
  'docs/guides/accessibility-maps.md',
  'docs/tutorials/README.md',
  'docs/tutorials/cli/README.md',
  'docs/development/architecture.md',
  'docs/development/macos-release.md',
  'docs/local-http-api.md',
  'docs/scenario-analysis-architecture.md',
  'docs/street-routing.md',
  'docs/vigo-cli.md',
  'docs/cache-provenance.md',
  'docs/gtfs-support-matrix.md',
  'docs/known-routing-limitations.md',
  'docs/routing-contract.md',
]
for (const relativePath of requiredFiles) {
  assert(fs.existsSync(repositoryPath(relativePath)), `Missing maintained documentation: ${relativePath}`)
}

const readme = read('README.md')
for (const statement of [
  'VIGO—Visual Intelligence for GTFS Operations—is an experimental platform for',
  'inspecting, compiling, routing, and analyzing scheduled public-transit',
  'This repository is the public home of the VIGO',
  'is currently being prepared for public release.',
]) {
  assert(readme.includes(statement), `README is missing the public status statement: ${statement}`)
}
assert(readme.includes('native Rust kernel'), 'README must identify the native Rust routing owner.')
assert(readme.includes('[Apache License 2.0](LICENSE)'), 'README must link the repository license.')

assert(!fs.existsSync(repositoryPath('paper')), 'Publication material must not be present in the public tree.')
assert(!fs.existsSync(repositoryPath('docs/release_nodes')), 'Private release history must not be present.')
assert(!fs.existsSync(repositoryPath('python')), 'Language bindings must remain outside the Rust-engine repository.')
assert(!fs.existsSync(repositoryPath('docs/tutorials/python')), 'Python-package tutorials do not belong here.')
assert(read('LICENSE').startsWith('Apache License\nVersion 2.0, January 2004'), 'LICENSE is not Apache-2.0.')
assert(
  read('native/vigo-routing-kernel/Cargo.toml').includes(`version = "${packageJson.version}"`)
    && read('native/vigo-routing-kernel/Cargo.toml').includes('license = "Apache-2.0"'),
  'Native crate metadata drifted from the public version or license.',
)

const markdownFiles = [
  repositoryPath('README.md'),
  repositoryPath('CONTRIBUTING.md'),
  repositoryPath('SECURITY.md'),
  ...walk(docsRoot).filter((filePath) => filePath.endsWith('.md')),
]
const forbiddenDocumentation = [
  { pattern: /(?:^|[/(])paper\//imu, label: 'publication-tree path' },
  { pattern: /release_nodes/iu, label: 'private release-history path' },
  { pattern: /\/(?:Users|Volumes)\//u, label: 'local filesystem path' },
  { pattern: /vigo-dev(?:\.git)?/iu, label: 'private development repository' },
]

let linkCount = 0
for (const markdownPath of markdownFiles) {
  const source = fs.readFileSync(markdownPath, 'utf8')
  const displayPath = path.relative(root, markdownPath)
  for (const rule of forbiddenDocumentation) {
    assert(!rule.pattern.test(source), `${displayPath} contains a ${rule.label}.`)
  }

  for (const match of source.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/gu)) {
    let target = match[1].trim()
    if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1)
    target = target.split(/\s+["']/u, 1)[0]
    if (!target || target.startsWith('#') || /^(?:https?:|mailto:)/iu.test(target)) continue
    const fileTarget = decodeURIComponent(target.split('#', 1)[0].split('?', 1)[0])
    if (!fileTarget) continue
    const absoluteTarget = path.resolve(path.dirname(markdownPath), fileTarget)
    const repositoryRelative = path.relative(root, absoluteTarget)
    assert(
      !repositoryRelative.startsWith('..') && !path.isAbsolute(repositoryRelative),
      `${displayPath} links outside the repository: ${target}`,
    )
    assert(fs.existsSync(absoluteTarget), `${displayPath} has a broken local link: ${target}`)
    linkCount += 1
  }
}

console.log(JSON.stringify({
  status: 'passed',
  version: packageJson.version,
  maintainedMarkdownFiles: markdownFiles.length,
  checkedLocalLinks: linkCount,
  publicationMaterialPresent: false,
  privateReleaseHistoryPresent: false,
  pythonPackagePresent: false,
}, null, 2))
