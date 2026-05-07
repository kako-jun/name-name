import { afterEach, describe, expect, it, vi } from "vitest";
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

  it("uploads small asset and returns 201", async () => {
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
    const body = (await res.json()) as { sha: string };
    expect(body.sha).toBe("newsha");
  });
});
