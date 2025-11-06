# Name×Name 開発ガイド (Claude Code用)

このファイルは、Claude Codeがこのプロジェクトを理解し、効率的に開発を進めるための情報をまとめたものです。

## プロジェクト概要

**Name×Name**: ビジュアルノベル制作・実行ツール

- ビジュアルノベルの原稿を管理（章、シーン、カット構造）
- エディタモード: キャンバス上でドラッグ&ドロップで編集
- プレイモード: Phaserでゲーム実行
- Git管理: 原稿とアセットをGitで自動バージョン管理
- ブランチ戦略: develop（開発用）/ main（本番用）

## プロジェクト構造（モノレポ）

```
name-name/
├── frontend/           # React + Vite + TypeScript
│   ├── src/
│   │   ├── components/ # UIコンポーネント
│   │   └── game/       # Phaserゲーム
│   ├── package.json
│   └── vite.config.ts
├── backend/            # FastAPI + Python
│   ├── app/
│   │   ├── main.py           # APIエンドポイント
│   │   ├── models.py         # Pydanticモデル
│   │   ├── git_service.py    # Git操作
│   │   └── markdown_parser.py # Markdown変換
│   ├── projects/             # ゲームプロジェクト（gitignore対象）
│   │   └── {game-name}/      # 各ゲームのリポジトリ
│   ├── pyproject.toml        # uv用依存関係
│   └── .gitignore
├── compose.yaml        # Docker Compose設定
└── CLAUDE.md           # このファイル
```

## 重要な設計原則

### 1. ツールとゲームデータの分離
- **Name×Nameツール**: このリポジトリ（name-name）
- **ゲームプロジェクト**: 別リポジトリ（例: ogurasia）
- 各ゲームは`backend/projects/`にクローンされる（gitignore対象）

### 2. Windowsでも動作する
- シンボリックリンクは使わない
- API経由でリポジトリをクローン・管理
- パスはOS依存しない形で扱う

### 3. ブランチ戦略
- **develop**: 開発・編集用（デフォルト）
- **main**: 本番公開用
- ローカル環境はdevelopブランチ
- 本番環境（GCP）はmainブランチを参照

## 開発環境のセットアップ

### バックエンド (FastAPI + Python)

```bash
cd backend

# 仮想環境作成と依存関係インストール
uv venv
uv sync

# サーバー起動
uv run uvicorn app.main:app --reload --host 0.0.0.0 --port 8001
```

**ポイント**:
- `uv`を使用（高速で最新の方式）
- `pyproject.toml`で依存関係管理（requirements.txtは廃止）
- ポートは8001を使用（8000が使われていることがあるため）

### フロントエンド (React + Vite)

```bash
cd frontend

# 依存関係インストール
npm install

# 開発サーバー起動
npm run dev
# → http://localhost:5173
```

### Docker Compose（推奨）

```bash
# ルートディレクトリで
docker compose up
```

フロントエンドとバックエンドが同時に起動します。

## ゲームプロジェクトの管理

### 新規ゲームの作成

```bash
# APIで初期化
curl -X POST http://localhost:8001/api/projects/init \
  -H "Content-Type: application/json" \
  -d '{"name": "my-game", "branch": "develop"}'
```

これで以下が自動生成されます：
- Git リポジトリ
- chapters/all.md
- assets/images/
- assets/audio/
- assets/videos/

### 既存ゲームのクローン

```bash
# APIでクローン
curl -X POST http://localhost:8001/api/projects/clone \
  -H "Content-Type: application/json" \
  -d '{
    "name": "ogurasia",
    "repo_url": "https://github.com/kako-jun/ogurasia.git",
    "branch": "develop"
  }'
```

**重要**:
- 手動で`git clone`しない
- 必ずAPI経由でクローン（Windows互換性のため）
- クローンされたプロジェクトは`backend/projects/`に配置

### プロジェクトの同期

```bash
# git pull
curl -X POST http://localhost:8001/api/projects/{name}/sync
```

### ブランチ切り替え

```bash
# developからmainに切り替え（本番確認用）
curl -X POST http://localhost:8001/api/projects/{name}/switch-branch \
  -H "Content-Type: application/json" \
  -d '{"branch": "main"}'
```

## ゲームプロジェクトの構造

各ゲームリポジトリは以下の構造を持ちます：

```
my-game/
├── .git/
├── .gitignore          # .name-name.jsonを除外
├── .name-name.json     # ローカル設定（ブランチ情報）
├── chapters/
│   └── all.md          # 章データ（Markdown形式）
└── assets/
    ├── images/
    ├── audio/
    └── videos/
```

### Markdownフォーマット

```markdown
# 第1章: タイトル

## シーン1: シーンタイトル

### カット1
- **キャラクター**: 主人公
- **テキスト**: セリフ内容
- **表情**: normal
```

## よく使うコマンド

### バックエンド開発

```bash
cd backend

# サーバー起動
uv run uvicorn app.main:app --reload --host 0.0.0.0 --port 8001

# プロジェクト一覧
LD_PRELOAD= curl http://localhost:8001/api/projects

# 章データ取得
LD_PRELOAD= curl http://localhost:8001/api/projects/ogurasia/chapters

# アセット一覧
LD_PRELOAD= curl http://localhost:8001/api/projects/ogurasia/assets/images
```

**注意**: `LD_PRELOAD=`はproxyを回避するために必要な場合があります。

### フロントエンド開発

```bash
cd frontend

# 開発サーバー起動
npm run dev

# ビルド
npm run build

# プレビュー
npm run preview
```

### Git操作

```bash
# コミット
git add -A
git commit -m "メッセージ"

# 別ディレクトリのリポジトリを操作
git -C /path/to/repo status
git -C /path/to/repo push origin develop

# proxyを回避してpush
LD_PRELOAD= git push origin main
```

## API エンドポイント一覧

### プロジェクト管理
- `GET /api/projects` - プロジェクト一覧
- `POST /api/projects/init` - 新規作成
- `POST /api/projects/clone` - クローン
- `POST /api/projects/{name}/sync` - 同期
- `POST /api/projects/{name}/switch-branch` - ブランチ切替

### 章データ
- `GET /api/projects/{name}/chapters` - 取得
- `PUT /api/projects/{name}/chapters` - 保存

### アセット管理
- `GET /api/projects/{name}/assets/{type}` - 一覧（type: images/audio/videos）
- `POST /api/projects/{name}/assets/{type}` - アップロード
- `GET /api/projects/{name}/assets/{type}/{filename}` - ダウンロード
- `DELETE /api/projects/{name}/assets/{type}/{filename}` - 削除

## トラブルシューティング

### ポート8001が使用中
```bash
# プロセスを確認
lsof -i :8001

# または別のポートを使用
uv run uvicorn app.main:app --reload --port 8002
```

### プロジェクトのクローンに失敗
- `backend/projects/{name}`が既に存在している可能性
- 手動で削除してから再クローン
```bash
rm -rf backend/projects/{name}
```

### Git pushがproxyでブロックされる
```bash
LD_PRELOAD= git push origin develop
```

### バックエンドの依存関係エラー
```bash
cd backend
rm -rf .venv
uv venv
uv sync
```

## 開発時の注意点

1. **シンボリックリンクは使わない** - Windows互換性のため
2. **API経由でプロジェクト管理** - 手動のgit操作は避ける
3. **ブランチを意識** - develop（開発）/ main（本番）
4. **projects/はgitignore対象** - 各ゲームは独立したリポジトリ
5. **LD_PRELOAD=を使う** - proxy環境でのcurl/git操作時
6. **uvを使う** - Python依存関係管理

## 次のステップ

現在の状態：
- ✅ バックエンドAPI実装完了
- ✅ プロジェクト管理機能完成
- ✅ アセット管理機能完成
- ✅ ブランチ戦略実装完了
- ⬜ フロントエンドとバックエンドの統合
- ⬜ エディタUIでプロジェクト選択機能
- ⬜ エディタからバックエンドAPIを呼び出し
- ⬜ アセットアップロードUI
- ⬜ Phaserとの統合テスト

## 参考ドキュメント

- `backend/README.md` - バックエンドAPI詳細
- `backend/ASSETS.md` - アセット管理とPhaser統合
- `backend/BRANCHES.md` - ブランチ戦略詳細
