import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/types";
import { MAX_ASSET_BYTES, MAX_GIT_DATA_BYTES } from "../src/types";

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

  // PR #120 review M1: 実ゲームリポ (friday-1930 / ogurasia 等) の
  //   assets/{sounds, movies, ideas}/ をホワイトリストに含めて 200 を返す。
  it.each(["sounds", "movies", "ideas"] as const)(
    "accepts real-world asset type %s with 200",
    async (type) => {
      globalThis.fetch = vi.fn(async () => jsonResponse([])) as typeof fetch;
      const req = new Request(
        `https://name-name-api.workers.dev/api/projects/ogurasia/assets/${type}`,
      );
      const res = await worker.fetch(req, ENV, ctx);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { type: string; entries: unknown[] };
      expect(body.type).toBe(type);
      expect(Array.isArray(body.entries)).toBe(true);
    },
  );
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

  it("rejects asset > 100 MiB with 413 (LFS required)", async () => {
    // base64 length to exceed MAX_GIT_DATA_BYTES の 100 MiB
    const targetBytes = MAX_GIT_DATA_BYTES + 1024;
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
          filename: "huge.bin",
          contentBase64: big,
          message: "add huge",
        }),
      },
    );
    const res = await worker.fetch(req, ENV, ctx);
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: string; size: number };
    expect(body.error).toContain("LFS");
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

  // ----- Git Data API 経路 (#116) -----
  //
  // Contents API の 5 MiB 上限を超えるアセットは Worker が自動で Git Data API
  // (blob/tree/commit/ref) 経路に切り替える。フローは 7 ステップ:
  //   GET /repos/{o}/{r}                          (branch 省略時のみ)
  //   GET /contents/{path}                        (sha 指定時のみ、楽観ロック)
  //   GET /git/ref/heads/{branch}
  //   GET /git/commits/{sha}
  //   POST /git/blobs
  //   POST /git/trees
  //   POST /git/commits
  //   PATCH /git/refs/heads/{branch}

  /**
   * URL パターンに応じて mock レスポンスを返す fetch を組み立てる。
   * 各 step が呼ばれた回数を `calls` で観測できる。
   */
  function makeGitDataMock(opts: {
    defaultBranch?: string;
    contentsSha?: string | null; // null = 404, undefined = not called
    refSha?: string;
    parentTreeSha?: string;
    newBlobSha?: string;
    newTreeSha?: string;
    newCommitSha?: string;
    finalRefSha?: string;
  }): { fetch: typeof fetch; calls: Record<string, number> } {
    const calls: Record<string, number> = {
      repo: 0,
      contents: 0,
      ref: 0,
      commitGet: 0,
      blob: 0,
      tree: 0,
      commitCreate: 0,
      refPatch: 0,
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : (input as Request).url ?? String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      // GET /repos/{owner}/{repo} (default branch resolution)
      if (method === "GET" && /\/repos\/[^/]+\/[^/]+$/.test(url)) {
        calls.repo++;
        return jsonResponse({ default_branch: opts.defaultBranch ?? "main" });
      }
      // GET /repos/.../contents/...
      if (method === "GET" && url.includes("/contents/")) {
        calls.contents++;
        if (opts.contentsSha === null) {
          return jsonResponse({ message: "Not Found" }, 404);
        }
        return jsonResponse({
          path: "assets/images/big.png",
          sha: opts.contentsSha,
          size: 999,
          type: "file",
        });
      }
      // GET /git/ref/heads/{branch} (octokit url-encodes the slash → heads%2F)
      if (method === "GET" && /\/git\/ref\/heads(%2F|\/)/.test(url)) {
        calls.ref++;
        return jsonResponse({ object: { sha: opts.refSha ?? "parent-commit" } });
      }
      // GET /git/commits/{sha}
      if (method === "GET" && url.includes("/git/commits/")) {
        calls.commitGet++;
        return jsonResponse({ tree: { sha: opts.parentTreeSha ?? "base-tree" } });
      }
      // POST /git/blobs
      if (method === "POST" && url.endsWith("/git/blobs")) {
        calls.blob++;
        return jsonResponse({ sha: opts.newBlobSha ?? "new-blob" }, 201);
      }
      // POST /git/trees
      if (method === "POST" && url.endsWith("/git/trees")) {
        calls.tree++;
        return jsonResponse({ sha: opts.newTreeSha ?? "new-tree" }, 201);
      }
      // POST /git/commits
      if (method === "POST" && url.endsWith("/git/commits")) {
        calls.commitCreate++;
        return jsonResponse({ sha: opts.newCommitSha ?? "new-commit" }, 201);
      }
      // PATCH /git/refs/heads/{branch} (octokit url-encodes the slash → heads%2F)
      if (method === "PATCH" && /\/git\/refs\/heads(%2F|\/)/.test(url)) {
        calls.refPatch++;
        return jsonResponse({ object: { sha: opts.finalRefSha ?? opts.newCommitSha ?? "new-commit" } });
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }) as typeof fetch;
    return { fetch: fetchMock, calls };
  }

  /** N バイトの base64 文字列を生成 (中身は 'A' 連打、適切なパディング付き) */
  function makeBase64OfBytes(N: number): string {
    const groupCount = Math.ceil(N / 3);
    const padCount = (3 - (N % 3)) % 3;
    const b64Length = groupCount * 4;
    return "A".repeat(b64Length - padCount) + "=".repeat(padCount);
  }

  it("uploads 5 MiB asset via Git Data API and returns 201 with new blob sha", async () => {
    const { fetch: mockFetch, calls } = makeGitDataMock({
      newBlobSha: "blob-abc",
      newCommitSha: "commit-xyz",
    });
    globalThis.fetch = mockFetch;

    const big = makeBase64OfBytes(MAX_ASSET_BYTES); // ちょうど 5 MiB
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
          message: "add 5 MiB",
          branch: "main",
        }),
      },
    );
    const res = await worker.fetch(req, ENV, ctx);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { sha: string; commit_sha: string; size: number };
    expect(body.sha).toBe("blob-abc");
    expect(body.commit_sha).toBe("commit-xyz");
    expect(body.size).toBe(MAX_ASSET_BYTES);
    // branch が指定されているので default_branch 解決は呼ばれない
    expect(calls.repo).toBe(0);
    // sha 未指定なので contents lookup も呼ばれない
    expect(calls.contents).toBe(0);
    // Git Data API 5 ステップが全部呼ばれる
    expect(calls.ref).toBe(1);
    expect(calls.commitGet).toBe(1);
    expect(calls.blob).toBe(1);
    expect(calls.tree).toBe(1);
    expect(calls.commitCreate).toBe(1);
    expect(calls.refPatch).toBe(1);
  });

  it("resolves default_branch when branch is omitted (Git Data API path)", async () => {
    const { fetch: mockFetch, calls } = makeGitDataMock({
      defaultBranch: "develop",
      newBlobSha: "blob-def",
    });
    globalThis.fetch = mockFetch;

    const big = makeBase64OfBytes(MAX_ASSET_BYTES + 100);
    const req = new Request(
      "https://name-name-api.workers.dev/api/projects/ogurasia/assets/sounds",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer dev-token",
        },
        body: JSON.stringify({
          filename: "bgm.ogg",
          contentBase64: big,
          message: "add bgm",
        }),
      },
    );
    const res = await worker.fetch(req, ENV, ctx);
    expect(res.status).toBe(201);
    expect(calls.repo).toBe(1); // default_branch 解決のため呼ばれる
  });

  it("performs optimistic locking (sha matches) on Git Data API path", async () => {
    const { fetch: mockFetch, calls } = makeGitDataMock({
      contentsSha: "existing-sha-xyz",
      newBlobSha: "blob-updated",
    });
    globalThis.fetch = mockFetch;

    const big = makeBase64OfBytes(MAX_ASSET_BYTES + 100);
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
          message: "update",
          branch: "main",
          sha: "existing-sha-xyz",
        }),
      },
    );
    const res = await worker.fetch(req, ENV, ctx);
    expect(res.status).toBe(201);
    expect(calls.contents).toBe(1);
    expect(calls.refPatch).toBe(1);
  });

  it("returns 409 when optimistic lock sha mismatches (Git Data API path)", async () => {
    const { fetch: mockFetch, calls } = makeGitDataMock({
      contentsSha: "actual-sha",
    });
    globalThis.fetch = mockFetch;

    const big = makeBase64OfBytes(MAX_ASSET_BYTES + 100);
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
          message: "update",
          branch: "main",
          sha: "stale-sha",
        }),
      },
    );
    const res = await worker.fetch(req, ENV, ctx);
    expect(res.status).toBe(409);
    expect(calls.contents).toBe(1);
    // sha 不一致で短絡したので blob 作成等は呼ばれない
    expect(calls.blob).toBe(0);
    expect(calls.refPatch).toBe(0);
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
