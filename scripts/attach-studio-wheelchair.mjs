// Attach a complete wheelchair City without replacing the ordinary City data.
import fs from 'node:fs/promises'
import path from 'node:path'
import { validateCityDirectory } from '../src/city.mjs'
import { studioWheelchairSelection } from '../src/server/studio-wheelchair.mjs'
const [projectPath, cityPath] = process.argv.slice(2)
if (!projectPath || !cityPath) throw new Error('Usage: node scripts/attach-studio-wheelchair.mjs <Studio-project-directory> <prepared-wheelchair-City>')
const projectDirectory = path.join(path.resolve(projectPath), '.vigo')
const projectFile = path.join(projectDirectory, 'project.json')
const original = await fs.readFile(projectFile, 'utf8')
const project = JSON.parse(original)
const source = path.resolve(cityPath)
validateCityDirectory(source)
const staging = await fs.mkdtemp(path.join(projectDirectory, '.wheelchair-staging-'))
try {
  await fs.cp(source, path.join(staging, 'wheelchair'), { recursive: true })
  studioWheelchairSelection(staging, project, { wheelchair: true })
  if (await fs.readFile(projectFile, 'utf8') !== original) throw new Error('City sources changed during preparation; retry with the current sources.')
  const target = path.join(projectDirectory, 'wheelchair')
  const backup = path.join(projectDirectory, `wheelchair-backup-${Date.now()}`)
  let moved = false
  try { await fs.rename(target, backup); moved = true } catch (e) { if (e.code !== 'ENOENT') throw e }
  try { await fs.rename(path.join(staging, 'wheelchair'), target) } catch (e) {
    if (moved) await fs.rename(backup, target)
    throw e
  }
  console.log(JSON.stringify({ status: 'ready', directory: target, ...(moved ? { backup } : {}) }))
} finally { await fs.rm(staging, { recursive: true, force: true }) }
