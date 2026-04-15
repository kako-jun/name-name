# Name×Name

ビジュアルノベル制作・実行ツール

Markdownで原稿を書き、PixiJSで美しいノベルゲームとして実行できます。
原稿とアセットはGitで自動管理され、PCでもスマホでも常に最新の原稿を編集できます。

## 特徴

### 📝 直感的なエディタ
- キャンバス上でドラッグ&ドロップ
- 章・シーン構造で整理
- リアルタイムプレビュー

### 🎮 美しいゲーム実行
- PixiJSによるノベルプレイヤー
- スムーズなアニメーション・演出（暗転、場面転換、立ち絵表情変更）
- BGM・SE再生（Web Audio API）
- セーブ/ロード、バックログ、シークバー
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
- Rust（パーサーのビルドに必要）
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
- バックエンドAPI: http://localhost:7373

### 個別セットアップ

**パーサー（Rust → WASM）:**
```bash
cd parser
wasm-pack build --target web
```

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
uv run uvicorn app.main:app --reload --host 0.0.0.0 --port 7373
```

## 使い方

### 1. ゲームプロジェクトの作成

**新規作成:**
```bash
curl -X POST http://localhost:7373/api/projects/init \
  -H "Content-Type: application/json" \
  -d '{"name": "my-game"}'
```

**既存プロジェクトをクローン:**
```bash
curl -X POST http://localhost:7373/api/projects/clone \
  -H "Content-Type: application/json" \
  -d '{
    "name": "my-game",
    "repo_url": "https://github.com/user/my-game.git"
  }'
```

### 2. 原稿の編集

フロントエンドのエディタを開いて、キャンバス上で編集：
1. プロジェクトを選択
2. シーンを作成
3. ダイアログ（台詞）を入力
4. 保存（自動的にGitコミット）

### 3. ゲームの実行

「プレイモード」に切り替えて、作成したゲームを実行・確認できます。

### 4. 操作方法

| 操作 | 動作 |
|---|---|
| Space / Enter / → | 次のテキストへ |
| ← | 前のテキストへ |
| S | セーブメニュー |
| L | ロードメニュー |
| B | バックログ表示/非表示 |
| Escape | オーバーレイを閉じる |
| クリック/タップ | 次のテキストへ |
| シークバー | クリックで任意位置にジャンプ |

### 5. アセットの追加

フロントエンドのアセット管理画面から：
1. プロジェクトを開く
2. 右上の「アセット」ボタンをクリック
3. タブ（画像・音声・動画・アイデア）を選択
4. 検索で既存アセットを絞り込み
5. 画面下部のアップロード領域にドラッグ&ドロップ
6. セーブボタンでコミット・プッシュ

## Markdown v0.1 フォーマット

原稿はMarkdownの拡張形式で記述します。

```markdown
---
engine: name-name
chapter: 1
title: "出会い"
default_bgm: amehure.ogg
---

## 1-1: 教室の朝

[背景: radius/BG_COMMON_GRAD_3.png]
[BGM: amehure.ogg]
[暗転解除]

**主人公** (suppin_1, 左):
今日も平和な一日が始まる。

**ヒロイン** (smile_1, 右):
おはよう！
```

詳しい構文は [docs/spec/markdown-v0.1.md](./docs/spec/markdown-v0.1.md) を参照してください。

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

## 技術スタック

### フロントエンド
- React 18 + TypeScript
- Vite 6
- Tailwind CSS 4
- PixiJS（ノベルプレイヤー）

### パーサー
- Rust（wasm-bindgen, tsify-next）
- Markdown → Event[] の双方向変換

### バックエンド
- FastAPI (Python)
- GitPython
- Pydantic

### インフラ
- Docker Compose
- Google Cloud Platform (GCP)

## ドキュメント

- [docs/spec/markdown-v0.1.md](./docs/spec/markdown-v0.1.md) - Markdown v0.1 構文仕様
- [docs/architecture.md](./docs/architecture.md) - アーキテクチャ設計書
- [docs/guide/controls.md](./docs/guide/controls.md) - 操作ガイド
- [CLAUDE.md](./CLAUDE.md) - 開発ガイド（Claude Code用）
- [backend/README.md](./backend/README.md) - バックエンドAPI仕様
- [backend/ASSETS.md](./backend/ASSETS.md) - アセット管理詳細
- [backend/BRANCHES.md](./backend/BRANCHES.md) - ブランチ戦略

## ライセンス

MIT

## 作者

kako-jun
