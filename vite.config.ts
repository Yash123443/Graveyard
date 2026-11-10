import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Same-origin API access: the browser calls /api/*, Vite forwards to the local
// backend. Only /api/health is rewritten (the backend serves it at /health);
// every other /api route is passed through unchanged.
const apiProxy = {
  '/api': {
    target: 'http://127.0.0.1:3002',
    changeOrigin: false,
    rewrite: (path: string) => path.replace(/^\/api\/health(?=$|\?)/, '/health'),
  },
}

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        // Keep the app shell small and allow the renderer/runtime to download
        // in parallel and remain cached between visits.
        manualChunks: {
          'three-runtime': ['three', '@react-three/fiber', '@react-three/drei'],
          animation: ['gsap'],
        },
      },
    },
  },
  server: {
    host: '0.0.0.0',
    port: 3000,
    proxy: apiProxy,
  },
  preview: {
    host: '0.0.0.0',
    port: 3000,
    proxy: apiProxy,
  },
})
