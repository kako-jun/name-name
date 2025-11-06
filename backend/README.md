# Name×Name Backend

ビジュアルノベル制作ツール「Name×Name」のバックエンドAPI

## 技術スタック

- **FastAPI**: Python非同期Webフレームワーク
- **GitPython**: Git操作ライブラリ
- **Pydantic**: データ検証
- **Uvicorn**: ASGIサーバー

## 機能

### 1. プロジェクト管理
- プロジェクト一覧取得
- 新規プロジェクト初期化（ローカルGitリポジトリ作成）
- 既存プロジェクトのクローン
- プロジェクト同期（git pull）

### 2. 章データ管理
- 章データ取得（Markdown → JSON）
- 章データ保存（JSON → Markdown）
- 自動Git commit & push
- Markdown形式でVSCode/Claude Codeと連携

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
│   ├── git_service.py       # Git操作ラッパー
│   └── markdown_parser.py   # Markdown <-> JSON変換
├── projects/                # ゲームプロジェクト（各々独立したGitリポジトリ）
│   ├── game-1/
│   │   ├── .git/
│   │   ├── chapters/all.md
│   │   └── assets/
│   └── game-2/
│       ├── .git/
│       ├── chapters/all.md
│       └── assets/
├── Dockerfile
├── requirements.txt
├── README.md
└── ASSETS.md               # アセット管理の詳細

```

## セットアップ

### ローカル開発

```bash
# 依存関係のインストール
pip install -r requirements.txt

# サーバー起動
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

### Docker

```bash
# Dockerイメージのビルド
docker build -t name-name-backend .

# コンテナ起動
docker run -p 8000:8000 -v $(pwd)/projects:/app/projects name-name-backend
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
```

### 章データ

```
GET    /api/projects/{name}/chapters         # 章データ取得
PUT    /api/projects/{name}/chapters         # 章データ保存
```

### アセット管理

```
GET    /api/projects/{name}/assets/{type}           # アセット一覧
POST   /api/projects/{name}/assets/{type}           # アセットアップロード
GET    /api/projects/{name}/assets/{type}/{file}    # アセット取得
DELETE /api/projects/{name}/assets/{type}/{file}    # アセット削除
```

`{type}`: `images`, `audio`, `videos`

## データ形式

### Chapter（章）
```json
{
  "id": 1,
  "title": "出会い",
  "scenes": [...]
}
```

### Scene（シーン）
```json
{
  "id": 1,
  "title": "教室",
  "cuts": [...]
}
```

### Cut（カット/台詞）
```json
{
  "id": 1,
  "character": "主人公",
  "text": "今日も平和な一日が始まる。",
  "expression": "normal"
}
```

### Markdownフォーマット

```markdown
# 第1章: 出会い

## シーン1: 教室

### カット1
- **キャラクター**: 主人公
- **テキスト**: 今日も平和な一日が始まる。
- **表情**: normal

### カット2
- **キャラクター**: ヒロイン
- **テキスト**: おはよう！
- **表情**: smile
```

## CORS設定

デフォルトでVite開発サーバーからのアクセスを許可：
- `http://localhost:5173`
- `http://localhost:5174`

本番環境では適切なオリジンに変更してください。

## ログ

`logging`モジュールを使用してINFOレベルでログ出力。
重要な操作（clone、pull、commit、push）はすべてログに記録されます。

## エラーハンドリング

- 400: 不正なリクエスト（必須パラメータ不足など）
- 404: リソースが見つからない（プロジェクトやファイル）
- 500: サーバーエラー（Git操作失敗など）

## Phaserとの連携

詳細は `ASSETS.md` を参照してください。

エディタモードとプレイモードで同じアセットAPIを使用できるよう設計されています。
Phaserの`this.load.image()`などで直接APIのURLを指定することで、
バックエンドから動的にアセットをロードできます。

## ブランチ戦略

Name×Nameは、Gitブランチで開発環境と本番環境を分離します。

### ブランチの役割
- **`develop`**: 編集・テスト用（デフォルト、ローカル開発環境）
- **`main`**: 本番公開用（GCP本番環境）

### 仕組み
1. ローカルで`develop`ブランチで編集
2. 保存すると自動的に`develop`にcommit & push
3. 準備ができたらGitHubで`develop`→`main`のPRを作成
4. 本番環境は`main`ブランチのみを参照

詳細は `BRANCHES.md` を参照してください。

### API
```bash
# プロジェクト作成時にブランチ指定
POST /api/projects/init
{"name": "my-game", "branch": "develop"}

# ブランチ切り替え
POST /api/projects/{name}/switch-branch
{"branch": "main"}
```

## 今後の拡張

- [ ] ユーザー認証・権限管理
- [ ] プロジェクトのリネーム・削除機能
- [ ] Git LFSサポート（大容量ファイル対応）
- [ ] アセットのバリデーション（ファイル形式・サイズチェック）
- [ ] プレビュー画像の自動生成
- [ ] リアルタイムコラボレーション（WebSocket）
