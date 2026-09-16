import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import process from 'node:process'

async function findApiPort() {
  const preferred = Number(process.env.VIGO_PORT ?? process.env.VIGO_API_PORT ?? 5179) || 5179
  const host = (process.env.VIGO_HOST || '127.0.0.1').trim() || '127.0.0.1'
  for (let port = preferred; port <= 65535; port += 1) {
    const available = await new Promise((resolve, reject) => {
      const probe = createServer()
      probe.once('error', (error) => {
        if (error.code === 'EADDRINUSE') resolve(false)
        else reject(error)
      })
      probe.listen(port, host, () => probe.close(() => resolve(true)))
    })
    if (available) {
      if (port !== preferred) console.log(`[dev] API port ${preferred} is busy; using ${port}.`)
      return port
    }
  }
  throw new Error('No available API port found.')
}

process.env.VIGO_PORT = String(await findApiPort())

const children = []

function run(name, command, args) {
  const child = spawn(command, args, {
    env: process.env,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  children.push(child)

  child.stdout.on('data', (chunk) => {
    process.stdout.write(`[${name}] ${chunk}`)
  })

  child.stderr.on('data', (chunk) => {
    process.stderr.write(`[${name}] ${chunk}`)
  })

  child.on('exit', (code, signal) => {
    if (signal) return
    if (code && code !== 0) {
      shutdown(code)
    }
  })
}

function shutdown(code = 0) {
  for (const child of children) {
    if (!child.killed) child.kill('SIGTERM')
  }
  process.exit(code)
}

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))

run('api', process.execPath, ['src/server/vigo-api.mjs'])
run('web', process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'dev:web'])
