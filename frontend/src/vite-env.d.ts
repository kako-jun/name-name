/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Worker (CF Workers) の API base URL。
   * 未設定時は src/api/client.ts の defaultApiBaseUrl() が使われる。
   */
  readonly VITE_API_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
