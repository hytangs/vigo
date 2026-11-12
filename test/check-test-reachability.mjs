// Every test/check-* file must run in Release, or be listed below with the
// reason it does not. Release's verification is the scripts its workflows
// invoke: npm scripts, the named suites of scripts/run-checks.mjs, and
// direct `node`/`python` invocations, followed transitively.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const scripts = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).scripts
const suites = JSON.parse(fs.readFileSync(path.join(root, 'scripts/check-suites.json'), 'utf8'))
const workflows = ['ci.yml', 'release.yml'].map(name => fs.readFileSync(path.join(root, '.github/workflows', name), 'utf8'))

// Checks that deliberately do not gate a release, with the reason.
export const nonGating = {
}

const reached = new Set()
const seenScripts = new Set()
const testPath = /\b(?:node|python3?)\s+((?:test|scripts)\/[\w./-]+\.(?:mjs|py))/g
function visitCommand(command) {
  for (const [, name] of command.matchAll(/npm run ([\w:-]+)/g)) visitScript(name)
  for (const [, name] of command.matchAll(/scripts\/run-checks\.mjs ([\w:-]+)/g)) {
    assert(suites[name], `Unknown check suite ${name}`)
    for (const file of suites[name]) reached.add(file)
  }
  for (const [, file] of command.matchAll(testPath)) reached.add(file)
}
function visitScript(name) {
  if (seenScripts.has(name)) return
  seenScripts.add(name)
  assert(scripts[name], `Release invokes a missing npm script: ${name}`)
  visitCommand(scripts[name])
}
for (const workflow of workflows) {
  for (const line of workflow.split('\n')) visitCommand(line.replace(/working-directory:.*/, ''))
}
// Python workflow steps run from python/; their paths are relative to it.
for (const workflow of workflows) {
  for (const [, file] of workflow.matchAll(/python\s+(scripts\/[\w./-]+\.py)/g)) reached.add(`python/${file}`)
}

// A reached check can run others itself (check-standalone-docs runs its
// portability check); follow those references transitively.
const pending = [...reached]
while (pending.length) {
  const file = pending.pop()
  const source = path.join(root, file)
  if (!file.startsWith('test/') || !fs.existsSync(source)) continue
  for (const [, name] of fs.readFileSync(source, 'utf8').matchAll(/['"`](?:test\/)?(check-[\w-]+\.(?:mjs|py))['"`]/g)) {
    const nested = `test/${name}`
    if (!reached.has(nested) && fs.existsSync(path.join(root, nested))) {
      reached.add(nested)
      pending.push(nested)
    }
  }
}

const checks = fs.readdirSync(path.join(root, 'test'))
  .filter(name => /^check-.*\.(mjs|py)$/.test(name))
  .map(name => `test/${name}`)
const missing = checks.filter(file => !reached.has(file) && !Object.hasOwn(nonGating, file))
const stale = Object.keys(nonGating).filter(file => reached.has(file) || !checks.includes(file))
assert.deepEqual(missing, [], `Checks no Release step runs; wire them in or list them in nonGating with a reason:\n${missing.join('\n')}`)
assert.deepEqual(stale, [], `nonGating entries that Release runs or that no longer exist:\n${stale.join('\n')}`)
console.log(`Test reachability passed: ${checks.length} checks, ${checks.length - Object.keys(nonGating).length} run by Release, ${Object.keys(nonGating).length} documented as non-gating.`)
