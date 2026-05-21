// Issue #237 / #234: scripts listing endpoint テスト。
// ルート直下の `.md` のうち frontmatter `engine: name-name` を含むものだけ返す。
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
title: "オグラシア — 機能ショーケース"
---

## 1-1: ようこそ

> ようこそ
`;

const DATA_MD = `---
engine: name-name
chapter: 1
title: "オグラシア — マスターデータ"
hidden: true
---

## data: マスター

[モンスター slime]
名前: スライム
[/モンスター]
`;

const README_MD = `# オグラシア

これは name-name エンジンを使ったゲーム。
`;

function mockRoot(entries: Array<{ name: string; path: string; sha: string; size: number; type?: string }>) {
  return entries.map((e) => ({
    name: e.name,
    path: e.path,
    sha: e.sha,
    size: e.size,
    type: e.type ?? "file",
    download_url: null,
  }));
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

beforeEach(async () => {
  const cache = (caches as unknown as { default?: Cache }).default;
  if (cache) {
    for (const ref of ["default", "develop", "main"]) {
      await cache.delete(
        new Request(
          `https://name-name-cache.local/${encodeURIComponent(`scripts:kako-jun/ogurasia:${ref}`)}`,
        ),
      );
    }
  }
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  vi.restoreAllMocks();
});

describe("GET /api/projects/:name/scripts", () => {
  it("returns name-name .md files at the project root with title and hidden flag", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      // ルートディレクトリ listing は path="" を返す（octokit は `contents/` で取りに行く）
      if (url.match(/\/repos\/kako-jun\/ogurasia\/contents\/?$/) || url.match(/\/contents\/?\?/)) {
        return jsonResponse(
          mockRoot([
            { name: "script.md", path: "script.md", sha: "sha-script", size: 1234 },
            { name: "data.md", path: "data.md", sha: "sha-data", size: 567 },
            { name: "README.md", path: "README.md", sha: "sha-readme", size: 100 },
          ]),
        );
      }
      if (url.includes("/contents/script.md")) {
        return jsonResponse(mockFileContents("script.md", SCRIPT_MD, "sha-script"));
      }
      if (url.includes("/contents/data.md")) {
        return jsonResponse(mockFileContents("data.md", DATA_MD, "sha-data"));
      }
      if (url.includes("/contents/README.md")) {
        return jsonResponse(mockFileContents("README.md", README_MD, "sha-readme"));
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const req = new Request(
      "https://name-name-api.workers.dev/api/projects/ogurasia/scripts",
    );
    const res = await worker.fetch(req, ENV, ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      scripts: Array<{ path: string; title: string | null; hidden: boolean; sha: string; size: number }>;
    };
    expect(body.scripts.map((s) => s.path)).toEqual(["script.md", "data.md"]);
    // script.md は先頭固定
    expect(body.scripts[0].path).toBe("script.md");
    expect(body.scripts[0].title).toContain("ショーケース");
    expect(body.scripts[0].hidden).toBe(false);
    // data.md は hidden: true で識別される
    expect(body.scripts[1].hidden).toBe(true);
    // README.md は engine: name-name を持たないので除外
    expect(body.scripts.find((s) => s.path === "README.md")).toBeUndefined();
  });

  it("returns 404 for an unknown project", async () => {
    const req = new Request(
      "https://name-name-api.workers.dev/api/projects/no-such-project/scripts",
    );
    const res = await worker.fetch(req, ENV, ctx);
    expect(res.status).toBe(404);
  });

  it("returns 405 for non-GET methods", async () => {
    const req = new Request(
      "https://name-name-api.workers.dev/api/projects/ogurasia/scripts",
      { method: "POST" },
    );
    const res = await worker.fetch(req, ENV, ctx);
    expect(res.status).toBe(405);
  });

  it("returns an empty array when the repo root has no .md files", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(mockRoot([])));
    globalThis.fetch = fetchMock as typeof fetch;
    const req = new Request(
      "https://name-name-api.workers.dev/api/projects/ogurasia/scripts",
    );
    const res = await worker.fetch(req, ENV, ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { scripts: unknown[] };
    expect(body.scripts).toEqual([]);
  });

  it("filters out .md files larger than 64KB without fetching their content", async () => {
    const fileFetches: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.match(/\/repos\/kako-jun\/ogurasia\/contents\/?$/) || url.match(/\/contents\/?\?/)) {
        return jsonResponse(
          mockRoot([
            { name: "script.md", path: "script.md", sha: "sha-script", size: 1234 },
            // 200KB の大 .md は size で足切りされる（fetch されない）
            { name: "huge.md", path: "huge.md", sha: "sha-huge", size: 200 * 1024 },
          ]),
        );
      }
      fileFetches.push(url);
      if (url.includes("/contents/script.md")) {
        return jsonResponse(mockFileContents("script.md", SCRIPT_MD, "sha-script"));
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const req = new Request(
      "https://name-name-api.workers.dev/api/projects/ogurasia/scripts",
    );
    const res = await worker.fetch(req, ENV, ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { scripts: Array<{ path: string }> };
    expect(body.scripts.map((s) => s.path)).toEqual(["script.md"]);
    // huge.md は fetch されないことを確認
    expect(fileFetches.some((u) => u.includes("huge.md"))).toBe(false);
  });

  it("propagates GitHub error status on root listing failure", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ message: "not found" }, 404));
    globalThis.fetch = fetchMock as typeof fetch;
    const req = new Request(
      "https://name-name-api.workers.dev/api/projects/ogurasia/scripts",
    );
    const res = await worker.fetch(req, ENV, ctx);
    expect(res.status).toBe(404);
  });
});
