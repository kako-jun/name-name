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
│   │   └── game/             # ゲームレンダラー（PixiJS）
│   │       ├── NovelRenderer.ts     # ノベルプレイヤー
│   │       ├── DialogBox.ts         # ノベル用ダイアログ（話者名別枠 + ▼）
│   │       ├── TopDownRenderer.ts   # RPG 見下ろし型
│   │       ├── RaycastRenderer.ts   # RPG 一人称レイキャスト型
│   │       └── RpgDialogBox.ts      # RPG 共通ダイアログ（TopDown / Raycast で共用）
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
| `frontend/` | エディタUI + ノベルプレイヤー（PixiJS） + RPGプレイヤー（PixiJS） | Yes（WASMで parser を呼ぶ。`src/wasm/parser.ts` 経由） |
| `backend/` | プロジェクト管理、Git操作、アセット配信 | No（生テキスト中継） |

バックエンドはパースしない。Markdown テキストをそのままフロントエンドに渡し、フロントエンドが WASM パーサー（`frontend/src/wasm/parser.ts`）で Event[] に変換する。WASM の初期化は遅延実行（初回呼び出し時に `init()` を実行）。

## データフロー

### 編集時

```
ユーザー操作 → React UI (EventDocument 直接操作) → parser(emit) → Markdown → API → Git保存
```

エディタは `EventDocument`（`chapters[].scenes[].events[]` のツリー）を真実の情報源として
保持する。UI の編集操作は `EventDocument` を直接更新し、`emitMarkdown` で Markdown 文字列に
変換してから autosave 経由で backend に保存する。旧 `Chapter` / `Scene` / `Cut` 型は削除済み。

### 再生時

```
API → Markdown → parser(parse) → Event[] → resolveEvents → NovelRenderer(PixiJS)
```

## パーサー

Rust で実装。wasm-bindgen + tsify-next で TypeScript 型を自動生成する。

### Event 型

`parser/src/models.rs` が型の正本。主要なバリアント:

- `Dialog` — ダイアログ（character, expression, position, text）
- `Narration` — ナレーション（text）
- `Background` — 背景変更（path）
- `Bgm` — BGM 制御（action: Play/Stop, path）
- `Se` — SE 再生（path）
- `Blackout` — 暗転制御（action: On/Off）
- `SceneTransition` — 場面転換
- `Exit` — 立ち絵退場（character）
- `ExpressionChange` — 表情変更（character, expression）
- `Wait` — 待機（ms）
- `Flag` — フラグ設定（name, value）
- `Condition` — 条件分岐（flag, events: Event[]）
- `Choice` — 選択肢（options: ChoiceOption[]）
- `RpgMap` — RPG マップ（width, height, tile_size, tiles: u8[][]）
- `PlayerStart` — プレイヤー初期位置（x, y, direction）
- `Npc` — NPC 配置（id, name, x, y, color, message: string[], sprite?: string, frames?: u32, direction?: Direction）

フロントマターは Event ではなく、`Chapter` 構造体のフィールド（number, title, hidden, default_bgm）としてパースされる。`Scene` も Event ではなくドキュメント構造の一部。

### 双方向変換

- `parse(markdown) → Event[]` — Markdown テキストを Event 配列に変換
- `emit(events) → markdown` — Event 配列を Markdown テキストに復元

ラウンドトリップテスト（parse → emit → parse で同一結果）により整合性を保証する。

## 状態管理: NovelGameState

ノベルプレイヤーはスナップショット方式で状態を管理する。

### NovelGameState の構成

```typescript
interface NovelGameState {
  sceneId: string | null;                    // 現在のシーンID
  eventIndex: number;                        // 現在のイベントインデックス
  textIndex: number;                         // 現在のテキスト行インデックス
  flags: Record<string, FlagValue>;          // フラグ状態
  backgroundPath: string | null;             // 表示中の背景
  isBlackout: boolean;                       // 暗転中か
  characters: Array<{ name: string; expression: string; position: string }>;
  currentBgmPath: string | null;             // 再生中のBGM
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
| `seekTo(historyIndex)` | 履歴の指定位置にジャンプ |
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

- 元の events 配列を変更しない（不変展開）
- フラグ変更のたびに再評価し、新しい ResolvedEvent[] を生成
- ResolvedEvent[] のインデックスがシークバーの位置に対応

### 演出イベントの即時実行

以下のイベントはユーザー操作を待たず即時実行し、次のイベントに自動進行する:

- `Background` — 背景変更
- `Blackout` — 暗転/暗転解除（action: On/Off）
- `SceneTransition` — 場面転換
- `Bgm` / `Se` — 音声制御
- `Flag` — フラグ設定
- `Exit` / `ExpressionChange` — 立ち絵制御
- `Wait` — 待機

`Dialog` と `Narration` のみユーザー操作（クリック/キー）で進行する。

## セーブ/ロード

### 保存先

localStorage に 3 スロット分のセーブデータを保存する。

### SaveSlotData

```typescript
interface SaveSlotData {
  slot: number;
  sceneId: string | null;
  eventIndex: number;
  textIndex: number;
  flags: Record<string, FlagValue>;
  backgroundPath: string | null;
  isBlackout: boolean;
  characters: Array<{ name: string; expression: string; position: string }>;
  currentBgmPath: string | null;
  savedAt: string;             // ISO 8601
  sceneName: string | null;    // 表示用シーン名
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

## RPG サブシステム

RPG プレイモードもノベルと同じく PixiJS で実装する（Phaser から移行済み）。
レンダラーは 2 種類:

- `frontend/src/game/TopDownRenderer.ts` — 見下ろし型（デフォルト）。グリッド単位のステップ移動で編集との対応が取りやすい
- `frontend/src/game/RaycastRenderer.ts` — 一人称レイキャスト型。DDA 方式で縦ストライプ描画、距離フォグ、NPC は距離ソート billboard

`RPGPlayer` は `view` prop（`'topdown' | 'raycast'`）でどちらを使うかを受け取り、シーンヘッダー `[view=...]` の値がそのまま伝わる。MapEditor は編集性を優先して常に TopDown を使う。

### RPGProject データモデル

`frontend/src/types/rpg.ts` に定義：

- `MapData` — `width` / `height` / `tileSize` + 2次元配列の `tiles`（`TileType` = GRASS / ROAD / TREE / WATER）
- `PlayerData` — 初期グリッド座標と向き（`up` / `down` / `left` / `right`）
- `NPCData` — グリッド座標・名前・会話メッセージ・表示色・オプション: `sprite`（スプライトシートパス）・`frames`（歩行アニメフレーム数 / 方向あたり、未指定なら 2）・`direction`（アイドル時の向き、未指定なら `down`）
- `RPGProject` — 上記の集合（+ 将来の `EventData`）

`TILE_COLORS_HEX` がタイルの描画色（PixiJS `Graphics` で矩形塗りつぶしに使用）。

### レンダラー共通インタフェース（TopDownRenderer / RaycastRenderer）

| API | 説明 |
|---|---|
| `init(container)` | PixiJS `Application` を生成し `<canvas>` を親要素に追加 |
| `load(gameData)` | マップ・プレイヤー・NPC を描画して入力受付開始 |
| `destroy()` | ticker・イベントリスナー解除、PIXI `Application` 破棄 |

内部はレイヤ分割：`mapLayer` / `npcLayer` / `playerLayer` を `world` コンテナに束ね、プレイヤー位置に追従するカメラ（`world.x/y` のオフセット更新）を適用する。マップが画面より大きい場合のみクランプ、小さい場合は中央寄せ。

### プレイヤー移動

- 矢印キー / WASD でグリッド単位に移動（1タイル単位）
- 通行不可タイル（TREE / WATER）と NPC のいるタイルには入れない
- 移動中は `performance.now()` ベースで 150ms かけて線形補間し、完了まで次入力を受け付けない
- 進行方向に小さな三角マーカーを表示（向きの視覚化）

### NPC スプライトとアニメーション（TopDown / Raycast 共通）

`frontend/src/game/npcSpriteSheet.ts` にロード・切り出し・手続き生成の責務を集約。両レンダラーは同じ `loadNpcSpriteSheet` / `clampFrames` / `directionToRow` / `clearDemoSheetCache` API を共有する。

- **シート規約**: `frames × 4` グリッド。行 = 向き（0: `down`, 1: `left`, 2: `right`, 3: `up`）、列 = 歩行フレーム（0..frames-1）。各セル `tileSize × tileSize`
- **`frames` 値域**: parser は `>= 1` を受理するが、レンダラー側で 1〜4 に clamp（`clampFrames`）。未指定は 2（ドラクエ式）
- **アイドルアニメ**: 500ms 周期で frame 0 ↔ 1 をループ（`frames=1` なら静止）。NPC ごとに位相オフセットを与え、画一感を防ぐ
- **向き**: `NPCData.direction`（未指定なら `down`）に対応する行を表示。アイドル中は固定（自律移動・プレイヤー追従は未対応）
- **外部スプライト**: `PIXI.Assets.load(path)` で PNG 等をロード。失敗時は `console.warn` して単色 billboard のまま維持
- **`__demo` センチネル**: `sprite: '__demo'` 指定時は `buildDemoSheet` で `RenderTexture` に頭・胴体・目・足を描いた簡易スプライトを生成する。リポに画像アセットを持たずに「NPC が動く」デモを成立させるための仕組み。`(color, frames, tileSize)` 組で `WeakMap<Renderer, Map>` にキャッシュされ、同条件の NPC 間で共有される
- **フォールバック**: `sprite` 未指定・ロード失敗は単色矩形で描画（TopDown は色付き四角 + 赤枠、Raycast は billboard sprite に `Texture.WHITE` + `tint` = `data.color`）

#### TopDown 固有

プレイヤーと同じ `world` コンテナ内の `npcLayer` に NPC 単位の `Container`（`Sprite` + placeholder `Graphics`）を配置。スプライトロード完了時に placeholder を `visible=false` にして切り替える。

#### Raycast 固有

`npcLayer` を stage 直下に配置（`worldLayer` とは分離）。NPC ごとに:
- **Sprite + Graphics mask**: sprite は常に 1 つ、初期状態は `Texture.WHITE` を `data.color` で tint。シートロード完了で texture を差し替え、tint はフォグ専用に再利用
- **距離ソート**: `npcLayer.sortableChildren = true`。毎フレーム `container.zIndex = -transformY` で奥→手前順に描画
- **列単位の z-buffer 遮蔽**: 壁との遮蔽は mask Graphics に可視列だけ `rect()` + `fill()`。従来の `Graphics.rect` + 直接描画と同等の正確性を保ったまま Sprite ベースに移行した
- **フォグ**: スプライトロード済みは `tint = applyFog(0xffffff, fog)`、未ロード（単色）は `tint = applyFog(n.data.color, fog)`
- **射影計算の純粋関数化**: NPC のカメラ座標系への射影（transformX/Y、同一タイル・背面・退化カメラの culling、スプライトサイズ・描画範囲の算出）は `frontend/src/game/raycastProjection.ts` の `projectNpcToScreen` 純粋関数に切り出し済み。`depth` は生の transformY（z-buffer 比較用）、`spriteHeight` は `minDepth` クランプ後の深度から算出。境界値ユニットテストは `raycastProjection.test.ts`

### 会話ダイアログ

- プレイヤーの前方 1 タイルに NPC がいる状態で Enter / Space
- 画面下部のウィンドウに NPC 名と `message` を即時表示（タイプライター演出なし）
- 再度 Enter / Space で閉じる。ダイアログ表示中は移動入力を無視
- 見た目・状態管理は `RpgDialogBox` クラス（`frontend/src/game/RpgDialogBox.ts`）に集約。TopDownRenderer / RaycastRenderer は `show(name, message)` / `hide()` / `redraw(w, h)` / `isShowing` のみを呼ぶ

### サンプルデータ

`frontend/src/game/sampleRpgData.ts` に 16×12 のサンプルマップと NPC 2 人を用意。`RPGPlayer` コンポーネントは `gameData` prop が未指定ならこれを使用し、データ永続化（#34）より前でも RPG がそのまま動作する。

## RPG データフロー

RPG マップ・プレイヤー初期位置・NPC は Event として .md ファイルに統合される（別ファイルではない）。ノベル要素と同じシーンに混在可能。

```
.md ファイル
  ↓ parser(parse)
EventDocument（chapters[].scenes[].events[] に RpgMap/PlayerStart/Npc を含む）
  ↓ rpgProjectFromDoc(doc)    ← 最初にマップを含むシーンを探す
RPGProject（frontend/src/types/rpg.ts）
  ↓
MapEditor / NPCEditor / RPGPlayer
```

編集時の書き戻し:

```
MapEditor/NPCEditor の変更
  ↓ applyRpgProjectToDoc(doc, project)    ← 対象シーンの RPG 要素を置換（ノベル要素は保持）
新しい EventDocument
  ↓ parser(emit)
.md（自動保存 → ワーキングディレクトリに PUT → エディタ上で「保存」ボタンで Git commit）
```

ヘルパー関数は `frontend/src/game/rpgProjectFromDoc.ts` に実装。

- `rpgProjectFromDoc(doc, sceneId?)` — doc → RPGProject（マップが無ければ null）
- `applyRpgProjectToDoc(doc, project, sceneId)` — RPGProject → doc（既存シーンの RPG 要素を置換、無ければ新シーン追加）

## ツールとゲームデータの分離

- **Name×Name ツール**: このリポジトリ（name-name）
- **ゲームプロジェクト**: 別リポジトリ（例: ogurasia）
- 各ゲームは `backend/projects/` にクローンされる（gitignore 対象）
- API 経由でクローン・管理（手動 git clone 禁止、Windows 互換性のため）

## 下流プロジェクトのスモークテスト

name-name の parser / emitter を壊すと下流ゲームが一斉に動かなくなるため、代表プロジェクトの最小 Markdown を `parser/tests/fixtures/` に fixture として取り込み、構造を検証するスモークテストを置く。

| fixture | テスト | 対象下流 | カバー |
|---|---|---|---|
| `fixtures/friday1930-sample.md` | `friday1930_smoke_test.rs` | [friday-1930](https://github.com/kako-jun/friday-1930) | ノベル（ダイアログ/ナレーション/背景/BGM/暗転/SE/退場/場面転換）+ RPG（RpgMap/PlayerStart/Npc/view=raycast）の混在 |

**運用ルール:**
- 下流の `chapters/all.md` を更新したら、対応する fixture も手動で同期する（ファイルコピー）
- fixture はあくまで「代表的な構造例」。バイト一致を要求する必要はなく、view / RpgMap / NPC の抽出が期待通りかを assert する
- スモークテストで扱うのは **ハッピーパスの構造検証のみ**。parser の異常系（空ファイル、不正値、ミスマッチ等）は `integration_test.rs` で担保する
- 下流ごとに fixture とテストを1セット追加していく（ogurasia 等、将来の通常 RPG 下流も同じ方式で展開する想定）

## 型チェック

`frontend/tsconfig.json` は references 構成（`files: []`）。
ルート直下に `tsc --noEmit` を走らせてもノーチェックになるため、`npm run type-check` は `tsc -b --noEmit` を使う。
CI でも同じコマンドで app + node 両方の tsconfig が検証される。
