import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Native street indexes can retain memory maps until garbage collection. The
// parent owns the fixture directory and removes it after the worker exits, so
// cleanup never races a live map on Windows.
export async function processFixtureDirectory(moduleUrl, prefix) {
  if (process.argv[2] === '--fixture-worker') return process.argv[3]
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  try {
    execFileSync(process.execPath, [fileURLToPath(moduleUrl), '--fixture-worker', folder], {
      stdio: 'inherit',
      env: process.env,
    })
  } finally {
    await fs.rm(folder, { recursive: true, force: true })
  }
  process.exit(0)
}
