// /api/projects/:name/assets/:type ハンドラ
//
// - GET  : assets/{type}/ 配下の Contents API ディレクトリ一覧を返す
// - POST : サイズで経路を自動分岐
//          - <  5 MiB : Contents API (base64) でファイル単位 PUT
//          - >= 5 MiB && <= 100 MiB : Git Data API (blob/tree/commit/ref) (#116)
//          - >  100 MiB             : 413 (LFS は別 Issue)

import type { Endpoints } from "@octokit/types";
import { authenticate, requireEditor } from "./auth";
import { assetsCacheKey, cacheDelete, cacheGet, cachePut } from "./cache";
import { createGitHub, logRateLimit, normalizeError } from "./github";
import { GitDataConflictError, uploadAssetViaGitData } from "./git-data";
import { findProject, splitRepo } from "./projects";
import {
  ASSET_TYPES,
  MAX_ASSET_BYTES,
  MAX_GIT_DATA_BYTES,
  type AssetEntry,
  type AssetType,
  type AssetUploadBody,
  type Env,
} from "./types";

type ContentsGetResponseData =
  Endpoints["GET /repos/{owner}/{repo}/contents/{path}"]["response"]["data"];
type ContentsPutResponseData =
  Endpoints["PUT /repos/{owner}/{repo}/contents/{path}"]["response"]["data"];

function jsonResponse(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...extraHeaders },
  });
}

function isAssetType(s: string): s is AssetType {
  return (ASSET_TYPES as ReadonlyArray<string>).includes(s);
}

/**
 * base64 文字列の素朴な妥当性チェック。
 * 空白除去後に長さが 4 の倍数でなければ不正と見なす。
 * （実バイト列のデコードは GitHub 側に任せる前提だが、ここで早期 reject すると
 *  クライアントエラーを 400 として明示できる）
 */
function isValidBase64Length(b64: string): boolean {
  const cleaned = b64.replace(/\s+/g, "");
  return cleaned.length % 4 === 0;
}

/** base64 文字列のデコード後バイト数を算出。実デコードはせずに長さだけ見る */
function base64DecodedLength(b64: string): number {
  const cleaned = b64.replace(/\s+/g, "");
  if (cleaned.length === 0) return 0;
  let pad = 0;
  if (cleaned.endsWith("==")) pad = 2;
  else if (cleaned.endsWith("=")) pad = 1;
  return Math.floor((cleaned.length * 3) / 4) - pad;
}

/**
 * GET /api/projects/:name/assets/raw/*assetPath
 *
 * GitHub Contents API でファイルを取得し、base64 デコードしてバイナリとして返す。
 * private repo でも GITHUB_TOKEN があれば取得できる。
 *
 * assetPath は "images/placeholder-kako/smile.png" のような
 * assets/ 以下の相対パスを想定している（assets/ プレフィックスなし）。
 * Worker 内では `assets/${assetPath}` に展開して GitHub API に渡す。
 *
 * 【認証設計】
 * このエンドポイントは認証なし（requireEditor 不要）。
 * 理由: PlayerScreen（一般ユーザー向け再生）が認証なしでアセットを取得する必要があるため。
 * 脅威モデル: assets/ 配下には公開予定の素材のみ置く運用とする。
 * 機密性の高いファイルは assets/ に置かないこと。
 *
 * 【GitHub Contents API の制限】
 * 1 ファイル最大 1 MiB まで content（base64）を返す。
 * それを超えるファイルは content が空文字列になるため、413 を返す。
 * name-name の画像・音声アセットは通常この範囲内に収まる想定。
 */
export async function handleRawAsset(
  request: Request,
  env: Env,
  projectName: string,
  assetPath: string,
): Promise<Response> {
  const project = findProject(projectName);
  if (!project) {
    return new Response("project not found", { status: 404 });
  }

  // path traversal 防御: ".." を含むパスは拒否する。
  // GitHub Contents API 自体も "../" パスを拒否するが、早期リターンで明示する。
  if (assetPath.includes("..")) {
    return new Response("invalid path", { status: 400 });
  }

  const url = new URL(request.url);
  const ref = url.searchParams.get("ref") ?? "main";
  const { owner, repo } = splitRepo(project);
  const path = `assets/${assetPath}`;

  const octokit = createGitHub(env);
  try {
    const res = await octokit.request("GET /repos/{owner}/{repo}/contents/{path}", {
      owner,
      repo,
      path,
      ref,
    });
    logRateLimit("assets.raw", res.headers as Record<string, string | number | undefined>);

    const data = res.data as { type: string; content?: string; encoding?: string; size?: number };
    if (data.type !== "file") {
      return new Response("not a file", { status: 404 });
    }

    // GitHub Contents API は 1 MiB 超のファイルで content を空文字列にして返す。
    // その場合は Git Data API (blob) 経由が必要だが、現状は 413 で通知する。
    if (typeof data.content !== "string" || data.content === "") {
      return new Response(
        `asset too large for Contents API (size=${data.size ?? "unknown"} bytes, max ~1 MiB). Use Git LFS or reduce file size.`,
        { status: 413 },
      );
    }

    // base64 → バイナリ（Workers の atob + charCodeAt が最も確実）
    const cleanedB64 = data.content.replace(/\s+/g, "");
    const binaryString = atob(cleanedB64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }

    // Content-Type を拡張子から推定
    const ext = assetPath.split(".").pop()?.toLowerCase() ?? "";
    const mimeMap: Record<string, string> = {
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      gif: "image/gif",
      webp: "image/webp",
      svg: "image/svg+xml",
      mp3: "audio/mpeg",
      ogg: "audio/ogg",
      wav: "audio/wav",
      mp4: "video/mp4",
      webm: "video/webm",
      // intermission.md (#404) 等の assets/scripts/*.md をテキストとして取得できるようにする。
      // markdown 専用 MIME は厳密に用意する必要がなく、text/plain で十分（fetch().text() で読む）。
      md: "text/plain",
    };
    const contentType = mimeMap[ext] ?? "application/octet-stream";

    // CORS: 画像・音声はブラウザの <img>/<audio> から直接参照されるため * を許可する。
    // Worker 全体の CORS（ALLOWED_ORIGIN 検証）と別に設定しているが、
    // assets/raw は「ゲームプレイヤーが認証なしで取得する公開素材」の想定のため意図的。
    // cache-control: 5分（300秒）は開発中の素材更新と帯域コストのバランス。
    // ?ref=develop でのプレビュー時はブラウザキャッシュに注意。
    return new Response(bytes, {
      status: 200,
      headers: {
        "content-type": contentType,
        "cache-control": "public, max-age=300",
        "access-control-allow-origin": "*",
      },
    });
  } catch (err) {
    const ne = normalizeError(err);
    logRateLimit("assets.raw.err", ne.responseHeaders);
    return new Response(ne.message, { status: ne.status });
  }
}

export async function handleListAssets(
  request: Request,
  env: Env,
  projectName: string,
  type: string,
): Promise<Response> {
  const project = findProject(projectName);
  if (!project) return jsonResponse({ error: `unknown project: ${projectName}` }, 404);
  if (!isAssetType(type)) {
    return jsonResponse({ error: `unknown asset type: ${type}`, allowed: ASSET_TYPES }, 400);
  }

  const url = new URL(request.url);
  const ref = url.searchParams.get("ref");
  const { owner, repo } = splitRepo(project);
  const path = `assets/${type}`;

  const cacheKey = assetsCacheKey(owner, repo, type, ref);
  const hit = await cacheGet(cacheKey);
  if (hit) {
    const cloned = new Response(hit.body, hit);
    cloned.headers.set("x-cache", "HIT");
    return cloned;
  }

  const octokit = createGitHub(env);
  try {
    const res = await octokit.request("GET /repos/{owner}/{repo}/contents/{path}", {
      owner,
      repo,
      path,
      ref: ref ?? undefined,
    });
    logRateLimit("assets.list", res.headers as Record<string, string | number | undefined>);

    const data = res.data as ContentsGetResponseData;
    if (!Array.isArray(data)) {
      // ディレクトリでない: 空相当扱いではなく 400 で知らせる
      return jsonResponse({ error: `${path} is not a directory` }, 400);
    }
    const entries: AssetEntry[] = data.map((e) => ({
      name: e.name,
      path: e.path,
      sha: e.sha,
      size: e.size,
      type: e.type === "dir" ? "dir" : "file",
      // NOTE: download_url を含めて返している。public repo 前提のため
      //   raw.githubusercontent.com の URL を直接転載している。
      //   private 化する場合は Worker 経由で streaming に切り替える必要がある。
      download_url: e.download_url ?? null,
    }));
    const response = jsonResponse({ type, entries }, 200, { "x-cache": "MISS" });
    await cachePut(cacheKey, response);
    return response;
  } catch (err) {
    const ne = normalizeError(err);
    logRateLimit("assets.list.err", ne.responseHeaders);
    if (ne.status === 404) {
      // assets/{type}/ がまだ無いリポでは空配列を返す
      return jsonResponse({ type, entries: [] }, 200);
    }
    return jsonResponse({ error: ne.message }, ne.status);
  }
}

export async function handleUploadAsset(
  request: Request,
  env: Env,
  projectName: string,
  type: string,
): Promise<Response> {
  const project = findProject(projectName);
  if (!project) return jsonResponse({ error: `unknown project: ${projectName}` }, 404);
  if (!isAssetType(type)) {
    return jsonResponse({ error: `unknown asset type: ${type}`, allowed: ASSET_TYPES }, 400);
  }

  const auth = await authenticate(request, env);
  const guard = requireEditor(auth);
  if (guard) return guard;

  let body: AssetUploadBody;
  try {
    body = (await request.json()) as AssetUploadBody;
  } catch {
    return jsonResponse({ error: "invalid JSON body" }, 400);
  }
  if (typeof body.filename !== "string" || body.filename.length === 0) {
    return jsonResponse({ error: "filename is required" }, 400);
  }
  if (body.filename.includes("/") || body.filename.includes("..")) {
    return jsonResponse({ error: "filename must be a basename (no slashes / no '..')" }, 400);
  }
  if (typeof body.contentBase64 !== "string") {
    return jsonResponse({ error: "contentBase64 is required" }, 400);
  }
  if (!isValidBase64Length(body.contentBase64)) {
    return jsonResponse(
      { error: "contentBase64 is not a valid base64 string (length must be a multiple of 4 after whitespace removal)" },
      400,
    );
  }
  if (typeof body.message !== "string" || body.message.length === 0) {
    return jsonResponse({ error: "message is required" }, 400);
  }
  // sha は任意。指定があれば既存ファイルの更新（Contents PUT）として扱う。
  if (body.sha !== undefined && (typeof body.sha !== "string" || body.sha.length === 0)) {
    return jsonResponse({ error: "sha must be a non-empty string when provided" }, 400);
  }

  const sizeBytes = base64DecodedLength(body.contentBase64);
  // GitHub blob 上限の 100 MiB を超える本体は LFS が必要 (別 Issue 案件)。
  if (sizeBytes > MAX_GIT_DATA_BYTES) {
    return jsonResponse(
      {
        error: `asset must be <= ${MAX_GIT_DATA_BYTES} bytes (100 MiB). Files larger than this require Git LFS (separate issue).`,
        size: sizeBytes,
      },
      413,
    );
  }

  const { owner, repo } = splitRepo(project);
  const path = `assets/${type}/${body.filename}`;
  const branch = body.branch;
  const octokit = createGitHub(env);
  // base64 文字列の whitespace は両経路で除去してから渡す。
  const cleanedContent = body.contentBase64.replace(/\s+/g, "");

  // 5 MiB 未満は Contents API、5 MiB 以上は Git Data API 経路。
  if (sizeBytes < MAX_ASSET_BYTES) {
    try {
      const res = await octokit.request("PUT /repos/{owner}/{repo}/contents/{path}", {
        owner,
        repo,
        path,
        message: body.message,
        content: cleanedContent,
        branch,
        // sha があれば既存ファイル上書き、なければ新規作成として扱う。
        // 新規作成時に GitHub 側で同名ファイルが既にあると 422 を返すので、それはそのまま伝搬する。
        sha: body.sha,
      });
      logRateLimit("assets.upload", res.headers as Record<string, string | number | undefined>);

      // 一覧キャッシュをパージ。
      // NOTE(#118): 現状はこの Worker が触る branch / default 二系統だけパージしている。
      //   ブランチ横断でのパージは GitHub webhook 経由で #118 にて本実装する予定。
      await cacheDelete(assetsCacheKey(owner, repo, type, branch ?? null));
      await cacheDelete(assetsCacheKey(owner, repo, type, null));

      const data = res.data as ContentsPutResponseData;
      return jsonResponse(
        {
          path: data.content?.path ?? path,
          sha: data.content?.sha ?? null,
          commit_sha: data.commit?.sha ?? null,
          size: sizeBytes,
        },
        201,
        { "x-cache": "BYPASS" },
      );
    } catch (err) {
      const ne = normalizeError(err);
      logRateLimit("assets.upload.err", ne.responseHeaders);
      return jsonResponse({ error: ne.message, status: ne.status }, ne.status);
    }
  }

  // ----- Git Data API 経路 (#116) -----
  try {
    const result = await uploadAssetViaGitData(octokit, {
      owner,
      repo,
      path,
      contentBase64: cleanedContent,
      message: body.message,
      branch,
      expectedSha: body.sha,
    });

    // branch 省略時は default_branch が解決されている。両方 (resolved + null) を
    // パージしてキャッシュ整合を取る (review N-1)。
    await cacheDelete(assetsCacheKey(owner, repo, type, result.branch));
    if (branch && branch !== result.branch) {
      await cacheDelete(assetsCacheKey(owner, repo, type, branch));
    }
    await cacheDelete(assetsCacheKey(owner, repo, type, null));

    return jsonResponse(
      {
        path: result.path,
        sha: result.sha,
        commit_sha: result.commit_sha,
        size: sizeBytes,
      },
      201,
      { "x-cache": "BYPASS" },
    );
  } catch (err) {
    if (err instanceof GitDataConflictError) {
      return jsonResponse({ error: err.message, status: 409 }, 409);
    }
    const ne = normalizeError(err);
    logRateLimit("assets.upload.git-data.err", ne.responseHeaders);
    return jsonResponse({ error: ne.message, status: ne.status }, ne.status);
  }
}
