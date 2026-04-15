# アーキテクチャ設計書

Name×Name のシステム構成と主要な設計判断をまとめる。

## モノレポ構造

```
name-name/
├── parser/             # Rust crate（Markdownパーサー本体）
│   ├── Cargo.toml
│   ├── src/
│   │   ├── lib.rs            # WASMエクスポート
│   │   ├── models.rs         # Eventデータモデル（型の正本）
│   │   ├── parser.rs         # Markdown → Events
│   │   └── emitter.rs        # Events → Markdown
│   └── tests/
├── frontend/           # React + Vite + TypeScript
│   ├── src/
│   │   ├── components/       # UIコンポーネント
│   │   └── game/             # ゲームレンダラー
│   │       ├── novel/        # ノベルプレイヤー（PixiJS）
│   │       └── rpg/          # RPGプレイヤー（Phaser, 移行予定）
│   ├── package.json
│   └── vite.config.ts
├── backend/            # FastAPI + Python（プロジェクト管理のみ）
│   ├── app/
│   │   ├── main.py           # APIエンドポイント
│   │   ├── models.py         # Pydanticモデル
│   │   └── git_service.py    # Git操作
│   ├── projects/             # ゲームプロジェクト（gitignore対象）
│   └── pyproject.toml
├── docs/               # ドキュメント
└── compose.yaml        # Docker Compose設定
```

### 各モジュールの責務

| モジュール | 責務 | パースする？ |
|---|---|---|
| `parser/` | Markdown ↔ Event[] の双方向変換 | Yes（正本） |
| `frontend/` | エディタUI + ノベルプレイヤー + RPGプレイヤー | No（WASMで parser を呼ぶ） |
| `backend/` | プロジェクト管理、Git操作、アセット配信 | No（生テキスト中継） |

バックエンドはパースしない。Markdown テキストをそのままフロントエンドに渡し、フロントエンドが WASM パーサーで Event[] に変換する。

## データフロー

### 編集時

```
ユーザー操作 → React UI → Event[] → parser(emit) → Markdown → API → Git保存
```

### 再生時

```
API → Markdown → parser(parse) → Event[] → resolveEvents → NovelRenderer(PixiJS)
```

## パーサー

Rust で実装。wasm-bindgen + tsify-next で TypeScript 型を自動生成する。

### Event 型

`parser/src/models.rs` が型の正本。主要なバリアント:

- `FrontMatter` — メタデータ（engine, chapter, title, hidden, default_bgm）
- `Scene` — シーン定義（id, title）
- `Dialogue` — ダイアログ（character, expression, position, text）
- `Narration` — ナレーション（text）
- `Background` — 背景変更（path）
- `Bgm` / `BgmStop` — BGM 再生/停止
- `Se` — SE 再生
- `Blackout` / `BlackoutRelease` — 暗転/暗転解除
- `SceneTransition` — 場面転換
- `CharacterExit` — 立ち絵退場
- `ExpressionChange` — 表情変更
- `Wait` — 待機（ミリ秒）
- `SetFlag` — フラグ設定
- `Condition` — 条件分岐（内部にイベント配列を持つ）
- `Choice` — 選択肢（選択肢リスト）

### 双方向変換

- `parse(markdown) → Event[]` — Markdown テキストを Event 配列に変換
- `emit(events) → markdown` — Event 配列を Markdown テキストに復元

ラウンドトリップテスト（parse → emit → parse で同一結果）により整合性を保証する。

## 状態管理: NovelGameState

ノベルプレイヤーはスナップショット方式で状態を管理する。

### NovelGameState の構成

```typescript
interface NovelGameState {
  eventIndex: number;           // 現在のイベントインデックス
  backgroundPath: string | null; // 表示中の背景
  bgmPath: string | null;       // 再生中のBGM
  isBlackout: boolean;          // 暗転中か
  characters: CharacterState[]; // 表示中の立ち絵
  flags: Record<string, FlagValue>; // フラグ状態
}
```

### スナップショット方式の利点

1. **巻き戻し**: 履歴スタックから前のスナップショットを取り出すだけ
2. **シーク**: 先頭からリプレイせず、対象位置のスナップショットを直接復元
3. **セーブ/ロード**: スナップショットをそのまま JSON 化して保存・復元
4. **宣言的復元**: `applyState(snapshot)` で画面を完全に再構築

### 主要API

| API | 説明 |
|---|---|
| `advance()` | 次のイベントに進む |
| `goBack()` | 前のイベントに戻る |
| `getSnapshot()` | 現在の状態をスナップショットとして取得 |
| `seekTo(index)` | 指定インデックスにジャンプ |
| `applyState(state)` | スナップショットから画面を復元 |

## レンダリングパイプライン

```
Event[] (パース結果)
    ↓
resolveEvents(events, flags)    ← Condition を評価・展開
    ↓
ResolvedEvent[]                 ← フラットな配列（Condition なし）
    ↓
NovelRenderer (PixiJS)          ← 1イベントずつ描画
```

### resolveEvents

`Condition` イベントを実行時のフラグ状態に基づいて展開し、フラットな `ResolvedEvent[]` を生成する。

- events 配列の splice は行わない（不変展開）
- フラグ変更のたびに再評価し、新しい ResolvedEvent[] を生成
- ResolvedEvent[] のインデックスがシークバーの位置に対応

### 演出イベントの即時実行

以下のイベントはユーザー操作を待たず即時実行し、次のイベントに自動進行する:

- `Background` — 背景変更
- `Blackout` / `BlackoutRelease` — 暗転/暗転解除
- `SceneTransition` — 場面転換
- `Bgm` / `BgmStop` / `Se` — 音声制御
- `SetFlag` — フラグ設定
- `CharacterExit` / `ExpressionChange` — 立ち絵制御
- `Wait` — 待機

`Dialogue` と `Narration` のみユーザー操作（クリック/キー）で進行する。

## セーブ/ロード

### 保存先

localStorage に 3 スロット分のセーブデータを保存する。

### SaveSlotData

```typescript
interface SaveSlotData {
  slotIndex: number;
  timestamp: string;
  gameState: NovelGameState;  // スナップショット
  previewText: string;        // セーブ画面に表示するテキスト
}
```

### JSON エクスポート/インポート

セーブデータを JSON ファイルとしてエクスポート・インポートできる。異なるブラウザ間でのデータ移行に使用。

## 音声システム

Web Audio API を使用。

### BGM
- ループ再生
- 曲切り替え時はフェードアウト → 新曲開始
- `[BGM停止]` でフェードアウト停止

### SE
- ワンショット再生
- 複数 SE の同時再生対応

### AudioBuffer キャッシュ
- 一度デコードした AudioBuffer をキャッシュ
- ユーザーインタラクション制約（autoplay policy）に対応

## ツールとゲームデータの分離

- **Name×Name ツール**: このリポジトリ（name-name）
- **ゲームプロジェクト**: 別リポジトリ（例: ogurasia）
- 各ゲームは `backend/projects/` にクローンされる（gitignore 対象）
- API 経由でクローン・管理（手動 git clone 禁止、Windows 互換性のため）
