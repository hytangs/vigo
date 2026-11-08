// Interrupt at the first observable staging directory, before mkdirSync
// returns to the builder. This makes the signal-handler registration race
// deterministic instead of depending on the runner's scheduler.
import fs from 'node:fs'
import path from 'node:path'

const mkdir = fs.mkdirSync
fs.mkdirSync = function (directory, ...options) {
  const result = mkdir.call(this, directory, ...options)
  if (path.basename(String(directory)).startsWith('.city.vigo-building-')) {
    process.kill(process.pid, 'SIGTERM')
  }
  return result
}
