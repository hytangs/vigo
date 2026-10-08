import { fork } from 'node:child_process'
import { EventEmitter } from 'node:events'

// Importers own raw graphs, sorting arrays and native allocator arenas. Keep
// them outside the serving process and publish completion only after exit.
export class PreparationProcess extends EventEmitter {
  constructor(url, { workerData }) {
    super()
    this.child = fork(url, [], {
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      serialization: 'advanced',
      execArgv: process.execArgv.filter(arg => !arg.startsWith('--inspect')),
    })
    this.pid = this.child.pid
    this.stopping = false
    this.exited = false
    this.completion = new Promise(resolve => { this.resolveExit = resolve })
    let terminal
    this.child.on('message', message => {
      if (this.stopping) return
      if (message?.type === 'complete' || message?.type === 'failed') terminal = message
      else this.emit('message', message)
    })
    this.child.on('error', error => this.emit('error', error))
    this.child.once('exit', (code, signal) => {
      this.exited = true
      this.resolveExit(code ?? 1)
      if (!this.stopping && terminal && (code === 0 || terminal.type === 'failed')) {
        this.emit('message', { ...terminal, preparation: {
          ...terminal.preparation, pid: this.pid, exited: true,
        } })
      }
      this.emit('exit', code ?? 1, signal)
    })
    this.child.send(workerData, error => { if (error) this.emit('error', error) })
  }

  async terminate() {
    this.stopping = true
    if (!this.exited) this.child.kill('SIGKILL')
    return this.completion
  }
}
