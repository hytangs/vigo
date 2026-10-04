import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '../..')
export const standaloneBinary = path.resolve(process.env.VIGO_STANDALONE_PATH
  || path.join(root, 'native/vigo-routing-kernel/target/release', process.platform === 'win32' ? 'vigo.exe' : 'vigo'))
if (!fs.existsSync(standaloneBinary)) {
  throw new Error('Build the standalone runtime with npm run build:standalone, or set VIGO_STANDALONE_PATH to the package being checked.')
}
