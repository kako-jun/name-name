/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Worker (CF Workers) の API base URL。
   * 未設定時は src/api/client.ts の DEFAULT_API_URL (`http://localhost:8787`) が使われる。
   */
  readonly VITE_API_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
