# デプロイ手順

> **対象 Issue**: #111
> **アーキテクチャ**: ADR `docs/adr/0001-hosting-architecture.md`

name-name は **CF Pages（フロント）+ CF Worker（API）+ GitHub REST API（永続化）** で公開する。

```
ブラウザ
  ↓
name-name.llll-ll.com   ← CF Pages（静的フロント、本ドキュメント）
  ↓ fetch
name-name-api.workers.dev   ← CF Worker（octokit プロキシ）
  ↓ GitHub REST API
github.com/kako-jun/<game>
```

## 1. CF Worker のデプロイ（先にこちら）

### 前提

- `worker/wrangler.toml` が設定済み
- Cloudflare アカウントで `wrangler login` 完了

### Secret 設定（初回のみ）

```bash
cd worker

# GitHub Fine-grained PAT（kako-jun のリポへの contents read/write 権限）
wrangler secret put GITHUB_TOKEN

# DEV_AUTH_TOKEN は本番不要（#110 で本実装に置き換える前のローカル開発用）
# 本番デプロイ時は設定しない、または空にする
```

### デプロイ

```bash
cd worker
npm install
npx wrangler deploy
```

成功すると `name-name-api.workers.dev` に publish される。

### 動作確認

```bash
curl https://name-name-api.workers.dev/api/projects
# → 4 件のプロジェクト一覧が JSON で返る
```

## 2. CF Pages のデプロイ（フロント）

### CF Pages プロジェクト作成（初回のみ）

Cloudflare ダッシュボード → Workers & Pages → Create application → Pages → Connect to Git で `kako-jun/name-name` を接続。

### Build settings

| 項目 | 値 |
|---|---|
| Production branch | `main` |
| Framework preset | None |
| Build command | `cd frontend && npm ci && npm run build` |
| Build output directory | `frontend/dist` |
| Root directory | `/`（プロジェクトルート） |
| Node version | `20` |

WASM (`parser/pkg/`) はリポにコミット済（`parser/pkg/.gitignore` で `*` だが `git add -f` 済み）なので、CF Pages 側で `wasm-pack` を回す必要はない。

### Environment variables

| 変数 | 値 |
|---|---|
| `VITE_API_URL` | `https://name-name-api.workers.dev` |

CF Pages のダッシュボードで Production / Preview それぞれに設定。

### Custom domain

`name-name.llll-ll.com` を CF Pages に紐付ける:

1. CF Pages の `Custom domains` タブで `name-name.llll-ll.com` を追加
2. CF DNS に CNAME レコード（CF が自動生成）を追加（`llll-ll.com` 自体が CF 管理下なら自動）

### デプロイ

`main` ブランチへの push で自動デプロイ。CI 完了後、約 1〜2 分で反映。

### 動作確認

| URL | 期待 |
|---|---|
| `https://name-name.llll-ll.com/` | ジャンプ風タイトル画面（ゲーム選択） |
| `https://name-name.llll-ll.com/play/friday-1930` | friday-1930 のノベル+RPGレイキャストが再生 |
| `https://name-name.llll-ll.com/edit/friday-1930` | 編集画面（#110 の認証実装後はログイン必須） |
| `https://name-name.llll-ll.com/admin` | 旧プロジェクト管理画面 |

## 3. CORS 確認

Worker の `wrangler.toml` の `ALLOWED_ORIGIN` が `https://name-name.llll-ll.com` になっていること:

```toml
[vars]
ALLOWED_ORIGIN = "https://name-name.llll-ll.com"
DEFAULT_OWNER = "kako-jun"
```

dev 環境は `http://localhost:7374` を許可するため、ローカル開発時は別 wrangler.toml or `--var` でオーバーライド。

## 4. トラブルシューティング

### CF Pages のビルドが落ちる

- `parser/pkg/*.wasm` がコミットされているか確認（`git ls-files parser/pkg/`）
- `node_modules/.bin/tsc` が見つからない場合は `npm ci` のキャッシュをクリア

### `/play/<game>` で「ゲームデータが見つかりません」

- Worker の `GITHUB_TOKEN` が設定されているか
- `wrangler tail` でリクエストログを観察
- 対象ゲームリポの `main` ブランチに `chapters/all.md` が存在するか

### `/edit/<game>` で 401 / 403

- #110 の認証実装後はログインが必須。CF Access の設定を確認
- 暫定（#110 未実装期間）は `localStorage.setItem('dev_auth_token', '<DEV_AUTH_TOKEN>')` で開発トークンをセット

### CORS エラー

- Worker `ALLOWED_ORIGIN` と CF Pages のドメインが一致しているか
- preview デプロイ（PR ごとの一時 URL）は別 origin になるので CORS から漏れる。preview を使うなら `ALLOWED_ORIGINS` 配列化が要る（フォローアップ Issue 候補）

## 5. 旧 backend の停止

`backend/` (FastAPI / GitPython / compose.yaml) は #112 で削除予定。CF Pages + Worker が稼働している間は触らないでよい。

## 6. ロールバック

- CF Pages: ダッシュボードの `Deployments` から過去ビルドを `Rollback`
- CF Worker: `wrangler rollback` で直前バージョンに戻す

---

## 関連 Issue

- #105 ホスティング ADR
- #106 Worker 新設（マージ済）
- #107 frontend API 切替（マージ済）
- #108 ルーティング (`/play` `/edit`)（マージ済）
- #109 ジャンプ風トップ（マージ済）
- #110 CF Access or GitHub OAuth 認証（未着手、kako-jun 判断待ち）
- #111 CF Pages デプロイ（本ドキュメント、kako-jun 手作業）
- #112 旧 backend 削除（Worker 動作確認後）
