// Host-side proxy that emulates a *minimal subset* of the GitHub Contents API
// against locally cloned game repos.
//
// 起動経路:
//   `npm run dev` の dev.mjs から、`NAME_NAME_LOCAL=1` (または `--local` 引数) が
//   指定されたときに spawn される。Worker はこの中継を `GITHUB_API_BASE` 経由で
//   叩くだけなので、Worker 側コードは GitHub と本サービスを区別しない。
//
// 用途:
//   シナリオ編集中に毎回 push してから動作確認、を不要にする。
//   `/edit/<game>` で保存 → ローカル作業ツリーへ即反映、`/play/<game>` で読む
//   ときも push 前のローカルツリーから読む。
//
// 実装範囲:
//   - GET  /repos/:owner/:repo/contents/:path        (file / dir)
//   - PUT  /repos/:owner/:repo/contents/:path        (sha optional, mtime ベースの楽観ロック)
//   - GET  /repos/:owner/:repo/git/trees/:tree_sha   (常に再帰・ワーキングツリー現状を返す。#371)
//   - GET  /raw/:owner/:repo/:path                   (download_url 用 raw 配信)
//
// ゲームリポの探索:
//   `LOCAL_REPOS_BASE` で `:` 区切りの親ディレクトリを指定 (環境ごとに異なるので
//   コードに直書きしない)。各 base に対して `<base>/<repo>` を順に試して最初に
//   見つかったものを使う。
import http from "node:http";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.LOCAL_FS_PROXY_PORT ?? "9092");
const BASES = (process.env.LOCAL_REPOS_BASE ?? "")
  .split(path.delimiter)
  .map((s) => s.trim())
  .filter(Boolean);

if (BASES.length === 0) {
  console.error(
    "[local-fs-proxy] LOCAL_REPOS_BASE is empty; set it to a `:` separated list of parent dirs that contain game repos",
  );
  process.exit(1);
}

async function findRepoDir(name) {
  for (const base of BASES) {
    const p = path.join(base, name);
    try {
      const s = await stat(p);
      if (s.isDirectory()) return p;
    } catch {
      // not here
    }
  }
  return null;
}

/** GitHub の contents API は git blob SHA を `sha` フィールドで返す。 */
function gitBlobSha(content) {
  const header = Buffer.from(`blob ${content.length}\0`);
  const hash = crypto.createHash("sha1");
  hash.update(header);
  hash.update(content);
  return hash.digest("hex");
}

function isUnsafePath(rel) {
  if (rel.includes("..")) return true;
  if (rel.includes("\0")) return true;
  if (path.isAbsolute(rel)) return true;
  return false;
}

function jsonResponse(res, status, body) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function rawDownloadUrl(req, owner, repo, relPath) {
  const host = req.headers.host ?? `127.0.0.1:${PORT}`;
  return `http://${host}/raw/${owner}/${repo}/${relPath}`;
}

async function handleGetContents(req, res, owner, repo, relPath) {
  const repoDir = await findRepoDir(repo);
  if (!repoDir) return jsonResponse(res, 404, { message: `repo not found locally: ${repo}` });
  const filePath = path.join(repoDir, relPath);

  let st;
  try {
    st = await stat(filePath);
  } catch {
    return jsonResponse(res, 404, { message: "Not Found" });
  }

  if (st.isDirectory()) {
    const entries = await readdir(filePath, { withFileTypes: true });
    const items = await Promise.all(
      entries.map(async (e) => {
        const childPath = path.join(filePath, e.name);
        const cs = await stat(childPath);
        const childRel = path.posix.join(relPath, e.name);
        let sha = "";
        if (e.isFile()) {
          try {
            sha = gitBlobSha(await readFile(childPath));
          } catch {
            // unreadable file — fall through with empty sha
          }
        }
        return {
          name: e.name,
          path: childRel,
          sha,
          size: cs.size,
          type: e.isDirectory() ? "dir" : "file",
          download_url: e.isFile() ? rawDownloadUrl(req, owner, repo, childRel) : null,
        };
      }),
    );
    return jsonResponse(res, 200, items);
  }

  const buf = await readFile(filePath);
  return jsonResponse(res, 200, {
    type: "file",
    name: path.basename(relPath),
    path: relPath,
    sha: gitBlobSha(buf),
    size: buf.length,
    content: buf.toString("base64"),
    encoding: "base64",
    download_url: rawDownloadUrl(req, owner, repo, relPath),
  });
}

async function handlePutContents(req, res, owner, repo, relPath) {
  const repoDir = await findRepoDir(repo);
  if (!repoDir) return jsonResponse(res, 404, { message: `repo not found locally: ${repo}` });
  const filePath = path.join(repoDir, relPath);

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
  } catch {
    return jsonResponse(res, 400, { message: "invalid JSON body" });
  }
  if (typeof body.content !== "string") {
    return jsonResponse(res, 400, { message: "content is required (base64)" });
  }
  const decoded = Buffer.from(body.content.replace(/\s+/g, ""), "base64");

  // 楽観ロック: body.sha があり、現存ファイルの sha と一致しなければ 409。
  // 新規作成 (sha 無し) で既にファイルがあれば 422 (GitHub と同じ)
  let existing = null;
  try {
    existing = await readFile(filePath);
  } catch {
    // 新規
  }
  if (body.sha) {
    if (!existing) return jsonResponse(res, 404, { message: "sha given but file missing" });
    if (gitBlobSha(existing) !== body.sha) {
      return jsonResponse(res, 409, { message: "sha mismatch (file changed locally)" });
    }
  } else if (existing) {
    return jsonResponse(res, 422, { message: "file already exists; pass sha to update" });
  }

  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, decoded);
  const newSha = gitBlobSha(decoded);
  return jsonResponse(res, 200, {
    content: {
      path: relPath,
      sha: newSha,
      size: decoded.length,
    },
    commit: {
      // 実 commit は作らない (kako-jun が後で手で commit/push する想定)。
      // 形だけ埋めて Worker 側の型を満たす。
      sha: `local-${Date.now()}`,
      message: body.message ?? `local edit ${relPath}`,
    },
  });
}

// git/trees でスキップするディレクトリ。theo-hayami 自体には無いが、将来
// scriptsDir を使う別リポで巨大ディレクトリを踏まないための防御。
const TREE_EXCLUDED_DIRS = new Set([".git", "node_modules"]);

// 呼び出し元 (`worker/src/scripts.ts` の `listScriptsFromTree` / `pickMdFiles`)
// が実際に使うのは `.md` かつ `size <= 64 * 1024` のファイルだけ、という
// フィルタ条件を先取りして無駄な readFile を避けるための早期判定用の閾値。
// フィルタ条件そのものの正本は呼び出し元にあり、ここではそれと同じ値を
// 重複させて「どうせ後で捨てられるなら読まない」という I/O 最適化にだけ
// 使う（walkTree 自身がフィルタするわけではない。詳細は下の docstring）。
const MD_SHA_MAX_SIZE_BYTES = 64 * 1024;

/**
 * リポのワーキングディレクトリを再帰的に歩き、GitHub Git Trees API
 * (`recursive=1`) のレスポンス形状に沿ったエントリ配列を組み立てる。
 *
 * パフォーマンス最重要: theo-hayami の作業ツリーは docs 配下の参考画像等を
 * 含めて 1GB 超ある。呼び出し元 (`listScriptsFromTree`) が実際に使うのは
 * `.md` かつ `MD_SHA_MAX_SIZE_BYTES` 以下のファイルだけなので、blob sha を
 * 計算するために全文を読み込むのは、その条件を満たす `.md` ファイルだけに
 * 限定する。それ以外（非 `.md`、または `.md` でも閾値超のファイル）は
 * stat のみでサイズを取り、sha は空文字列を返す（呼び出し元はどちらの
 * ケースも filter で弾くため sha を読まない）。
 *
 * 注意: これは walkTree 自体が呼び出し元のフィルタ条件を代行している
 * わけではない。エントリ自体は（サイズに関わらず）常に一覧に含める。
 * あくまで「どうせ後で捨てられる readFile」を避けるための早期判定。
 *
 * HTTP ハンドラ本体から分離してあるのは、テストがこの関数を直接呼んで
 * 走査ロジックだけを検証できるようにするため。export しているのも同じ理由
 * (#371 テストからの white-box import 用)。
 */
export async function walkTree(repoDir) {
  const entries = [];

  async function walk(dir, relDir) {
    const dirents = await readdir(dir, { withFileTypes: true });
    for (const dirent of dirents) {
      if (dirent.isDirectory()) {
        if (TREE_EXCLUDED_DIRS.has(dirent.name)) continue;
        await walk(
          path.join(dir, dirent.name),
          path.posix.join(relDir, dirent.name),
        );
        continue;
      }
      if (!dirent.isFile()) continue; // symlink 等は対象外

      const childPath = path.join(dir, dirent.name);
      const relPath = path.posix.join(relDir, dirent.name);
      const cs = await stat(childPath);

      let sha = "";
      if (dirent.name.toLowerCase().endsWith(".md") && cs.size <= MD_SHA_MAX_SIZE_BYTES) {
        try {
          sha = gitBlobSha(await readFile(childPath));
        } catch {
          // unreadable file — fall through with empty sha
        }
      }

      entries.push({
        path: relPath,
        mode: "100644",
        type: "blob",
        sha,
        size: cs.size,
      });
    }
  }

  await walk(repoDir, "");
  return entries;
}

async function handleGetTree(req, res, owner, repo) {
  const repoDir = await findRepoDir(repo);
  if (!repoDir) return jsonResponse(res, 404, { message: `repo not found locally: ${repo}` });
  const tree = await walkTree(repoDir);
  // tree_sha / recursive クエリは無視: ローカル fs モードは常にワーキング
  // ツリーの現状を再帰的に返す（呼び出し元は常に recursive=1 で呼ぶ唯一の
  // 用途しか無いため）。
  return jsonResponse(res, 200, { sha: "local", tree, truncated: false });
}

async function handleRaw(req, res, owner, repo, relPath) {
  const repoDir = await findRepoDir(repo);
  if (!repoDir) {
    res.statusCode = 404;
    res.end("not found");
    return;
  }
  const filePath = path.join(repoDir, relPath);
  try {
    const buf = await readFile(filePath);
    res.statusCode = 200;
    res.setHeader("content-length", String(buf.byteLength));
    res.end(buf);
  } catch {
    res.statusCode = 404;
    res.end("not found");
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
    let m;

    m = url.pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/contents\/(.+)$/);
    if (m) {
      const [, owner, repo, rawRelPath] = m;
      // Octokit は path テンプレートを URL エンコードするため `/` が `%2F` に
      // なりうる。GitHub 側はどちらも受けるので、こちらでも decode してから扱う。
      const relPath = decodeURIComponent(rawRelPath);
      if (isUnsafePath(relPath)) return jsonResponse(res, 400, { message: "unsafe path" });
      if (req.method === "GET") return handleGetContents(req, res, owner, repo, relPath);
      if (req.method === "PUT") return handlePutContents(req, res, owner, repo, relPath);
      return jsonResponse(res, 405, { message: "method not allowed" });
    }

    m = url.pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/git\/trees\/([^/]+)$/);
    if (m) {
      const [, owner, repo] = m; // tree_sha は無視（常に HEAD ワーキングツリー相当）
      if (req.method === "GET") return handleGetTree(req, res, owner, repo);
      return jsonResponse(res, 405, { message: "method not allowed" });
    }

    m = url.pathname.match(/^\/raw\/([^/]+)\/([^/]+)\/(.+)$/);
    if (m) {
      const [, owner, repo, rawRelPath] = m;
      const relPath = decodeURIComponent(rawRelPath);
      if (isUnsafePath(relPath)) return jsonResponse(res, 400, { message: "unsafe path" });
      return handleRaw(req, res, owner, repo, relPath);
    }

    return jsonResponse(res, 404, { message: "endpoint not implemented in local-fs-proxy" });
  } catch (err) {
    console.error("[local-fs-proxy] error:", err);
    return jsonResponse(res, 500, { message: String(err) });
  }
});

// エントリポイントガード: `node scripts/local-fs-proxy.mjs` として直接起動
// されたときだけ listen する。テストが `walkTree` を white-box import する
// ときに副作用として port を握ってしまわないようにするため (#371)。
const isMainModule = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMainModule) {
  server.listen(PORT, "127.0.0.1", () => {
    console.log(`[local-fs-proxy] listening on http://127.0.0.1:${PORT} (bases: ${BASES.join(", ")})`);
  });
}
