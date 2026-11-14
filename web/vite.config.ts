import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'esnext',
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (
            id.includes('node_modules/react/') ||
            id.includes('node_modules/react-dom/') ||
            id.includes('node_modules/scheduler/')
          ) {
            return 'vendor-react'
          }
          if (id.includes('node_modules/@tanstack/')) {
            return 'vendor-tanstack'
          }
          if (
            id.includes('node_modules/@codemirror/') ||
            id.includes('node_modules/@lezer/')
          ) {
            return 'vendor-codemirror'
          }
          if (id.includes('node_modules/lucide-react/')) {
            return 'vendor-icons'
          }
          return undefined
        },
      },
    },
  },
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:3000',
      '/uploads': 'http://127.0.0.1:3000',
      '/feed.xml': 'http://127.0.0.1:3000',
      '/atom.xml': 'http://127.0.0.1:3000',
      '/feed.json': 'http://127.0.0.1:3000',
      '/llms.txt': 'http://127.0.0.1:3000',
      '/llms-full.txt': 'http://127.0.0.1:3000',
      '/robots.txt': 'http://127.0.0.1:3000',
      '/sitemap.xml': 'http://127.0.0.1:3000',
    },
  },
})
