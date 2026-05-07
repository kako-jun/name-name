import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/types";
import { MAX_ASSET_BYTES } from "../src/types";

const ENV: Env = {
  ALLOWED_ORIGIN: "https://name-name.llll-ll.com",
  DEFAULT_OWNER: "kako-jun",
  GITHUB_TOKEN: "test-pat",
  DEV_AUTH_TOKEN: "dev-token",
};

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

const ORIGINAL_FETCH = globalThis.fetch;

beforeEach(async () => {
  // assets キャッシュをテスト間で持ち越さないよう、毎回 caches.default をパージ。
  // assetsCacheKey の規則: assets:{owner}/{repo}:{ref}:{type}
  const cache = (caches as unknown as { default?: Cache }).default;
  if (cache) {
    const keysToPurge = [
      "assets:kako-jun/ogurasia:default:images",
      "assets:kako-jun/ogurasia:default:audio",
      "assets:kako-jun/skirts-colour:default:images",
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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "x-ratelimit-remaining": "4900",
    },
  });
}

describe("GET /api/projects/:name/assets/:type", () => {
  it("returns directory listing as AssetEntry[]", async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse([
        {
          name: "title.png",
          path: "assets/images/title.png",
          sha: "abc",
          size: 1234,
          type: "file",
          download_url: "https://raw.example/title.png",
        },
        {
          name: "subdir",
          path: "assets/images/subdir",
          sha: "def",
          size: 0,
          type: "dir",
          download_url: null,
        },
      ]),
    ) as typeof fetch;

    const req = new Request(
      "https://name-name-api.workers.dev/api/projects/ogurasia/assets/images",
    );
    const res = await worker.fetch(req, ENV, ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { type: string; entries: Array<{ name: string }> };
    expect(body.type).toBe("images");
    expect(body.entries.map((e) => e.name)).toEqual(["title.png", "subdir"]);
  });

  it("returns empty array when GitHub responds 404", async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({ message: "Not Found" }, 404)) as typeof fetch;
    const req = new Request(
      "https://name-name-api.workers.dev/api/projects/ogurasia/assets/audio",
    );
    const res = await worker.fetch(req, ENV, ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entries: unknown[] };
    expect(body.entries).toEqual([]);
  });

  it("rejects unknown asset type with 400", async () => {
    const req = new Request(
      "https://name-name-api.workers.dev/api/projects/ogurasia/assets/weapons",
    );
    const res = await worker.fetch(req, ENV, ctx);
    expect(res.status).toBe(400);
  });
});

describe("POST /api/projects/:name/assets/:type", () => {
  it("requires editor auth", async () => {
    const req = new Request(
      "https://name-name-api.workers.dev/api/projects/ogurasia/assets/images",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          filename: "x.png",
          contentBase64: "AAAA",
          message: "add",
        }),
      },
    );
    const res = await worker.fetch(req, ENV, ctx);
    expect(res.status).toBe(401);
  });

  it("rejects asset > 5 MiB with 413", async () => {
    // base64 length to exceed MAX_ASSET_BYTES の 5 MiB → 約 5,592,406 文字
    const targetBytes = MAX_ASSET_BYTES + 1024;
    const b64Length = Math.ceil(targetBytes / 3) * 4;
    const big = "A".repeat(b64Length);
    const req = new Request(
      "https://name-name-api.workers.dev/api/projects/ogurasia/assets/images",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer dev-token",
        },
        body: JSON.stringify({
          filename: "big.png",
          contentBase64: big,
          message: "add big",
        }),
      },
    );
    const res = await worker.fetch(req, ENV, ctx);
    expect(res.status).toBe(413);
  });

  it("rejects asset == 5 MiB with 413 (boundary)", async () => {
    // ちょうど MAX_ASSET_BYTES (5 MiB) を作る。
    // base64 のデコード後バイト数 N に対し、文字長 = ceil(N / 3) * 4。
    // N = 5 MiB は 3 の倍数 (5*1024*1024 = 5242880 = 3*1747626 + 2)
    // → 文字長 = 1747627 * 4 = 6990508、末尾パディング 1 個 ('=')
    // 安全側で N = MAX_ASSET_BYTES ぴったりになる base64 を生成する
    const N = MAX_ASSET_BYTES; // 5 * 1024 * 1024
    // bytes 列を base64 化した時の長さは 4*ceil(N/3)、末尾パディング数は (3 - N%3) % 3
    const groupCount = Math.ceil(N / 3);
    const padCount = (3 - (N % 3)) % 3;
    const b64Length = groupCount * 4;
    const big = "A".repeat(b64Length - padCount) + "=".repeat(padCount);
    const req = new Request(
      "https://name-name-api.workers.dev/api/projects/ogurasia/assets/images",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer dev-token",
        },
        body: JSON.stringify({
          filename: "exact.png",
          contentBase64: big,
          message: "add exact 5 MiB",
        }),
      },
    );
    const res = await worker.fetch(req, ENV, ctx);
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: string; size: number };
    expect(body.size).toBe(MAX_ASSET_BYTES);
    expect(body.error).toContain("#116");
  });

  it("rejects invalid base64 (length not multiple of 4) with 400", async () => {
    const req = new Request(
      "https://name-name-api.workers.dev/api/projects/ogurasia/assets/images",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer dev-token",
        },
        body: JSON.stringify({
          filename: "bad.png",
          contentBase64: "AAA", // length 3 → not a multiple of 4
          message: "add bad",
        }),
      },
    );
    const res = await worker.fetch(req, ENV, ctx);
    expect(res.status).toBe(400);
  });

  it("rejects filenames with slashes", async () => {
    const req = new Request(
      "https://name-name-api.workers.dev/api/projects/ogurasia/assets/images",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer dev-token",
        },
        body: JSON.stringify({
          filename: "sub/x.png",
          contentBase64: "AAAA",
          message: "add",
        }),
      },
    );
    const res = await worker.fetch(req, ENV, ctx);
    expect(res.status).toBe(400);
  });

  it("uploads small asset and returns 201 with x-cache: BYPASS", async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse(
        {
          content: { sha: "newsha", path: "assets/images/x.png" },
          commit: { sha: "commit" },
        },
        201,
      ),
    ) as typeof fetch;

    const req = new Request(
      "https://name-name-api.workers.dev/api/projects/ogurasia/assets/images",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer dev-token",
        },
        body: JSON.stringify({
          filename: "x.png",
          contentBase64: "AAAA", // 3 bytes after decode
          message: "add",
        }),
      },
    );
    const res = await worker.fetch(req, ENV, ctx);
    expect(res.status).toBe(201);
    expect(res.headers.get("x-cache")).toBe("BYPASS");
    const body = (await res.json()) as { sha: string };
    expect(body.sha).toBe("newsha");
  });

  it("forwards sha when provided (existing-file overwrite)", async () => {
    let capturedBody: unknown = null;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void input;
      if (init?.body && typeof init.body === "string") {
        capturedBody = JSON.parse(init.body);
      }
      return jsonResponse(
        {
          content: { sha: "updatedsha", path: "assets/images/x.png" },
          commit: { sha: "commit2" },
        },
        200,
      );
    }) as typeof fetch;

    const req = new Request(
      "https://name-name-api.workers.dev/api/projects/ogurasia/assets/images",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer dev-token",
        },
        body: JSON.stringify({
          filename: "x.png",
          contentBase64: "AAAA",
          message: "overwrite",
          sha: "existing-sha",
        }),
      },
    );
    const res = await worker.fetch(req, ENV, ctx);
    expect(res.status).toBe(201);
    const sent = capturedBody as { sha?: string } | null;
    expect(sent?.sha).toBe("existing-sha");
  });

  it("propagates 422 when GitHub returns 422 (e.g. existing file without sha)", async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({ message: "Invalid request. \"sha\" wasn't supplied." }, 422),
    ) as typeof fetch;
    const req = new Request(
      "https://name-name-api.workers.dev/api/projects/ogurasia/assets/images",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer dev-token",
        },
        body: JSON.stringify({
          filename: "x.png",
          contentBase64: "AAAA",
          message: "add (no sha)",
        }),
      },
    );
    const res = await worker.fetch(req, ENV, ctx);
    expect(res.status).toBe(422);
  });
});
