import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

// vitest-pool-workers 経由で workerd 上でテストを走らせる。
// wrangler.toml を再利用し、テスト用の env を上書きする。
export default defineWorkersConfig({
  test: {
    // デフォルト include は worker/ 配下全体に効く。scripts/*.test.mjs は
    // node:test 用 (host 側 Node プロセスで直接動かす local-fs-proxy テスト、
    // #371) なので、vitest には test/ 配下の *.test.ts だけを拾わせる。
    include: ["test/**/*.test.ts"],
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          // テスト用の secret / vars 上書き
          bindings: {
            ALLOWED_ORIGIN: "https://name-name.llll-ll.com",
            DEFAULT_OWNER: "kako-jun",
            GITHUB_TOKEN: "test-pat",
            DEV_AUTH_TOKEN: "dev-token",
          },
        },
      },
    },
  },
});
