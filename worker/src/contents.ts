// /api/projects/:name/contents/* ハンドラ
//
// - GET : Contents API を叩いて base64 を utf-8 にデコード、{ path, sha, content } を返す
// - PUT : { content, sha, message, branch? } を受け取り、base64 化して PUT する
//         sha mismatch (409) はそのまま 409 でクライアントへ返す
//         新規ファイル作成 (sha なし) は #115 で実装予定。現状は 400 で reject する。

import type { Endpoints } from "@octokit/types";
import { authenticate, requireEditor } from "./auth";
import { cacheDelete, cacheGet, cachePut, contentsCacheKey } from "./cache";
import { createGitHub, logRateLimit, normalizeError } from "./github";
import { findProject, splitRepo } from "./projects";
import type { ContentsGetResponse, ContentsPutBody, Env } from "./types";

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

function notFound(message: string): Response {
  return jsonResponse({ error: message }, 404);
}

function badRequest(message: string): Response {
  return jsonResponse({ error: message }, 400);
}

function badGateway(message: string): Response {
  return jsonResponse({ error: message }, 502);
}

/** path に traversal が含まれていないかの素朴チェック */
function isUnsafePath(path: string): boolean {
  if (path.includes("..")) return true;
  if (path.includes("//")) return true;
  return false;
}

/**
 * Workers ランタイムには atob/btoa が存在するが、UTF-8 文字列の変換には注意が必要。
 * 受け取った base64 → Uint8Array → TextDecoder で utf-8 デコードする。
 * 不正な base64 (`atob` が `InvalidCharacterError` を投げる) は呼び出し側で catch すること。
 */
function base64ToUtf8(b64: string): string {
  const cleaned = b64.replace(/\s+/g, "");
  const bin = atob(cleaned);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder("utf-8").decode(bytes);
}

function utf8ToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

export async function handleGetContents(
  request: Request,
  env: Env,
  projectName: string,
  path: string,
): Promise<Response> {
  const project = findProject(projectName);
  if (!project) return notFound(`unknown project: ${projectName}`);
  if (!path) return badRequest("path is required");
  if (isUnsafePath(path)) return badRequest("path contains '..' or '//' which is not allowed");

  const url = new URL(request.url);
  const ref = url.searchParams.get("ref"); // ブランチ / コミット指定（任意）
  const { owner, repo } = splitRepo(project);

  const cacheKey = contentsCacheKey(owner, repo, path, ref);
  const hit = await cacheGet(cacheKey);
  if (hit) {
    // キャッシュヒットを示すヘッダを足す
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
    logRateLimit("contents.get", res.headers as Record<string, string | number | undefined>);

    const data = res.data as ContentsGetResponseData;
    // ディレクトリの場合 res.data は配列。ファイルのみ受ける。
    if (Array.isArray(data)) {
      return badRequest("path is a directory; use /assets/ endpoint instead");
    }
    if (data.type !== "file" || typeof data.content !== "string") {
      return badRequest(`unsupported content type: ${data.type}`);
    }
    let text: string;
    try {
      text = base64ToUtf8(data.content);
    } catch (decodeErr) {
      // GitHub が壊れた base64 を返した場合（通常は起こらないがガード）
      console.error("[contents.get] base64 decode failed", decodeErr);
      return badGateway("failed to decode base64 from GitHub");
    }
    const respBody: ContentsGetResponse = {
      path: data.path,
      sha: data.sha,
      content: text,
      encoding: "utf-8",
    };
    const response = jsonResponse(respBody, 200, { "x-cache": "MISS" });
    await cachePut(cacheKey, response);
    return response;
  } catch (err) {
    const ne = normalizeError(err);
    logRateLimit("contents.get.err", ne.responseHeaders);
    return jsonResponse({ error: ne.message }, ne.status);
  }
}

export async function handlePutContents(
  request: Request,
  env: Env,
  projectName: string,
  path: string,
): Promise<Response> {
  const project = findProject(projectName);
  if (!project) return notFound(`unknown project: ${projectName}`);
  if (!path) return badRequest("path is required");
  if (isUnsafePath(path)) return badRequest("path contains '..' or '//' which is not allowed");

  const auth = await authenticate(request, env);
  const guard = requireEditor(auth);
  if (guard) return guard;

  let body: ContentsPutBody;
  try {
    body = (await request.json()) as ContentsPutBody;
  } catch {
    return badRequest("invalid JSON body");
  }
  if (typeof body.content !== "string") return badRequest("content is required");
  if (typeof body.sha !== "string" || body.sha.length === 0) {
    // TODO(#115): 新規ファイル作成 (sha なし PUT) のサポート。
    //   現状は仕様乖離より UX 優先で 400 を返す。
    return badRequest("sha is required for update; create is not implemented yet (see #115)");
  }
  if (typeof body.message !== "string" || body.message.length === 0) {
    return badRequest("message is required");
  }

  const { owner, repo } = splitRepo(project);
  const branch = body.branch;
  const octokit = createGitHub(env);
  try {
    const res = await octokit.request("PUT /repos/{owner}/{repo}/contents/{path}", {
      owner,
      repo,
      path,
      message: body.message,
      content: utf8ToBase64(body.content),
      sha: body.sha,
      branch,
    });
    logRateLimit("contents.put", res.headers as Record<string, string | number | undefined>);

    // 該当パスの read キャッシュをパージ（branch 指定の有無を両方）。
    // NOTE(#118): 現状はこの Worker が触る branch / default 二系統だけパージしている。
    //   ブランチ横断でのパージは GitHub webhook 経由で #118 にて本実装する予定。
    await cacheDelete(contentsCacheKey(owner, repo, path, branch ?? null));
    await cacheDelete(contentsCacheKey(owner, repo, path, null));

    const data = res.data as ContentsPutResponseData;
    return jsonResponse(
      {
        path: data.content?.path ?? path,
        sha: data.content?.sha ?? null,
        commit_sha: data.commit?.sha ?? null,
      },
      200,
      { "x-cache": "PURGED" },
    );
  } catch (err) {
    const ne = normalizeError(err);
    logRateLimit("contents.put.err", ne.responseHeaders);
    // 409 (sha mismatch) は楽観ロック失敗としてそのまま伝える
    return jsonResponse({ error: ne.message, status: ne.status }, ne.status);
  }
}
