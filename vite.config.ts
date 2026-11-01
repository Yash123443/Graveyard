import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

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
  },
  preview: {
    host: '0.0.0.0',
    port: 3000,
  },
})
