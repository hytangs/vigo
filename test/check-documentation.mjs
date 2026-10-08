import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { runInNewContext } from 'node:vm'

const root = path.resolve(import.meta.dirname, '..')
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8')
const manifest = JSON.parse(read('package.json'))
const lock = JSON.parse(read('package-lock.json'))
assert.equal(lock.version, manifest.version)
assert.equal(lock.packages?.['']?.version, manifest.version)
assert.equal(manifest.license, 'Apache-2.0')
assert.equal(read('native/vigo-routing-kernel/Cargo.toml').match(/^version = "([^"]+)"/mu)?.[1], manifest.version)
assert.equal(read('native/vigo-routing-kernel/Cargo.lock').match(/name = "vigo-routing-kernel"\nversion = "([^"]+)"/u)?.[1], manifest.version)

function walk(directory) {
  return fs.readdirSync(path.join(root, directory), { withFileTypes: true }).flatMap(entry => {
    // Documentation IDs and links use forward slashes on every host.
    const file = path.posix.join(directory, entry.name)
    return entry.isDirectory() ? walk(file) : [file]
  })
}

for (const file of ['README.md', 'docs/guide.md', 'docs/guide.html', 'LICENSE', 'NOTICE']) {
  assert(fs.existsSync(path.join(root, file)), `Missing documentation: ${file}`)
}
assert(manifest.scripts['docs:build'], 'Missing documentation build command')
for (const file of ['README.md', 'docs/guide.md', 'docs/guide.html']) {
  assert(read(file).includes(`VIGO ${manifest.version}`), `${file} does not identify the current version`)
}

const documents = [
  'README.md', 'CHANGELOG.md', 'SECURITY.md', '.github/CONTRIBUTING.md',
  'src/styles/README.md', 'native/vigo-routing-kernel/UNIFIED_ROUTING_KERNEL.md',
  ...walk('docs').filter(file => /\.(?:md|html)$/u.test(file)),
]
const sources = new Map(documents.map(file => [file, read(file)]))
const anchors = new Map()
for (const [file, source] of sources) {
  const ids = new Set([...source.matchAll(/\bid=["']([^"']+)["']/gu)].map(match => match[1]))
  if (file.endsWith('.md')) {
    const counts = new Map()
    const prose = source.replace(/^```[^\n]*\n[\s\S]*?^```\s*$/gmu, '')
    for (const match of prose.matchAll(/^#{1,6}\s+(.+?)\s*#*$/gmu)) {
      const slug = match[1].toLowerCase().replace(/<[^>]*>/gu, '').replace(/[^\p{L}\p{N}\p{M}_\-\s]/gu, '').replace(/ /gu, '-')
      const count = counts.get(slug) ?? 0
      counts.set(slug, count + 1)
      ids.add(count ? `${slug}-${count}` : slug)
    }
  }
  anchors.set(file, ids)
}

let localLinks = 0, checkedAnchors = 0, scriptReferences = 0
const linkedFiles = new Set(['docs/guide.md'])
for (const [file, source] of sources) {
  // Check examples as well as prose: a documented npm command must still exist.
  for (const match of (file === 'docs/history.md' ? '' : source).matchAll(/\bnpm run ([\w:-]+)/gu)) {
    assert(Object.hasOwn(manifest.scripts, match[1]), `${file} documents an unknown npm script: ${match[1]}`)
    scriptReferences += 1
  }
  const targets = [
    ...[...source.matchAll(/!?\[[^\]]*\]\((<[^>]+>|[^)]+)\)/gu)].map(match => match[1]),
    ...[...source.matchAll(/\b(?:href|src|srcset)=["']([^"']+)["']/gu)].map(match => match[1]),
  ]
  for (let target of targets) {
    target = target.trim().replace(/^<|>$/gu, '').split(/\s+["']/u, 1)[0]
    if (!target || /^(?:[a-z][\w+.-]*:|\/\/)/iu.test(target)) continue
    const [pathname, fragment] = target.split('#', 2)
    const absolute = pathname ? path.resolve(root, path.dirname(file), decodeURIComponent(pathname.split('?')[0])) : path.join(root, file)
    const relative = path.relative(root, absolute).split(path.sep).join('/')
    assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative), `${file} links outside the repository: ${target}`)
    assert(fs.existsSync(absolute), `${file} has a broken local link: ${target}`)
    linkedFiles.add(relative)
    localLinks += 1
    if (fragment && anchors.has(relative)) {
      assert(anchors.get(relative).has(decodeURIComponent(fragment)), `${file} has a broken anchor: ${target}`)
      checkedAnchors += 1
    }
  }
}
// Keep documentation and its media discoverable when pages are consolidated.
for (const file of walk('docs').filter(file => /\.(?:md|html|png|svg)$/u.test(file))) {
  assert(linkedFiles.has(file), `Unlinked documentation or asset: ${file}`)
}
console.log(JSON.stringify({ status: 'passed', documents: documents.length, localLinks, checkedAnchors, scriptReferences }, null, 2))

// The local viewer must retain zero-valued trips and unreachable outcomes separately.
const viewer = { document: { querySelector: () => ({ addEventListener() {} }) } }
runInNewContext(read('scripts/docs-viewer.js'), viewer)
const describe = result => Object.fromEntries(viewer.describePublicResult(result))
const matrix = describe({ schema: 'vigo.matrix.v1', status: 'ok', durationsSeconds: [[0, 60, null]] })
assert.equal(matrix['Reachable pairs'], '2')
assert.equal(matrix['Unreachable pairs'], '1')
assert.equal(matrix['Shortest duration'], '0 s')
assert.equal(describe({ schema: 'vigo.route.v1', status: 'not_found', journey: null }).Journey, 'No journey satisfies this request.')
assert.equal(describe({ schema: 'vigo.reach.v1', status: 'ok', surface: { valuesSeconds: [0, null, 900] } })['Reachable cells'], '2')
assert.equal(describe({ schema: 'vigo.reach.v1', status: 'ok', areas: { type: 'FeatureCollection', features: [] } }).Surface, 'Map areas (raster omitted)')
assert.equal(describe({ schema: 'vigo.error.v1', status: 'error', error: { message: '<script>untrusted</script>' } }).Error, '<script>untrusted</script>')
assert.throws(() => describe({ status: 'ready', rows: [] }), /public VIGO/)
assert.throws(() => describe({ schema: 'vigo.matrix.v1', status: 'ok', durationsSeconds: [[1], [1, 2]] }), /rectangular/)
assert.throws(() => describe({ schema: 'vigo.matrix.v1', status: 'ok', durationsSeconds: [['12']] }), /finite/)
console.log('Result viewer: public outcomes, zero/null cells, map output, and malformed inputs passed.')
