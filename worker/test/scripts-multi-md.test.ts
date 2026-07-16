// kako-jun/name-name#284 / #314: scriptsDir プロジェクトの scripts listing テスト。
//
// theo-hayami のような大量 MD プロジェクトでは、一覧生成時に各 MD 本文を
// Contents API で本文 peek すると 260 req 級になり cold start が 1 分級になる。
// scriptsDir 指定プロジェクトは GitHub Contents API のディレクトリ一覧だけを
// 使い、本文 peek はしない。
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

function contentEntry(path: string, sha: string, size = 100, type = "file") {
  return {
    name: path.split("/").pop() ?? path,
    path,
    sha,
    size,
    type,
    download_url: type === "file" ? `https://raw.test/${path}` : null,
  };
}

function isContentsRequest(url: string, path: string): boolean {
  const pathname = new URL(url).pathname;
  const prefix = "/repos/kako-jun/theo-hayami/contents/";
  if (!pathname.startsWith(prefix)) return false;
  return decodeURIComponent(pathname.slice(prefix.length)) === path;
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

describe("GET /api/projects/:name/scripts (scriptsDir / fast directory listing #314)", () => {
  it("scriptsDir 配下 + 1 段下の .md を Contents API の一覧だけで列挙し、本文 peek をしない", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (isContentsRequest(url, "content/scripts")) {
        return jsonResponse([
          contentEntry("content/scripts/script.md", "sha-script", 123),
          contentEntry("content/scripts/free", "sha-free", 0, "dir"),
          contentEntry("content/scripts/main", "sha-main", 0, "dir"),
          contentEntry("content/scripts/readme.md", "sha-readme", 100),
          contentEntry("content/scripts/README.txt", "sha-txt", 100),
        ]);
      }
      if (isContentsRequest(url, "content/scripts/free")) {
        return jsonResponse([
          contentEntry("content/scripts/free/a.md", "sha-a", 100),
          contentEntry("content/scripts/free/nested", "sha-nested", 0, "dir"),
        ]);
      }
      if (isContentsRequest(url, "content/scripts/main")) {
        return jsonResponse([
          contentEntry("content/scripts/main/b.md", "sha-b", 100),
        ]);
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
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.map((call) => call[0].toString())).toEqual(
      expect.arrayContaining([
        expect.stringContaining("/contents/content%2Fscripts"),
        expect.stringContaining("/contents/content%2Fscripts%2Ffree"),
        expect.stringContaining("/contents/content%2Fscripts%2Fmain"),
      ]),
    );
  });

  it("64KB 超と 500 件超は高速経路でも打ち切る", async () => {
    const many = Array.from({ length: 520 }, (_, i) =>
      contentEntry(`content/scripts/free/s${i}.md`, `sha-${i}`, 100),
    );
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (isContentsRequest(url, "content/scripts")) {
        return jsonResponse([
          contentEntry("content/scripts/huge.md", "sha-huge", 200 * 1024),
          contentEntry("content/scripts/free", "sha-free", 0, "dir"),
        ]);
      }
      if (isContentsRequest(url, "content/scripts/free")) {
        return jsonResponse(many);
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

  it("Contents API の scriptsDir 取得失敗は status を伝播する", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (isContentsRequest(url, "content/scripts")) {
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
