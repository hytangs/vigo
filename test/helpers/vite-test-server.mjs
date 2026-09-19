import { createServer } from 'vite'

// Fixtures do not edit source files while running. Watching the repository also
// watches their Chromium profiles, whose Cookies databases are locked on Windows.
export function createViteTestServer(options = {}) {
  return createServer({ ...options, server: { ...options.server, watch: null } })
}
