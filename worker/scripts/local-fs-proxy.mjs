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
//   - GET  /repos/:owner/:repo/contents/:path  (file / dir)
//   - PUT  /repos/:owner/:repo/contents/:path  (sha optional, mtime ベースの楽観ロック)
//   - GET  /raw/:owner/:repo/:path             (download_url 用 raw 配信)
//
// ゲームリポの探索:
//   `LOCAL_REPOS_BASE` で `:` 区切りの親ディレクトリを指定 (環境ごとに異なるので
//   コードに直書きしない)。各 base に対して `<base>/<repo>` を順に試して最初に
//   見つかったものを使う。
import http from "node:http";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

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

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[local-fs-proxy] listening on http://127.0.0.1:${PORT} (bases: ${BASES.join(", ")})`);
});
