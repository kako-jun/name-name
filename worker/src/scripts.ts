// /api/projects/:name/scripts ハンドラ (#237 / 親 #234)
//
// プロジェクトリポのルート直下にある `.md` のうち frontmatter に
// `engine: name-name` を含むものを列挙して返す。エディタの「ファイルタブ」UI の元データ。
//
// 戦略:
//   1. Contents API でルート directory listing → `.md` で size <= 64KB を pick
//      （ノベルゲーム原稿で 64KB 超は普通無い。assets/ 等は dir として弾かれる）
//   2. 各 .md について short content fetch → 先頭 1〜2KB を peek
//      → frontmatter (`--- ... ---`) を抽出 → engine: name-name を含むか判定
//   3. 含むものだけ `[{ path, title, hidden, sha, size }]` で返す
//
// 設計判断:
//   - GitHub の Contents API は dir 取得時に各 file の content は返さないので、
//     N 回 fetch する必要がある。プロジェクトルートの .md は通常 1〜5 個なので許容。
//   - listing は worker の Cache API で 30s キャッシュする（既存方針 #118）。
//     保存時に cacheDelete で個別 contents パージしているが、scripts listing は
//     新規 .md 追加時にしか変化しないので別キーで管理する。
//   - frontmatter は YAML パーサを持ち込まず、簡易な正規表現抽出で済ませる。
//     name-name のシナリオ frontmatter は engine / title / chapter / hidden 程度しか
//     使わず、quoted strings や nested objects は想定しない。

import type { Endpoints } from "@octokit/types";
import { cacheGet, cachePut } from "./cache";
import { createGitHub, logRateLimit, normalizeError } from "./github";
import { findProject, splitRepo } from "./projects";
import type { Env } from "./types";

type ContentsGetResponseData =
  Endpoints["GET /repos/{owner}/{repo}/contents/{path}"]["response"]["data"];

export interface ScriptInfo {
  path: string;
  sha: string;
  size: number;
  /** frontmatter title （`title:` 行）。無ければ path を流用する想定でクライアントに任せる */
  title: string | null;
  /** frontmatter `hidden: true` フラグ。`/play` 側は hidden=true を露出しない想定 */
  hidden: boolean;
}

interface ScriptsListResponse {
  scripts: ScriptInfo[];
}

function jsonResponse(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...extraHeaders },
  });
}

/** scripts listing 用の Cache API キー（contents/assets と衝突しない prefix） */
function scriptsCacheKey(owner: string, repo: string, ref: string | null): string {
  return `scripts:${owner}/${repo}:${ref ?? "default"}`;
}

/** base64 → utf-8 (contents.ts と同じ実装。ここに inline するのは循環 import を避けるため) */
function base64ToUtf8(b64: string): string {
  const cleaned = b64.replace(/\s+/g, "");
  const bin = atob(cleaned);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder("utf-8").decode(bytes);
}

/**
 * Markdown 先頭の YAML frontmatter を抽出する。
 * 厳密な YAML パースはせず、`---\n` で始まり `\n---\n` で閉じるブロックの中の
 * `key: value` を素朴に拾うだけ。quote / nested / multiline は未対応。
 */
function parseFrontmatter(text: string): Record<string, string> {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const lines = m[1].split(/\r?\n/);
  const result: Record<string, string> = {};
  for (const line of lines) {
    const kv = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.+?)\s*$/);
    if (!kv) continue;
    let value = kv[2];
    // `"...".` `'...'` を剥がす
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    result[kv[1]] = value;
  }
  return result;
}

/** name-name のシナリオ .md かどうか */
function isNameNameScript(fm: Record<string, string>): boolean {
  return fm.engine === "name-name";
}

export async function handleListScripts(
  request: Request,
  env: Env,
  projectName: string,
): Promise<Response> {
  const project = findProject(projectName);
  if (!project) return jsonResponse({ error: `unknown project: ${projectName}` }, 404);

  const url = new URL(request.url);
  const ref = url.searchParams.get("ref");
  const { owner, repo } = splitRepo(project);

  const cacheKey = scriptsCacheKey(owner, repo, ref);
  const hit = await cacheGet(cacheKey);
  if (hit) {
    const cloned = new Response(hit.body, hit);
    cloned.headers.set("x-cache", "HIT");
    return cloned;
  }

  const octokit = createGitHub(env);

  // Step 1: ルートディレクトリ listing
  let rootListing: ContentsGetResponseData;
  try {
    const res = await octokit.request("GET /repos/{owner}/{repo}/contents/{path}", {
      owner,
      repo,
      path: "",
      ref: ref ?? undefined,
    });
    logRateLimit("scripts.list.root", res.headers as Record<string, string | number | undefined>);
    rootListing = res.data as ContentsGetResponseData;
  } catch (err) {
    const ne = normalizeError(err);
    logRateLimit("scripts.list.root.err", ne.responseHeaders);
    return jsonResponse({ error: ne.message }, ne.status);
  }

  if (!Array.isArray(rootListing)) {
    // ルートがファイル単体 = 想定外の repo 構成
    return jsonResponse({ error: "repository root is not a directory" }, 502);
  }

  // 0 件 .md の repo もありうる（external_url 型）。空配列で返す。
  const candidates = rootListing
    .filter((entry) => entry.type === "file" && entry.name.toLowerCase().endsWith(".md"))
    // 64KB 上限: ノベルゲーム原稿として現実的な上限。
    // README 等のメタファイルは frontmatter peek で弾けるが、サイズで足切りすることで N 回 fetch のコストを抑える。
    .filter((entry) => entry.size <= 64 * 1024)
    // ファイル数上限: ルートに 50 個以上 .md がある repo は対象外（暴走防止）
    .slice(0, 50);

  // Step 2: 各 .md について content fetch → frontmatter peek
  const scripts: ScriptInfo[] = [];
  for (const entry of candidates) {
    try {
      const res = await octokit.request("GET /repos/{owner}/{repo}/contents/{path}", {
        owner,
        repo,
        path: entry.path,
        ref: ref ?? undefined,
      });
      const data = res.data as ContentsGetResponseData;
      if (Array.isArray(data) || data.type !== "file" || typeof data.content !== "string") {
        continue;
      }
      const text = base64ToUtf8(data.content);
      const fm = parseFrontmatter(text);
      if (!isNameNameScript(fm)) continue;
      scripts.push({
        path: entry.path,
        sha: entry.sha,
        size: entry.size,
        title: fm.title ?? null,
        hidden: fm.hidden === "true",
      });
    } catch (err) {
      // 個別ファイルの失敗は listing 全体を落とさず、ログだけ残してスキップ
      console.error(`[scripts.list] failed to peek ${entry.path}`, err);
      continue;
    }
  }

  // script.md を先頭に固定 → 他は path 昇順
  scripts.sort((a, b) => {
    if (a.path === "script.md") return -1;
    if (b.path === "script.md") return 1;
    return a.path.localeCompare(b.path);
  });

  const body: ScriptsListResponse = { scripts };
  const response = jsonResponse(body, 200, { "x-cache": "MISS" });
  await cachePut(cacheKey, response);
  return response;
}
