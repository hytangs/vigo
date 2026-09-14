import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const apiPort = Number(process.env.VIGO_PORT ?? process.env.VIGO_API_PORT ?? 5179) || 5179

export default defineConfig({
  plugins: [react()],
  publicDir: 'public',
  build: {
    outDir: 'public',
    emptyOutDir: false,
    copyPublicDir: false,
    chunkSizeWarningLimit: 1100,
    rollupOptions: {
      output: {
        entryFileNames: 'assets/app.js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name][extname]',
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
    watch: { ignored: ['**/temp/**', '**/release/**', '**/public/assets/**', '**/public/index.html', '**/public/vigo.mjs', '**/public/_engine/**'] },
    proxy: {
      // Preserve the browser's Host so the API can verify the same local
      // origin even when a second development checkout uses another port.
      '/api': { target: `http://127.0.0.1:${apiPort}`, changeOrigin: false },
    },
  },
  preview: {
    host: '127.0.0.1',
    port: 4178,
  },
})
