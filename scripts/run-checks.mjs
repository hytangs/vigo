// Run independent checks sequentially: many fixtures share native caches or
// generated files. Report every failure and wall time without hiding later checks.
import { spawnSync } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import suites from './check-suites.json' with { type: 'json' }
const name = process.argv[2]
if (!Object.hasOwn(suites, name)) throw new Error(`Unknown check suite: ${name}`)
const results = []
for (const file of suites[name]) {
  const started = performance.now()
  const child = spawnSync(process.execPath, [file], { stdio: 'inherit', env: process.env })
  const seconds = (performance.now() - started) / 1000
  const passed = !child.error && child.status === 0
  results.push({ file, passed, seconds })
  console.log(`${passed ? 'PASS' : 'FAIL'} ${file} (${seconds.toFixed(2)}s)`)
  if (child.error) console.error(child.error.message)
  if (child.signal === 'SIGINT' || child.signal === 'SIGTERM') break
}
console.log(`\n${name}: ${results.filter((r) => r.passed).length}/${suites[name].length} passed`)
for (const result of results.filter((r) => !r.passed)) console.error(`FAILED ${result.file}`)
process.exitCode = results.length === suites[name].length && results.every((r) => r.passed) ? 0 : 1
