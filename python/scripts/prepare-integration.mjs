import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const engine = process.cwd()
const { writeCliFixtureInputs } = await import(pathToFileURL(path.join(engine, 'test/helpers/cli-fixture-inputs.mjs')))
const fixture = path.join(engine, 'temp/python-fixture')
fs.mkdirSync(fixture, { recursive: true })
await writeCliFixtureInputs(fixture)
if (process.env.GITHUB_ENV) fs.appendFileSync(process.env.GITHUB_ENV, `VIGO_TEST_INPUTS=${fixture}\n`)
else console.log(fixture)
