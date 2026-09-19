import { lstat, readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

// Scan only the application payload, not Electron's signed framework resources.
// Report file names and finding categories; never print possible secret values.
export async function auditPackageFiles(root, { forbiddenRoots = [] } = {}) {
  const failures = []
  let files = 0, bytes = 0
  const roots = [...forbiddenRoots, os.homedir()].filter(value => value && value.length > 3)
  async function visit(directory) {
    for (const name of await readdir(directory)) {
      const file = path.join(directory, name), relative = path.relative(root, file)
      const info = await lstat(file)
      if (info.isSymbolicLink()) { failures.push(`${relative}: symlink in application payload`); continue }
      if (/^(?:\.env(?:\..*)?|\.git|\.DS_Store|node_modules|temp|\.cache|credentials(?:\.json)?)$/iu.test(name)
        || /\.(?:sqlite(?:-wal|-shm)?|db|log|pem|p12|pfx|key|map)$/iu.test(name)) {
        failures.push(`${relative}: development data or credential file`)
      }
      if (info.isDirectory()) { await visit(file); continue }
      if (!info.isFile()) continue
      files++; bytes += info.size
      const data = await readFile(file)
      const text = data.toString('utf8')
      if (roots.some(value => data.includes(Buffer.from(value)) || data.includes(Buffer.from(value.replaceAll('\\', '\\\\'))))
        || /\/(?:Users|home)\/[^/\s"']+\//u.test(text)) failures.push(`${relative}: embedded developer path`)
      if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bsk-[A-Za-z0-9_-]{24,}/u.test(text)) failures.push(`${relative}: possible embedded credential`)
    }
  }
  await visit(root)
  if (failures.length) throw new Error(`Package audit failed:\n${failures.join('\n')}`)
  return { files, bytes, developerPaths: 0, suspectedCredentials: 0 }
}
