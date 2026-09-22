import { lstat, readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

// Shared by source and packaged-payload checks, including binary strings and
// UTF-16 Windows metadata. Return categories only, never matched values.
export function publicationContentFindings(data, { forbiddenRoots = [] } = {}) {
  const roots = [...forbiddenRoots, os.homedir()].filter(value => value && value.length > 3)
  const texts = [data.toString('utf8'), data.toString('utf16le')]
  const rules = [
    [/\/(?:Users|home|Volumes)\/[^/\s"']+/u, 'embedded developer path'],
    [/\b[A-Za-z]:[\\/]+(?:Users|Documents and Settings)[\\/]+[^\\/\s"']+/iu, 'embedded developer path'],
    [/vigo-(?:bench|paper)|\/private\/var\/folders\/|https:\/\/github\.com\/hytangs\/vigo-dev(?:\.git)?|r[a]pidonkey/iu, 'private workspace reference'],
    [/-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----|\b(?:sk-|crsr_)[A-Za-z0-9_-]{24,}|\bgh(?:p|o|s|r|u)_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b|\bAKIA[0-9A-Z]{16}\b|\bxox[baprs]-[A-Za-z0-9-]{20,}/u, 'possible embedded credential'],
  ]
  const findings = new Set()
  if (roots.some(value => [value, value.replaceAll('\\', '\\\\')].some(root => (
    data.includes(Buffer.from(root)) || data.includes(Buffer.from(root, 'utf16le'))
  )))) findings.add('embedded developer path')
  for (const [pattern, category] of rules) {
    if (texts.some(text => pattern.test(text))) findings.add(category)
  }
  return [...findings]
}

// Scan only the application payload, not Electron's signed framework resources.
// Report file names and finding categories; never print possible secret values.
export async function auditPackageFiles(root, { forbiddenRoots = [] } = {}) {
  const failures = []
  let files = 0, bytes = 0
  async function visit(directory) {
    for (const name of await readdir(directory)) {
      const file = path.join(directory, name), relative = path.relative(root, file)
      const info = await lstat(file)
      if (info.isSymbolicLink()) { failures.push(`${relative}: symlink in application payload`); continue }
      if (info.isDirectory() && /^(?:tests?|__tests__|fixtures|coverage)$/iu.test(name)
        || /(?:\.(?:test|spec)\.[cm]?[jt]sx?$|^check-.*\.[cm]?[jt]sx?$)/iu.test(name)) {
        failures.push(`${relative}: test artifact in application payload`)
      }
      if (/^(?:\.env(?:\..*)?|\.git|\.DS_Store|node_modules|temp|\.cache|credentials(?:\.json)?)$/iu.test(name)
        || /\.(?:sqlite(?:-wal|-shm)?|db|log|pem|p12|pfx|key|map)$/iu.test(name)) {
        failures.push(`${relative}: development data or credential file`)
      }
      if (info.isDirectory()) { await visit(file); continue }
      if (!info.isFile()) continue
      files++; bytes += info.size
      const data = await readFile(file)
      for (const category of publicationContentFindings(data, { forbiddenRoots })) failures.push(`${relative}: ${category}`)
    }
  }
  await visit(root)
  if (failures.length) throw new Error(`Package audit failed:\n${failures.join('\n')}`)
  return { files, bytes, developerPaths: 0, suspectedCredentials: 0 }
}
