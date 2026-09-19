import { createViteTestServer as createServer } from './vite-test-server.mjs'

// These tests only use ssrLoadModule. React's plugin otherwise adds client
// dependencies that keep the optimizer writing after the temporary cache closes.
export function createSsrTestServer(options = {}) {
  return createServer({
    ...options,
    server: { middlewareMode: true, hmr: false },
    appType: 'custom',
    plugins: [...(options.plugins ?? []), {
      name: 'ssr-test-without-client-optimizer',
      config: {
        order: 'post',
        handler(config) {
          config.optimizeDeps = { ...config.optimizeDeps, noDiscovery: true, include: [] }
        },
      },
    }],
  })
}
