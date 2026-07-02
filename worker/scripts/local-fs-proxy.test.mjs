// local-fs-proxy.mjs のテスト (#371: GET /repos/:owner/:repo/git/trees/:tree_sha)。
//
// vitest ( workerd 上、`npm test` ) とは別レーン: このファイルは host 側の
// 素の Node プロセスで実サーバ/実 fs を触るため、node:test + node:assert を
// 使う。`npm run test:proxy` で実行する ( `npm test` から呼ばれる )。
//
// black-box: `node scripts/local-fs-proxy.mjs` を実際に spawn して HTTP で叩く。
// white-box: `walkTree` を直接 import して走査ロジックだけを検証する。
//
// white-box テストは `readFile` の呼び出し有無を node:test の
// `mock.module()` で監視するため `--experimental-test-module-mocks` フラグ
// が必要 (npm script 側で付与済み)。white-box import は `?case=...` の
// クエリ付き specifier を使い、テストごとに新しい module instance を
// evaluate させている。理由:
//   1. モジュール先頭の `LOCAL_REPOS_BASE` チェックが import 時に一度だけ
//      走る副作用を毎回リセットしたいわけではない (これは process.env を
//      先に設定しておけば一度で足りる) が、
//   2. `mock.module("node:fs/promises", ...)` は「まだ一度も読み込まれて
//      いない」specifier の解決だけをフックできる。同じ specifier を前の
//      テストで無印 import 済みだと、その module instance は実 fs に
//      linkされたまま再利用され、後から mock しても効かない。
//   クエリを変えるたびに Node は新しい module record として扱うため、
//   mock 設定後の import だけを確実に mocked fs へ向けられる。
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, rm, mkdir, writeFile, symlink } from "node:fs/promises";
import * as realFsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROXY_SCRIPT = path.join(__dirname, "local-fs-proxy.mjs");
const MODULE_URL = new URL("./local-fs-proxy.mjs", import.meta.url).href;

// white-box import 全体を通して満たしておけば良い (walkTree 自体は
// findRepoDir を使わないので中身は問わない)。
process.env.LOCAL_REPOS_BASE = process.env.LOCAL_REPOS_BASE || tmpdir();

let queryCounter = 0;
/** `walkTree` だけを fresh に import する (mock 適用前後の分離用)。 */
async function importWalkTree() {
  queryCounter += 1;
  const mod = await import(`${MODULE_URL}?case=${queryCounter}`);
  return mod.walkTree;
}

async function makeTmpDir(prefix) {
  return mkdtemp(path.join(tmpdir(), prefix));
}

/** git 実装から独立した sha 検証用: `git hash-object --stdin` を子プロセスで実行する。 */
function gitHashObjectStdin(buf) {
  return execFileSync("git", ["hash-object", "--stdin"], { input: buf }).toString().trim();
}

function findEntry(tree, relPath) {
  return tree.find((e) => e.path === relPath);
}

// ---------------------------------------------------------------------------
// white-box: walkTree() を直接呼ぶテスト
// ---------------------------------------------------------------------------

test("walkTree: T6 空の repoDir は空配列を返す", async (t) => {
  const dir = await makeTmpDir("t6-empty-");
  t.after(() => rm(dir, { recursive: true, force: true }));

  const walkTree = await importWalkTree();
  const tree = await walkTree(dir);
  assert.deepEqual(tree, []);
});

test("walkTree: T7 深さ2以上にネストした node_modules は除外される", async (t) => {
  const dir = await makeTmpDir("t7-nested-nm-");
  t.after(() => rm(dir, { recursive: true, force: true }));

  await mkdir(path.join(dir, "nested", "node_modules", "some-pkg"), { recursive: true });
  await writeFile(path.join(dir, "nested", "node_modules", "some-pkg", "index.js"), "module.exports = 1;");
  await writeFile(path.join(dir, "nested", "keep.md"), "# keep");

  const walkTree = await importWalkTree();
  const tree = await walkTree(dir);
  const paths = tree.map((e) => e.path);
  assert.ok(paths.includes("nested/keep.md"), "nested 配下の非除外ファイルは残る");
  assert.ok(
    !paths.some((p) => p.includes("node_modules")),
    "ネストした node_modules 配下は一切出てこない",
  );
});

test("walkTree: T8 .github ディレクトリは .git の部分一致で除外されない", async (t) => {
  const dir = await makeTmpDir("t8-dotgithub-");
  t.after(() => rm(dir, { recursive: true, force: true }));

  await mkdir(path.join(dir, ".github", "workflows"), { recursive: true });
  await writeFile(path.join(dir, ".github", "workflows", "ci.yml"), "name: ci");

  const walkTree = await importWalkTree();
  const tree = await walkTree(dir);
  const paths = tree.map((e) => e.path);
  assert.ok(
    paths.includes(".github/workflows/ci.yml"),
    "Set.has が完全一致であること (.git の部分一致で誤除外されない) の回帰防止",
  );
});

test("walkTree: T10/T5 小文字 .md ファイルの sha は git blob sha (git hash-object --stdin) と一致する", async (t) => {
  const dir = await makeTmpDir("t10-md-sha-");
  t.after(() => rm(dir, { recursive: true, force: true }));

  const content = Buffer.from("---\nengine: name-name\n---\n\n## scene\n> hello\n", "utf-8");
  await writeFile(path.join(dir, "script.md"), content);

  const walkTree = await importWalkTree();
  const tree = await walkTree(dir);
  const entry = findEntry(tree, "script.md");
  assert.ok(entry, "script.md のエントリが存在する");
  assert.equal(entry.type, "blob");
  assert.equal(entry.mode, "100644");
  assert.equal(entry.sha, gitHashObjectStdin(content));
  assert.equal(entry.size, content.length);
});

test("walkTree: T11 大文字/混在拡張子 (.MD, .Md) も .md 扱いで sha が計算される", async (t) => {
  const dir = await makeTmpDir("t11-case-ext-");
  t.after(() => rm(dir, { recursive: true, force: true }));

  const upper = Buffer.from("# upper", "utf-8");
  const mixed = Buffer.from("# mixed", "utf-8");
  await writeFile(path.join(dir, "UPPER.MD"), upper);
  await writeFile(path.join(dir, "Mixed.Md"), mixed);

  const walkTree = await importWalkTree();
  const tree = await walkTree(dir);

  const upperEntry = findEntry(tree, "UPPER.MD");
  const mixedEntry = findEntry(tree, "Mixed.Md");
  assert.equal(upperEntry.sha, gitHashObjectStdin(upper));
  assert.equal(mixedEntry.sha, gitHashObjectStdin(mixed));
});

test("walkTree: T12 ディレクトリでなくファイルとして存在する \".git\" は除外されず通常ファイル扱い", async (t) => {
  const dir = await makeTmpDir("t12-dotgit-file-");
  t.after(() => rm(dir, { recursive: true, force: true }));

  // ルート直下の ".git" はリポ自体の除外対象ディレクトリと衝突するので、
  // サブディレクトリの下に「ファイルとしての .git」を作る。
  await mkdir(path.join(dir, "sub"), { recursive: true });
  await writeFile(path.join(dir, "sub", ".git"), "gitdir: ../.git/modules/sub\n");

  const walkTree = await importWalkTree();
  const tree = await walkTree(dir);
  const entry = findEntry(tree, "sub/.git");
  assert.ok(entry, "ファイルとしての .git は除外されず一覧に出る (dirent.isDirectory() が false のため)");
  assert.equal(entry.type, "blob");
});

test("walkTree: T13 ファイルへの symlink はエントリに出ない", async (t) => {
  const dir = await makeTmpDir("t13-symlink-file-");
  t.after(() => rm(dir, { recursive: true, force: true }));

  await writeFile(path.join(dir, "target.md"), "# target");
  await symlink(path.join(dir, "target.md"), path.join(dir, "link.md"));

  const walkTree = await importWalkTree();
  const tree = await walkTree(dir);
  const paths = tree.map((e) => e.path);
  assert.ok(paths.includes("target.md"));
  assert.ok(!paths.includes("link.md"), "symlink 自体はエントリとして出ない (skip)");
});

test("walkTree: T14 ディレクトリへの symlink は中身も走査されない", async (t) => {
  const dir = await makeTmpDir("t14-symlink-dir-");
  t.after(() => rm(dir, { recursive: true, force: true }));

  await mkdir(path.join(dir, "realdir"), { recursive: true });
  await writeFile(path.join(dir, "realdir", "inside.md"), "# inside");
  await symlink(path.join(dir, "realdir"), path.join(dir, "linkdir"));

  const walkTree = await importWalkTree();
  const tree = await walkTree(dir);
  const paths = tree.map((e) => e.path);
  assert.ok(paths.includes("realdir/inside.md"), "実ディレクトリ側は走査される");
  assert.ok(
    !paths.some((p) => p.startsWith("linkdir/")),
    "symlink ディレクトリの中身は走査されない",
  );
  assert.ok(!paths.includes("linkdir"), "symlink ディレクトリ自体もエントリに出ない");
});

test("walkTree: T17 baseDir/64KB/README 除外は walkTree 自身の責務ではない (無加工で含まれる契約)", async (t) => {
  const dir = await makeTmpDir("t17-no-filter-");
  t.after(() => rm(dir, { recursive: true, force: true }));

  await writeFile(path.join(dir, "README.md"), "# readme (walkTree は除外しない)");
  const huge = Buffer.alloc(70 * 1024, "a"); // 64KB 超
  await writeFile(path.join(dir, "huge.md"), huge);
  // baseDir 相当のパス階層があっても walkTree はただの相対パスとして返すだけ。
  await mkdir(path.join(dir, "scripts-like-dir"), { recursive: true });
  await writeFile(path.join(dir, "scripts-like-dir", "nested.md"), "# nested");

  const walkTree = await importWalkTree();
  const tree = await walkTree(dir);
  const paths = tree.map((e) => e.path);
  assert.ok(paths.includes("README.md"), "README.md はフィルタされず含まれる (呼び出し元の責務)");
  const hugeEntry = findEntry(tree, "huge.md");
  assert.ok(hugeEntry, "64KB 超の .md もフィルタされず含まれる (呼び出し元の責務)");
  assert.equal(hugeEntry.size, huge.length);
  assert.ok(paths.includes("scripts-like-dir/nested.md"));
});

test("walkTree: T18 日本語ディレクトリ・ファイル名を正しく再帰し posix パスで往復する", async (t) => {
  const dir = await makeTmpDir("t18-japanese-");
  t.after(() => rm(dir, { recursive: true, force: true }));

  await mkdir(path.join(dir, "日本語ディレクトリ"), { recursive: true });
  const content = Buffer.from("# 日本語の中身\n", "utf-8");
  await writeFile(path.join(dir, "日本語ディレクトリ", "日本語ファイル.md"), content);

  const walkTree = await importWalkTree();
  const tree = await walkTree(dir);
  const entry = findEntry(tree, "日本語ディレクトリ/日本語ファイル.md");
  assert.ok(entry, "日本語パスが posix区切り(/) で正しく往復する");
  assert.equal(entry.sha, gitHashObjectStdin(content));
});

test("walkTree: T19 CRLF を含む .md 内容は変換なしの生バイトで hash される", async (t) => {
  const dir = await makeTmpDir("t19-crlf-");
  t.after(() => rm(dir, { recursive: true, force: true }));

  const content = Buffer.from("line1\r\nline2\r\n", "utf-8");
  await writeFile(path.join(dir, "crlf.md"), content);

  const walkTree = await importWalkTree();
  const tree = await walkTree(dir);
  const entry = findEntry(tree, "crlf.md");
  assert.equal(
    entry.sha,
    gitHashObjectStdin(content),
    "CRLF -> LF 等の正規化をせず生バイトのままハッシュされる",
  );
});

test("walkTree: T25 .gitignore 対象/未追跡ファイルも一覧に混入する (git 非統合の既知の仕様差)", async (t) => {
  const dir = await makeTmpDir("t25-gitignore-");
  t.after(() => rm(dir, { recursive: true, force: true }));

  execFileSync("git", ["init", "-q"], { cwd: dir });
  await writeFile(path.join(dir, ".gitignore"), "ignored.md\n");
  await writeFile(path.join(dir, "ignored.md"), "# should be gitignored");
  await writeFile(path.join(dir, "untracked.md"), "# never git add-ed");
  await writeFile(path.join(dir, "tracked.md"), "# tracked");
  execFileSync("git", ["add", "tracked.md", ".gitignore"], { cwd: dir });
  execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "-m", "init"], {
    cwd: dir,
  });

  const walkTree = await importWalkTree();
  const tree = await walkTree(dir);
  const paths = tree.map((e) => e.path);
  assert.ok(paths.includes("tracked.md"));
  assert.ok(paths.includes("ignored.md"), "walkTree は git を見ないので gitignore 対象も含まれる (仕様差)");
  assert.ok(paths.includes("untracked.md"), "walkTree は git を見ないので未追跡ファイルも含まれる (仕様差)");
});

// --- mock.module ベース: readFile の呼び出しそのものを監視するテスト ---

test("walkTree: T9 非 .md ファイルは sha:\"\" かつ readFile を一切呼ばない (spy)", async (t) => {
  const dir = await makeTmpDir("t9-nonmd-");
  t.after(() => rm(dir, { recursive: true, force: true }));
  const content = Buffer.from([0, 1, 2, 3, 4]);
  await writeFile(path.join(dir, "image.png"), content);

  const calls = [];
  const mocked = mock.module("node:fs/promises", {
    namedExports: {
      ...realFsPromises,
      readFile: async (...args) => {
        calls.push(args[0]);
        return realFsPromises.readFile(...args);
      },
    },
  });
  t.after(() => mocked.restore());

  const walkTree = await importWalkTree();
  const tree = await walkTree(dir);
  const entry = findEntry(tree, "image.png");
  assert.ok(entry);
  assert.equal(entry.sha, "");
  assert.equal(entry.size, content.length);
  assert.deepEqual(calls, [], "非 .md ファイルに対して readFile は呼ばれない (性能最適化の契約)");
});

test("walkTree: T15 .md の readFile 失敗は sha:\"\" にサイレントフォールバックする (ログ無し, spy)", async (t) => {
  const dir = await makeTmpDir("t15-readfail-");
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, "broken.md"), "content that will never be read");

  const mocked = mock.module("node:fs/promises", {
    namedExports: {
      ...realFsPromises,
      readFile: async () => {
        throw new Error("EACCES (simulated)");
      },
    },
  });
  t.after(() => mocked.restore());

  const errorCalls = [];
  const warnCalls = [];
  const origError = console.error;
  const origWarn = console.warn;
  console.error = (...args) => errorCalls.push(args);
  console.warn = (...args) => warnCalls.push(args);
  t.after(() => {
    console.error = origError;
    console.warn = origWarn;
  });

  const walkTree = await importWalkTree();
  const tree = await walkTree(dir);
  const entry = findEntry(tree, "broken.md");
  assert.ok(entry, "readFile が失敗してもエントリ自体は出る");
  assert.equal(entry.sha, "", "sha は空文字列にフォールバックする");
  assert.deepEqual(errorCalls, [], "現状は console.error を呼ばない (この仕様をロックする。改善はスコープ外)");
  assert.deepEqual(warnCalls, [], "現状は console.warn も呼ばない");
});

test("import only: エントリポイントガードにより import しただけではサーバが listen されない", async () => {
  // #371 最小リファクタの検証: `node scripts/local-fs-proxy.mjs` として直接
  // 実行された場合だけ listen し、import 経路では listen しないこと。
  // walkTree は既にこのファイル内で何度も import 済みなので、ここでは
  // デフォルトポート (9092) 以外の適当な空きポートを自前で bind できる
  // ことを確認して、モジュール側が何も掴んでいないことを傍証する。
  const net = await import("node:net");
  const probePort = 19599;
  await new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(probePort, "127.0.0.1", () => {
      srv.close(() => resolve());
    });
  });
});

// ---------------------------------------------------------------------------
// black-box: 実プロセスを spawn して HTTP で叩くテスト
// ---------------------------------------------------------------------------

let nextPort = 19600;
function allocPort() {
  nextPort += 1;
  return nextPort;
}

/**
 * 子プロセスに SIGTERM を送り、実際に `exit` イベントが発火するまで待つ。
 * `timeoutMs` 以内に exit しなければ SIGKILL にエスカレーションする。
 * kill シグナル送信だけで待たずに戻ると、負荷の高い CI で次のテストの
 * ポート確保や後片付けと競合してプロセスが残留し得るため (should #373)。
 */
function killAndWaitForExit(child, { timeoutMs = 3000 } = {}) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(escalate);
      resolve();
    };
    child.once("exit", finish);
    const escalate = setTimeout(() => {
      if (settled) return;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.kill("SIGTERM");
  });
}

/**
 * `node scripts/local-fs-proxy.mjs` を子プロセスとして起動し、listen ログを
 * 確認してから baseUrl を返す。t.after で確実に kill し、exit まで待つ。
 */
function startProxy(t, { reposBase, port = allocPort() }) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [PROXY_SCRIPT], {
      cwd: path.dirname(PROXY_SCRIPT),
      env: { ...process.env, LOCAL_REPOS_BASE: reposBase, LOCAL_FS_PROXY_PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error("timed out waiting for local-fs-proxy to start"));
    }, 5000);

    child.stdout.on("data", (chunk) => {
      if (settled) return;
      if (chunk.toString().includes("listening on")) {
        settled = true;
        clearTimeout(timeout);
        resolve({ baseUrl: `http://127.0.0.1:${port}`, child });
      }
    });
    let stderrBuf = "";
    child.stderr.on("data", (chunk) => {
      stderrBuf += chunk.toString();
    });
    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(new Error(`local-fs-proxy exited early (code=${code}): ${stderrBuf}`));
    });

    t.after(() => killAndWaitForExit(child));
  });
}

test("HTTP: T1 GET ?recursive=1 は 200 で {sha, tree, truncated:false} を返す", async (t) => {
  const parent = await makeTmpDir("http-t1-parent-");
  t.after(() => rm(parent, { recursive: true, force: true }));
  const repoDir = path.join(parent, "repo1");
  await mkdir(repoDir, { recursive: true });
  await writeFile(path.join(repoDir, "a.md"), "# a");

  const { baseUrl } = await startProxy(t, { reposBase: parent });
  const res = await fetch(`${baseUrl}/repos/kako-jun/repo1/git/trees/main?recursive=1`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.sha, "local");
  assert.equal(body.truncated, false);
  assert.ok(Array.isArray(body.tree));
  assert.ok(body.tree.some((e) => e.path === "a.md"));
});

test("HTTP: T2 存在しない repo 名は 404 と repo not found メッセージ", async (t) => {
  const parent = await makeTmpDir("http-t2-parent-");
  t.after(() => rm(parent, { recursive: true, force: true }));

  const { baseUrl } = await startProxy(t, { reposBase: parent });
  const res = await fetch(`${baseUrl}/repos/kako-jun/no-such-repo/git/trees/main?recursive=1`);
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.match(body.message, /repo not found locally: no-such-repo/);
});

test("HTTP: T3 /git/trees/:sha への POST は 405", async (t) => {
  const parent = await makeTmpDir("http-t3-parent-");
  t.after(() => rm(parent, { recursive: true, force: true }));
  await mkdir(path.join(parent, "repo1"), { recursive: true });

  const { baseUrl } = await startProxy(t, { reposBase: parent });
  const res = await fetch(`${baseUrl}/repos/kako-jun/repo1/git/trees/main`, { method: "POST" });
  assert.equal(res.status, 405);
});

test("HTTP: T4 URL に余分なセグメントがあると 500 にはならず汎用 404 に落ちる", async (t) => {
  const parent = await makeTmpDir("http-t4-parent-");
  t.after(() => rm(parent, { recursive: true, force: true }));
  await mkdir(path.join(parent, "repo1"), { recursive: true });

  const { baseUrl } = await startProxy(t, { reposBase: parent });
  const res = await fetch(`${baseUrl}/repos/kako-jun/repo1/git/trees/main/`);
  assert.notEqual(res.status, 500, "ルート不一致で 500 落ちしないこと");
  assert.equal(res.status, 404, "汎用 404 (endpoint not implemented) に落ちる");
});

test("HTTP: T20 サーバ起動後に新規作成したファイルは即座に一覧へ反映される (キャッシュ無し)", async (t) => {
  const parent = await makeTmpDir("http-t20-parent-");
  t.after(() => rm(parent, { recursive: true, force: true }));
  const repoDir = path.join(parent, "repo1");
  await mkdir(repoDir, { recursive: true });

  const { baseUrl } = await startProxy(t, { reposBase: parent });

  const res1 = await fetch(`${baseUrl}/repos/kako-jun/repo1/git/trees/main?recursive=1`);
  const body1 = await res1.json();
  assert.ok(!body1.tree.some((e) => e.path === "new.md"));

  await writeFile(path.join(repoDir, "new.md"), "# brand new");

  const res2 = await fetch(`${baseUrl}/repos/kako-jun/repo1/git/trees/main?recursive=1`);
  const body2 = await res2.json();
  assert.ok(
    body2.tree.some((e) => e.path === "new.md"),
    "起動中のサーバでもファイル追加が次のリクエストへ即反映される",
  );
});

test("HTTP: T21 変更なしで連続2回 GET すると結果が完全一致する", async (t) => {
  const parent = await makeTmpDir("http-t21-parent-");
  t.after(() => rm(parent, { recursive: true, force: true }));
  const repoDir = path.join(parent, "repo1");
  await mkdir(repoDir, { recursive: true });
  await writeFile(path.join(repoDir, "a.md"), "# a");
  await writeFile(path.join(repoDir, "b.txt"), "b");

  const { baseUrl } = await startProxy(t, { reposBase: parent });
  const res1 = await fetch(`${baseUrl}/repos/kako-jun/repo1/git/trees/main?recursive=1`);
  const res2 = await fetch(`${baseUrl}/repos/kako-jun/repo1/git/trees/main?recursive=1`);
  const [body1, body2] = await Promise.all([res1.json(), res2.json()]);
  assert.deepEqual(body1, body2);
});
