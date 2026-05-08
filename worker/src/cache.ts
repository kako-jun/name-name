// Cache API ヘルパー
//
// - GET の結果を 10 秒キャッシュする
// - PUT/POST が成功したら該当キーをパージする (write-through)
// - テスト環境では caches.default が無いので、ヘルパーは undefined を許容する
//
// TTL を短く (10s) しているのは #118 への対応。develop→main マージは GitHub UI 経由で
// 走るため Worker がそのタイミングを検知できず、main のキャッシュが古いまま残る問題が
// あった。kako-jun 1 人運用 + 5000 req/h レート枠に余裕があるため、TTL 短縮で
// 実用十分と判断。generation-based / webhook 方式は将来必要になったら再検討する。

const DEFAULT_TTL_SECONDS = 10;

function getCache(): Cache | null {
  // @cloudflare/workers-types の caches.default
  // miniflare/vitest-pool-workers でも提供される。標準 Web 環境では undefined。
  const c = (caches as unknown as { default?: Cache }).default;
  return c ?? null;
}

/**
 * cache key として使う Request を作る。実際の Worker request の URL とは独立に、
 * 内部用 URL（host = "name-name-cache.local"）を組み立てる。
 */
function makeCacheRequest(key: string): Request {
  return new Request(`https://name-name-cache.local/${encodeURIComponent(key)}`, {
    method: "GET",
  });
}

export async function cacheGet(key: string): Promise<Response | null> {
  const cache = getCache();
  if (!cache) return null;
  const hit = await cache.match(makeCacheRequest(key));
  return hit ?? null;
}

export async function cachePut(
  key: string,
  response: Response,
  ttlSeconds: number = DEFAULT_TTL_SECONDS,
): Promise<void> {
  const cache = getCache();
  if (!cache) return;
  // Cache API が Cache-Control を見るので、コピーに header を付ける
  const cloned = new Response(response.clone().body, response);
  cloned.headers.set("cache-control", `public, max-age=${ttlSeconds}`);
  await cache.put(makeCacheRequest(key), cloned);
}

export async function cacheDelete(key: string): Promise<boolean> {
  const cache = getCache();
  if (!cache) return false;
  return cache.delete(makeCacheRequest(key));
}

export function contentsCacheKey(
  owner: string,
  repo: string,
  path: string,
  ref: string | null,
): string {
  return `contents:${owner}/${repo}:${ref ?? "default"}:${path}`;
}

export function assetsCacheKey(
  owner: string,
  repo: string,
  type: string,
  ref: string | null,
): string {
  return `assets:${owner}/${repo}:${ref ?? "default"}:${type}`;
}
