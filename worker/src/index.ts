// Worker エントリ + ルーティング (Hono)
//
// ルート:
//   GET    /api/projects
//   GET    /api/projects/:name/contents/*path
//   PUT    /api/projects/:name/contents/*path
//   GET    /api/projects/:name/assets/:type
//   POST   /api/projects/:name/assets/:type
//
// CORS: env.ALLOWED_ORIGIN からのみ通す。preflight は hono/cors に任せる。

import { Hono } from "hono";
import { cors } from "hono/cors";
import { handleListAssets, handleRawAsset, handleUploadAsset } from "./assets";
import { handleGetContents, handlePutContents } from "./contents";
import { handleListProjects } from "./projects";
import type { Env } from "./types";

const app = new Hono<{ Bindings: Env }>();

// dev mode の判定: GITHUB_API_BASE が立っているとき = scripts/dev.mjs 経由起動。
// その時のみ localhost / プライベート IP の dev origin を CORS で許可する。
// 本番 (CF Worker) では GITHUB_API_BASE は未設定なので production origin だけ通る。
function isValidIPv4Octet(s: string): boolean {
  if (!/^\d{1,3}$/.test(s)) return false;
  const n = Number(s);
  return n >= 0 && n <= 255;
}
function isLoopbackOrPrivateHostname(hostname: string): boolean {
  if (hostname === "localhost") return true;
  const parts = hostname.split(".");
  if (parts.length !== 4) return false;
  if (!parts.every(isValidIPv4Octet)) return false;
  const [a, b] = parts.map(Number);
  if (a === 127) return true;
  if (a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
}
function isDevOrigin(origin: string): boolean {
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  return isLoopbackOrPrivateHostname(u.hostname);
}

/**
 * `<game>.llll-ll.com` でゲーム専用サブドメインからのアクセスも本番扱いで通す。
 * (ALLOWED_ORIGIN は `https://name-name.llll-ll.com` 単体しか持てないため、
 *  origin 関数で「ALLOWED_ORIGIN と同じドメインの subdomain」を許可する)。
 *
 * 判定基準: ALLOWED_ORIGIN が `https://<host>.llll-ll.com` 形式のとき、
 *   `https://<sub>.<同じ親ドメイン>` も許可する。
 */
function isProductionSiblingOrigin(origin: string, allowed: string): boolean {
  let o: URL;
  let a: URL;
  try {
    o = new URL(origin);
    a = new URL(allowed);
  } catch {
    return false;
  }
  if (o.protocol !== a.protocol) return false;
  if (o.protocol !== "https:") return false;
  // 親ドメインを比較する。`name-name.llll-ll.com` の親は `llll-ll.com`。
  const allowedParent = a.hostname.split(".").slice(-2).join(".");
  if (allowedParent.split(".").length < 2) return false;
  if (!o.hostname.endsWith(`.${allowedParent}`)) return false;
  // `llll-ll.com` 自体は通さない (apex は別運用想定)
  if (o.hostname === allowedParent) return false;
  return true;
}

app.use("*", (c, next) =>
  cors({
    origin: (origin) => {
      if (origin === c.env.ALLOWED_ORIGIN) return origin;
      if (origin && isProductionSiblingOrigin(origin, c.env.ALLOWED_ORIGIN)) return origin;
      if (c.env.GITHUB_API_BASE && origin && isDevOrigin(origin)) return origin;
      return c.env.ALLOWED_ORIGIN;
    },
    allowMethods: ["GET", "PUT", "POST", "OPTIONS"],
    allowHeaders: ["authorization", "content-type"],
    maxAge: 86400,
  })(c, next),
);

// 各エンドポイントは「許可メソッドの登録 → app.all で 405 catch-all」の順で書く。
// この順序により、未許可メソッドが onNotFound で 404 にされるのを防ぎ 405 で返せる。
const methodNotAllowed = (c: { json: (body: unknown, status?: number) => Response }) =>
  c.json({ error: "method not allowed" }, 405);

app.get("/api/projects", (c) => handleListProjects(c.req.raw, c.env));
app.all("/api/projects", methodNotAllowed);

app.get("/api/projects/:name/contents/:path{.+}", (c) =>
  handleGetContents(c.req.raw, c.env, c.req.param("name"), c.req.param("path")),
);
app.put("/api/projects/:name/contents/:path{.+}", (c) =>
  handlePutContents(c.req.raw, c.env, c.req.param("name"), c.req.param("path")),
);
app.all("/api/projects/:name/contents/:path{.+}", methodNotAllowed);

app.get("/api/projects/:name/assets/raw/:path{.+}", (c) =>
  handleRawAsset(c.req.raw, c.env, c.req.param("name"), c.req.param("path")),
);
app.all("/api/projects/:name/assets/raw/:path{.+}", methodNotAllowed);

app.get("/api/projects/:name/assets/:type", (c) =>
  handleListAssets(c.req.raw, c.env, c.req.param("name"), c.req.param("type")),
);
app.post("/api/projects/:name/assets/:type", (c) =>
  handleUploadAsset(c.req.raw, c.env, c.req.param("name"), c.req.param("type")),
);
app.all("/api/projects/:name/assets/:type", methodNotAllowed);

app.notFound((c) =>
  c.json({ error: "not found" }, 404),
);

app.onError((err, c) => {
  console.error("[fetch] unhandled", err);
  return c.json({ error: "internal server error" }, 500);
});

export default app;
