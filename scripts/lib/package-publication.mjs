import fs from 'node:fs/promises'
import path from 'node:path'

// Keep runtime, archive and checksum from the same completed build together.
export async function publishArtifacts(replacements, backup, rename = fs.rename) {
  await fs.mkdir(backup)
  const saved = [], published = []
  try {
    for (const [, destination] of replacements) {
      const previous = path.join(backup, path.basename(destination))
      try { await rename(destination, previous) }
      catch (error) { if (error.code === 'ENOENT') continue; throw error }
      saved.push([previous, destination])
    }
    for (const [source, destination] of replacements) {
      await rename(source, destination)
      published.push(destination)
    }
  } catch (error) {
    for (const destination of published.reverse()) await fs.rm(destination, { recursive: true, force: true })
    for (const [previous, destination] of saved.reverse()) await fs.rename(previous, destination)
    await fs.rmdir(backup)
    throw error
  }
  await fs.rm(backup, { recursive: true })
}
