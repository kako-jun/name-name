// 共通型定義（worker 全体で参照する Env / Project / レスポンス型）

export interface Env {
  // wrangler.toml の [vars]
  ALLOWED_ORIGIN: string;
  DEFAULT_OWNER: string;

  // wrangler secret put で設定
  GITHUB_TOKEN?: string;
  DEV_AUTH_TOKEN?: string;

  // ローカル開発で workerd から corp proxy 越しに api.github.com を叩けないとき、
  // host 側で立てた中継サーバを向き先にするための base URL（例: `http://127.0.0.1:9091`）。
  // 未設定なら api.github.com を直接叩く（本番 CF Worker の経路）。
  // proxy 値そのものはコードや wrangler.toml には書かず、shell env 経由で
  // dev ラッパー (scripts/dev.mjs) が自動付与する。
  GITHUB_API_BASE?: string;
}

export interface Project {
  name: string;
  title: string;
  repo: string; // "owner/name"
  external_url?: string; // 設定時は name-name を経由せず直接このURLに飛ぶ
  // シナリオ .md の置き場所（リポ直下からの相対パス。例 "content/scripts"）。
  // 未指定なら従来どおりリポ直下を列挙する（後方互換）。
  // 指定時は「その直下 + その直下のサブディレクトリ 1 段」を列挙する
  // （例 content/scripts/free/ や content/scripts/main/ の .md も拾う）。
  scriptsDir?: string;
}

export interface ContentsGetResponse {
  path: string;
  sha: string;
  content: string;
  encoding: "utf-8";
}

export interface ContentsPutBody {
  content: string;
  // sha があれば既存ファイル更新（楽観ロック）、なければ新規作成。
  // GitHub の Contents API は sha 不一致 → 409、同名ファイル既存で sha なし → 422 を返す。
  sha?: string;
  message?: string;
  branch?: string;
}

export interface AssetEntry {
  name: string;
  path: string;
  sha: string;
  size: number;
  type: "file" | "dir";
  download_url: string | null;
}

export interface AssetUploadBody {
  filename: string;
  // base64 エンコード済みの本体
  contentBase64: string;
  message: string;
  branch?: string;
  // 既存ファイルを上書きする場合の sha。新規作成時は省略する。
  sha?: string;
}

// アセットの種類（assets/ 配下のサブディレクトリ名に対応）
//
// kako-jun/name-name#107 (PR #120 review M1): 実態のゲームリポ
// (friday-1930, ogurasia 等) は assets/{images, sounds, movies, ideas}/ の
// 4 種類で運用している。Worker 側のホワイトリストを 4 種に絞ると将来拡張で
// 毎回 Worker をデプロイし直すことになるため、実態 4 種 + 将来拡張 6 種を
// 両方許容する。フロントは現状 images/sounds/movies/ideas のみ送るが、
// 拡張時に Worker 側のコードを触らずに済む。
export type AssetType =
  // 実態（ゲームリポで実際に使われているサブディレクトリ）
  | "images"
  | "sounds"
  | "movies"
  | "ideas"
  // 将来拡張用（細分化したいときの予約）
  | "audio"
  | "bgm"
  | "se"
  | "voice"
  | "video"
  | "fonts";

export const ASSET_TYPES: ReadonlyArray<AssetType> = [
  "images",
  "sounds",
  "movies",
  "ideas",
  "audio",
  "bgm",
  "se",
  "voice",
  "video",
  "fonts",
];

// Contents API 経由でアップロードできる上限。GitHub Contents API のレスポンス側に
// 1 MiB 制限があるため安全側で 5 MiB に絞る。これを超えるアセットは Git Data API
// (blob/tree/commit) 経路で扱う (#116)。
export const MAX_ASSET_BYTES = 5 * 1024 * 1024; // 5 MiB

// Git Data API 経由でアップロードできる実用上限。
//
// GitHub の blob サイズ上限自体は 100 MiB だが、Cloudflare Workers の per-request
// メモリ上限が 128 MiB なので 100 MiB の base64 (≈133 MiB の文字列、UTF-16 内部表現で
// 倍プラス octokit の JSON.stringify コピーが乗ると 256 MiB 超) は確実に OOM する。
// 安全圏は 20-25 MiB 程度。25 MiB を超える本体は 413 で reject し、それ以上は
// Git LFS or streaming 経路 (将来 Issue) で扱う。
export const MAX_GIT_DATA_BYTES = 25 * 1024 * 1024; // 25 MiB (Worker memory practical limit)
