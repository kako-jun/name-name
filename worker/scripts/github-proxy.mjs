// Host-side reverse proxy that forwards requests to https://api.github.com
// through the shell's HTTPS_PROXY/HTTP_PROXY (using undici in plain Node).
//
// 起動経路:
//   `npm run dev` の dev.mjs から、HTTPS_PROXY が shell に存在する場合のみ
//   spawn される。worker はこの中継サーバを `GITHUB_API_BASE` 経由で叩く。
//
// なぜ別プロセスか:
//   workerd ランタイムには undici / Node の HTTP agent を埋め込めず、
//   corp proxy を経由する CONNECT トンネルが張れないため、host 側の Node で
//   trampoline する。worker からは plain fetch でアクセスするだけで済む。
import http from "node:http";
import { fetch, ProxyAgent } from "undici";

const PORT = Number(process.env.GITHUB_PROXY_PORT ?? "9091");
const proxyUrl = process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY;
if (!proxyUrl) {
  console.error("[github-proxy] HTTPS_PROXY/HTTP_PROXY not set; refusing to start");
  process.exit(1);
}
const dispatcher = new ProxyAgent(proxyUrl);

const server = http.createServer(async (req, res) => {
  try {
    const target = `https://api.github.com${req.url}`;
    const headers = { ...req.headers };
    delete headers.host;
    delete headers["content-length"];

    let body;
    if (req.method !== "GET" && req.method !== "HEAD") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      body = Buffer.concat(chunks);
    }

    const upstream = await fetch(target, {
      method: req.method,
      headers,
      body,
      dispatcher,
      // GitHub API does its own redirects; pass through.
      redirect: "manual",
    });

    // upstream を arrayBuffer で受けると content-encoding (gzip 等) は undici 内部で
    // 復号されている。よって元レスポンスの content-length と byte 数が乖離するため、
    // hop-by-hop と content-length をまとめて strip し、こちらで再設定する。
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.statusCode = upstream.status;
    const HOP_BY_HOP = new Set([
      "transfer-encoding",
      "connection",
      "keep-alive",
      "proxy-authenticate",
      "proxy-authorization",
      "te",
      "trailers",
      "trailer",
      "upgrade",
      "content-encoding",
      "content-length",
    ]);
    upstream.headers.forEach((v, k) => {
      if (HOP_BY_HOP.has(k.toLowerCase())) return;
      res.setHeader(k, v);
    });
    res.setHeader("content-length", String(buf.byteLength));
    res.end(buf);
  } catch (err) {
    console.error("[github-proxy] error:", err);
    if (!res.headersSent) {
      res.statusCode = 502;
      res.setHeader("content-type", "application/json; charset=utf-8");
    }
    res.end(JSON.stringify({ error: "github-proxy upstream failure", message: String(err) }));
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[github-proxy] listening on http://127.0.0.1:${PORT} (proxy redacted)`);
});
