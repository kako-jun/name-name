// /api/projects/:name/scripts ハンドラ (#237 / 親 #234)
//
// プロジェクトリポのシナリオ `.md` のうち frontmatter に
// `engine: name-name` を含むものを列挙して返す。エディタの「ファイルタブ」UI の元データ。
//
// 列挙対象（#284 マルチ MD 再生）:
//   - `scriptsDir` 未指定のプロジェクト: 従来どおりリポ直下のみ
//   - `scriptsDir` 指定のプロジェクト（例 theo-hayami の `content/scripts`）:
//     その直下 + その直下のサブディレクトリ 1 段（例 content/scripts/free/、
//     content/scripts/main/）まで再帰列挙する。再帰は 1 段で十分。
//
// 戦略:
//   - `scriptsDir` 指定プロジェクトは Git Trees API の recursive tree で `.md` を一括列挙する。
//     theo-hayami のような 260 本級で、一覧APIが各MD本文を260回 fetch して1分級になるのを避ける。
//   - `scriptsDir` 未指定プロジェクトは従来どおり、リポ直下 .md の本文を peek して
//     frontmatter (`engine: name-name`, `hidden`, `title`) を読む。ルート直下は通常数本なので許容。
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
type GitTreeResponseData =
  Endpoints["GET /repos/{owner}/{repo}/git/trees/{tree_sha}"]["response"]["data"];

export interface ScriptInfo {
  path: string;
  sha: string;
  size: number;
  /** frontmatter title （`title:` 行）。無ければ path を流用する想定でクライアントに任せる */
  title: string | null;
  /** frontmatter `hidden: true` フラグ。`/play` 側は hidden=true を露出しない想定 */
  hidden: boolean;
}

// theo-hayami は 260 本超の短いセルを scriptsDir 配下に持つ。50 件で切ると
// メニューのジャンプ先 scene が jumpSceneIndex に入らず、選択後に空表示になる。
// 暴走防止は残すが、実運用の全セルを列挙できる余裕を持たせる。
const MAX_SCRIPT_FILES = 500;

interface ScriptsListResponse {
  scripts: ScriptInfo[];
}

function jsonResponse(
  body: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...extraHeaders,
    },
  });
}

/** scripts listing 用の Cache API キー（contents/assets と衝突しない prefix）。
 *  PUT contents で `.md` を書いた直後に scripts listing が古いまま残らないよう、
 *  contents.ts から `cacheDelete(scriptsCacheKey(...))` で呼ばれる（#237 review M2）。 */
export function scriptsCacheKey(
  owner: string,
  repo: string,
  ref: string | null,
): string {
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
    // quoted string でなければ末尾 `#` 以降をコメントとして剥がす (#237 review S4)。
    // quoted 内の `#` は値の一部なので保護する。
    const quoted =
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"));
    if (!quoted) {
      const hashIdx = value.indexOf("#");
      if (hashIdx >= 0) {
        value = value.slice(0, hashIdx).trimEnd();
      }
    } else {
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

/** ディレクトリ listing 1 件分の最小型（必要フィールドだけ） */
interface DirEntry {
  name: string;
  path: string;
  sha: string;
  size: number;
  type: string;
}

interface TreeEntry {
  path?: string;
  mode?: string;
  type?: string;
  sha?: string;
  size?: number;
}

type Octokit = ReturnType<typeof createGitHub>;

/**
 * 指定ディレクトリ（リポ相対 path。`""` はリポ直下）を Contents API で listing する。
 * directory でないファイル単体 path だった場合・listing 失敗時は null を返す
 * （呼び出し側でスキップ）。
 */
async function listDirectory(
  octokit: Octokit,
  owner: string,
  repo: string,
  path: string,
  ref: string | null,
  logLabel: string,
): Promise<DirEntry[] | null> {
  try {
    const res = await octokit.request(
      "GET /repos/{owner}/{repo}/contents/{path}",
      {
        owner,
        repo,
        path,
        ref: ref ?? undefined,
      },
    );
    logRateLimit(
      logLabel,
      res.headers as Record<string, string | number | undefined>,
    );
    const data = res.data as ContentsGetResponseData;
    if (!Array.isArray(data)) return null;
    return data as unknown as DirEntry[];
  } catch (err) {
    const ne = normalizeError(err);
    logRateLimit(`${logLabel}.err`, ne.responseHeaders);
    // 正規化したエラーを throw する。起点ディレクトリ listing の失敗は致命として
    // 呼び出し側へ伝播し、scriptsDir 配下のサブディレクトリ listing の失敗は
    // 呼び出し側が try/catch で握り潰してスキップする。
    throw ne;
  }
}

async function listScriptsFromTree(
  octokit: Octokit,
  owner: string,
  repo: string,
  baseDir: string,
  ref: string | null,
): Promise<ScriptInfo[]> {
  const res = await octokit.request(
    "GET /repos/{owner}/{repo}/git/trees/{tree_sha}",
    {
      owner,
      repo,
      tree_sha: ref ?? "HEAD",
      recursive: "1",
    },
  );
  logRateLimit(
    "scripts.tree",
    res.headers as Record<string, string | number | undefined>,
  );
  const data = res.data as GitTreeResponseData;
  const prefix = baseDir.length > 0 ? `${baseDir}/` : "";
  const scripts = (data.tree as TreeEntry[])
    .filter((entry) => {
      if (entry.type !== "blob") return false;
      if (!entry.path?.startsWith(prefix)) return false;
      const relative = entry.path.slice(prefix.length);
      if (
        !relative ||
        (relative.includes("/") && relative.split("/").length > 2)
      )
        return false;
      if (relative.toLowerCase() === "readme.md") return false;
      return (
        entry.path.toLowerCase().endsWith(".md") &&
        (entry.size ?? 0) <= 64 * 1024
      );
    })
    .slice(0, MAX_SCRIPT_FILES)
    .map((entry) => ({
      path: entry.path as string,
      sha: entry.sha ?? "",
      size: entry.size ?? 0,
      title: null,
      hidden: false,
    }));

  scripts.sort(compareScriptInfo);
  return scripts;
}

function compareScriptInfo(a: ScriptInfo, b: ScriptInfo): number {
  if (a.path === "script.md" || a.path.endsWith("/script.md")) return -1;
  if (b.path === "script.md" || b.path.endsWith("/script.md")) return 1;
  return a.path.localeCompare(b.path);
}

export async function handleListScripts(
  request: Request,
  env: Env,
  projectName: string,
): Promise<Response> {
  const project = findProject(projectName);
  if (!project)
    return jsonResponse({ error: `unknown project: ${projectName}` }, 404);

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

  // Step 1: 列挙対象ディレクトリの directory listing。
  //   - scriptsDir 未指定: リポ直下（path=""）のみ
  //   - scriptsDir 指定: その直下 + その直下のサブディレクトリ 1 段
  // 「列挙の起点ディレクトリ」を 1 つ決め、そこから 1 段だけ下りる。
  const baseDir = project.scriptsDir
    ? project.scriptsDir.replace(/^\/+|\/+$/g, "") // 前後の / を剥がす
    : "";

  if (project.scriptsDir) {
    try {
      const body: ScriptsListResponse = {
        scripts: await listScriptsFromTree(octokit, owner, repo, baseDir, ref),
      };
      const response = jsonResponse(body, 200, { "x-cache": "MISS" });
      await cachePut(cacheKey, response);
      return response;
    } catch (err) {
      const ne = normalizeError(err);
      return jsonResponse({ error: ne.message }, ne.status);
    }
  }

  // 起点ディレクトリ listing。失敗（404 等）は致命なのでそのまま伝播する。
  let baseListing: DirEntry[];
  try {
    const listed = await listDirectory(
      octokit,
      owner,
      repo,
      baseDir,
      ref,
      "scripts.list.root",
    );
    if (listed === null) {
      // 起点がファイル単体 = 想定外の repo 構成
      return jsonResponse(
        { error: "scripts directory is not a directory" },
        502,
      );
    }
    baseListing = listed;
  } catch (err) {
    const ne = normalizeError(err);
    return jsonResponse({ error: ne.message }, ne.status);
  }

  // .md ファイルを拾うフィルタ（64KB 足切り）。
  const pickMdFiles = (entries: DirEntry[]): DirEntry[] =>
    entries.filter(
      (entry) =>
        entry.type === "file" &&
        entry.name.toLowerCase().endsWith(".md") &&
        // 64KB 上限: ノベルゲーム原稿として現実的な上限。
        // README 等のメタファイルは frontmatter peek で弾けるが、サイズで足切りすることで N 回 fetch のコストを抑える。
        entry.size <= 64 * 1024,
    );

  // 起点直下の .md
  let candidates: DirEntry[] = pickMdFiles(baseListing);

  // scriptsDir 指定時のみ、起点直下のサブディレクトリ 1 段を下りて .md を足す。
  // （再帰は 1 段で十分。サブの中のサブは見ない）
  if (project.scriptsDir) {
    const subDirs = baseListing
      .filter((entry) => entry.type === "dir")
      // サブディレクトリ数上限（暴走防止）
      .slice(0, 50);
    for (const dir of subDirs) {
      let subListing: DirEntry[] | null;
      try {
        subListing = await listDirectory(
          octokit,
          owner,
          repo,
          dir.path,
          ref,
          "scripts.list.sub",
        );
      } catch {
        // サブディレクトリ listing の失敗は listing 全体を落とさずスキップ
        continue;
      }
      if (subListing) candidates = candidates.concat(pickMdFiles(subListing));
    }
  }

  // ファイル数上限: 大量 MD プロジェクトでも全 scene を jumpSceneIndex に入れる。
  // ここで落としたファイルの scene へ選択ジャンプすると再生不能になるため、
  // theo-hayami の 260 本級を収めつつ暴走だけ止める上限にする。
  candidates = candidates.slice(0, MAX_SCRIPT_FILES);

  // Step 2: 各 .md について content fetch → frontmatter peek
  const scripts: ScriptInfo[] = [];
  for (const entry of candidates) {
    try {
      const res = await octokit.request(
        "GET /repos/{owner}/{repo}/contents/{path}",
        {
          owner,
          repo,
          path: entry.path,
          ref: ref ?? undefined,
        },
      );
      const data = res.data as ContentsGetResponseData;
      if (
        Array.isArray(data) ||
        data.type !== "file" ||
        typeof data.content !== "string"
      ) {
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
  scripts.sort(compareScriptInfo);

  const body: ScriptsListResponse = { scripts };
  const response = jsonResponse(body, 200, { "x-cache": "MISS" });
  await cachePut(cacheKey, response);
  return response;
}
