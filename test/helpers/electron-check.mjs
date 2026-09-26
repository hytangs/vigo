import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import electron from 'electron'

export async function runElectronCheck(source) {
  const root = path.resolve(import.meta.dirname, '../..')
  const directory = await fs.mkdtemp(path.join(root, 'temp', 'electron-check-'))
  const entry = path.join(directory, 'check.mjs')
  try {
    await fs.mkdir(path.join(directory, 'appdata', 'VIGO'), { recursive: true })
    await fs.mkdir(path.join(directory, 'cities'))
    await fs.writeFile(path.join(directory, 'appdata', 'VIGO', 'config.json'), JSON.stringify({ schemaVersion: 'vigo.config.v1', storageRoot: path.join(directory, 'cities') }))
    await fs.writeFile(entry, `import { app, BrowserWindow, net } from 'electron';\nimport assert from 'node:assert/strict';\napp.setPath('appData', ${JSON.stringify(path.join(directory, 'appdata'))});\napp.setPath('userData', ${JSON.stringify(path.join(directory, 'profile'))});\nconst wait = ms => new Promise(resolve => setTimeout(resolve, ms));\nasync function until(read) { const deadline = Date.now()+15000; while(Date.now()<deadline) { const result=await read(); if(result) return result; await wait(25); } throw Error('Electron check timed out'); }\nvoid (async () => { try { ${source}\n console.log('ELECTRON_CHECK_PASSED'); app.quit(); } catch(error) { console.error(error); app.exit(1); } })();\n`)
    await new Promise((resolve, reject) => {
      const env = { ...process.env, VIGO_CONFIG_DIR: path.join(directory, 'config'), VIGO_PROJECTS_DIR: path.join(directory, 'cities') }
      delete env.ELECTRON_RUN_AS_NODE
      const child = spawn(electron, [...(process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : []), entry], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
      let output = ''
      const append = chunk => { output = (output + chunk.toString()).slice(-64000) }
      child.stdout.on('data', append); child.stderr.on('data', append)
      const timeout = setTimeout(() => child.kill('SIGKILL'), 60_000)
      child.once('error', error => { clearTimeout(timeout); reject(error) })
      child.once('exit', code => { clearTimeout(timeout); code === 0 && output.includes('ELECTRON_CHECK_PASSED') ? resolve() : reject(new Error(output)) })
    })
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
}
