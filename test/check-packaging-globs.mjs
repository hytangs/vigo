import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

// Exercise the packaging tool's resolved dependencies, including nested installs.
const require = createRequire(import.meta.resolve('@electron/packager'))
const { createPackageWithOptions, extractFile, listPackage, statFile, uncacheAll } =
  await import(pathToFileURL(require.resolve('@electron/asar')).href)
const root = await mkdtemp(path.join(os.tmpdir(), 'vigo-packaging-globs-'))
try {
  const source = path.join(root, 'source files'), archive = path.join(root, 'app.asar')
  const files = {
    'main.js': 'export const fixture = true',
    '.settings.json': '{"fixture":true}',
    'assets/icon[1].txt': 'literal brackets',
    'assets/日本語.txt': 'unicode filename',
    'native/kernel.node': 'synthetic native payload',
    'locales/en/message.txt': 'unpacked directory',
  }
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(source, name)
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, content)
  }
  await mkdir(path.join(source, 'ignored'))
  await writeFile(path.join(source, 'ignored', 'private.txt'), 'must not be archived')
  await createPackageWithOptions(source, archive, {
    unpack: '*.node',
    unpackDir: '{locales,translations}',
    globOptions: { ignore: [path.join(source, 'ignored', '**').split(path.sep).join('/')] },
  })
  const entries = listPackage(archive).map(name => name.split(path.sep).join('/'))
  assert.equal(new Set(entries).size, entries.length, 'Archive entries are unique')
  assert(!entries.some(name => name.includes('ignored')), 'Ignored files leaked into the archive')
  for (const [name, content] of Object.entries(files)) {
    assert(entries.includes('/' + name), `Missing packaged file: ${name}`)
    assert.equal(extractFile(archive, name).toString(), content, `Changed packaged file: ${name}`)
  }
  for (const name of ['native/kernel.node', 'locales/en/message.txt']) {
    assert.equal(statFile(archive, name).unpacked, true, `Unpack pattern did not match ${name}`)
    assert.equal(await readFile(path.join(archive + '.unpacked', name), 'utf8'), files[name])
  }
  assert(!statFile(archive, 'main.js').unpacked, 'Ordinary files should remain packed')
} finally {
  uncacheAll()
  await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
}
console.log('Packaging glob compatibility: hidden, Unicode and literal filenames, exclusions, and unpack patterns passed.')
