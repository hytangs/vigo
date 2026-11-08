// Publishes a City in this process and SIGKILLs it at a chosen step, so recovery
// is tested against what a real crash leaves on disk.
import fs from 'node:fs'
import path from 'node:path'
import { createCityStagingDirectory, publishCity } from '../../src/city.mjs'

const [template, output, marker, crashAt] = process.argv.slice(2)
const crash = () => process.kill(process.pid, 'SIGKILL')
const { renameSync, rmSync } = fs
let renames = 0
fs.renameSync = (from, to) => {
  renameSync(from, to)
  renames += 1
  if (crashAt === 'between-renames' && renames === 1) crash()
  if (crashAt === 'after-publish' && renames === 2) crash()
}
fs.rmSync = (target, options) => {
  if (crashAt === 'during-removal') {
    rmSync(path.join(target, 'network.json'))
    crash()
  }
  rmSync(target, options)
}

const staged = createCityStagingDirectory(output)
fs.cpSync(template, staged, { recursive: true })
fs.writeFileSync(path.join(staged, 'network.json'), JSON.stringify({ schemaVersion: 'vigo.city.v1', marker }))
publishCity(staged, output, { replace: true })
throw new Error(`Publication finished without reaching the ${crashAt} crash point.`)
