import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import wasm from 'vite-plugin-wasm'
import topLevelAwait from 'vite-plugin-top-level-await'

// kako-jun/name-name#107: 旧 FastAPI (localhost:7373) への dev proxy は廃止。
//   フロントは絶対 URL (Worker) を直接叩く。CORS は Worker 側 ALLOWED_ORIGIN で対応。
//
// WASM 本体 (parser/pkg/*.wasm) は frontend/scripts/sync-wasm.mjs が
// frontend/src/wasm/wasm-bytes.generated.ts に base64 で埋め込む (predev/prebuild)。
// これにより `@fs/` 経由を経路途中で書き換える corp proxy 環境でも動く。
export default defineConfig({
  plugins: [react(), wasm(), topLevelAwait()],
  server: {
    port: 7374,
    open: true,
  },
})
