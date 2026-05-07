// 共通型定義（worker 全体で参照する Env / Project / レスポンス型）

export interface Env {
  // wrangler.toml の [vars]
  ALLOWED_ORIGIN: string;
  DEFAULT_OWNER: string;

  // wrangler secret put で設定
  GITHUB_TOKEN?: string;
  DEV_AUTH_TOKEN?: string;
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
  sha: string;
  message: string;
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
// 必要に応じて拡張する
export type AssetType =
  | "images"
  | "audio"
  | "bgm"
  | "se"
  | "voice"
  | "video"
  | "fonts";

export const ASSET_TYPES: ReadonlyArray<AssetType> = [
  "images",
  "audio",
  "bgm",
  "se",
  "voice",
  "video",
  "fonts",
];

export const MAX_ASSET_BYTES = 5 * 1024 * 1024; // 5 MiB
