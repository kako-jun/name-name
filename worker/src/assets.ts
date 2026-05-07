// /api/projects/:name/assets/:type ハンドラ
//
// - GET  : assets/{type}/ 配下の Contents API ディレクトリ一覧を返す
// - POST : 5 MiB 以下の base64 アップロード（>5 MiB は別 Issue で Git Data API 経由）

import { authenticate, requireEditor } from "./auth";
import { assetsCacheKey, cacheDelete, cacheGet, cachePut } from "./cache";
import { createGitHub, logRateLimit, normalizeError } from "./github";
import { findProject, splitRepo } from "./projects";
import {
  ASSET_TYPES,
  MAX_ASSET_BYTES,
  type AssetEntry,
  type AssetType,
  type AssetUploadBody,
  type Env,
} from "./types";

function jsonResponse(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...extraHeaders },
  });
}

function isAssetType(s: string): s is AssetType {
  return (ASSET_TYPES as ReadonlyArray<string>).includes(s);
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

    if (!Array.isArray(res.data)) {
      // ディレクトリでない: 空相当扱いではなく 400 で知らせる
      return jsonResponse({ error: `${path} is not a directory` }, 400);
    }
    const entries: AssetEntry[] = (
      res.data as Array<{
        name: string;
        path: string;
        sha: string;
        size: number;
        type: string;
        download_url: string | null;
      }>
    ).map((e) => ({
      name: e.name,
      path: e.path,
      sha: e.sha,
      size: e.size,
      type: e.type === "dir" ? "dir" : "file",
      download_url: e.download_url,
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
  if (typeof body.message !== "string" || body.message.length === 0) {
    return jsonResponse({ error: "message is required" }, 400);
  }

  const sizeBytes = base64DecodedLength(body.contentBase64);
  if (sizeBytes > MAX_ASSET_BYTES) {
    return jsonResponse(
      {
        error: `asset exceeds ${MAX_ASSET_BYTES} bytes`,
        size: sizeBytes,
        // TODO(別 Issue): >5 MiB は Git Data API (blob/tree/commit) で対応
      },
      413,
    );
  }

  const { owner, repo } = splitRepo(project);
  const path = `assets/${type}/${body.filename}`;
  const branch = body.branch;
  const octokit = createGitHub(env);
  try {
    const res = await octokit.request("PUT /repos/{owner}/{repo}/contents/{path}", {
      owner,
      repo,
      path,
      message: body.message,
      content: body.contentBase64.replace(/\s+/g, ""),
      branch,
    });
    logRateLimit("assets.upload", res.headers as Record<string, string | number | undefined>);

    // 一覧キャッシュをパージ
    await cacheDelete(assetsCacheKey(owner, repo, type, branch ?? null));
    await cacheDelete(assetsCacheKey(owner, repo, type, null));

    const data = res.data as { content?: { sha: string; path: string }; commit?: { sha: string } };
    return jsonResponse(
      {
        path: data.content?.path ?? path,
        sha: data.content?.sha ?? null,
        commit_sha: data.commit?.sha ?? null,
        size: sizeBytes,
      },
      201,
    );
  } catch (err) {
    const ne = normalizeError(err);
    logRateLimit("assets.upload.err", ne.responseHeaders);
    return jsonResponse({ error: ne.message, status: ne.status }, ne.status);
  }
}
