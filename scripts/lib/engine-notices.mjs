import { execFile } from 'node:child_process'
import { readFile, readdir, realpath, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

export async function engineNotices(root, rustTarget) {
  const sections = ['VIGO Engine third-party license notices\n']
  async function collect(directory, name, version, license) {
    sections.push(`\n${name} ${version} (${license || 'see license text'})\n`)
    for (const file of (await readdir(directory)).sort()) {
      if (!/^(?:licen[cs]e|copying|notice)/i.test(file)) continue
      const location = path.join(directory, file)
      if ((await stat(location)).isFile()) sections.push(await readFile(location, 'utf8'))
    }
  }
  const seen = new Set()
  async function npm(name, parent) {
    let directory = parent
    let location
    while (true) {
      const candidate = path.join(directory, 'node_modules', name)
      try { await stat(path.join(candidate, 'package.json')); location = await realpath(candidate); break }
      catch { /* Resolve transitive modules through their parent directories. */ }
      const next = path.dirname(directory)
      if (next === directory) throw new Error(`Missing license metadata for ${name}.`)
      directory = next
    }
    if (seen.has(location)) return
    seen.add(location)
    const metadata = JSON.parse(await readFile(path.join(location, 'package.json'), 'utf8'))
    await collect(location, name, metadata.version, metadata.license)
    for (const dependency of Object.keys(metadata.dependencies ?? {}).sort()) await npm(dependency, location)
  }
  // These are the bundled CLI's runtime dependencies, including import/build.
  // HTTP uses only Node built-ins and the same resident CLI protocol.
  for (const dependency of ['jszip', 'papaparse', 'pbf']) await npm(dependency, root)
  const cargo = process.env.VIGO_CARGO || path.join(os.homedir(), '.cargo', 'bin', process.platform === 'win32' ? 'cargo.exe' : 'cargo')
  const result = await run(cargo, ['metadata', '--locked', '--offline', '--filter-platform', rustTarget, '--format-version=1'], {
    cwd: path.join(root, 'native', 'vigo-routing-kernel'), timeout: 60000, maxBuffer: 16 * 1024 * 1024,
  })
  const metadata = JSON.parse(result.stdout)
  for (const entry of metadata.packages.sort((a, b) => `${a.name}:${a.version}`.localeCompare(`${b.name}:${b.version}`))) {
    if (entry.name !== 'vigo-routing-kernel') await collect(path.dirname(entry.manifest_path), entry.name, entry.version, entry.license)
  }
  return sections.join('\n')
}
