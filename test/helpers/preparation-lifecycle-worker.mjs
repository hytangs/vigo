import { preparationInput, publishPreparation } from '../../src/server/runtime/preparation-channel.mjs'

const { mode } = await preparationInput()
globalThis.compilerScratch = Buffer.alloc(64 * 1024 * 1024, 17)
setInterval(() => {}, 1000) // Native/importer handles must not keep it resident.
publishPreparation({ type: 'progress', progress: { phase: 'allocated', pid: process.pid } })
if (mode === 'complete') publishPreparation({ type: 'complete', result: { value: 17 } })
if (mode === 'failed') publishPreparation({ type: 'failed', error: 'deliberate compiler failure' })
if (mode === 'crash') process.exit(2)
