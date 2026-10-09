import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { startInMemoryVigoApi } from './helpers/in-memory-vigo-api.mjs'

// macOS protects Documents. Verify actual filesystem calls, rather than only
// asserting the displayed folder or trusting an already-authorized test host.
if (process.platform === 'darwin') {
  const repositoryRoot = path.resolve(import.meta.dirname, '..')
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vigo-storage-permission-'))
  const configDir = path.join(root, 'config'), savedLibrary = path.join(root, 'saved-library')
  const marker = path.join(root, 'allow-access'), violations = path.join(root, 'violations')
  const readOnly = path.join(root, 'read-only-check')
  const cleanupEntered = path.join(root, 'cleanup-entered'), cleanupRelease = path.join(root, 'cleanup-release')
  const staging = path.join(savedLibrary, 'fixture', '.vigo', 'staging')
  const wrapper = path.join(root, 'server.mjs')
  let api
  try {
    await fs.mkdir(configDir)
    await fs.writeFile(wrapper, `import fs from 'node:fs/promises';
const access = fs.access.bind(fs), append = fs.appendFile.bind(fs);
const protectedRoots = ${JSON.stringify([path.join(os.homedir(), 'Documents'), savedLibrary])};
for (const method of ['mkdir','readdir','stat','statfs','access','readFile','writeFile','rm']) {
  const original = fs[method].bind(fs);
  fs[method] = async (target, ...args) => {
    const value = String(target);
    if (['mkdir','writeFile','rm'].includes(method) && (value === ${JSON.stringify(savedLibrary)} || value.startsWith(${JSON.stringify(savedLibrary)} + '/'))
      && await access(${JSON.stringify(readOnly)}).then(() => true, () => false)) {
      await append(${JSON.stringify(violations)}, 'Background library write');
      throw new Error('Status request wrote to the library');
    }
    if (protectedRoots.some(root => value === root || value.startsWith(root + '/'))
      && !await access(${JSON.stringify(marker)}).then(() => true, () => false)) {
      await append(${JSON.stringify(violations)}, method + '\\n');
      throw new Error('Unrequested library access');
    }
    if (method === 'rm' && value === ${JSON.stringify(staging)}) {
      await fs.writeFile(${JSON.stringify(cleanupEntered)}, 'entered');
      while (!await access(${JSON.stringify(cleanupRelease)}).then(() => true, () => false)) await new Promise(resolve => setTimeout(resolve, 10));
    }
    return original(target, ...args);
  };
}
await import(${JSON.stringify(pathToFileURL(path.join(repositoryRoot, 'src/server/vigo-api.mjs')).href)});
`)
    const start = () => startInMemoryVigoApi({ repositoryRoot, serverPath: wrapper,
      environment: { VIGO_CONFIG_DIR: configDir, VIGO_PROJECTS_DIR: '' } })
    for (const configured of [false, true]) {
      if (configured) await fs.writeFile(path.join(configDir, 'config.json'), JSON.stringify({ storageRoot: savedLibrary }))
      api = await start()
      for (const endpoint of ['/api/health', '/api/config', '/api/projects', '/api/capabilities']) {
        const result = await api.requestJson(endpoint)
        assert.equal(result.status, 200, endpoint)
        if (result.body.config) {
          assert.equal(result.body.config.storageAccessRequired, true)
          assert.equal(result.body.config.setupRequired, !configured)
          assert.equal(result.body.config.defaultStorageRoot, path.join(os.homedir(), 'Documents', 'Vigo Projects'))
        }
      }
      for (const endpoint of ['/api/storage', '/api/projects/saved?detail=metadata']) {
        assert.equal((await api.requestJson(endpoint)).status, 409)
      }
      for (const body of [null, [], 42, 'folder', '{', '"folder"']) {
        assert.equal((await api.requestJson('/api/config', { method: 'PATCH', body })).status, 400)
      }
      for (const storageRoot of [null, '', '   ', 42, false, [], {}]) {
        const rejected = await api.requestJson('/api/config', { method: 'PATCH', body: { storageRoot } })
        assert.equal(rejected.status, 400, 'Invalid folder selection must not unlock the library')
      }
      const preference = await api.requestJson('/api/config', { method: 'PATCH', body: { appearance: 'light' } })
      assert.equal(preference.status, 200)
      assert.equal(preference.body.config.storageAccessRequired, true)
      await assert.rejects(fs.stat(violations), { code: 'ENOENT' })
      await api.stop(); api = null
    }
    // Opening the saved folder is explicit. Existing files and configuration
    // survive, and API access works in this session after selection.
    await fs.mkdir(savedLibrary)
    await fs.mkdir(staging, { recursive: true })
    await fs.writeFile(path.join(staging, 'abandoned.uploading'), 'old upload')
    const retained = path.join(savedLibrary, 'keep.txt')
    await fs.writeFile(retained, 'existing City files stay here')
    api = await start()
    await fs.writeFile(marker, 'user selected folder')
    const selection = api.requestJson('/api/config', { method: 'PATCH', body: { storageRoot: savedLibrary } })
    for (let i = 0; i < 200 && !await fs.access(cleanupEntered).then(() => true, () => false); i++) await new Promise(resolve => setTimeout(resolve, 10))
    await fs.access(cleanupEntered)
    assert.equal((await api.requestJson('/api/health')).status, 200, 'Cleanup must not delay health')
    let mutationSettled = false
    const mutation = api.requestJson('/api/projects', { method: 'POST', body: { name: 'After opening' } }).then(result => { mutationSettled = true; return result })
    await new Promise(resolve => setTimeout(resolve, 100))
    assert.equal(mutationSettled, false, 'Library opening must block writes until cleanup ends')
    await fs.writeFile(cleanupRelease, 'continue')
    const selected = await selection
    assert.equal((await mutation).status, 201)
    await assert.rejects(fs.access(staging), { code: 'ENOENT' })
    assert.equal(selected.status, 200)
    assert.equal(selected.body.config.storageAccessRequired, false)
    assert.equal(selected.body.config.storageRoot, savedLibrary)
    assert.equal((await api.requestJson('/api/storage')).status, 200)
    await fs.writeFile(readOnly, 'status checks must be read-only')
    for (const endpoint of ['/api/health', '/api/config']) {
      assert.equal((await api.requestJson(endpoint)).status, 200)
    }
    assert.equal((await api.requestJson('/api/config', { method: 'PATCH', body: { appearance: 'dark' } })).status, 200)
    assert.equal(await fs.readFile(retained, 'utf8'), 'existing City files stay here')
    await assert.rejects(fs.stat(violations), { code: 'ENOENT' })
    console.log('macOS library access: no startup, health, listing or preference probes; explicit opening preserves existing data.')
  } finally {
    await fs.writeFile(cleanupRelease, 'continue').catch(() => {})
    await api?.stop()
    await fs.rm(root, { recursive: true, force: true })
  }
} else {
  console.log('macOS library access policy does not apply on this platform.')
}
