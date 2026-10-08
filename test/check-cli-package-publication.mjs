import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { publishArtifacts } from '../scripts/lib/package-publication.mjs'

for (const existing of [true, false]) {
  for (let failure = 0; failure <= 6; failure++) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vigo-cli-publication-'))
    try {
      const replacements = []
      for (const name of ['runtime', 'archive', 'checksum']) {
        const source = path.join(root, `new-${name}`), destination = path.join(root, name)
        for (const [file, value] of [[source, 'new'], ...(existing ? [[destination, 'old']] : [])]) {
          if (name === 'runtime') await fs.mkdir(file)
          await fs.writeFile(name === 'runtime' ? path.join(file, 'vigo.mjs') : file, value)
        }
        replacements.push([source, destination])
      }
      let calls = 0
      const action = publishArtifacts(replacements, path.join(root, 'previous'), async (source, destination) => {
        if (++calls === failure) throw new Error('injected publication failure')
        await fs.rename(source, destination)
      })
      if (failure) await assert.rejects(action, /injected publication failure/)
      else await action
      for (const [, destination] of replacements) {
        if (failure && !existing) {
          await assert.rejects(fs.stat(destination), { code: 'ENOENT' })
        } else {
          const file = destination.endsWith('runtime') ? path.join(destination, 'vigo.mjs') : destination
          assert.equal(await fs.readFile(file, 'utf8'), failure ? 'old' : 'new')
        }
      }
      await assert.rejects(fs.stat(path.join(root, 'previous')), { code: 'ENOENT' })
    } finally { await fs.rm(root, { recursive: true, force: true }) }
  }
}
console.log('CLI publication: fresh installs and all six interrupted replacement steps preserve a complete package.')
