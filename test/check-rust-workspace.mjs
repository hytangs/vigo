// Enforce the extracted crate boundary, then test the canonical implementation.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const cargo = process.env.VIGO_CARGO || path.join(os.homedir(), '.cargo', 'bin', process.platform === 'win32' ? 'cargo.exe' : 'cargo')
const metadata = JSON.parse(execFileSync(cargo, ['metadata', '--locked', '--offline', '--no-deps', '--format-version', '1'], { cwd: root, encoding: 'utf8' }))
assert.equal(metadata.target_directory, path.join(root, 'target'), 'All Rust builds share one target directory')
assert(metadata.packages.some(item => item.name === 'vigo-routing-kernel'), 'The runtime belongs to the workspace')
assert(!fs.existsSync(path.join(root, 'crates/vigo-runtime/Cargo.lock')), 'Do not restore a second Rust lockfile')
const route = metadata.packages.find(item => item.name === 'vigo-route')
assert(route, 'The routing core must be a workspace package')
assert.deepEqual(route.dependencies.filter(item => item.kind !== 'dev').map(item => item.name).sort(), ['serde'],
  'Routing algorithms must not acquire a transport, storage or process-runtime dependency')
const source = path.join(root, 'crates/vigo-route/src')
for (const file of fs.readdirSync(source, { recursive: true }).filter(name => name.endsWith('.rs'))) {
  const code = fs.readFileSync(path.join(source, file), 'utf8')
  assert(!/\bnapi(?:_derive)?::|\bserde_json::(?:Value|json!)|\bstd::(?:fs|env|thread|net)::/.test(code),
    `Routing must receive data and configuration from its caller: ${file}`)
}
for (const args of [
  ['fmt', ...metadata.packages.filter(item => metadata.workspace_members.includes(item.id)).flatMap(item => ['--package', item.name]), '--', '--check'],
  ['test', '--locked', '--workspace'],
  ['clippy', '--locked', '--workspace', '--all-targets', '--', '-D', 'warnings'],
]) execFileSync(cargo, args, { cwd: root, stdio: 'inherit' })
console.log('Rust workspace contracts, algorithms and dependency boundaries passed.')
