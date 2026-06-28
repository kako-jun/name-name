// kako-jun/name-name#284 / #314: scriptsDir プロジェクトの scripts listing テスト。
//
// theo-hayami のような大量 MD プロジェクトでは、一覧生成時に各 MD 本文を
// Contents API で peek すると 260 req 級になり cold start が 1 分級になる。
// scriptsDir 指定プロジェクトは Git Trees API recursive listing で path/sha/size を
// 一括取得し、本文 peek はしない。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/types";

const ENV: Env = {
  ALLOWED_ORIGIN: "https://name-name.llll-ll.com",
  DEFAULT_OWNER: "kako-jun",
  GITHUB_TOKEN: "test-pat",
  DEV_AUTH_TOKEN: "dev-token",
};

const ctx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
} as unknown as ExecutionContext;
const ORIGINAL_FETCH = globalThis.fetch;

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

function treeEntry(path: string, sha: string, size = 100, type = "blob") {
  return { path, mode: type === "blob" ? "100644" : "040000", type, sha, size };
}

function isTreeRequest(url: string): boolean {
  return url.includes("/repos/kako-jun/theo-hayami/git/trees/");
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

describe("GET /api/projects/:name/scripts (scriptsDir / fast tree listing #314)", () => {
  it("scriptsDir 配下 + 1 段下の .md を Git tree 1 回で列挙し、本文 peek をしない", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (isTreeRequest(url)) {
        return jsonResponse({
          truncated: false,
          tree: [
            treeEntry("content/scripts/script.md", "sha-script", 123),
            treeEntry("content/scripts/free/a.md", "sha-a", 100),
            treeEntry("content/scripts/main/b.md", "sha-b", 100),
            treeEntry("content/scripts/free/nested/deep.md", "sha-deep", 100),
            treeEntry("content/scripts/README.txt", "sha-txt", 100),
            treeEntry("docs/outside.md", "sha-outside", 100),
          ],
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const req = new Request(
      "https://name-name-api.workers.dev/api/projects/theo-hayami/scripts?ref=main",
    );
    const res = await worker.fetch(req, ENV, ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      scripts: Array<{
        path: string;
        title: string | null;
        hidden: boolean;
        sha: string;
        size: number;
      }>;
    };

    expect(body.scripts.map((s) => s.path)).toEqual([
      "content/scripts/script.md",
      "content/scripts/free/a.md",
      "content/scripts/main/b.md",
    ]);
    expect(body.scripts[0]).toMatchObject({
      path: "content/scripts/script.md",
      sha: "sha-script",
      title: null,
      hidden: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0].toString()).toContain(
      "/git/trees/main",
    );
  });

  it("64KB 超と 500 件超は高速経路でも打ち切る", async () => {
    const many = Array.from({ length: 520 }, (_, i) =>
      treeEntry(`content/scripts/free/s${i}.md`, `sha-${i}`, 100),
    );
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (isTreeRequest(url)) {
        return jsonResponse({
          truncated: false,
          tree: [
            treeEntry("content/scripts/huge.md", "sha-huge", 200 * 1024),
            ...many,
          ],
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const req = new Request(
      "https://name-name-api.workers.dev/api/projects/theo-hayami/scripts",
    );
    const res = await worker.fetch(req, ENV, ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { scripts: Array<{ path: string }> };

    expect(body.scripts).toHaveLength(500);
    expect(body.scripts.some((s) => s.path === "content/scripts/huge.md")).toBe(
      false,
    );
  });

  it("Git tree 取得失敗は status を伝播する", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (isTreeRequest(url)) {
        return jsonResponse({ message: "not found" }, 404);
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const req = new Request(
      "https://name-name-api.workers.dev/api/projects/theo-hayami/scripts",
    );
    const res = await worker.fetch(req, ENV, ctx);
    expect(res.status).toBe(404);
  });
});
