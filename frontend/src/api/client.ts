// Worker (CF Workers) 用 API クライアント。kako-jun/name-name#107 で
// 旧 FastAPI (`localhost:7373`) ベースから Worker (`localhost:8787` / 本番
// `name-name-api.workers.dev`) ベースに切り替えた。
//
// 設計メモ:
// - すべての API 呼び出しはこのモジュールに集約する。`fetch` を直接
//   各画面から叩かない。Worker URL をハードコードしない。
// - base URL は VITE_API_URL → `apiBaseUrl` 引数 → 既定 `localhost:8787`
//   の優先順位。runtime には `apiBaseUrl` 引数が最終決定値で渡るため、
//   このモジュールが直接 import.meta.env を読むのは「明示指定が無い場合の
//   既定値」を作るときだけにする。
// - 旧 FastAPI モデルにあった "ローカルワーキングディレクトリ" の概念は
//   Worker モデルでは存在しない（保存 = 即 commit）。`getStatus` /
//   `commit` / `discard` / `getTags` は #108 (Editor/Player 統合) で
//   UI を整理するまでの間だけスタブとして残す。

const DEFAULT_API_URL = 'http://localhost:8787'

/**
 * 環境変数による既定 base URL。`VITE_API_URL` を最優先、未設定なら
 * `localhost:8787`。createApiClient() に明示的に baseUrl を渡せば
 * そちらが優先される（App.tsx の設定 UI から動的に変更できる）。
 */
export function defaultApiBaseUrl(): string {
  // import.meta.env は Vite ビルド時に置換される定数。
  // テスト (vitest jsdom) では undefined のことがあるので optional chain。
  const envUrl =
    typeof import.meta !== 'undefined' && import.meta.env
      ? (import.meta.env.VITE_API_URL as string | undefined)
      : undefined
  return envUrl && envUrl.length > 0 ? envUrl : DEFAULT_API_URL
}

// ---- レスポンス・リクエスト型 ----

export interface ProjectInfo {
  name: string
  title: string
  repo: string
}

export interface ContentsResponse {
  path: string
  sha: string
  content: string
  encoding?: 'utf-8'
}

export interface ContentsPutResponse {
  path: string
  sha: string | null
  commit_sha: string | null
}

export interface AssetEntry {
  name: string
  path: string
  sha: string
  size: number
  type: 'file' | 'dir'
  download_url: string | null
}

export interface AssetUploadResponse {
  path: string
  sha: string | null
  commit_sha: string | null
  size?: number
}

// アセット種別。Worker 側 (worker/src/types.ts) と完全一致しない（Worker は
// `audio`/`bgm`/`se`/`voice`/`video`/`fonts` を持つ。フロントの旧モデルは
// `images`/`sounds`/`movies`/`ideas`）。ここは段階移行のため string で受け、
// 不一致は Worker 側で 400 になる。最終的に #108 で揃える。
export type AssetType = 'images' | 'sounds' | 'movies' | 'ideas' | string

// ---- 認証ヘッダ ----

const AUTH_TOKEN_STORAGE_KEY = 'dev_auth_token'

/**
 * localStorage に保存された開発用トークンを Bearer で送る。
 * #110 (本番認証) で OAuth フローに置き換わるが、それまでは手動投入。
 * exported しているのはテストとデバッグから値を覗くため。
 */
export function authHeaders(): HeadersInit {
  // SSR / vitest jsdom 以外で localStorage が無いケースに備えて try-catch
  try {
    const token =
      typeof localStorage !== 'undefined' ? localStorage.getItem(AUTH_TOKEN_STORAGE_KEY) : null
    return token ? { authorization: `Bearer ${token}` } : {}
  } catch {
    return {}
  }
}

// ---- 内部 fetch ヘルパー ----

interface ApiClientOptions {
  baseUrl?: string
  /** テスト用に fetch を差し替えるためのフック */
  fetchImpl?: typeof fetch
}

class ApiError extends Error {
  status: number
  body: unknown
  constructor(status: number, body: unknown, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.body = body
  }
}

export { ApiError }

async function parseJsonOrThrow<T>(res: Response, label: string): Promise<T> {
  const text = await res.text()
  let body: unknown = undefined
  if (text) {
    try {
      body = JSON.parse(text)
    } catch {
      body = text
    }
  }
  if (!res.ok) {
    const errMsg =
      body && typeof body === 'object' && body !== null && 'error' in body
        ? String((body as { error: unknown }).error)
        : `${label} failed: ${res.status}`
    throw new ApiError(res.status, body, errMsg)
  }
  return body as T
}

// ---- API クライアント本体 ----

export interface ApiClient {
  /** プロジェクト一覧 */
  listProjects(): Promise<ProjectInfo[]>

  /** Markdown / 設定ファイル 1 本を取得。`ref` はブランチ名（既定 develop） */
  getContents(projectName: string, path: string, ref?: string): Promise<ContentsResponse>

  /** Markdown / 設定ファイル 1 本を更新（または新規作成）。
   *  既存ファイルの更新時は sha 必須（楽観ロック）。
   */
  putContents(
    projectName: string,
    path: string,
    body: {
      content: string
      sha?: string
      message?: string
      branch: string
    }
  ): Promise<ContentsPutResponse>

  /** assets/{type}/ ディレクトリ一覧 */
  listAssets(
    projectName: string,
    type: AssetType,
    options?: { ref?: string }
  ): Promise<AssetEntry[]>

  /** assets/{type}/{filename} を base64 でアップロード（5 MiB 未満） */
  uploadAsset(
    projectName: string,
    type: AssetType,
    filename: string,
    contentBase64: string,
    branch: string,
    options?: { sha?: string; message?: string }
  ): Promise<AssetUploadResponse>

  // ---- 旧互換スタブ（#108 の UI 整理で削除予定） ----
  /** 「未コミット変更あり」概念は Worker モデルに無い。常に false */
  getStatus(): Promise<{ has_uncommitted: boolean }>
  /** Worker モデルでは PUT contents が即 commit するため独立 commit は no-op */
  commit(): Promise<void>
  /** discard は Worker モデルでは「最新を再取得して上書き」相当。no-op */
  discard(): Promise<void>
  /** タグは別 Issue (assets メタ再設計) で対応。暫定で空配列 */
  getTags(): Promise<string[]>
}

export function createApiClient(options: ApiClientOptions = {}): ApiClient {
  const baseUrl = (options.baseUrl ?? defaultApiBaseUrl()).replace(/\/$/, '')
  const fetchImpl: typeof fetch = options.fetchImpl ?? fetch.bind(globalThis)

  function url(path: string): string {
    return `${baseUrl}${path.startsWith('/') ? path : `/${path}`}`
  }

  return {
    async listProjects(): Promise<ProjectInfo[]> {
      const res = await fetchImpl(url('/api/projects'), {
        headers: { ...authHeaders() },
      })
      const data = await parseJsonOrThrow<{ projects: ProjectInfo[] }>(res, 'listProjects')
      return data.projects
    },

    async getContents(projectName: string, path: string, ref?: string): Promise<ContentsResponse> {
      const safePath = encodePathPreserveSlashes(path)
      const qs = ref ? `?ref=${encodeURIComponent(ref)}` : ''
      const res = await fetchImpl(
        url(`/api/projects/${encodeURIComponent(projectName)}/contents/${safePath}${qs}`),
        {
          headers: { ...authHeaders() },
        }
      )
      return parseJsonOrThrow<ContentsResponse>(res, 'getContents')
    },

    async putContents(
      projectName: string,
      path: string,
      body: {
        content: string
        sha?: string
        message?: string
        branch: string
      }
    ): Promise<ContentsPutResponse> {
      const safePath = encodePathPreserveSlashes(path)
      const res = await fetchImpl(
        url(`/api/projects/${encodeURIComponent(projectName)}/contents/${safePath}`),
        {
          method: 'PUT',
          headers: {
            'content-type': 'application/json',
            ...authHeaders(),
          },
          body: JSON.stringify(body),
        }
      )
      return parseJsonOrThrow<ContentsPutResponse>(res, 'putContents')
    },

    async listAssets(
      projectName: string,
      type: AssetType,
      options: { ref?: string } = {}
    ): Promise<AssetEntry[]> {
      const qs = options.ref ? `?ref=${encodeURIComponent(options.ref)}` : ''
      const res = await fetchImpl(
        url(
          `/api/projects/${encodeURIComponent(projectName)}/assets/${encodeURIComponent(type)}${qs}`
        ),
        {
          headers: { ...authHeaders() },
        }
      )
      const data = await parseJsonOrThrow<{
        type: string
        entries: AssetEntry[]
      }>(res, 'listAssets')
      return data.entries ?? []
    },

    async uploadAsset(
      projectName: string,
      type: AssetType,
      filename: string,
      contentBase64: string,
      branch: string,
      options: { sha?: string; message?: string } = {}
    ): Promise<AssetUploadResponse> {
      const message =
        options.message && options.message.length > 0 ? options.message : `upload ${filename}`
      const res = await fetchImpl(
        url(`/api/projects/${encodeURIComponent(projectName)}/assets/${encodeURIComponent(type)}`),
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...authHeaders(),
          },
          body: JSON.stringify({
            filename,
            contentBase64,
            branch,
            message,
            sha: options.sha,
          }),
        }
      )
      return parseJsonOrThrow<AssetUploadResponse>(res, 'uploadAsset')
    },

    // ---- スタブ群 ----
    async getStatus(): Promise<{ has_uncommitted: boolean }> {
      return { has_uncommitted: false }
    },
    async commit(): Promise<void> {
      // no-op: Worker モデルでは PUT contents が即 commit
    },
    async discard(): Promise<void> {
      // no-op: 呼び出し側で「最新を再取得」する
    },
    async getTags(): Promise<string[]> {
      return []
    },
  }
}

/**
 * パスの "/" は残し、各セグメントだけ encodeURIComponent する。
 * `chapters/all.md` → `chapters/all.md`、`日本語/ファイル.md` → percent-encoded
 */
function encodePathPreserveSlashes(path: string): string {
  return path
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/')
}

/**
 * Module-level の既定インスタンス。`apiBaseUrl` をプロップで切り替える設計の
 * 都合上、各画面では `createApiClient({ baseUrl: apiBaseUrl })` を毎回作るのが
 * 基本。ただしテストや小さな utility から軽く使うときのために default も置く。
 */
export const apiClient: ApiClient = createApiClient()

export const __internal = {
  AUTH_TOKEN_STORAGE_KEY,
  encodePathPreserveSlashes,
}
