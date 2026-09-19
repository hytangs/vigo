import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const jobs = new Map()
const script = fileURLToPath(new URL('../../scripts/lamp-runtime-study.py', import.meta.url))
export function runLampStudy({ directory, startDate, trainingEndDate, endDate, routeId }, signal) {
  if (jobs.has(directory)) throw new Error('A running-time study is already running for this City.')
  const dates = [startDate, trainingEndDate, endDate].map(value => Date.parse(`${value}T12:00Z`))
  if (dates.some(value => !Number.isFinite(value)) || dates[0] > dates[1] || dates[1] >= dates[2] || dates[2] - dates[0] > 30 * 86400000) throw new Error('Choose up to 31 chronological service dates, with training ending before evaluation.')
  const job = new Promise((resolve, reject) => {
    const child = spawn(process.env.VIGO_AGENCY_PYTHON || 'python3', [script, '--start', startDate, '--train-end', trainingEndDate, '--end', endDate, '--output', path.join(directory, 'lamp'), ...(routeId ? ['--route', routeId] : [])], { stdio: ['ignore', 'pipe', 'pipe'] })
    let errors = '', stopped = false
    child.stdout.on('data', () => {})
    child.stderr.on('data', chunk => { errors = (errors + chunk.toString()).slice(-3000) })
    const stop = () => { stopped = true; child.kill('SIGTERM') }
    const timer = setTimeout(stop, 600000)
    signal?.addEventListener('abort', stop, { once: true })
    if (signal?.aborted) stop()
    const clean = () => { clearTimeout(timer); signal?.removeEventListener('abort', stop) }
    child.on('error', error => { clean(); reject(new Error(`The Python research runtime could not start: ${error.message}`)) })
    child.on('close', code => {
      clean()
      if (stopped) reject(new Error('The study stopped. Previously completed results remain available.'))
      else if (code !== 0) reject(new Error(`The running-time study could not finish. ${errors.split('\n').filter(Boolean).at(-1) || 'Check Python, pandas and pyarrow availability.'}`))
      else resolve({ complete: true })
    })
  }).finally(() => jobs.delete(directory))
  jobs.set(directory, job)
  return job
}
