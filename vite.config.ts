import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const apiPort = Number(process.env.VIGO_PORT ?? process.env.VIGO_API_PORT ?? 5179) || 5179

export default defineConfig({
  plugins: [react()],
  build: {
    chunkSizeWarningLimit: 1100,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/maplibre-gl')) return 'maplibre'
          if (id.includes('node_modules/lucide-react')) return 'icons'
        },
      },
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5178,
    proxy: {
      '/api': `http://127.0.0.1:${apiPort}`,
    },
  },
  preview: {
    host: '127.0.0.1',
    port: 4178,
  },
})
