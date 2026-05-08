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

    await cacheDelete(assetsCacheKey(owner, repo, type, branch ?? null));
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
