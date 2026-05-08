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

export const MAX_ASSET_BYTES = 5 * 1024 * 1024; // 5 MiB
