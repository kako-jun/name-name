import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import wasm from 'vite-plugin-wasm'
import topLevelAwait from 'vite-plugin-top-level-await'

// kako-jun/name-name#107: 旧 FastAPI (localhost:7373) への dev proxy は廃止。
//   フロントは絶対 URL (Worker) を直接叩く。CORS は Worker 側 ALLOWED_ORIGIN で対応。
export default defineConfig({
  plugins: [react(), wasm(), topLevelAwait()],
  server: {
    port: 7374,
    open: true,
  },
})
