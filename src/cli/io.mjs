import fs from 'node:fs'
import path from 'node:path'

export async function readJsonObject(input, label, { stdin = false, maxBytes = Infinity } = {}) {
  if (!input?.trim()) throw new Error(`${label} requires a JSON file`)
  const fromStdin = stdin && input === '-'
  const source = fromStdin ? 'standard input' : path.resolve(input)
  let bytes
  if (fromStdin) {
    if (process.stdin.isTTY) throw new Error(`${label}: pipe JSON into --request - or provide a file`)
    const chunks = []
    let size = 0
    for await (const chunk of process.stdin) {
      size += chunk.length
      if (size > maxBytes) throw new Error(`${label} exceeds the ${maxBytes / 1024 / 1024} MiB input limit`)
      chunks.push(chunk)
    }
    bytes = Buffer.concat(chunks)
  } else {
    let stat
    try { stat = fs.statSync(source) } catch (error) {
      if (error.code === 'ENOENT') throw new Error(`${label} file not found: ${source}`)
      throw error
    }
    if (!stat.isFile()) throw new Error(`${label} must be a file: ${source}`)
    if (stat.size > maxBytes) throw new Error(`${label} exceeds the ${maxBytes / 1024 / 1024} MiB input limit`)
    bytes = fs.readFileSync(source)
  }
  if (bytes.length > maxBytes) throw new Error(`${label} exceeds the ${maxBytes / 1024 / 1024} MiB input limit`)
  let parsed
  try { parsed = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/u, '')) } catch {
    throw new Error(`${label} is not valid JSON (${source}). Provide one JSON object.`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} must be one JSON object (${source})`)
  }
  return parsed
}

export function writeOutputFile(output, serialized) {
  let destination = path.resolve(output)
  // Match normal file writes when the caller uses a symlink, and preserve private file modes.
  if (fs.lstatSync(destination, { throwIfNoEntry: false })?.isSymbolicLink()) destination = fs.realpathSync(destination)
  const mode = fs.existsSync(destination) ? fs.statSync(destination).mode & 0o777 : undefined
  const parent = path.dirname(destination)
  fs.mkdirSync(parent, { recursive: true })
  // Publish only a complete result. The temporary file shares the destination filesystem.
  const temporary = fs.mkdtempSync(path.join(parent, '.vigo-result-'))
  try {
    const staged = path.join(temporary, 'result.json')
    fs.writeFileSync(staged, serialized, { mode })
    if (mode !== undefined) fs.chmodSync(staged, mode)
    fs.renameSync(staged, destination)
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true })
  }
}

export function writeJsonResult(payload, output = '') {
  const serialized = `${JSON.stringify(payload, null, 2)}\n`
  if (output && output !== '-') writeOutputFile(output, serialized)
  process.stdout.write(serialized)
}

export function handleOutputErrors() {
  process.stdout.on('error', error => {
    // A consumer such as head has the output it needs; do not print a Node stack trace.
    if (error.code === 'EPIPE') process.exit(0)
    process.stderr.write(`VIGO output failed: ${error.message}\n`)
    process.exit(2)
  })
}
