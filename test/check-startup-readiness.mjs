import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {pathToFileURL} from 'node:url'
import {startInMemoryVigoApi} from './helpers/in-memory-vigo-api.mjs'

const repositoryRoot = path.resolve(import.meta.dirname, '..')
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vigo-startup-'))
const cities = path.join(root, 'cities'), meta = path.join(cities, 'fixture', '.vigo')
const release = path.join(root, 'release-cleanup'), entered = path.join(root, 'cleanup-entered')
let api
try {
  await fs.mkdir(path.join(meta, 'staging'), {recursive: true})
  await fs.writeFile(path.join(meta, 'staging', 'abandoned.uploading'), 'old upload')
  await fs.writeFile(path.join(meta, 'project.json'), JSON.stringify({
    schemaVersion: 'vigo.project.v1', id: 'fixture', name: 'Startup fixture', feeds: [], jobs: [], artifacts: [],
    routingStore: {status: 'ready', fileName: 'missing.sqlite'},
  }))
  // Hold housekeeping indefinitely until the parent releases it. Readiness
  // must depend on neither deletion speed nor a wall-clock performance budget.
  const wrapper = path.join(root, 'server.mjs')
  await fs.writeFile(wrapper, `import fs from 'node:fs/promises';
const remove = fs.rm.bind(fs);
fs.rm = async (target, options) => {
  if (String(target) === ${JSON.stringify(path.join(meta, 'staging'))}) {
    await fs.writeFile(${JSON.stringify(entered)}, 'entered');
    while (!await fs.access(${JSON.stringify(release)}).then(()=>true,()=>false)) await new Promise(r=>setTimeout(r,10));
  }
  return remove(target, options);
};
await import(${JSON.stringify(pathToFileURL(path.join(repositoryRoot, 'src/server/vigo-api.mjs')).href)});
`)
  api = await startInMemoryVigoApi({repositoryRoot, serverPath: wrapper, environment: {
    VIGO_PROJECTS_DIR: cities, VIGO_CONFIG_DIR: path.join(root, 'config'),
  }})
  const [health, list] = await Promise.all([api.requestJson('/api/health'), api.requestJson('/api/projects')])
  assert.equal(health.status, 200)
  assert.equal(list.status, 200)
  assert.equal(list.body.projects[0].routingStore.status, 'ready', 'Library reads saved metadata without opening stores')
  const opened = await api.requestJson('/api/projects/fixture?detail=metadata')
  assert.equal(opened.body.project.routingStore.status, 'error', 'Opening still validates the missing store')
  for (let i=0; i<100 && !await fs.access(entered).then(()=>true,()=>false); i++) await new Promise(r=>setTimeout(r,10))
  await fs.access(entered)
  const route = await api.requestJson('/api/projects/fixture/national-route', {method: 'POST', body: {}})
  assert.equal(route.status, 409, 'Routing validates its store without waiting for abandoned-upload cleanup')
  let settled = false
  const mutation = api.requestJson('/api/projects', {method: 'POST', body: {name: 'After cleanup'}}).then(r=>{settled=true;return r})
  await new Promise(r=>setTimeout(r,100))
  assert.equal(settled, false, 'Mutations wait for housekeeping to prevent source deletion races')
  await fs.writeFile(release, 'continue')
  assert.equal((await mutation).status, 201)
  await assert.rejects(fs.access(path.join(meta, 'staging')), {code: 'ENOENT'})
  console.log(JSON.stringify({status:'passed', engineReadyMs:api.startupMs, libraryMs:list.latencyMs,
    checks:['readiness during stalled cleanup','metadata-only library','store validation on open','mutation cleanup barrier']}))
} finally {
  await fs.writeFile(release, 'continue').catch(()=>{})
  await api?.stop()
  await fs.rm(root, {recursive:true,force:true})
}
