import fs from 'node:fs/promises'
import path from 'node:path'

// Runtime checks keep their latest screenshots under temp/ for review. Remove
// earlier runs of the same check first so temp/ does not grow on every run.
export async function checkDirectory(root, prefix) {
  const parent = path.join(root, 'temp')
  await fs.mkdir(parent, { recursive: true })
  const earlier = (await fs.readdir(parent))
    .filter(name => name.startsWith(prefix) && /^[A-Za-z0-9]{6}$/.test(name.slice(prefix.length)))
  await Promise.all(earlier.map(name => fs.rm(path.join(parent, name), { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })))
  return fs.mkdtemp(path.join(parent, prefix))
}
