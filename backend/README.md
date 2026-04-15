# Name×Name Backend

ビジュアルノベル制作ツール「Name×Name」のバックエンドAPI

## 技術スタック

- **FastAPI**: Python非同期Webフレームワーク
- **GitPython**: Git操作ライブラリ
- **Pydantic**: データ検証
- **Uvicorn**: ASGIサーバー

## 役割

バックエンドはプロジェクト管理とアセット管理のみを担当する。Markdownのパースはフロントエンド側でRust WASMパーサー（`parser/`）を使用するため、バックエンドではパースしない。

### 1. プロジェクト管理
- プロジェクト一覧取得
- 新規プロジェクト初期化（ローカルGitリポジトリ作成）
- 既存プロジェクトのクローン
- プロジェクト同期（git pull）

### 2. 章データ管理
- 章データ取得（Markdown生テキストを返す）
- 章データ保存（Markdown生テキストをそのまま書き込む）
- 自動Git commit & push

### 3. アセット管理
- 画像、音声、動画のアップロード
- アセット一覧取得
- アセット配信（静的ファイルサーブ）
- アセット削除
- 全てのアセット操作でGit管理

## ディレクトリ構造

```
backend/
├── app/
│   ├── __init__.py
│   ├── main.py              # FastAPIアプリケーション
│   ├── models.py            # Pydanticモデル
│   └── git_service.py       # Git操作ラッパー
├── projects/                # ゲームプロジェクト（各々独立したGitリポジトリ）
├── Dockerfile
├── pyproject.toml
├── README.md
└── ASSETS.md               # アセット管理の詳細
```

## セットアップ

### ローカル開発

```bash
cd backend
uv venv
uv sync
uv run uvicorn app.main:app --reload --host 0.0.0.0 --port 7373
```

### Docker Compose（推奨）

```bash
# ルートディレクトリで実行
docker compose up
```

## API エンドポイント

### プロジェクト管理

```
GET    /api/projects                         # プロジェクト一覧
POST   /api/projects/init                    # 新規プロジェクト作成
POST   /api/projects/clone                   # 既存プロジェクトをクローン
POST   /api/projects/{name}/sync             # プロジェクト同期
POST   /api/projects/{name}/switch-branch    # ブランチ切替
POST   /api/projects/{name}/discard          # 未コミット変更を破棄
```

### 章データ

```
GET    /api/projects/{name}/chapters         # Markdown生テキスト取得
PUT    /api/projects/{name}/chapters         # Markdown生テキスト保存
```

レスポンス形式:
```json
{"content": "---\nengine: name-name\n..."}
```

リクエスト形式:
```json
{"content": "---\nengine: name-name\n..."}
```

### コミット・ステータス

```
GET    /api/projects/{name}/status           # 未コミット変更の確認
POST   /api/projects/{name}/commit           # コミット・プッシュ
```

### アセット管理

```
GET    /api/projects/{name}/assets/{type}               # アセット一覧（?q= 名前検索, ?tag= タグフィルタ）
POST   /api/projects/{name}/assets/{type}               # アセットアップロード
GET    /api/projects/{name}/assets/{type}/{file}        # アセット取得
DELETE /api/projects/{name}/assets/{type}/{file}        # アセット削除
PUT    /api/projects/{name}/assets/{type}/{file}/tags   # タグ設定
DELETE /api/projects/{name}/assets/{type}/{file}/tags/{tag}  # タグ削除
```

### タグ管理

```
GET    /api/projects/{name}/tags                        # 全ユニークタグ一覧
```

`{type}`: `images`, `sounds`, `movies`, `ideas`

タグ情報はプロジェクト内の `.name-name-tags.json` に保存されます（Git管理対象）。

## CORS設定

開発中はすべてのオリジンを許可。
本番環境では適切なオリジンに変更してください。

## エラーハンドリング

- 400: 不正なリクエスト（必須パラメータ不足など）
- 404: リソースが見つからない（プロジェクトやファイル）
- 500: サーバーエラー（Git操作失敗など）

## ブランチ戦略

詳細は `BRANCHES.md` を参照。

- **`develop`**: 編集・テスト用（デフォルト）
- **`main`**: 本番公開用
