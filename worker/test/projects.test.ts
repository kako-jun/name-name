import { describe, expect, it } from "vitest";
import worker from "../src/index";
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
    expect(body.projects.length).toBe(4);
    expect(body.projects.map((p) => p.name)).toEqual([
      "ogurasia",
      "skirts-colour",
      "friday-1930",
      "gymnasia",
    ]);
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
