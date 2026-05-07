# ブランチ戦略

> **⚠️ 2026-05-08 改訂**
> 旧版は「ローカル Docker 開発 + GCP 本番」前提でしたが、**ホスティング戦略は CF Pages + CF Worker + GitHub API（Agasteer 方式）に転換**しました。本ファイルもそれに合わせて書き直しています。
> 正本（永続的な意思決定記録）: `repos/private/notes/.agasteer/notes/dev/name-name.md` の「ホスティング戦略（2026-05-08 確定）」セクション。
> 旧版で説明されていた「FastAPI に POST してブランチ切替」「`backend/projects/` に clone」「GCP 本番環境」はすべて廃止予定です。

## ブランチの役割

各ゲームリポ（`kako-jun/ogurasia`, `kako-jun/skirts-colour`, `kako-jun/friday-1930` 等）は2本のブランチを持ちます。

### `develop` ブランチ（編集用）

- **誰が触るか**: kako-jun のみ（`name-name.llll-ll.com/edit/<game>` 経由）
- **どこから触るか**: ブラウザのエディタ → CF Worker → GitHub Contents API → `develop` への commit
- **特徴**:
  - 自由に編集・保存できる
  - 一般ユーザーから見えない（`/play/*` は main しか参照しない）
  - 未完成原稿・試作中シーンを置く場所

### `main` ブランチ（公開用）

- **誰が見るか**: 一般ユーザー（`name-name.llll-ll.com/play/<game>`）
- **どう反映するか**: kako-jun が GitHub UI で `develop` → `main` の PR をマージ
- **特徴**:
  - 確定した原稿のみがマージされる
  - マージ＝即公開（Worker のキャッシュをパージしてから次のリクエストで反映）

## ワークフロー

### 1. 通常の編集作業

```
kako-jun (ブラウザ)
    ↓ /edit/<game> でログイン
name-name.llll-ll.com (CF Pages, 静的フロント)
    ↓ fetch
name-name-api.workers.dev (CF Worker)
    ↓ GitHub REST API (octokit)
github.com/kako-jun/<game>  (develop ブランチに commit)
```

1. `/edit/<game>` を開く（CF Access or GitHub OAuth で kako-jun を認証）
2. Worker が `GET /repos/kako-jun/<game>/contents/...?ref=develop` で内容取得
3. ブラウザ上で編集
4. 保存ボタン → Worker が `PUT /repos/.../contents/...` で SHA 付きコミット（`develop` に対して）

### 2. 本番反映

```
develop → Pull Request → main → 一般ユーザーから見える
```

1. GitHub 上で `develop` → `main` の PR を作成
2. kako-jun が確認してマージ
3. Worker のキャッシュをパージ（保存時 or マージ時に webhook で）
4. 次の `/play/<game>` リクエストから新しい main が見える

### 3. 別デバイスでの楽観ロック

Contents API は `sha` 必須。別デバイスで先に編集された場合は 409 が返るので、エディタ側に「最新を取り直す」ボタンを実装して事故を防ぐ。

## 認証

- **編集 (`/edit/*`)**: CF Access or GitHub OAuth で kako-jun のみ通過
- **再生 (`/play/*`)**: ログイン不要
- **GitHub PAT**: Worker の Secret（`wrangler secret put GITHUB_TOKEN`）に格納。**ブラウザに一切渡さない**

## 廃止された旧計画（参考）

以下は旧版の記述で、**現在は使われていません**。順次削除されます。

- `POST /api/projects/{name}/switch-branch` (FastAPI バックエンド) → 廃止
- `backend/projects/{name}/.git/` にローカルクローン → 廃止（GitHub をそのまま使う）
- `.name-name.json` の `branch` フィールド → 廃止（ブランチはURL/UIで指定）
- GCP 本番環境が main を自動デプロイ → 廃止（CF Pages + Worker に置換）

## まとめ

- **`develop`**: 編集用（kako-jun が `/edit/<game>` から触る）
- **`main`**: 公開用（一般ユーザーが `/play/<game>` で見る）
- 編集 = Worker → GitHub Contents API で `develop` に commit
- 公開 = GitHub UI で develop→main マージ → Worker キャッシュパージ
