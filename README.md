# Name×Name

ビジュアルノベル制作・実行ツール

直感的なキャンバスエディタでビジュアルノベルを作成し、Phaserで美しいゲームとして実行できます。
原稿とアセットはGitで自動管理され、PCでもスマホでも常に最新の原稿を編集できます。

## 特徴

### 📝 直感的なエディタ
- キャンバス上でドラッグ&ドロップ
- 章・シーン・カット構造で整理
- リアルタイムプレビュー

### 🎮 美しいゲーム実行
- Phaser 3ゲームエンジン
- スムーズなアニメーション
- マルチデバイス対応

### 🔄 自動バージョン管理
- 原稿の変更を自動保存（ワーキングディレクトリ）
- セーブボタンでGitコミット・プッシュ
- PC・スマホから同じ原稿を編集
- ブランチで開発版と本番版を分離

### 🎨 アセット管理
- 画像・音声・動画・アイデアをまとめて管理
- サムネイル表示と検索機能
- プレビュー機能（画像・音声・動画）
- ドラッグ&ドロップでアップロード
- セーブボタンでGitコミット

## インストール

### 必要なもの

- Node.js 20以上
- Python 3.11以上
- Git

### クイックスタート

```bash
# リポジトリをクローン
git clone https://github.com/kako-jun/name-name.git
cd name-name

# Docker Composeで起動（推奨）
docker compose up
```

ブラウザで以下にアクセス：
- フロントエンド: http://localhost:5173
- バックエンドAPI: http://localhost:8000

### 個別セットアップ

**フロントエンド:**
```bash
cd frontend
npm install
npm run dev
```

**バックエンド:**
```bash
cd backend
uv venv
uv sync
uv run uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

## 使い方

### 1. ゲームプロジェクトの作成

**新規作成:**
```bash
curl -X POST http://localhost:8000/api/projects/init \
  -H "Content-Type: application/json" \
  -d '{"name": "my-game"}'
```

**既存プロジェクトをクローン:**
```bash
curl -X POST http://localhost:8000/api/projects/clone \
  -H "Content-Type: application/json" \
  -d '{
    "name": "my-game",
    "repo_url": "https://github.com/user/my-game.git"
  }'
```

### 2. 原稿の編集

フロントエンドのエディタを開いて、キャンバス上で編集：
1. 章を追加
2. シーンを作成
3. カット（台詞）を入力
4. 保存（自動的にGitコミット）

### 3. ゲームの実行

「プレイモード」に切り替えて、作成したゲームを実行・確認できます。

### 4. アセットの追加

フロントエンドのアセット管理画面から：
1. プロジェクトを開く
2. 右上の「アセット」ボタンをクリック
3. タブ（画像・音声・動画・アイデア）を選択
4. 検索で既存アセットを絞り込み
5. 画面下部のアップロード領域にドラッグ&ドロップ
6. セーブボタンでコミット・プッシュ

**API経由でアップロード:**
```bash
# 画像をアップロード
curl -X POST http://localhost:8000/api/projects/my-game/assets/images \
  -F "file=@character.png"

# 音声をアップロード
curl -X POST http://localhost:8000/api/projects/my-game/assets/sounds \
  -F "file=@bgm.mp3"

# 動画をアップロード
curl -X POST http://localhost:8000/api/projects/my-game/assets/movies \
  -F "file=@intro.mp4"
```

## プロジェクト構造

```
my-game/                # ゲームプロジェクト（別リポジトリ）
├── .git/
├── .gitignore
├── .name-name.json    # ローカル設定（gitignore対象）
├── chapters/
│   └── all.md         # 原稿（Markdown形式）
└── assets/
    ├── images/        # 画像ファイル
    ├── sounds/        # 音声ファイル
    ├── movies/        # 動画ファイル
    └── ideas/         # アイデアファイル（テキスト等）
```

### Markdown形式の原稿

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

この形式なら、VSCodeやClaude Codeでも直接編集できます。

## 本番環境へのデプロイ

### 開発→本番の流れ

1. ローカルで`develop`ブランチを編集
2. 保存すると自動的にGitにコミット・プッシュ
3. GitHubでPull Requestを作成（`develop` → `main`）
4. レビュー後、マージ
5. 本番環境（GCP）が`main`ブランチを参照

これにより、開発中の原稿が本番環境に影響しません。

## 技術スタック

### フロントエンド
- React 18 + TypeScript
- Vite 6
- Tailwind CSS 4
- Phaser 3

### バックエンド
- FastAPI (Python)
- GitPython
- Pydantic

### インフラ
- Docker Compose
- Google Cloud Platform (GCP)

## ドキュメント

- [CLAUDE.md](./CLAUDE.md) - 開発ガイド（Claude Code用）
- [backend/README.md](./backend/README.md) - バックエンドAPI仕様
- [backend/ASSETS.md](./backend/ASSETS.md) - アセット管理詳細
- [backend/BRANCHES.md](./backend/BRANCHES.md) - ブランチ戦略

## ライセンス

MIT

## 作者

kako-jun
