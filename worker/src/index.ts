// Worker エントリ + ルーティング
//
// ルート:
//   GET    /api/projects
//   GET    /api/projects/:name/contents/*path
//   PUT    /api/projects/:name/contents/*path
//   GET    /api/projects/:name/assets/:type
//   POST   /api/projects/:name/assets/:type
//
// CORS:
//   - env.ALLOWED_ORIGIN からのみ通す
//   - OPTIONS preflight に対応

import { handleListAssets, handleUploadAsset } from "./assets";
import { handleGetContents, handlePutContents } from "./contents";
import { handleListProjects } from "./projects";
import type { Env } from "./types";

const CORS_HEADERS_BASE: Record<string, string> = {
  "access-control-allow-methods": "GET, PUT, POST, OPTIONS",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-max-age": "86400",
};

function corsHeaders(env: Env, origin: string | null): Record<string, string> {
  const allowed = env.ALLOWED_ORIGIN;
  // 完全一致のみ許可。ローカル開発で `wrangler dev` から叩く場合は wrangler.toml の
  // ALLOWED_ORIGIN を `http://localhost:5173` などに上書きすること。
  const allowOrigin = origin && origin === allowed ? origin : allowed;
  return {
    ...CORS_HEADERS_BASE,
    "access-control-allow-origin": allowOrigin,
    vary: "origin",
  };
}

function withCors(response: Response, env: Env, origin: string | null): Response {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(corsHeaders(env, origin))) {
    headers.set(k, v);
  }
  return new Response(response.body, { status: response.status, headers });
}

function notFound(): Response {
  return new Response(JSON.stringify({ error: "not found" }), {
    status: 404,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function methodNotAllowed(): Response {
  return new Response(JSON.stringify({ error: "method not allowed" }), {
    status: 405,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

interface RouteMatch {
  // /api/projects
  kind: "list-projects";
}
interface ContentsRoute {
  kind: "contents";
  project: string;
  path: string;
}
interface AssetsRoute {
  kind: "assets";
  project: string;
  type: string;
}
type Route = RouteMatch | ContentsRoute | AssetsRoute | null;

function matchRoute(pathname: string): Route {
  // /api/projects
  if (pathname === "/api/projects" || pathname === "/api/projects/") {
    return { kind: "list-projects" };
  }
  // /api/projects/:name/contents/*
  const contentsMatch = pathname.match(/^\/api\/projects\/([^/]+)\/contents\/(.+)$/);
  if (contentsMatch) {
    return { kind: "contents", project: contentsMatch[1], path: contentsMatch[2] };
  }
  // /api/projects/:name/assets/:type
  const assetsMatch = pathname.match(/^\/api\/projects\/([^/]+)\/assets\/([^/]+)\/?$/);
  if (assetsMatch) {
    return { kind: "assets", project: assetsMatch[1], type: assetsMatch[2] };
  }
  return null;
}

async function dispatch(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const route = matchRoute(url.pathname);
  if (!route) return notFound();

  switch (route.kind) {
    case "list-projects":
      if (request.method === "GET") return handleListProjects(request, env);
      return methodNotAllowed();
    case "contents":
      if (request.method === "GET") {
        return handleGetContents(request, env, route.project, route.path);
      }
      if (request.method === "PUT") {
        return handlePutContents(request, env, route.project, route.path);
      }
      return methodNotAllowed();
    case "assets":
      if (request.method === "GET") {
        return handleListAssets(request, env, route.project, route.type);
      }
      if (request.method === "POST") {
        return handleUploadAsset(request, env, route.project, route.type);
      }
      return methodNotAllowed();
  }
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const origin = request.headers.get("origin");

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(env, origin),
      });
    }

    try {
      const res = await dispatch(request, env);
      return withCors(res, env, origin);
    } catch (err) {
      console.error("[fetch] unhandled", err);
      const res = new Response(
        JSON.stringify({ error: "internal server error" }),
        {
          status: 500,
          headers: { "content-type": "application/json; charset=utf-8" },
        },
      );
      return withCors(res, env, origin);
    }
  },
};
