# name-name-api (Cloudflare Worker)

`name-name` のホスティング戦略 (ADR `docs/adr/0001-hosting-architecture.md`) に基づき、
旧 FastAPI + GitPython バックエンドの代わりに、薄い Cloudflare Worker から
GitHub REST API を叩く Agasteer 方式の薄プロキシ。

```
ブラウザ (CF Pages, name-name.llll-ll.com)
    ↓ fetch
name-name-api.workers.dev (この Worker)
    ↓ @octokit/core
github.com/kako-jun/<game>
```

Issue: kako-jun/name-name#106

## エンドポイント

| Method | Path | 説明 |
|---|---|---|
| GET | `/api/projects` | 公開ゲーム一覧（ハードコード）|
| GET | `/api/projects/:name/contents/*path` | Contents API ラッパー (base64 → utf-8) |
| PUT | `/api/projects/:name/contents/*path` | Contents API で commit。sha 必須（楽観ロック）|
| GET | `/api/projects/:name/assets/:type` | `assets/{type}/` のディレクトリ一覧 |
| POST | `/api/projects/:name/assets/:type` | base64 アップロード（**5 MiB 未満**）|

`PUT` / `POST` は editor 認証が必要。**現状は dev only** で `Authorization: Bearer ${DEV_AUTH_TOKEN}` 一致のみ通す。
本実装（CF Access JWT or GitHub OAuth）は **kako-jun/name-name#110**。

## セットアップ

```bash
cd worker
npm install
npm run build   # tsc --noEmit
npm test        # vitest (vitest-pool-workers)
```

## ローカル起動

`GITHUB_TOKEN` は本番でも secret として扱う。`DEV_AUTH_TOKEN` は **ローカル開発のみ** で使う擬似 editor トークンなので、`.dev.vars` に書く（`.gitignore` 済み）。

```bash
# .dev.vars (gitignore 対象、ローカル開発のみ)
# DEV_AUTH_TOKEN=<your-local-token>
# GITHUB_TOKEN=<your-fine-grained-pat>
```

本番では:

```bash
# 初回のみ
wrangler secret put GITHUB_TOKEN     # GitHub fine-grained PAT
# DEV_AUTH_TOKEN は本番では不要。#110 の本認証 (CF Access JWT / GitHub OAuth) に置き換え予定。
```

```bash
# dev server
npm run dev
# → http://localhost:8787
```

### `nodejs_compat` フラグについて

`wrangler.toml` の `compatibility_flags = ["nodejs_compat"]` は、`@octokit/core` 5.x が
`node:events` 等の Node 互換モジュールを参照する可能性があるため有効化している。
また `vitest-pool-workers` の起動条件にも必須。

例:

```bash
curl http://localhost:8787/api/projects
curl http://localhost:8787/api/projects/ogurasia/contents/chapters/all.md

curl -X PUT http://localhost:8787/api/projects/ogurasia/contents/chapters/all.md \
  -H "authorization: Bearer ${DEV_AUTH_TOKEN}" \
  -H "content-type: application/json" \
  -d '{"content":"# 新本文","sha":"<前回の sha>","message":"edit chapters/all"}'
```

## デプロイ

`/deploy` スキルか以下で手動。**本 Issue では deploy しない**（#111 で kako-jun が手動デプロイ）。

```bash
wrangler deploy
```

## 今後の Issue

- **#110** authenticate() 本実装（CF Access / GitHub OAuth）
- **#111** 初回 wrangler deploy（kako-jun が手動）
- **#112** 旧 `backend/` (FastAPI) と `compose.yaml` の削除
- **#115** 新規ファイル作成エンドポイント（sha なし PUT）
- **#116** `>= 5 MiB` のアセットを Git Data API (blob/tree/commit) で扱う
- **#117** PROJECTS リストの KV / D1 化
- **#118** ブランチ横断のキャッシュパージ（GitHub webhook 経由）

## ファイル構成

```
worker/
├── package.json
├── tsconfig.json
├── wrangler.toml
├── vitest.config.ts
├── README.md
├── src/
│   ├── index.ts          # エントリ + ルーティング + CORS
│   ├── github.ts         # @octokit/core ラッパー + rate-limit ログ
│   ├── auth.ts           # 認証ミドルウェア（#110 で本実装、現状スタブ）
│   ├── cache.ts          # Cache API ヘルパー (60 秒)
│   ├── projects.ts       # GET /api/projects（ハードコード）
│   ├── contents.ts       # GET/PUT /api/projects/:name/contents/*
│   ├── assets.ts         # GET/POST /api/projects/:name/assets/:type
│   └── types.ts          # Env / Project / レスポンス型
└── test/
    ├── projects.test.ts
    ├── contents.test.ts
    └── assets.test.ts
```
