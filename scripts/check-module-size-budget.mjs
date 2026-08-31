import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const budgets = {
  'native/vigo-routing-kernel/src/lib.rs': 303_500,
  'native/vigo-routing-kernel/src/timetable.rs': 190_200,
  'server/national-gtfs-store.mjs': 561_400,
  'server/vigo-api.mjs': 231_600,
  'src/App.tsx': 236_300,
  'src/VigoMap.tsx': 132_500,
}

const results = Object.entries(budgets).map(([file, maximumBytes]) => {
  const bytes = fs.statSync(path.join(root, file)).size
  assert(
    bytes <= maximumBytes,
    `${file} grew to ${bytes.toLocaleString()} bytes; extract a documented module boundary instead of raising the ${maximumBytes.toLocaleString()}-byte budget.`,
  )
  return { file, bytes, maximumBytes }
})

console.log(JSON.stringify({ status: 'passed', modules: results }, null, 2))
