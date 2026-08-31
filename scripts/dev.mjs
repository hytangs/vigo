import { spawn } from 'node:child_process'
import process from 'node:process'

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

run('api', process.execPath, ['server/vigo-api.mjs'])
run('web', process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'dev:web'])
