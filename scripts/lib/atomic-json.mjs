import fsp from 'node:fs/promises'
import path from 'node:path'

export async function atomicWriteJson(filePath, value) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true })
  const nextPath = `${filePath}.${process.pid}.${Date.now()}.next`
  try {
    await fsp.writeFile(nextPath, `${JSON.stringify(value, null, 2)}\n`)
    await fsp.rename(nextPath, filePath)
  } catch (error) {
    await fsp.rm(nextPath, { force: true }).catch(() => {})
    throw error
  }
}
