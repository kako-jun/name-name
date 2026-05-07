import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

// vitest-pool-workers 経由で workerd 上でテストを走らせる。
// wrangler.toml を再利用し、テスト用の env を上書きする。
export default defineWorkersConfig({
  test: {
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
