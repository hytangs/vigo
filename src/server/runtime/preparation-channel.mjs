import { once } from 'node:events'

export async function preparationInput() {
  if (!process.send) throw new Error('Preparation must run in its own child process.')
  // Do not leave a compiler running if the owning Studio process disappears.
  process.once('disconnect', () => process.exit(1))
  const [input] = await once(process, 'message')
  return input
}

export function publishPreparation(message) {
  const terminal = message.type === 'complete' || message.type === 'failed'
  if (terminal) message = { ...message, preparation: {
    memory: process.memoryUsage(), peakRssBytes: process.resourceUsage().maxRSS * 1024,
  } }
  process.send(message, error => {
    if (error || terminal) process.exit(error || message.type === 'failed' ? 1 : 0)
  })
}
