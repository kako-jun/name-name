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
| PUT | `/api/projects/:name/contents/*path` | Contents API で commit。**新規作成 + 更新どちらも対応**（#115 で実装済）|
| GET | `/api/projects/:name/assets/:type` | `assets/{type}/` のディレクトリ一覧 |
| POST | `/api/projects/:name/assets/:type` | base64 アップロード。サイズで経路自動分岐: `<5 MiB`=Contents API、`>=5 MiB && <=25 MiB`=Git Data API (#116)、`>25 MiB`=413 |

> **大容量アセットの上限**: GitHub の blob 上限は 100 MiB だが、Cloudflare Workers の per-request メモリ上限が 128 MiB なので 100 MiB 級の base64 (≈133 MiB の文字列) は OOM する。本 Worker は安全圏として **25 MiB** で頭打ちにしている。それ以上は Git LFS or streaming アップロード経路 (将来 Issue) で扱う。

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

# 既存ファイルの更新（sha 必須・楽観ロック）
curl -X PUT http://localhost:8787/api/projects/ogurasia/contents/chapters/all.md \
  -H "authorization: Bearer ${DEV_AUTH_TOKEN}" \
  -H "content-type: application/json" \
  -d '{"content":"# 新本文","sha":"<前回の sha>","message":"edit chapters/all"}'

# 新規ファイルの作成（sha 省略 / message も省略可：デフォルト `create <path>`）
curl -X PUT http://localhost:8787/api/projects/ogurasia/contents/chapters/new.md \
  -H "authorization: Bearer ${DEV_AUTH_TOKEN}" \
  -H "content-type: application/json" \
  -d '{"content":"# 新シーン"}'
```

`PUT` のセマンティクス（#115）:

- `sha` あり → 既存ファイル更新。GitHub が sha 不一致を検知すると `409 Conflict`。
- `sha` なし → 新規ファイル作成。同名ファイルが既にある場合、GitHub が返す `422` を
  Worker 側で `409 Conflict` に正規化して返す（更新するなら `sha` を渡してくださいの旨）。
- `message` 任意（省略時は `create <path>` / `update <path>` のデフォルト）。
- 成功時はどちらも `200 OK` で `{ path, sha, commit_sha }` を返し、`x-cache: PURGED`。

## デプロイ

`/deploy` スキルか以下で手動。**本 Issue では deploy しない**（#111 で kako-jun が手動デプロイ）。

```bash
wrangler deploy
```

## 今後の Issue

- **#110** authenticate() 本実装（CF Access / GitHub OAuth）

実装済:

- **#118** ブランチ横断のキャッシュパージ — TTL を 60→10 秒に短縮することで実用妥協。GitHub UI で develop→main マージしても 10 秒以内に main 配信が新しくなる。kako-jun 1 人運用前提、レート枠 5000 req/h に余裕。generation-based / webhook 方式は将来必要になったら再検討


- **#111** 初回 wrangler deploy（session377 で手動完了）
- **#112** 旧 `backend/` (FastAPI) と `compose.yaml` の削除（session377 完了）
- **#115** 新規ファイル作成エンドポイント（sha なし PUT）— 422 → 409 正規化、`PUT` で create + update 両対応
- **#116** `>= 5 MiB` のアセットを Git Data API (blob/tree/commit/ref) で扱う（`<= 100 MiB`、それ以上は LFS = 別 Issue）
- **#117** PROJECTS リストの KV / D1 化（won't do、ハードコードのまま）

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
│   ├── cache.ts          # Cache API ヘルパー (10 秒、#118 でブランチ横断パージ妥協のため短縮)
│   ├── projects.ts       # GET /api/projects（ハードコード）
│   ├── contents.ts       # GET/PUT /api/projects/:name/contents/*
│   ├── assets.ts         # GET/POST /api/projects/:name/assets/:type
│   └── types.ts          # Env / Project / レスポンス型
└── test/
    ├── projects.test.ts
    ├── contents.test.ts
    └── assets.test.ts
```
