import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sourceDirectory = path.join(root, 'docs', 'developer-guide')
const sourceName = 'VIGO-0.3.1-Developer-Guide.tex'
const buildDirectory = path.join(root, 'temp', 'developer-guide-build')
const outputDirectory = path.join(root, 'output', 'pdf')

fs.rmSync(buildDirectory, { recursive: true, force: true })
fs.mkdirSync(buildDirectory, { recursive: true })
fs.mkdirSync(outputDirectory, { recursive: true })

const environment = {
  ...process.env,
  TEXINPUTS: `${sourceDirectory}:${process.env.TEXINPUTS ?? ''}`,
}

function runLatexPass(pass) {
  const result = spawnSync(
    'xelatex',
    [
      '-interaction=nonstopmode',
      '-halt-on-error',
      `-output-directory=${buildDirectory}`,
      path.join(sourceDirectory, sourceName),
    ],
    { cwd: sourceDirectory, env: environment, encoding: 'utf8' },
  )
  process.stdout.write(result.stdout ?? '')
  process.stderr.write(result.stderr ?? '')
  if (result.status !== 0) {
    throw new Error(`VIGO Developer Guide XeLaTeX pass ${pass} failed.`)
  }
}

for (let pass = 1; pass <= 3; pass += 1) runLatexPass(pass)

const pdfName = sourceName.replace(/\.tex$/u, '.pdf')
const builtPdf = path.join(buildDirectory, pdfName)
const outputPdf = path.join(outputDirectory, pdfName)
fs.copyFileSync(builtPdf, outputPdf)
process.stdout.write(`Built ${outputPdf}\n`)
