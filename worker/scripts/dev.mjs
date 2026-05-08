// `npm run dev` のラッパー。
//
// 3 つの起動モード:
//
//   1. **直結モード** (default)
//      shell に proxy 環境変数が無く、`--local` も無い場合。Worker は
//      api.github.com を直接叩く。本番 CF Worker と同じ経路。
//
//   2. **proxy 中継モード** (corp proxy 配下)
//      shell の `HTTPS_PROXY` / `HTTP_PROXY` が立っている場合に有効。
//      host 側で github-proxy.mjs を spawn し、`GITHUB_API_BASE` で Worker を
//      その中継先に向ける。proxy 値はコード/wrangler.toml に書かない。
//
//   3. **ローカル fs モード** (`--local` または `NAME_NAME_LOCAL=1`)
//      ゲームリポをまだ push せずに動作確認したいときに有効。
//      host 側で local-fs-proxy.mjs を spawn し、Worker をそこに向ける。
//      `LOCAL_REPOS_BASE` (`:` 区切り) でゲームリポの親ディレクトリを
//      与える必要がある。proxy 中継モードとは排他で、`--local` 優先。
//
// 共通ルール:
//   - wrangler CLI 自身の env からは proxy を必ず外す
//     (wrangler が見ると loopback 接続まで proxy しようとして 500 になる)
//   - SIGINT / SIGTERM で子プロセス群をプロセスグループごと殺す
//
// 追加引数は `npm run dev -- --ip 0.0.0.0` の形で末尾に渡す。
import { spawn } from "node:child_process";

const args = ["dev"];
const childEnv = { ...process.env };
const isWindows = process.platform === "win32";
const PROXY_PORT = "9091";
const LOCAL_PORT = "9092";

const passthrough = [];
let useLocal = process.env.NAME_NAME_LOCAL === "1";
for (const a of process.argv.slice(2)) {
  if (a === "--local") {
    useLocal = true;
  } else {
    passthrough.push(a);
  }
}

const proxyUrl = process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY;
let helperChild = null;
let wranglerChild = null;
let helperLabel = null;

const cleanup = () => {
  for (const child of [helperChild, wranglerChild]) {
    if (!child || child.killed) continue;
    try {
      if (!isWindows && child.pid) {
        process.kill(-child.pid, "SIGTERM");
      } else {
        child.kill("SIGTERM");
      }
    } catch {
      // already dead
    }
  }
};

if (useLocal) {
  // local-fs モード優先 (proxy より) — push 前のシナリオ確認が目的なので、
  // 本物の GitHub に出る必要は無い。
  helperLabel = "local-fs-proxy";
  helperChild = spawn("node", ["scripts/local-fs-proxy.mjs"], {
    stdio: "inherit",
    env: { ...process.env, LOCAL_FS_PROXY_PORT: LOCAL_PORT },
    detached: !isWindows,
  });
  args.push("--var", `GITHUB_API_BASE:http://127.0.0.1:${LOCAL_PORT}`);
} else if (proxyUrl) {
  helperLabel = "github-proxy";
  helperChild = spawn("node", ["scripts/github-proxy.mjs"], {
    stdio: "inherit",
    env: { ...process.env, GITHUB_PROXY_PORT: PROXY_PORT },
    detached: !isWindows,
  });
  args.push("--var", `GITHUB_API_BASE:http://127.0.0.1:${PROXY_PORT}`);
}

if (helperChild) {
  helperChild.on("exit", (code, signal) => {
    if (signal === "SIGTERM") return; // こちらから止めた
    console.error(`[dev] ${helperLabel} exited unexpectedly (code=${code}); shutting down wrangler`);
    cleanup();
    process.exit(code ?? 1);
  });
}

// wrangler 自身が proxy を見ると localhost 接続まで壊れるので、必ず外す。
for (const key of ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"]) {
  delete childEnv[key];
}
args.push(...passthrough);

wranglerChild = spawn("wrangler", args, {
  stdio: "inherit",
  shell: true,
  env: childEnv,
  detached: !isWindows,
});
wranglerChild.on("exit", (code) => {
  cleanup();
  process.exit(code ?? 0);
});

process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);
