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
  // node + workers どちらでも使えるよう、Buffer なし実装
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "x-ratelimit-remaining": "4999",
      "x-ratelimit-limit": "5000",
      ...headers,
    },
  });
}

beforeEach(async () => {
  // Cache API のキャッシュをテスト間で持ち越さないよう、毎回 caches.default を
  // 走査・パージする。miniflare 環境では caches.default が利用可能。
  const cache = (caches as unknown as { default?: Cache }).default;
  if (cache) {
    // 本テストで使うキー（ogurasia の chapters / missing 等）を網羅的に削除する。
    // contentsCacheKey の組み立て規則に合わせる: contents:{owner}/{repo}:{ref}:{path}
    const keysToPurge = [
      "contents:kako-jun/ogurasia:default:chapters/all.md",
      "contents:kako-jun/ogurasia:default:missing.md",
    ];
    for (const k of keysToPurge) {
      await cache.delete(
        new Request(`https://name-name-cache.local/${encodeURIComponent(k)}`),
      );
    }
  }
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  vi.restoreAllMocks();
});

describe("GET /api/projects/:name/contents/*", () => {
  it("decodes base64 contents and returns { path, sha, content }", async () => {
    const text = "# オグラシア\nこんにちは\n";
    const seenUrls: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      seenUrls.push(url);
      return jsonResponse({
        type: "file",
        path: "chapters/all.md",
        sha: "deadbeef",
        encoding: "base64",
        content: utf8Base64(text),
      });
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const req = new Request(
      "https://name-name-api.workers.dev/api/projects/ogurasia/contents/chapters/all.md",
    );
    const res = await worker.fetch(req, ENV, ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { path: string; sha: string; content: string };
    expect(body.path).toBe("chapters/all.md");
    expect(body.sha).toBe("deadbeef");
    expect(body.content).toBe(text);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(seenUrls[0]).toContain("/repos/kako-jun/ogurasia/contents/");
  });

  it("returns 404 for unknown project", async () => {
    const req = new Request(
      "https://name-name-api.workers.dev/api/projects/no-such-game/contents/foo.md",
    );
    const res = await worker.fetch(req, ENV, ctx);
    expect(res.status).toBe(404);
  });

  it("propagates GitHub 404 for missing files", async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({ message: "Not Found" }, 404),
    ) as typeof fetch;
    const req = new Request(
      "https://name-name-api.workers.dev/api/projects/ogurasia/contents/missing.md",
    );
    const res = await worker.fetch(req, ENV, ctx);
    expect(res.status).toBe(404);
  });

  it("rejects path containing '..' with 400", async () => {
    const req = new Request(
      "https://name-name-api.workers.dev/api/projects/ogurasia/contents/foo/..%2Fetc/passwd",
    );
    const res = await worker.fetch(req, ENV, ctx);
    expect(res.status).toBe(400);
  });

  it("returns 502 when GitHub returns invalid base64", async () => {
    // atob が InvalidCharacterError を投げる文字列を仕込む
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({
        type: "file",
        path: "chapters/all.md",
        sha: "deadbeef",
        encoding: "base64",
        content: "@@@not-base64@@@",
      }),
    ) as typeof fetch;
    const req = new Request(
      "https://name-name-api.workers.dev/api/projects/ogurasia/contents/chapters/all.md",
    );
    const res = await worker.fetch(req, ENV, ctx);
    expect(res.status).toBe(502);
  });
});

describe("PUT /api/projects/:name/contents/*", () => {
  it("requires editor auth", async () => {
    const req = new Request(
      "https://name-name-api.workers.dev/api/projects/ogurasia/contents/chapters/all.md",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          content: "x",
          sha: "abc",
          message: "test",
        }),
      },
    );
    const res = await worker.fetch(req, ENV, ctx);
    expect(res.status).toBe(401);
  });

  it("returns 400 if sha is missing and references #115 in error", async () => {
    const req = new Request(
      "https://name-name-api.workers.dev/api/projects/ogurasia/contents/chapters/all.md",
      {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer dev-token",
        },
        body: JSON.stringify({ content: "x", message: "test" }),
      },
    );
    const res = await worker.fetch(req, ENV, ctx);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("sha");
    expect(body.error).toContain("#115");
  });

  it("rejects PUT path containing '..' with 400 before auth", async () => {
    const req = new Request(
      "https://name-name-api.workers.dev/api/projects/ogurasia/contents/foo/..%2Fetc/passwd",
      {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer dev-token",
        },
        body: JSON.stringify({ content: "x", sha: "abc", message: "test" }),
      },
    );
    const res = await worker.fetch(req, ENV, ctx);
    expect(res.status).toBe(400);
  });

  it("returns 409 when GitHub responds with sha mismatch", async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({ message: "sha does not match" }, 409),
    ) as typeof fetch;
    const req = new Request(
      "https://name-name-api.workers.dev/api/projects/ogurasia/contents/chapters/all.md",
      {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer dev-token",
        },
        body: JSON.stringify({
          content: "new",
          sha: "stale",
          message: "edit",
        }),
      },
    );
    const res = await worker.fetch(req, ENV, ctx);
    expect(res.status).toBe(409);
  });

  it("succeeds with valid sha and editor token", async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse(
        {
          content: { sha: "newsha", path: "chapters/all.md" },
          commit: { sha: "commit-sha" },
        },
        200,
      ),
    ) as typeof fetch;
    const req = new Request(
      "https://name-name-api.workers.dev/api/projects/ogurasia/contents/chapters/all.md",
      {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer dev-token",
        },
        body: JSON.stringify({
          content: "new",
          sha: "fresh",
          message: "edit",
        }),
      },
    );
    const res = await worker.fetch(req, ENV, ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-cache")).toBe("PURGED");
    const body = (await res.json()) as { sha: string };
    expect(body.sha).toBe("newsha");
  });
});
