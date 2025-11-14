import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 7374,
    open: true,
    proxy: {
      '/api': {
        target: 'http://localhost:7373',
        changeOrigin: true,
      },
    },
  },
})
