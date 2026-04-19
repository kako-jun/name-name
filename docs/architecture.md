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

- `MapData` — `width` / `height` / `tileSize` + 2次元配列の `tiles`（`TileType` = GRASS / ROAD / TREE / WATER）+ `wallHeights?: number[][]`（Issue #49 Phase 1）+ `floorHeights?: number[][]`（Issue #84、踏み込むとカメラ高さが上がる）+ `ceilingHeights?: number[][]`（Issue #87、ジャンプの頭ぶつけ判定）
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

#### 壁テクスチャ（Raycast）

壁描画は「縦ストライプ Sprite プール」方式で行う。

- **レイヤ順**: `worldLayer` 直下に `worldGraphics`（空・床のベタ塗り、奥）と `wallSpritesContainer`（壁 Sprite プール、手前）を配置。NPC は stage 直下の `npcLayer` にあるため、空 → 床 → 壁 → NPC の順で重なる
- **ストライプ Sprite プール**: `numStripes = ceil(screenWidth / stripeWidth)` 個の `Sprite` を `wallSpritesContainer` に保持。毎フレーム texture / x / height / tint / visible を更新して再利用する。画面リサイズで `numStripes` が変わるときは `ensureStripePool(target)` で余剰を destroy、不足を生成
- **テクスチャ**: `wallTextureSheet.ts` が TREE / WATER ごとに `TEXTURE_WIDTH=64` × `TEXTURE_HEIGHT=64` のベース RenderTexture を作り、左から 1 列ずつ 64 本の縦ストライプ Texture に切り分けてキャッシュする。`loadWallTexture(kind, renderer, externalPath?)` が非同期でこのシートを返す。ロード前は従来の `worldGraphics` ベタ塗り fallback を使う
- **u 座標の算出**: DDA で hit した壁の位置から `computeWallU(side, perpDist, px, py, rdx, rdy)` → [0, 1) の u を求め、`uToColumn(u, width)` で列 index に変換して `sheet.columns[col]` を Sprite.texture に設定する。Lodev 方式の u 反転（side=0 && rdx>0、side=1 && rdy<0）を純粋関数内で処理
- **テクスチャ切り出し（crop モード、Issue #86 Phase 2-5）**: 短い壁（wallHeight<1）はテクスチャの下部 `wallHeight` 分のみを 1:1 スケールで表示する。純粋関数 `computeWallTextureCrop(textureHeight, wallHeight)` が `{frameY, frameHeight}` を返し、RaycastRenderer は `new Texture({ source, frame: new Rectangle(col, frameY, 1, frameHeight) })` を毎フレーム生成して Sprite に割り当てる。pixel scale = `lineHeight/textureHeight` が wallHeight に依らず一定 → レンガ模様が縦潰れしない。wallHeight>=1 は texture 全体を使う従来 stretch 挙動（tiling は別 Issue）。wallHeight<=0 / NaN / Infinity は `frameHeight=0` で描画スキップ
- **フォグ**: `tint = applyFog(base, fog)` で暗く落とす。y-side（side=1）は `darken(0xffffff, 0.7)` を基底にしてから fog 適用し、壁面の立体感を保つ
- **デモテクスチャ**: リポに画像アセットを持たずに「色ベタではないテクスチャ」の体験が成立するよう、`__demo_tree`（緑系の木目 + 節目）と `__demo_water`（青系の波模様）を手続き生成する。`(renderer, kind)` 組で `WeakMap<Renderer, Map>` にキャッシュされ、`clearDemoWallCache(renderer)` で一括解放
- **テスト**: 純粋関数 `uToColumn` / `computeWallU` / `computeWallTextureCrop` の境界値テストは `wallTextureSheet.test.ts`。PixiJS 描画自体は手動確認

#### 壁高さ（wallHeights, Issue #49 Phase 1）

タイル座標ごとに壁の高さを変えられる。低い柵・高い塔のような段差表現が可能。

- **データモデル**: `MapData.wallHeights?: number[][]`（`tiles` と同じ `[y][x]` レイアウト）。`1.0` = 標準（従来挙動）、`0.5` = 腰高、`1.5` = 二階建て塔、`0` 以下 = 描画なし
- **未指定時**: `wallHeights` 自体が undefined、または該当行/セルが未定義の場合は `1.0` 扱い（既存マップは挙動不変）
- **TREE/WATER 以外のタイル**: `wallHeights` の値は無視される（壁でないので描画されない）
- **純粋関数**: `frontend/src/game/raycastProjection.ts` の `computeWallYRange(lineHeight, wallHeight, screenHeight)` が `drawStartY` / `drawEndY` を返す。地面位置（`drawEndY`）は wallHeight に依らず不変で、上端（`drawStartY`）が伸縮する。遠方カリング・フォグの伸長は `computeEffectiveFogMaxDist(baseFogMaxDist, wallHeight)`（Phase 2）。境界値テストは `raycastProjection.test.ts`
- **Sprite 配置**: 壁ストライプ Sprite は `anchor.set(0, 0)` で上端を `drawStartY` に置き、`height = drawEndY - drawStartY` で下端を地面に揃える。Phase 1 は縦方向全体スケール（壁が低いと texture 自体が圧縮されレンガ模様が潰れる）だったが、Issue #86 Phase 2-5 で `wallHeight<1` のときテクスチャ上端クロップ（`computeWallTextureCrop`）に切り替え、pixel scale が wallHeight に依らず一定になるようにした。`wallHeight>=1` は引き続き全体スケール
- **Phase 2 として残課題**: 視覚的な床段差壁面レンダリング（段差の側面を壁として描画する）、視覚的な天井レンダリング（per-column ceiling texture）、Markdown 構文 / エディタ UI からの wallHeights / floorHeights / ceilingHeights 指定は別 Issue で扱う。pitch（上下視線）は #80 Phase 2-1、ジャンプ（z 方向の動き）は #80 Phase 2-2、床段差（踏み込むとカメラ z が上がる MVP）は Issue #84、天井段差（頭ぶつけ判定 MVP）は Issue #87 で対応済み（下記参照）
- **既知の制限（Phase 1 → Phase 2 引き継ぎ）**:
  - **NPC 遮蔽の壁高さ連動**: Phase 2 で対応済み。`wallTopYBuffer` で壁上端の画面 Y を列ごとに記録し、NPC mask は「壁が前にある列でも、壁上端より上の部分のみ可視化」する。低い壁（wallHeight=0.5）の奥にいる NPC の頭が壁の上から出る
  - **遠方カリング・フォグの壁高さ連動**: Phase 2 で対応済み。純粋関数 `computeEffectiveFogMaxDist(baseFogMaxDist, wallHeight)` が `wallHeight > 1` の塔に限り `baseFogMaxDist * wallHeight` まで上限距離を伸長する（`wallHeight <= 1` は通常の壁と同じ距離で消える）。描画スキップ判定 (`perpDist <= effectiveFogMax + 0.5`) とフォグ計算 (`1 - perpDist / effectiveFogMax`) の両方に適用
  - **寸法ミスマッチは警告のみ**: `wallHeights` の行数・列数が `tiles` と一致しない場合、`load()` で `console.warn` を出すが描画は止めない（該当セルは未定義 → 1.0 フォールバック）。Markdown / エディタ UI 経由の入力時にバリデーションを強化するのは Phase 2 課題

#### pitch（上下視線, Issue #80 Phase 2）

プレイヤーが上下に視線を振れる。一人称ダンジョン探索で「天井を見上げる」「足元を覗く」感覚を出す。ジャンプ・床段差の前提となる地平線シフト機構でもある。

- **入力**: PageUp で上向き、PageDown で下向き。`pitchSpeed = 1.5 rad/s` で連続変化、`pitchMaxAbs = 0.4 rad`（≒ ±23°）でクランプ。マウス Y は未対応（キーのみで十分）
- **データモデル**: `RaycastRenderer.playerPitch: number`（rad、ランタイム状態のみ）。`load()` ごとに 0（水平）にリセット。`MapData` への永続化や Markdown 構文での演出指定は別 Issue
- **px オフセット変換**: Lodev 方式の `pitchOffsetPx = round(Math.tan(playerPitch) * h/2)`。`pitchOffsetPx > 0` で画面中央が下にシフト＝視線が上向き＝空が広く見える、という符号定義に統一
- **適用箇所**: 空・床ベタ塗りの分割位置 `horizonY = h/2 + pitchOffsetPx`、壁ストライプの `computeWallYRange(..., pitchOffsetPx)`、NPC スプライトの `projectNpcToScreen(..., pitchOffsetPx)` および sprite.y。すべて同じ baseY を共有
- **純粋関数の signature 拡張（後方互換）**: `computeWallYRange(lineHeight, wallHeight, screenHeight, pitchOffsetPx?=0)` / `projectNpcToScreen(..., minDepth, pitchOffsetPx?=0)`。デフォルト 0 で Phase 1 の既存呼び出しは挙動不変。`NaN/Infinity` は 0 扱い（既存契約に準拠）。画面外クランプは `[0, h]` のまま
- **既知の制限**: pitch は描画上のシフト演出のみで、実際のレイ方向（dir / plane）には影響しない。pitch を大きく取っても遠方の壁が「上から見下ろされる」幾何にはならず、純粋な縦シフトのまま。Quake 系の真の pitch を実装するには ray の Z 成分を導入する必要があり、現状では非対応

#### ジャンプ（Issue #80 Phase 2-2）

プレイヤーが Z キーで小さくジャンプできる。pitch と同じ「baseY シフト」機構の上に乗せた、地に足の付いたカメラ高さオフセット演出。

- **入力**: Z キーで一度だけジャンプ（押下時のみ。`e.repeat` を弾く）。空中での再ジャンプは不可（着地中のみ受け付け）。マウスや Markdown 構文での jump 制御は未対応（別 Issue）
- **データモデル**: `RaycastRenderer.playerJumpZ: number`（タイル単位、0 = 床面、正でジャンプ中。Issue #84 で `playerZ` からリネーム）と `playerVZ: number`（タイル/秒）。`load()` ごとに `playerJumpZ=0, playerVZ=0` にリセット。`MapData` への永続化は別 Issue
- **物理パラメータ**: `jumpInitialV = 3.0` タイル/秒、`gravity = 12.0` タイル/秒^2。最高到達高 = `v^2 / (2g) = 9 / 24 = 0.375` タイル、滞空時間 = `2v/g = 0.5` 秒。控えめだが視点が変わる感覚は十分
- **更新ロジック**: `updateMovement(dt)` 末尾で「`playerJumpZ > 0` または `playerVZ ≠ 0` のときだけ」`playerVZ -= gravity*dt; playerJumpZ += playerVZ*dt`、`playerJumpZ <= 0` で `playerJumpZ=0, playerVZ=0` に着地スナップ
- **px オフセット変換**: `cameraZOffsetPx = round((playerGroundZ + playerJumpZ) * h/2)`（Issue #84 で床段差 `playerGroundZ` との合算化）。pitch と同じ符号規約（正で baseY が下シフト＝視点が上＝壁・NPC が下方向に見える）。`pitchOffsetPx + cameraZOffsetPx = totalYOffsetPx` を空・床ベタ塗りの分割位置と純粋関数（`computeWallYRange` / `projectNpcToScreen`）に渡す
- **純粋関数の引数意味の汎化（後方互換）**: `computeWallYRange(..., pitchOffsetPx?=0)` / `projectNpcToScreen(..., pitchOffsetPx?=0)` の `pitchOffsetPx` 引数は「pitch 由来 + cameraZ（ジャンプ）由来の合算 Y シフト」を受け取る契約に汎化。引数名は後方互換のため変更せず、JSDoc の意味だけ拡張。`NaN/Infinity` は 0 扱い、画面外クランプ `[0, h]` も従来通り
- **既知の制限**: ジャンプ中も `isPassable` 判定は変えない（現状壁は通行不可のまま、壁の上に乗る挙動は未実装）。Markdown 構文での jump 演出指定は別 PR で扱う（Issue #80 の他項目）。NPC 遮蔽連動・fogMaxDist 連動は Phase 2 で対応済み（本 PR、上記「既知の制限（Phase 1 → Phase 2 引き継ぎ）」参照）。床段差（floorHeights）は Issue #84 で対応済み、天井段差（ceilingHeights、頭ぶつけ判定）は Issue #87 で対応済み（下記参照）

#### 床段差（floorHeights, Issue #84）

タイルごとに床の高さを変えられる。プレイヤーが踏み込むとカメラ高さが自動で上昇する MVP。視覚的な段差側面（壁化）は別 Issue。

- **データモデル**: `MapData.floorHeights?: number[][]`（`tiles` と同じ `[y][x]` レイアウト）。`0.0` = 地面標準（従来挙動）、`0.5` = 半段、`1.0` = 1 タイル分上。負値は沈み込み表現として許容
- **未指定時**: `floorHeights` 自体が undefined、または該当行/セルが未定義の場合は `0.0` 扱い（既存マップは挙動不変）
- **純粋関数**: `frontend/src/game/raycastProjection.ts` の `resolveFloorHeight(grid, tx, ty)` が床高さを返す。`getWallHeight` と同構造だが fallback は `0`（地面）。境界値テストは `raycastProjection.test.ts`
- **プレイヤー状態の分離**: `RaycastRenderer.playerGroundZ`（現在踏んでいるタイルの床高さ、床段差由来）と `playerJumpZ`（ジャンプ由来の相対高、旧 `playerZ` をリネーム）に分離。カメラ総オフセット `totalCameraZ = playerGroundZ + playerJumpZ` を `h/2` 倍して px に換算し、pitch オフセットと合算して純粋関数に渡す
- **更新タイミング**: `updateMovement(dt)` の移動処理後に `playerGroundZ = resolveFloorHeight(floorHeights, floor(x), floor(y))` で瞬時切替（補間なし）。段差の境界で視点が段階的にカクっと上がる
- **ジャンプとの関係**: ジャンプは床面（`playerGroundZ`）からの相対高 `playerJumpZ` で管理し、着地判定は `playerJumpZ <= 0`。床段差の上でも通常通りジャンプできる
- **寸法ミスマッチ**: `wallHeights` と同様、行数・列数が `tiles` と一致しない場合は `load()` で `console.warn` を出すが描画は止めない
- **既知の制限**: 視覚的な段差側面レンダリング（段差の縦面を壁として描画する ray-floor casting 等）は未対応。現状は「踏んだらカメラが上がる」だけで、段差そのものは見えない。Markdown 構文 / エディタ UI からの `floorHeights` 指定も別 Issue

#### 天井段差（ceilingHeights, Issue #87）

タイルごとに天井の高さを変えられる。プレイヤーがジャンプで頭をぶつけて跳ね返される MVP。視覚的な天井レンダリング（per-column ceiling texture）は別 Issue。

- **データモデル**: `MapData.ceilingHeights?: number[][]`（`tiles` と同じ `[y][x]` レイアウト）。`1.0` = 標準（従来挙動）、`0.5` = 低天井トンネル、等
- **未指定時**: `ceilingHeights` 自体が undefined、または該当行/セルが未定義の場合は `1.0` 扱い（既存マップは挙動不変）
- **フォールバック契約**: `NaN` / `Infinity` / `0` 以下は `1.0` 扱い。`resolveFloorHeight` が負値を沈み込みとして許容するのと対照的に、`resolveCeilingHeight` は退化ケース（天井が床より下）で頭ぶつけ判定が破綻しないよう `1.0` に倒す防御的設計
- **純粋関数**: `frontend/src/game/raycastProjection.ts` の `resolveCeilingHeight(grid, tx, ty)` が天井高さを返す。`resolveFloorHeight`（fallback 0、負値許容）と対照に fallback 1、0 以下非許容。境界値テストは `raycastProjection.test.ts`
- **ジャンプ干渉**: `updateMovement(dt)` のジャンプ更新ロジックで `playerJumpZ` の上限 = `ceilingHeight - playerGroundZ` を計算し、到達したらその位置でクランプ。`playerVZ > 0`（上昇中）のときのみ `0` に落として即落下開始（跳ね返り演出なし、MVP）。クランプ後も従来通り `playerJumpZ <= 0` で着地スナップ
- **寸法ミスマッチ**: `wallHeights` / `floorHeights` と同様、行数・列数が `tiles` と一致しない場合は `load()` で `console.warn` を出すが描画は止めない
- **既知の制限**:
  - 視覚的な天井レンダリング（per-column ceiling texture）は未対応。現状は頭ぶつけ挙動のみで、天井そのものは見えない
  - 跳ね返り演出（反発係数・下向き初速付与）もなく、天井到達時は即 `VZ=0` で落下開始
  - 空中移動で水平方向に低天井タイルへ入った瞬間、`playerJumpZ > maxJumpZ` なら位置だけクランプで下がる（z ポップダウン）。落下中（`VZ ≤ 0`）はそのまま落下継続するため影響軽微、MVP 許容
  - 天井が床より低い退化ケース（`playerGroundZ > 1` の床段差上に低天井を置く等）は `resolveCeilingHeight` が `1.0` にフォールバックするものの `maxJumpZ = 1 - playerGroundZ` が負になりうる。その場合は頭ぶつけ判定が即発動してジャンプが成立しないが MVP では許容
  - Markdown 構文 / エディタ UI からの `ceilingHeights` 指定も別 Issue

#### マップ検証（mapValidation, Issue #89）

wallHeights / floorHeights / ceilingHeights の次元が tiles と一致するかを純粋関数 `validateMapHeights(map)` で検証する。従来は `RaycastRenderer.load()` で field ごとに個別の `console.warn` を出していたが、Markdown 構文（#90）/ MapEditor（#91）からも同じ検証を呼べるよう純粋関数に切り出した。

- **場所**: `frontend/src/game/mapValidation.ts`
- **返り値**: `{ ok: boolean, errors: HeightDimensionError[] }`。errors は `{ field, kind, expected, actual, rowIndex? }` の配列
- **kind**: `row-count-mismatch`（行数不一致）/ `col-count-mismatch`（指定行の列数不一致）
- **方針**: 複数 field / 複数行のエラーは全て収集（early return しない）。ただし行数ミスマッチが出たその field は col-count 検証を打ち切る（ノイズ削減）
- **整形**: `formatHeightError(err)` で人間可読メッセージに整形。ログ出力・UI 表示共通で使う
- **呼び出し**: 現状は `RaycastRenderer.load()` のみ（warn ログとして利用）。Markdown 構文（#90）・MapEditor（#91）からも使う想定
- **対象外**: tiles 自体の次元検証（`mapTiles.length !== mapHeight` 等）は `validateMapHeights` の範疇外で、`RaycastRenderer.load()` 側に残す

#### `assets/textures/` 規約

- 現状は `__demo_tree` / `__demo_water` の組み込みデモテクスチャが `wallTextureSheet.ts` に手続き実装されているため、ゲームプロジェクト側は PNG を用意しなくても Raycast で壁がテクスチャで描画される
- 将来的にゲームプロジェクト側のテクスチャを使う場合は、プロジェクトリポジトリの `assets/textures/{name}.png` に配置し、`loadWallTexture(kind, renderer, externalPath)` にパスを渡す経路で読み込む想定（コード経路は別 Issue）。**現時点の実装は 64×64 固定**（`TEXTURE_WIDTH` / `TEXTURE_HEIGHT` 定数）。動的サイズ対応は別 Issue でやる
- タイル（TREE / WATER）にどのテクスチャを当てるかを Markdown 側から指定する構文（例: `[テクスチャ] ... [/テクスチャ]`）は **Issue #48 のスコープ外**。別 Issue で検討する

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
