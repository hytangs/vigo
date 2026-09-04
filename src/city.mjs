import fs from 'node:fs'
import path from 'node:path'

function uniqueSibling(directory, role) {
  const parent = path.dirname(directory)
  const name = path.basename(directory)
  return path.join(parent, `.${name}.vigo-${role}-${process.pid}-${Date.now()}`)
}

export function createCityStagingDirectory(outputDirectory) {
  const resolved = path.resolve(outputDirectory)
  fs.mkdirSync(path.dirname(resolved), { recursive: true })
  const stagingDirectory = uniqueSibling(resolved, 'building')
  fs.mkdirSync(stagingDirectory, { recursive: false })
  return stagingDirectory
}

export function validateCityDirectory(directory) {
  const resolved = path.resolve(directory)
  for (const relativePath of [
    'network.json',
    path.join('routing', 'project.sqlite'),
    path.join('osm', 'street-index.sqlite'),
  ]) {
    const artifact = path.join(resolved, relativePath)
    if (!fs.existsSync(artifact) || !fs.statSync(artifact).isFile()) {
      throw new Error(`The City is incomplete: ${relativePath} is missing.`)
    }
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(resolved, 'network.json'), 'utf8'))
  if (manifest?.schemaVersion !== 'vigo.city.v1') {
    throw new Error('This City was built by an unsupported VIGO version.')
  }
  return manifest
}

export function publishCity(stagingDirectory, outputDirectory, { replace = false } = {}) {
  const staged = path.resolve(stagingDirectory)
  const output = path.resolve(outputDirectory)
  if (path.dirname(staged) !== path.dirname(output)) {
    throw new Error('The staged and published network directories must share one parent.')
  }
  if (!fs.statSync(staged).isDirectory()) {
    throw new Error('The staged network package is not a directory.')
  }
  validateCityDirectory(staged)
  const existing = fs.existsSync(output)
  if (existing && !replace) {
    throw new Error(`City already exists; pass --replace to replace it: ${output}`)
  }

  const backup = uniqueSibling(output, 'previous')
  let previousMoved = false
  try {
    if (existing) {
      fs.renameSync(output, backup)
      previousMoved = true
    }
    fs.renameSync(staged, output)
  } catch (error) {
    if (previousMoved && !fs.existsSync(output) && fs.existsSync(backup)) {
      fs.renameSync(backup, output)
    }
    throw error
  }

  if (previousMoved) fs.rmSync(backup, { recursive: true, force: true })
}
