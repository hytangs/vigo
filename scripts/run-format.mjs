import { spawnSync } from 'node:child_process'
import files from './format-scope.json' with { type: 'json' }
const result = spawnSync(process.execPath, ['node_modules/prettier/bin/prettier.cjs', process.argv.includes('--write') ? '--write' : '--check', ...files], { stdio: 'inherit' })
if (result.error) throw result.error
process.exitCode = result.status ?? 1
