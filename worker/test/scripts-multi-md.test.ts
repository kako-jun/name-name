// kako-jun/name-name#284: マルチ MD 再生のための scriptsDir 対応テスト。
//
// handleListScripts は scriptsDir 指定プロジェクト（theo-hayami の
// content/scripts）では「起点ディレクトリ直下 + その直下のサブディレクトリ 1 段」
// の .md を列挙する。検証する観点:
//   1. 起点直下 + サブディレクトリ 1 段の .md が両方列挙される
//   2. 2 段目（サブのサブ）は列挙されない
//   3. あるサブの listing が 404 でも、起点直下 + 他サブの .md は返る（部分失敗を許容）
//   4. 起点ディレクトリ自体が 404 のときは status を伝播（致命）
//   5. scriptsDir 未指定プロジェクトは従来どおりリポ直下のみ列挙（後方互換）
//   6. 既存フィルタ（engine 必須・hidden・64KB 上限・件数上限）が scriptsDir 経路でも効く
//
// テスト対象プロジェクト: theo-hayami（projects.ts で scriptsDir: "content/scripts"）。
// scriptsDir 未指定の後方互換確認には ogurasia を使う。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/types";

const ENV: Env = {
  ALLOWED_ORIGIN: "https://name-name.llll-ll.com",
  DEFAULT_OWNER: "kako-jun",
  GITHUB_TOKEN: "test-pat",
  DEV_AUTH_TOKEN: "dev-token",
};

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

const ORIGINAL_FETCH = globalThis.fetch;

function utf8Base64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "x-ratelimit-remaining": "4999",
      "x-ratelimit-limit": "5000",
    },
  });
}

const SCRIPT_MD = `---
engine: name-name
chapter: 1
title: "せおはやみ — エントリ"
---

## 1-1: ようこそ

> ようこそ
`;

const FREE_A_MD = `---
engine: name-name
title: "フリー a"
---

## free-a

> free a
`;

const MAIN_B_MD = `---
engine: name-name
title: "メイン b"
---

## main-b

> main b
`;

const README_MD = `# せおはやみ

これは name-name エンジンを使ったゲーム。
`;

// content listing 1 件分のモック生成（dir / file 両対応）。
function entry(name: string, path: string, sha: string, size: number, type: "file" | "dir" = "file") {
  return { name, path, sha, size, type, download_url: null };
}

function mockFileContents(path: string, text: string, sha: string) {
  return {
    type: "file",
    path,
    sha,
    encoding: "base64",
    content: utf8Base64(text),
  };
}

// octokit は contents/{path} の path を URL エンコードする（slash も %2F）。
// 起点 path="" は `/contents?ref=...`、content/scripts は `/contents/content%2Fscripts?ref=...`、
// content/scripts/script.md は `/contents/content%2Fscripts%2Fscript.md?ref=...`。
//
// 重要: 「content/scripts の dir listing」と「content/scripts/script.md の content peek」は
// どちらも `/contents/content%2Fscripts` を含むため、prefix 一致では区別できない。
// エンコード済み path の直後が `?`（クエリ）または URL 末尾であることまで見て厳密一致する。
function isContentsRequest(url: string, path: string): boolean {
  const enc = path === "" ? "" : `/${encodeURIComponent(path)}`;
  // /contents{enc}（その後ろは ? か 末尾のみ。さらに深いセグメント %2F... は別 path）
  const re = new RegExp(`/contents${enc.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\?|$)`);
  return re.test(url);
}
function isRootListing(url: string): boolean {
  // path="" 起点（scriptsDir 未指定 ogurasia 用）
  return isContentsRequest(url, "");
}
function isDirListing(url: string, dirPath: string): boolean {
  return isContentsRequest(url, dirPath);
}
function isContentPeek(url: string, filePath: string): boolean {
  return isContentsRequest(url, filePath);
}

async function purgeCache(repo: string) {
  const cache = (caches as unknown as { default?: Cache }).default;
  if (!cache) return;
  for (const ref of ["default", "develop", "main"]) {
    await cache.delete(
      new Request(
        `https://name-name-cache.local/${encodeURIComponent(`scripts:kako-jun/${repo}:${ref}`)}`,
      ),
    );
  }
}

beforeEach(async () => {
  await purgeCache("theo-hayami");
  await purgeCache("ogurasia");
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  vi.restoreAllMocks();
});

describe("GET /api/projects/:name/scripts (scriptsDir / multi-MD #284)", () => {
  it("起点ディレクトリ直下 + サブディレクトリ 1 段の .md を両方列挙する", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      // 起点 content/scripts の listing
      if (isDirListing(url, "content/scripts")) {
        return jsonResponse([
          // 起点直下の .md
          entry("script.md", "content/scripts/script.md", "sha-script", 1234),
          // サブディレクトリ 1 段
          entry("free", "content/scripts/free", "sha-free-dir", 0, "dir"),
          entry("main", "content/scripts/main", "sha-main-dir", 0, "dir"),
        ]);
      }
      if (isDirListing(url, "content/scripts/free")) {
        return jsonResponse([entry("a.md", "content/scripts/free/a.md", "sha-a", 500)]);
      }
      if (isDirListing(url, "content/scripts/main")) {
        return jsonResponse([entry("b.md", "content/scripts/main/b.md", "sha-b", 600)]);
      }
      // 各 .md の content peek
      if (isContentPeek(url, "content/scripts/script.md")) {
        return jsonResponse(mockFileContents("content/scripts/script.md", SCRIPT_MD, "sha-script"));
      }
      if (isContentPeek(url, "content/scripts/free/a.md")) {
        return jsonResponse(mockFileContents("content/scripts/free/a.md", FREE_A_MD, "sha-a"));
      }
      if (isContentPeek(url, "content/scripts/main/b.md")) {
        return jsonResponse(mockFileContents("content/scripts/main/b.md", MAIN_B_MD, "sha-b"));
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const req = new Request("https://name-name-api.workers.dev/api/projects/theo-hayami/scripts");
    const res = await worker.fetch(req, ENV, ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { scripts: Array<{ path: string }> };
    const paths = body.scripts.map((s) => s.path);
    // 起点直下 + 両サブの .md が揃う
    expect(paths).toContain("content/scripts/script.md");
    expect(paths).toContain("content/scripts/free/a.md");
    expect(paths).toContain("content/scripts/main/b.md");
    expect(paths.length).toBe(3);
  });

  it("2 段目のサブディレクトリ（サブのサブ）は列挙されない（再帰は 1 段のみ）", async () => {
    const listedDirs: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (isDirListing(url, "content/scripts")) {
        listedDirs.push("content/scripts");
        return jsonResponse([
          entry("script.md", "content/scripts/script.md", "sha-script", 1234),
          entry("free", "content/scripts/free", "sha-free-dir", 0, "dir"),
        ]);
      }
      if (isDirListing(url, "content/scripts/free")) {
        listedDirs.push("content/scripts/free");
        return jsonResponse([
          entry("a.md", "content/scripts/free/a.md", "sha-a", 500),
          // サブのサブ（2 段目）— ここは降りないはず
          entry("nested", "content/scripts/free/nested", "sha-nested-dir", 0, "dir"),
        ]);
      }
      // 2 段目に降りてしまったら検知できるよう listedDirs に積む
      if (isDirListing(url, "content/scripts/free/nested")) {
        listedDirs.push("content/scripts/free/nested");
        return jsonResponse([entry("deep.md", "content/scripts/free/nested/deep.md", "sha-deep", 100)]);
      }
      if (isContentPeek(url, "content/scripts/script.md")) {
        return jsonResponse(mockFileContents("content/scripts/script.md", SCRIPT_MD, "sha-script"));
      }
      if (isContentPeek(url, "content/scripts/free/a.md")) {
        return jsonResponse(mockFileContents("content/scripts/free/a.md", FREE_A_MD, "sha-a"));
      }
      if (isContentPeek(url, "content/scripts/free/nested/deep.md")) {
        return jsonResponse(mockFileContents("content/scripts/free/nested/deep.md", MAIN_B_MD, "sha-deep"));
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const req = new Request("https://name-name-api.workers.dev/api/projects/theo-hayami/scripts");
    const res = await worker.fetch(req, ENV, ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { scripts: Array<{ path: string }> };
    const paths = body.scripts.map((s) => s.path);
    // 1 段目までは拾う
    expect(paths).toContain("content/scripts/script.md");
    expect(paths).toContain("content/scripts/free/a.md");
    // 2 段目の deep.md は拾わない
    expect(paths).not.toContain("content/scripts/free/nested/deep.md");
    // 2 段目のディレクトリ listing 自体が呼ばれていない
    expect(listedDirs).not.toContain("content/scripts/free/nested");
  });

  it("あるサブの listing が 404 でも、起点直下 + 他サブの .md は返る（部分失敗を許容）", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (isDirListing(url, "content/scripts")) {
        return jsonResponse([
          entry("script.md", "content/scripts/script.md", "sha-script", 1234),
          entry("free", "content/scripts/free", "sha-free-dir", 0, "dir"),
          entry("main", "content/scripts/main", "sha-main-dir", 0, "dir"),
        ]);
      }
      // free のサブ listing は 404（致命にせずスキップされるべき）
      if (isDirListing(url, "content/scripts/free")) {
        return jsonResponse({ message: "not found" }, 404);
      }
      if (isDirListing(url, "content/scripts/main")) {
        return jsonResponse([entry("b.md", "content/scripts/main/b.md", "sha-b", 600)]);
      }
      if (isContentPeek(url, "content/scripts/script.md")) {
        return jsonResponse(mockFileContents("content/scripts/script.md", SCRIPT_MD, "sha-script"));
      }
      if (isContentPeek(url, "content/scripts/main/b.md")) {
        return jsonResponse(mockFileContents("content/scripts/main/b.md", MAIN_B_MD, "sha-b"));
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const req = new Request("https://name-name-api.workers.dev/api/projects/theo-hayami/scripts");
    const res = await worker.fetch(req, ENV, ctx);
    // サブ 404 でも 200 で返る
    expect(res.status).toBe(200);
    const body = (await res.json()) as { scripts: Array<{ path: string }> };
    const paths = body.scripts.map((s) => s.path);
    expect(paths).toContain("content/scripts/script.md");
    expect(paths).toContain("content/scripts/main/b.md");
    // 404 だった free の .md は含まれない
    expect(paths.some((p) => p.startsWith("content/scripts/free/"))).toBe(false);
  });

  it("起点ディレクトリ自体が 404 のときは status を伝播する（致命）", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      // content/scripts 自体が無い → 404
      if (isDirListing(url, "content/scripts")) {
        return jsonResponse({ message: "not found" }, 404);
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const req = new Request("https://name-name-api.workers.dev/api/projects/theo-hayami/scripts");
    const res = await worker.fetch(req, ENV, ctx);
    expect(res.status).toBe(404);
  });

  it("scriptsDir 未指定プロジェクトは従来どおりリポ直下のみ列挙する（後方互換）", async () => {
    const listedPaths: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      // ogurasia はリポ直下（path=""）listing のみ。サブには降りない。
      if (isRootListing(url)) {
        listedPaths.push("root");
        return jsonResponse([
          entry("script.md", "script.md", "sha-script", 1234),
          // サブディレクトリがあっても降りない（scriptsDir 未指定）
          entry("chapters", "chapters", "sha-chapters-dir", 0, "dir"),
        ]);
      }
      if (isDirListing(url, "chapters")) {
        listedPaths.push("chapters");
        return jsonResponse([entry("c1.md", "chapters/c1.md", "sha-c1", 200)]);
      }
      if (isContentPeek(url, "script.md")) {
        return jsonResponse(mockFileContents("script.md", SCRIPT_MD, "sha-script"));
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const req = new Request("https://name-name-api.workers.dev/api/projects/ogurasia/scripts");
    const res = await worker.fetch(req, ENV, ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { scripts: Array<{ path: string }> };
    expect(body.scripts.map((s) => s.path)).toEqual(["script.md"]);
    // サブディレクトリ chapters には降りていない
    expect(listedPaths).not.toContain("chapters");
  });

  it("既存フィルタ（engine 必須・hidden・64KB 上限）が scriptsDir 経路でも効く", async () => {
    const fileFetches: string[] = [];
    const HIDDEN_MD = `---
engine: name-name
title: "隠し"
hidden: true
---

## hidden
> h
`;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (isDirListing(url, "content/scripts")) {
        return jsonResponse([
          entry("script.md", "content/scripts/script.md", "sha-script", 1234),
          // README は engine: name-name を持たない → frontmatter peek で除外
          entry("README.md", "content/scripts/README.md", "sha-readme", 100),
          // 64KB 超 → size で足切り（fetch されない）
          entry("huge.md", "content/scripts/huge.md", "sha-huge", 200 * 1024),
          entry("free", "content/scripts/free", "sha-free-dir", 0, "dir"),
        ]);
      }
      if (isDirListing(url, "content/scripts/free")) {
        return jsonResponse([
          // サブにある hidden: true の .md → 列挙されるが hidden フラグが立つ
          entry("hidden.md", "content/scripts/free/hidden.md", "sha-hidden", 300),
        ]);
      }
      fileFetches.push(url);
      if (isContentPeek(url, "content/scripts/script.md")) {
        return jsonResponse(mockFileContents("content/scripts/script.md", SCRIPT_MD, "sha-script"));
      }
      if (isContentPeek(url, "content/scripts/README.md")) {
        return jsonResponse(mockFileContents("content/scripts/README.md", README_MD, "sha-readme"));
      }
      if (isContentPeek(url, "content/scripts/free/hidden.md")) {
        return jsonResponse(mockFileContents("content/scripts/free/hidden.md", HIDDEN_MD, "sha-hidden"));
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const req = new Request("https://name-name-api.workers.dev/api/projects/theo-hayami/scripts");
    const res = await worker.fetch(req, ENV, ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      scripts: Array<{ path: string; hidden: boolean }>;
    };
    const paths = body.scripts.map((s) => s.path);
    // engine: name-name を持つ script.md と hidden.md は残る
    expect(paths).toContain("content/scripts/script.md");
    expect(paths).toContain("content/scripts/free/hidden.md");
    // README は engine を持たないので除外
    expect(paths).not.toContain("content/scripts/README.md");
    // huge.md は size 足切りで除外（content は fetch されない）
    expect(paths).not.toContain("content/scripts/huge.md");
    expect(fileFetches.some((u) => u.includes("huge.md"))).toBe(false);
    // サブの hidden.md は hidden フラグが立つ（scriptsDir 経路でも hidden 判定が効く）
    const hiddenScript = body.scripts.find((s) => s.path === "content/scripts/free/hidden.md");
    expect(hiddenScript?.hidden).toBe(true);
  });

  it("件数上限: theo-hayami の 260 本級を収め、暴走だけ 500 件で打ち切る", async () => {
    // 起点直下に 520 件の .md を置く → candidates.slice(0, 500) で 500 件に絞られる
    const many = Array.from({ length: 520 }, (_, i) =>
      entry(`s${i}.md`, `content/scripts/s${i}.md`, `sha-${i}`, 100),
    );
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (isDirListing(url, "content/scripts")) {
        return jsonResponse(many);
      }
      // 各 .md は engine: name-name の content を返す
      const m = url.match(/content%2Fscripts%2Fs(\d+)\.md/);
      if (m) {
        const i = m[1];
        return jsonResponse(
          mockFileContents(`content/scripts/s${i}.md`, SCRIPT_MD, `sha-${i}`),
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const req = new Request("https://name-name-api.workers.dev/api/projects/theo-hayami/scripts");
    const res = await worker.fetch(req, ENV, ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { scripts: Array<{ path: string }> };
    // 500 件で打ち切られる
    expect(body.scripts.length).toBe(500);
  });
});
