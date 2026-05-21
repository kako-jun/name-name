import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { splitRepo } from "../src/projects";
import type { Env } from "../src/types";

const ENV: Env = {
  ALLOWED_ORIGIN: "https://name-name.llll-ll.com",
  DEFAULT_OWNER: "kako-jun",
  GITHUB_TOKEN: "test-pat",
  DEV_AUTH_TOKEN: "dev-token",
};

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

describe("GET /api/projects", () => {
  it("returns the hard-coded project list", async () => {
    const req = new Request("https://name-name-api.workers.dev/api/projects");
    const res = await worker.fetch(req, ENV, ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { projects: Array<{ name: string }> };
    const names = body.projects.map((p) => p.name);
    for (const required of ["ogurasia", "skirts-colour", "friday-1930", "gymnasia", "llll-ll-media", "amanuma"]) {
      expect(names).toContain(required);
    }
  });

  it("attaches CORS headers for the allowed origin", async () => {
    const req = new Request("https://name-name-api.workers.dev/api/projects", {
      headers: { origin: "https://name-name.llll-ll.com" },
    });
    const res = await worker.fetch(req, ENV, ctx);
    expect(res.headers.get("access-control-allow-origin")).toBe(
      "https://name-name.llll-ll.com",
    );
  });

  it("responds to OPTIONS preflight with 204", async () => {
    const req = new Request("https://name-name-api.workers.dev/api/projects", {
      method: "OPTIONS",
      headers: { origin: "https://name-name.llll-ll.com" },
    });
    const res = await worker.fetch(req, ENV, ctx);
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-methods")).toContain("GET");
  });

  it("falls back to ALLOWED_ORIGIN for disallowed preflight Origin", async () => {
    const req = new Request("https://name-name-api.workers.dev/api/projects", {
      method: "OPTIONS",
      headers: { origin: "https://evil.example" },
    });
    const res = await worker.fetch(req, ENV, ctx);
    expect(res.status).toBe(204);
    // 許可外 Origin は echo back せず、必ず ALLOWED_ORIGIN を返す
    expect(res.headers.get("access-control-allow-origin")).toBe(
      "https://name-name.llll-ll.com",
    );
  });

  it("falls back to ALLOWED_ORIGIN for disallowed Origin on a normal response", async () => {
    const req = new Request("https://name-name-api.workers.dev/api/projects", {
      headers: { origin: "https://evil.example" },
    });
    const res = await worker.fetch(req, ENV, ctx);
    expect(res.headers.get("access-control-allow-origin")).toBe(
      "https://name-name.llll-ll.com",
    );
  });

  it("returns 405 for unsupported methods", async () => {
    const req = new Request("https://name-name-api.workers.dev/api/projects", {
      method: "DELETE",
    });
    const res = await worker.fetch(req, ENV, ctx);
    expect(res.status).toBe(405);
  });

  it("returns 404 for unknown routes", async () => {
    const req = new Request("https://name-name-api.workers.dev/api/unknown");
    const res = await worker.fetch(req, ENV, ctx);
    expect(res.status).toBe(404);
  });
});

describe("splitRepo()", () => {
  it("splits owner/repo correctly", () => {
    expect(splitRepo({ name: "x", title: "X", repo: "kako-jun/x" })).toEqual({
      owner: "kako-jun",
      repo: "x",
    });
  });

  it("throws when project.repo lacks a '/'", () => {
    expect(() =>
      splitRepo({ name: "x", title: "X", repo: "no-slash" }),
    ).toThrowError(/invalid project\.repo/);
  });

  it("throws when project.repo is empty", () => {
    expect(() =>
      splitRepo({ name: "x", title: "X", repo: "" }),
    ).toThrowError(/invalid project\.repo/);
  });

  it("throws when owner is empty", () => {
    expect(() =>
      splitRepo({ name: "x", title: "X", repo: "/repo" }),
    ).toThrowError(/invalid project\.repo/);
  });

  it("throws when repo is empty", () => {
    expect(() =>
      splitRepo({ name: "x", title: "X", repo: "owner/" }),
    ).toThrowError(/invalid project\.repo/);
  });
});
