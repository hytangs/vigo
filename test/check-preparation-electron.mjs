import path from 'node:path'
import { runElectronCheck } from './helpers/electron-check.mjs'

// Studio runs its API inside an Electron utility process. Exercise that exact
// parent runtime, including native GTFS/OSM compilers and child termination.
const entry = path.resolve(import.meta.dirname, 'check-preparation-process.mjs')
await runElectronCheck(`
  const { utilityProcess } = await import('electron');
  const { writeFile } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  await app.whenReady();
  const runner = new URL('./preparation.mjs', import.meta.url);
  await writeFile(runner, ${JSON.stringify(`await import(${JSON.stringify(entry)}); process.exit(0);`)});
  const worker = utilityProcess.fork(fileURLToPath(runner), [], { stdio: 'pipe' });
  let output = '';
  worker.stdout.on('data', chunk => { output += chunk; });
  worker.stderr.on('data', chunk => { output += chunk; });
  const code = await new Promise(resolve => worker.once('exit', resolve));
  assert.equal(code, 0, output);
  assert.match(output, /"checks":7/);
`)
console.log('Studio utility process: preparation succeeds and compiler processes exit.')
