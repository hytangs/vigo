import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createSsrTestServer } from './ssr-test-server.mjs'

// Load the real TypeScript dependency graph instead of rewriting imports or
// replacing application dependencies with empty functions in individual tests.
export async function importTestModules(...paths) {
  const cacheDir = await mkdtemp(path.join(os.tmpdir(), 'vigo-test-modules-'))
  let server
  try {
    server = await createSsrTestServer({ configFile: false, cacheDir, esbuild: { jsx: 'automatic' } })
    const modules = []
    for (const file of paths) modules.push(await server.ssrLoadModule(`/src/${file}`))
    return modules
  } finally {
    await server?.close()
    await rm(cacheDir, { recursive: true, force: true })
  }
}
