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
├── worker/             # Cloudflare Worker（GitHub REST API プロキシ）
│   ├── src/
│   │   ├── index.ts          # Hono ルーティング + CORS
│   │   ├── projects.ts       # GET /api/projects
│   │   ├── contents.ts       # GET/PUT /api/projects/:name/contents/*
│   │   ├── scripts.ts        # GET /api/projects/:name/scripts (#237)
│   │   ├── assets.ts         # GET/POST /api/projects/:name/assets/:type
│   │   ├── github.ts         # octokit ラッパー（baseUrl 切替で dev 用中継対応）
│   │   ├── auth.ts           # 認証ミドルウェア（CF Access 想定、#110）
│   │   └── cache.ts          # CF Cache API ヘルパー
│   ├── scripts/
│   │   ├── dev.mjs           # `npm run dev` ラッパー（直結 / proxy / local-fs の 3 モード）
│   │   ├── github-proxy.mjs  # corp proxy 中継（host 側）
│   │   └── local-fs-proxy.mjs# ローカル作業ツリー emulator（host 側）
│   └── wrangler.toml
└── docs/               # ドキュメント
```

### 各モジュールの責務

| モジュール  | 責務                                                              | パースする？                                           |
| ----------- | ----------------------------------------------------------------- | ------------------------------------------------------ |
| `parser/`   | Markdown ↔ Event[] の双方向変換                                   | Yes（正本）                                            |
| `frontend/` | エディタUI + ノベルプレイヤー（PixiJS） + RPGプレイヤー（PixiJS） | Yes（WASMで parser を呼ぶ。`src/wasm/parser.ts` 経由） |
| `worker/`   | GitHub REST API プロキシ、CORS、認証ゲート、Cache API             | No（生テキスト中継）                                   |

Worker はパースしない。GitHub から Markdown を取得してそのままフロントエンドに渡し、フロントエンドが WASM パーサー（`frontend/src/wasm/parser.ts`）で Event[] に変換する。WASM の初期化は遅延実行（初回呼び出し時に `init()` を実行）。

## データフロー

### 編集時

```
ユーザー操作 → React UI (EventDocument 直接操作) → parser(emit) → Markdown → Worker(/api/.../contents PUT) → GitHub
```

エディタは `EventDocument`（`chapters[].scenes[].events[]` のツリー）を真実の情報源として
保持する。UI の編集操作は `EventDocument` を直接更新し、`emitMarkdown` で Markdown 文字列に
変換してから autosave 経由で Worker に PUT する。旧 `Chapter` / `Scene` / `Cut` 型は削除済み。

#### 複数 .md ファイル運用 (#237 / 親 #234)

エディタは「単一 `script.md`」前提から「複数 `.md`」を扱える構造に拡張済み。
`GET /api/projects/:name/scripts` が対象 `.md` を `[{ path, title, hidden, sha, size }]` で返す。
`scriptsDir` 未指定プロジェクトでは、ルート直下の `.md` の本文を peek し、frontmatter
`engine: name-name` を含むものだけを返す。
プロジェクト設定に `scriptsDir`（例 `content/scripts`）を持たせると、列挙の起点を
そのディレクトリに移し、**起点直下＋サブディレクトリ 1 段**の `.md` を列挙する（#284。
theo-hayami がシナリオを `content/scripts/free` `content/scripts/main` に分割するため）。
この経路は #314 以降、Git Trees API の recursive listing で path/sha/size を一括取得し、
各 MD 本文の frontmatter peek はしない。theo-hayami の 260 本級で scripts listing が 260 req 級に
膨らむのを避けるためで、`scriptsDir` 配下は name-name script 置き場として扱う（`title=null`,
`hidden=false`）。
EditorScreen は listing をタブ UI で表示し、タブ切替で `currentScriptPath` 経由で
`getContents` / `putContents` を呼び直す。`hidden: true` の .md はタブにラベル表示され、
`/play` 系には露出しない（ogurasia の `data.md` 等のマスター定義置き場として使う）。この hidden
判定は frontmatter peek を行うルート直下プロジェクト向けで、`scriptsDir` 高速経路では使わない。

localStorage の draft キーは `name-name:editor-draft:${projectName}:${path}` で
ファイル単位に分離されている。タブ切替時に未保存変更があれば確認ダイアログを出す。

#### RPG タブのマスター統合 (#238 / 親 #234)

`mergeMasterDataFromDocs(docs[])` で複数 .md のマスター (`Monster` / `Item` / `Spell` /
`PartyMember`) を束ねる。重複 ID は **後勝ち**。`rpgProjectFromDoc(doc, sceneId, name, extraDocs)`
の `extraDocs` に他 .md (例: `data.md`) の `EventDocument` を渡すと、active doc が末尾に
ある状態でマージされ、active 側の上書きが効く。EditorScreen は availableScripts から
currentScriptPath 以外を全部 parallel fetch + parse して `otherDocs` state に詰める。

#### マルチMD再生と遅延ロード（#284 / #314）

ノベル本編もシナリオを複数 .md に分割できる。`PlayerScreen` は `listScripts`（`scriptsDir`
配下＋リポ直下）でプロジェクトの .md 一覧と各ファイルの `sha` を取得し、**エントリ＝path の
basename が `script.md`** のもの（無ければ先頭）を選ぶ。

通常再生は従来どおり**エントリ doc を `flattenDocumentEvents` で線形化した `events=`**（多シーンの
自動進行を維持）。それとは別に、読み込み済み doc の全シーンを `NovelPlayer` の
`jumpSceneIndex=` → `NovelRenderer.setJumpSceneIndex` でジャンプ解決索引（`allScenes`）として渡す
（再生ストリームは置換しない）。

#314 以降、`/play` の初期ロードでは全 .md を fetch/parse しない。初期表示は entry MD だけを読み、
選択肢などで未ロード scene へジャンプした時点で `NovelRenderer` の missing scene resolver が
必要な MD を追加取得する。まず `sceneId.md` と theo-hayami 形式の `theme__resident.md`
（例: `makiya-netami` → `netami__makiya.md`）を候補にし、見つからなければ未ロード MD を順に探す。
読み込み済み doc と in-flight 読み込みはセッション中 `Map` で共有し、同一セッション内の再遷移で
再 fetch / 再 parse しない。

ブラウザ間をまたぐ再訪問では `frontend/src/game/scriptContentCache.ts` の IndexedDB キャッシュを使う。
キャッシュは再生を止めない best-effort 最適化で、利用不可・読込失敗・保存失敗時は従来経路へ戻る。

- Markdown 本文 cache: key は `projectName + ref + path + sha`。`listScripts` の `sha` が一致すれば
  GitHub Contents API を呼ばず、IndexedDB の本文を使う。`sha` が変われば key が変わるため cache miss になる。
- parse済み `EventDocument` cache: key は `projectName + ref + path + sha + schemaVersion`。
  `schemaVersion` が一致すれば WASM `parseMarkdown` を呼ばず保存済み doc を使う。parser / document 形状を
  変えた場合は `PARSED_SCRIPT_DOCUMENT_SCHEMA_VERSION` を上げて既存 cache を無効化する。#340 では本文の表示用
  正準化（`--`→`──` / `…`→`⋯`。後述）を parser に足して正規形が変わったため 1→2 に上げ、素の `--`/`…` を
  含む旧解析結果を無効化した（キャッシュ復元は parseMarkdown/normalizeEvents を経ないため）。

`listScripts` 不在・失敗時は単一 `script.md` 再生へフォールバックする。このフォールバックは一覧 `sha` が
無いため IndexedDB cache 対象外。シーン ID は全 .md でグローバル一意が前提（`findSceneById` 先勝ち・
重複は warn）。なおエントリ doc のみが RPG 判定・`aspect_ratio`/`choice_style`/`font_family`/
`font_size`/`dialog_style`/`protagonist` の供給元（サブ MD の RPG シーンは未対応）。

#### production 向けシーン直接ディープリンク `?scene=`（#386）

`?scene=<sceneId>` は production ビルドでも常時有効な、特定シーンへの直接埋め込み用の入口。
`import.meta.env.DEV` 限定の `debug_scene`（[デバッグガイド](./guide/debugger.md) 参照。flags/
eventIndex/textIndex も指定できるデバッグ起点）とは別系統で、こちらは sceneId 単体のみを受け取る
最小限のパーサ（`frontend/src/game/sceneQuery.ts` の `parseSceneQuery`）。theo-hayami の
「1 セル 1 URL＝1 遅延埋め込み」設計のための経路で、他 .md の会話劇セルを 1 本だけ外部ページに
埋め込むときに使う。

`PlayerScreen` が `?scene=` を読み、対象 sceneId が属する script を（上記の missing scene
resolver 経由で）事前解決・ロードしてから `NovelPlayer` に `initialSceneId` として渡す。
`NovelPlayer` はマウント時に一度だけ `renderer.startFrom({ sceneId: initialSceneId })` を呼ぶ
（DEV 専用の `debug_scene` ブロックより前に評価するため、DEV で両方指定されると `debug_scene`
側が後勝ちで優先される）。無効・未解決の sceneId は現行どおりエントリ（ハブ）から開始する。

**confinement（在圏）+ 終劇**: 単独埋め込みは対象 script ファイルの外（hub・他ファイル）へ
choice で漏れてはいけない（theo-hayami #20: 他ファイルへの遷移は choice ではなく埋め込み外側の
HTML リンクで行う設計）。`PlayerScreen` の `findConfinedSceneIds(targetSceneId, docs, entryPath)`
が対象 sceneId が属する script ファイル自身の sceneId 一覧を算出し（entry doc/hub 自身は候補から
除外）、`NovelPlayer` → `NovelRenderer.setConfinedSceneIds` に渡す。`jumpToScene`（唯一の
choke point）はこの集合外への遷移を検知すると通常のシーン遷移をせず `endStory()` を呼び、
`NovelGameState.storyEnded` を true にする（背景・立ち絵はフェードアウトし、DOM 側は控えめな
"to be continued..." を表示する）。`?scene=` が hub 自身の sceneId を指した場合は
`findConfinedSceneIds` が null を返し、confinement を組まず無制限フローにフォールバックする
（hub → 各お題への通常 choice 遷移を壊さないため）。`storyEnded` の設計上の位置づけ
（ADR 0002 の「演出の中間状態を持たない」規律との関係）は
[ADR 0002](./adr/0002-deterministic-state-and-debuggability.md) を参照。

**埋め込み時のヘッダ抑制（#392）**: `PlayerScreen` 上端のヘッダ（プロジェクト一覧への戻る
ボタン＋タイトル）は、**iframe に埋め込まれて表示されているとき（`utils/isEmbedded.ts` の
`isEmbedded()` ＝ `window.self !== window.top`）は描画しない**。埋め込み文脈では name-name の
トップへ戻る導線が無意味で、埋め込み側（theo-hayami 等）が既に額縁とタイトルを出しており二重に
なるため。standalone タブで `/play/*` を直接開いたときは従来どおりヘッダを出す（後方互換）。
これは `?scene=` に依存しない一般的な埋め込み挙動で、`?scene=`（＝ディープリンク意図＝#388 の
TitleOverlay 飛ばしの条件）とは関心が別（ゲートも別）。

**プレイヤーの見た目テーマ `?theme=light|dark`（#394）**: ノベルゲーム本体（PixiJS キャンバス）は
常に `0x000000`＝黒なので、**プレイヤー（`/play/*`）の見た目デフォルトは黒（dark）**。ルート背景を
`bg-black`、ローディングを黒地・明色文字にして「黒→黒」で継ぎ目なくキャンバスへ繋ぐ（暗い埋め込み
先で白いロード画面がフラッシュしない）。React マウント前の白も `index.html` の body 黒背景で消す。
例外として**ライトな埋め込み先**は `?theme=light` を明示して白いロード画面を要求できる（`game/themeQuery.ts`
の `parseThemeQuery(search)` ＝ `?theme=light` のみ 'light'、他は既定 'dark'）。App の darkMode（エディタ
UI 用トグル、`isDark`）とは独立＝プレイヤーの見た目は `?theme`（既定 dark）だけで決まる。`?scene=`
（#388）・`isEmbedded()`（#392）とも独立した第3の埋め込み引数。

**完読の親通知 postMessage（#395）**: 埋め込み側（theo-hayami 等）に「どのセルを読み終わったか」を
知らせるため、**終劇（endStory）到達時に、iframe 埋め込み時（`isEmbedded()`）のみ親ウィンドウへ
`window.parent.postMessage({ source:'name-name', type:'story-ended', scene, project }, '*')` を送る**
（`game/storyEndedMessage.ts` の純粋関数 `buildStoryEndedMessage` が本体を組み立て、`NovelPlayer` の
`onStoryEndedChange` が `ended===true && isEmbedded()` のときだけ発火）。name-name の既読 localStorage は
別オリジンで埋め込み側から読めないため、完読の事実だけを渡し、埋め込み側が自前で既読を記録・表示する
（theo-hayami #30）。`scene` は `?scene=` の sceneId（無ければ null）、`project` は projectName。
standalone や `ended===false`（終劇解除）では送らない。origin は `'*'`（受信側が origin 検証する前提）。

### 再生時

```
Worker(listScripts) → entry Markdown / cached EventDocument → Event[] → resolveEvents → NovelRenderer(PixiJS)
```

## パーサー

Rust で実装。wasm-bindgen + tsify-next で TypeScript 型を自動生成する。

### Event 型

`parser/src/models.rs` が型の正本。主要なバリアント:

- `Dialog` — ダイアログ（character, expression, position, text, voice_path?, font_family?）
- `Narration` — ナレーション（text, voice_path?, font_family?）
- `Background` — 背景変更（path）。通常進行では旧背景と新背景を同時保持し、既定 700ms で alpha を入れ替えるクロスフェードを行う（復元・シーク・スキップは即時）
- `Bgm` — BGM 制御（action: Play/Stop, path, fade_ms?: Play=fade-in / Stop=fade-out 時間 ms）
- `Se` — SE 再生（path, fade_ms?: fade-in 時間 ms）
- `Blackout` — 暗転制御（action: On/Off）
- `SceneTransition` — 場面転換
- `PageBreak` — 手動改頁マーカー（本文中の単独行 `---`。`dialog_style: novel` の強制ページ境界。非テキストイベントとして読み飛ばす。#292 Phase 2）。**本文中の `--`（2 連）は別物**で、余韻横棒 `──` に正準化され novel の文送り境界になる（#340・後述）。改頁になるのは単独行 `---`（3 連以上）だけ
- `Exit` — 立ち絵退場（character）
- `ExpressionChange` — 表情変更（character, expression）
- `Wait` — 待機（ms）
- `Flag` — フラグ設定（name, value）
- `Condition` — 条件分岐（flag, events: Event[]）
- `Choice` — 選択肢（options: ChoiceOption[]）
- `RpgMap` — RPG マップ（width, height, tile_size, tiles: u8[][]）
- `PlayerStart` — プレイヤー初期位置（x, y, direction）
- `Npc` — NPC 配置（id, name, x, y, color, message: string[], sprite?: string, frames?: u32, direction?: Direction）

フロントマターは Event ではなく、`Chapter` 構造体のフィールド（number, title, hidden, default_bgm）と `Document` ルートフィールド（engine, aspect_ratio, choice_style, font_family, font_size, dialog_style, protagonist）としてパースされる。`Scene` も Event ではなくドキュメント構造の一部。

`Document.choice_style` は per-game の選択肢ボタンスタイル名（#146）。`default` / `soft` / `monochrome` の 3 種を ChoiceOverlay が持ち、未指定なら `default` 扱い。スタイル文字列は parser 側ではバリデーションせず生文字列として透過し、runtime 側で未知値を `default` にフォールバックする。

既読進捗は `/play` の `projectName` を `docKey` として `localStorage` に保存する（#140/#366）。保存は origin 単位なので、同じ Name×Name origin で同じ `projectName` を開く複数の埋め込みは共有する。別 origin ではブラウザ仕様上共有されない。scene ジャンプ後のスキップ判定は `sceneId#displayIndex` の文字列キーを使う。従来の display index 既読しかない既存データは、最初に遭遇した scene の `sceneId#displayIndex` へ best-effort 移行し、以後は scene-aware key を正本にする。これにより複数 MD の別セルで同じ行番号が誤って既読扱いになることを避ける。選択肢は jump 先の `sceneId` が既読 scene セットに含まれる場合、ChoiceOverlay が既読用の色で描く。scene セットへの既読マークは本文の最初ではなく、scene の末尾（次の `Choice` に到達した時点、またはスクリプト末尾）で行う。

`Document.font_family` は per-game のテキストフォント（#147）。CSS の `font-family` 文字列を生で透過する。runtime 側（`NovelRenderer`）が `frontend/src/game/FontLoader.ts` の `ensureFontLoaded()` で `<link rel="stylesheet">` を Google Fonts CSS API に向けて注入し、ロード完了後に `DialogBox.setFontFamily()` を呼ぶ。Dialog / Narration の `font_family` は per-line 上書き（`[フォント: family]` ディレクティブで pending 注入）で、優先順位は `per-line override → per-game default → runtime default ('Noto Sans JP', sans-serif)`。

`Document.font_size` は per-game の本文フォントサイズ（px・#283 補遺）。parser は数値のみ受理し（空・非数値は None）、runtime（`NovelRenderer.setFontSize`）が未指定時に既定 `40` へフォールバックして即座に `DialogBox.setFontSize()` を呼ぶ（フォント lazy load を伴わないため遅延適用は不要）。これにより 16:9 ADV（既定 40）と 9:16 ノベル（例 26）を per-game で切り替える。per-line 上書きは無く、名札系は本文サイズに連動、バックログ・選択肢・メニューは連動しない（`font_family` と同スコープ）。

`Document.dialog_style` は per-game の会話描画スタイル（#283）。`adv`（下部 ADV 箱）/ `novel`（全画面ノベル）の対等 2 択で、parser はバリデーションせず生文字列で透過し、未指定・不明値は runtime が `adv` 描画にフォールバックする（正規デフォルトという扱いはしない）。`NovelPlayer` → `NovelRenderer.setDialogStyle()` で `DialogBox.setNovelMode()`（名札 OFF・全画面 borderless 描画を流用）に伝わり、`novel` のときだけ全画面スクリム表示と `paginateSentencesByLines` による文境界改頁が有効になる。送りは**文単位（息継ぎ単位、#292 Phase 1）**: クリックは句点等で割った文を 1 つずつ送り（`sentenceIndex` は GameState）、既出文は同ページに溜まり、文末の右に種別付きクリッカー（`▼`=同ページ次文 / `❯`=ページ最後＝改頁）が出る。`assets/images/ui/text-next-{1..4}.webp` と `assets/images/ui/page-turn-{1..4}.webp` がある作品では、文の続き送りとページ送りを 4 フレーム画像カーソルで表示し、画像が無い/読めない作品では従来グリフにフォールバックする（#320）。クリッカーの座標は `setNovelDialogProgressive()` で累積テキストを更新した時点と `setIndicatorVisible(true)` の直前に `positionIndicator()` で同期し、`indicatorBaseY` と実 `indicator.y` を同時更新する（#333）。これにより ticker の次フレーム待ちで旧 y 座標が一瞬見えることを防ぐ。さらに**本文中の単独行 `---` は手動改頁マーカー `Event::PageBreak`（#292 Phase 2）**で、自動改頁の上に乗る強制ページ境界になる（`---` で Dialog を分割するため、各 text イベントが独立にページ分割される `getNovelPages` の切れ目がそのまま境界になり、`paginateSentencesByLines` 自体は不変）。フロントマター区切りの `---` は先頭ブロックのみで別扱い。表情変化・場面転換ではスクリムが自動退避する。改頁ページは派生（GameState には持たず再計算可能）。

`Document.protagonist` は per-game の質問役（主人公）の話者名（#286）。`dialog_style: novel` の立ち絵左右配置に使う。parser は生文字列で透過し（空は None）、`NovelPlayer` → `NovelRenderer.setProtagonist()` に流れる。`novel` でかつ protagonist 指定時、`showCharacterFromDialog` が Dialog の話者を役割に写す（`resolveNovelRoleXRatio`: 話者 = protagonist → 質問役＝左 `NOVEL_ROLE_X_RATIO.questioner=0.25` / それ以外 = 回答役＝右 `0.75`）。比率は `CharacterLayer.show(..., { xRatio })` の override 経路で sprite x に当て、position トークン（snapshot/復元の正本）は据え置く（縦位置は `CHARACTER_Y_RATIO`＝全員共通のベースライン。既定 1.0、frontmatter `character_y_ratio` で per-game 上書き可＝足を画面下端より下げ靴を切れる #308）。さらに直前と異なる話者になったら `CharacterLayer.nudgePose()` で立ち絵を軽く持ち上げて戻す自己復帰アニメをかけ（ticker 駆動・GameState 非保持の render-only 演出）、`#283` の scrim 自動退避に相乗りして「今この人」を見せる。場面冒頭の初出（`lastSpeaker===null`）・同一話者連続・スキップ中は nudge しない。adv / protagonist 未指定では左右配置・ポーズ変化とも一切起きない（従来配置・後方互換）。復元（`applyState`）でも protagonist 指定時は役割 x を当て直し、`lastSpeaker` を復元位置の話者に据えて誤 nudge を防ぐ。v1 では司会など3人目以降の定位置は未対応（非主人公＝右に倒す・TODO）。

**1 位置 1 キャラ（衝突時の自動退場・#303）**: `CharacterLayer.show()` は立ち絵を置く先の `targetX`（xRatio override > position トークン > center で解決）を占有している**別の立ち絵を退場させてから**新キャラを置く（`evictCollidersAt(targetX, keepName, instant)`）。役割配置で複数キャラが同じ右（`responder=0.75`）に続けて出る avatar__kantia 型の重なりを、`[退場:]` を明示せず解消する。除外対象は「自分自身（`keepName`＝同一キャラの再表示・位置変更）」「`renderOnly`（Title/Label/Image #274＝立ち絵スロットを占有しない演出要素）」「既に退場フェード中（`destroyOnComplete`）」。退場は通常 300ms フェード、`instant`（skip/復元）では即時。GameState には中間状態を持ち込まず、`getCharacterStates()` は**退場フェード中のキャラを除外**するため、衝突退場の途中で撮ったスナップショットからも前キャラが漏れず、セーブ/シーク/任意局面起動の復元で重なり・消えすぎが起きない。判定は別位置（左の質問役）には届かない（x 不一致）ので干渉しない。adv の position トークン経路（左/中央/右）でも同 x なら退場する（多人数を別位置に置く既存作品は x が異なるため非回帰）。

**立ち絵のスケール（原寸 / 元絵基準スケール / 目標高さ / per-character override / フィット・#360 #364 #294 #378）**: 立ち絵（`CharacterLayer.show()`）の表示スケールは `loadTexture` で5段の優先順位で決まる。①話者行に `フィット`/`fit` を書いた立ち絵は `computeFitScale`（論理画面より大きいときだけ画面全体に収める・#294）②per-game frontmatter `character_scale`（元絵基準の一律スケール・#378）が指定されていれば `sprite.scale = character_scale` をそのまま適用する（**元絵基準：表示px = character_scale × textureHeight**）③per-character frontmatter `character_height_ratios`（キャラごとの目標高さ override マップ・#364）に該当キャラがあれば、その値で `computeTargetHeightScale(textureHeight, ratio, screenHeight) = (ratio×screenHeight)/textureHeight` を適用して uniform スケール（幅はアスペクト比で追従）④マップに該当キャラが無ければ per-game frontmatter `character_height_ratio`（スクリプト単位デフォルト・#360）があれば同じ式で適用⑤どちらも無ければ原寸 `scale=1`（後方互換）。③④は**画面基準**で、`character_height_ratio(s)` の式が元絵の縦px（textureHeight）を割り消すため**元画像の解像度に依らず画面上の高さを一定**にする（立ち絵を高解像度で描き直しても大きさは不変で鮮明さだけ上がる／2倍リサイズした立ち絵が原寸だと画面をはみ出す問題への対処）が、**その代償として元絵に焼き込んだ身長差も潰れる**。対して②`character_scale` は**元絵基準**（textureHeight を割り消さない）で、**元絵に焼き込んだ身長差をそのまま画面に出す**（＝元絵解像度に依存する）。身長差を絵に描き込んだキャストを素材そのままの比率で並べたいときに②を使う。②は `clampCharacterScale(scale)`（`CharacterLayer.ts` の export 純関数）で `[0.05, 4]` にクランプし、非有限・非正は未設定扱い（下位優先順位へフォールバック）。③④の優先順位判定（マップ override があればそれ、無ければスクリプト単位デフォルト）は `resolveCharacterHeightRatio(characterName, ratios, defaultRatio)`（`CharacterLayer.ts` の export 純関数）に切り出している。`ratios[characterName]` を素朴なブラケットアクセスすると prototype chain 経由でキャラ名が `constructor` 等と一致したときに関数オブジェクトを返してしまうため、共通ヘルパー `hasOwn()`（`ownProperty.ts`・#368 で全箇所を統一）で own-property のみを見て判定する。数式は `computeFitScale` / `computeTargetHeightScale` / `clampCharacterScale`（いずれも `CharacterLayer.ts` の export 純関数・非有限/非正入力はフォールバック）へ切り出してテストする（doctrine 規律4）。`character_scale` / `character_height_ratio` / `character_height_ratios` は演出中間状態でなく per-game 表示設定なので GameState には持たず、`NovelPlayer` → `NovelRenderer.setCharacterScale()`/`setCharacterHeightRatios()` → `CharacterLayer` に流す（既存の `setCharacterHeightRatio`（#360）・`character_y_ratio`（#308）と対称の配線）。`character_scale` を後から変えても表示中の静的立ち絵に即再適用される（`reapplyCharacterHeightRatios` が①fit を除き②〜⑤の優先順位でライブ再スケール）。render-only（Title/Label/Image #274）は `loadTexture` を通らず自前 sizing のため非対象。

**主人公の本文色（#305）**: `dialog_style: novel` かつ `protagonist` 指定の作品（実質 theo のみ）で、主人公セリフの本文だけやや暖かいアイボリー `#FFF0D8`、住人は純白。`NovelRenderer.resolveBodyTextColor(speaker)`（novel かつ話者 = protagonist のときだけ `protagonistTextColor`、それ以外・adv・protagonist 未指定・話者 null は `RESIDENT_TEXT_COLOR=0xffffff`）で**話者から決定論的に導出**し、`render()` の都度 `DialogBox.setBodyTextColor()` に渡す。DialogBox 側は `bodyTextColor`（既定白）を `dialogText.style.fill` と表示中ルビの fill（`makeRubyTextStyle()` に集約・#307）に当てる。主人公色は**固定で `#FFF0D8`**: parser は色を解析せず `NovelPlayer` も渡さないため、**frontmatter での色上書きは未実装**（本番経路は常に既定 #FFF0D8）。`NovelRenderer.protagonistTextColor` フィールド（既定 #FFF0D8）と `setProtagonistTextColor()` はテスト・将来拡張用の内部フックとして残す（呼ばなければ既定が効く）。per-line の描画属性であり演出中間状態ではないため GameState には持たず、復元時も render で再導出される。adv / protagonist 未指定では全員白＝後方互換。

**立ち絵とテキストの表示順序の同期（#293）**: テキスト reveal（`render()` → `DialogBox` typewriter）は同期開始するのに対し、立ち絵は `CharacterLayer.show()` が `Assets.load` で**非同期に**テクスチャ取得するため、呼び出し順が立ち絵先でも見た目は「文字が出てから立ち絵が遅れて出る」順序逆転になっていた。これを `CharacterLayer.show(..., { onReady })`（テクスチャ load 完了／texture 不要な早期 return／load 失敗いずれでも**必ず1回**発火）と `NovelRenderer.showCharacterThenRender(afterShow)` で解決する: forward（前進）3 経路（`resetAndStartEvents` 場面冒頭・`advance` 話者/イベント交代・`[待機]` 明け）で立ち絵 sprite を同期生成しスナップショットを撮った後、**novel スタイルではテクスチャ用意完了まで `render()`（テキスト reveal）を遅延**して「立ち絵 →（同時/直後に）テキスト」を保証する。adv / skip（instant 表示でラグ無し）/ 立ち絵なし Dialog は同期描画＝従来どおり（非回帰）。順序保証は描画駆動のローカルなトークン照合（`eventIndex` 一致）で行い、保留中に別イベントへ進んだ場合は stale な onReady では描画しない（連続クリック耐性）。演出中間状態は GameState に持ち込まない（ADR 0002）。復元（`applyState`）経路は instant 表示でラグが無いため従来どおり同期 `render()`。

**登場フェードインも texture-ready ゲートに揃える（#17）**: 新規立ち絵の入場フェード（alpha 0→1）は、テクスチャ load 完了後に開始する。退場衝突がある経路（`evictCollidersAt` のコールバック）は元から texture-ready を待っていたが、**退場対象がいない（`colliderCount===0`）新規立ち絵は texture を待たず即フェードを開始していた**ため、初回コールドキャッシュで texture load が fade（立ち絵の登場フェードは `character_fade_ms`・エンジン既定 `DEFAULT_FADE_MS`=300ms／theo は 700ms に上書き）より遅いと、alpha が 1 に達し切ってから絵が現れ「フェードが見えず突然出る」不具合になっていた（例: ハブに居らず本編入口で初出の司会ヴィンチア＝衝突が無いためこの経路を踏む）。`colliderCount===0` でも `startEntrance`（texture-ready ゲート）を通すよう揃えて解消する。`instant`（skip / `applyState` 復元）は従来どおり即時表示（フェード無し）。

**立ち絵・背景の先読みと瞬断リトライ（#389）**: #293/#17 は「立ち絵・背景を表示の瞬間に初めて `Assets.load` する遅延ロードで、初出は必ずコールドロード（ネット取得）になり、遅延・瞬断すると #293 のフォールバック（ロード成否に関わらず onReady 発火）で『立ち絵なし・テキストあり』に倒れる」問題への表示順序側の対処だった。#389 はその根治として、コールドロードそのものを先読みで温め、失敗時に 1 回リトライする。**先読み `preloadUpcomingAssets()`**: `processUntilNextTextEvent()` の末尾（forward の全経路 advance / setScenes / jumpToScene が通る単一トリガー）で、現在の `eventIndex`（今表示するテキストイベントを含む）から `resolvedEvents` を前方走査し、**次の分岐（`Choice` / `Condition`）または配列末尾まで**の `Dialog` / `ExpressionChange` 立ち絵（`resolveCharacterImageUrls`＝webp/png 候補）と `Background` 背景（`resolveAssetUrl`）の URL を PixiJS `Assets.backgroundLoad` に積んで事前に温める。単独画像 `[画像:]`（#274, renderOnly）は先読み対象外（立ち絵・背景に限定）。`Dialog` の立ち絵は実表示ガード（`showCharacterFromDialog`: `expression`/`position`/`character` が全て truthy）に揃え、空文字・position 欠落は積まない。分岐に当たったら止めるのは、分岐先が確定するまで先読み対象を決められないため。緩い上限 `PRELOAD_MAX_TEXT_EVENTS`=8（`getTextEvent` 非 null のテキストイベント数で打ち切る保険。テキストイベント以外（`Background`/`ExpressionChange`）は予算に数えず、予算を使い切った後の次のテキストイベントに達した時点で走査終了＝そこに至るまでの `Background` 等は積む。残りは進行に合わせて次回呼び出しで積む）、`preloadedUrls` Set で重複除去（イベント列を差し替える `resetAndStartEvents` でクリアし、新しいイベント列では先読み状態も作り直す）、`assetBaseUrl` 空なら no-op。走査は同期・実ダウンロードは `backgroundLoad(...).catch(()=>{})` に投げっぱなし（await せず本編を待たせない）。選択肢送り・シーンジャンプ直後は分岐先が確定するまで先読みできず構造的にコールドのままだが、確定後の分岐内の後続アセットは先読みで温まる。#293 の順序保証とは独立で後方互換（先読み未完でも従来どおりテキストは詰まらない）。**瞬断リトライ `loadFirstAvailableTexture()`**: URL 候補（webp→png）が一巡全滅したら `LOAD_RETRY_DELAY_MS`=300ms 待って**1 回だけ**もう一巡リトライ（計 2 巡）してから reject する。PixiJS v8 の Loader は失敗 URL を `promiseCache` から削除する（キャッシュ済み reject を残さない）ため同一 URL のリトライも実際に再取得を試みる＝ネット回復にも別 URL 候補にも効く。#293 とは両立（失敗が確定すれば従来どおり onReady が 1 回発火してテキスト解禁。リトライぶん確定が遅れるだけで詰まらせない）。

### ルビ（青空文庫記法）(#148)

子供向け動画用途で漢字に読み仮名を振る機能。parser はスキーマを拡張せず、Dialog / Narration の `text` に `漢字《かんじ》` / `｜美少女《びしょうじょ》` といった記法を生 markdown のまま保持する。frontend が描画直前に `frontend/src/game/ruby.ts` の `parseRubyText()` で `RubyRun[]`（base + ruby? のラン列）に分解し、`frontend/src/game/rubyLayout.ts` の `computeRubyPlacements()` で wordwrap 行配列に対する配置（lineIndex / charStartInLine / charEndInLine / revealAt）を pure に算出する。

`DialogBox` の描画パス:

1. raw text を `parseRubyText` で runs に分解
2. `stripRubyMarkup` で plain text を作り、既存 `wordwrap` で行配列を得る。`wordwrap` は Canvas の
   `measureText` を使う公開 API だが、中核は `wrapTextWithMeasure` に分離されており、行頭禁止文字を
   前行へ押し込んだ後に後続文字まで超過行へ連鎖させない禁則境界を単体テストで固定している（#400）。
3. `computeRubyPlacements` で各ルビの (line, x 範囲, typewriter 上の reveal タイミング) を算出
4. `dialogText` に joined plain text を流し、typewriter ticker で 1 文字ずつ表示
5. `rubyContainer` に各ルビ用の小さい `Text` を予め非表示で配置し、`displayedCharCount` が `revealAt` を超えたタイミングで `visible = true` に切り替え

これにより既存 `typewriter` モジュールには手を入れず、ルビ表示は別レイヤとして加算される。ルビ仕様の詳細は `docs/spec/markdown-v0.1.md` の「ルビ（漢字読み仮名）」を参照。

### 双方向変換

- `parse(markdown) → Event[]` — Markdown テキストを Event 配列に変換
- `emit(events) → markdown` — Event 配列を Markdown テキストに復元

ラウンドトリップテスト（parse → emit → parse で同一結果）により整合性を保証する。

### 本文の表示用正準化 (#340)

`parse` の最後に `canonicalize_events`（`parser/src/canonicalize.rs`）を全シーンの Event へ掛け、**読ませる表示テキストの一部記号を上下中央に出る字形へ正準化**する。中央字形（`─`=U+2500 / `⋯`=U+22EF）は見栄えで採用しているが普段打つのが大変なので、**原稿は打ちやすい `--` / `…` で書き、読み込み時に中央字へ正準化する**。

- `--`（ASCII ハイフンちょうど 2 連）→ `──`（U+2500 × 2、余韻横棒）。単独 `-`・語中/URL のハイフン・`---`（3 連以上＝水平線 / 見出し下線 / フロントマター区切り / 手動改頁 `PageBreak`）は不変。
- `…`（U+2026、個数保持）→ `⋯`（U+22EF、言いよどみ）。
- **対象は読ませる表示テキスト全部**: `Dialog.text` / `Narration.text` / `Choice.options[].text` / `TitleShow.text` / `Label.text`、および **RpgEvent（`[イベント]`）内の会話** `EventCommand::Dialog.text` / `EventCommand::Narration.text`（RPG モードで DialogBox に描画される本文。`canonicalize_commands` ヘルパで適用）。**対象外**: RpgEvent 内 `Dialog.character`（話者名）・`NpcData.message`（NPC に話しかけた台詞・kako-jun が明示的に対象外と決定）・RPG マスタ名（Monster / Item / Spell / PartyMember の name・`NpcData.name`）・frontmatter・`##` 見出し（scene.title）・ディレクティブ引数・アセットパス・ID・話者名（`canonicalize_events` / `canonicalize_commands` の match が分岐を持たず素通しする＝マスタ / ドメイン分離）。
- **冪等**（二重適用しても不変。既存の `──` / `⋯` コーパスも不変）。
- **emit は本文を verbatim で書き出す**ため、正準化後の `──` / `⋯` はそのまま保存され原稿 `--` / `…` には戻らない。初回保存で中央字形が原稿へ焼き込まれ、以降の parse → emit は正規形で安定する。
- **2 層構成（#308 の二段罠対策）**: Rust パーサが正本だが、wasm が古い / IndexedDB キャッシュ経由でも素の記号を出さないよう、フロント側 `frontend/src/wasm/parser.ts` の `normalizeEvents` でも `canonicalizeBodyText`（`frontend/src/game/textCanonical.ts`、Rust と同一挙動）を掛ける。parse 済み EventDocument キャッシュは `PARSED_SCRIPT_DOCUMENT_SCHEMA_VERSION` を 1→2 に上げて旧解析結果を無効化する。
- 余韻横棒 `──`（原稿 `--`）は **novel の文送り境界**にもなる（`frontend/src/game/novelLayout.ts` の `splitIntoSentences`）。`──` は前の表示単位（文）に含め、隣接する `。──` / `──。` は 1 停止にまとめる。`⋯`（言いよどみ）と `、` は境界にしない。`。` / `？` / `！` の既存境界（#292 Phase 1）は維持。

## 状態管理: NovelGameState

ノベルプレイヤーはスナップショット方式で状態を管理する。
設計思想の詳細は [ADR 0002: 決定論的状態管理とデバッグ可能性](./adr/0002-deterministic-state-and-debuggability.md) を参照。

### NovelGameState の構成

```typescript
interface NovelGameState {
  sceneId: string | null; // 現在のシーンID
  eventIndex: number; // 現在のイベントインデックス
  textIndex: number; // 現在のテキスト行インデックス
  flags: Record<string, FlagValue>; // フラグ状態
  backgroundPath: string | null; // 表示中の背景
  backgroundColor: string | null; // 単色の地色（#273。背景画像の下に敷く。復元対象）
  backgroundBrightness: number | null; // 背景の明るさ 0.0〜1.0（同一画像をシーン毎に減光。sprite.tint 乗算。null=原画。復元対象）
  isBlackout: boolean; // 暗転中か
  characters: Array<{ name: string; expression: string; position: string }>; // 立ち絵のみ。タイトル/ラベル/画像は演出表示(renderOnly)で除外(#274)
  currentBgmPath: string | null; // 再生中のBGM
  storyEnded: boolean; // 終劇状態（#386）。confinement（在圏）外への choice ジャンプで true になる宣言的フラグ。演出の中間状態ではない
}
```

### スナップショット方式の利点

1. **巻き戻し**: 履歴スタックから前のスナップショットを取り出すだけ
2. **シーク**: 先頭からリプレイせず、対象位置のスナップショットを直接復元
3. **セーブ/ロード**: スナップショットをそのまま JSON 化して保存・復元
4. **宣言的復元**: `applyState(snapshot)` で画面を完全に再構築

背景クロスフェード (#319) は立ち絵フェードと同じ render-only 演出で、`NovelGameState` には中間 alpha を持たない。`NovelRenderer` は背景 sprite/mask を entry として管理し、通常進行の `[背景:]` では旧 entry を fade-out、新 entry を fade-in する。fade-out 完了時に旧 sprite と端フェード mask を破棄する。`dialog_style: novel` の forward 経路では、背景フェード完了を待ってから立ち絵 show / settle を待ち、その後に本文 `render()` を呼ぶため、「背景 → 立ち絵 → 本文」の舞台進行になる。`applyState` / seek / save load / skip は即時置換し、任意局面復元で不要なフェードを再生しない。

### 主要API

| API                                                     | 説明                                                                                                                                             |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `advance()`                                             | 次のイベントに進む                                                                                                                               |
| `goBack()`                                              | 前のイベントに戻る                                                                                                                               |
| `getSnapshot()`                                         | 現在の状態をスナップショットとして取得                                                                                                           |
| `seekTo(historyIndex)`                                  | 履歴の指定位置にジャンプ                                                                                                                         |
| `applyState(state)`                                     | スナップショットから画面を復元                                                                                                                   |
| `playScript(steps)`                                     | 操作列（`advance`/`choice`/`wait`）を決定論的にリプレイ（#220 Phase 1、デバッグ/テスト用。再生中 msPerChar=0、完了・例外時に復元、再入は throw） |
| `startFrom({sceneId, flags?, eventIndex?, textIndex?})` | 任意シーン+フラグ状態から開始（#220 Phase 2、デバッグ/テスト用。history リセット、flags 置換、不正 sceneId は完全 no-op）                        |
| `setConfinedSceneIds(ids \| null)`                       | confinement（在圏）一覧を設定する（#386）。null（既定）なら制限なし。設定すると `jumpToScene` はこの集合外への遷移を通常のシーン遷移にせず `endStory()`（終劇）にする。呼び出し元は `PlayerScreen`（`?scene=` ディープリンク単独埋め込み時のみ） |
| `setOnStoryEndedChange(cb)`                              | 終劇状態の変化コールバックを登録する（#386）。`NovelPlayer` が "to be continued..." の DOM 表示に使う                                              |

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
- `PageBreak` — 手動改頁マーカー（`---`）。何もせず読み飛ばす（次の text イベントが新ページから始まる、#292 Phase 2）
- `Bgm` / `Se` — 音声制御
- `Flag` — フラグ設定
- `Exit` / `ExpressionChange` — 立ち絵制御
- `Wait` — 待機

`Dialog` と `Narration` のみユーザー操作（クリック/キー）で進行する。

### NovelRenderer の純粋計算モジュール (#260)

`NovelRenderer.ts` は god-object 化しやすいため、入力→出力が決定論的で `this` / PixiJS / DOM / TimeController に一切依存しない計算を専用モジュールへ漸進分離している（#260）。`ruby.ts` / `rubyLayout.ts` / `raycastProjection.ts` と同じ流儀で、NovelRenderer 側は「いつ計算するか」「結果をどの表示オブジェクト・オーディオに当てるか」だけを保持する。各関数は抽出前に NovelRenderer 内へ直書きされていた式・数値・文字列と完全一致し（挙動不変）、リファレンス等価性をユニットテストで機械的に担保する。

- **`frontend/src/game/screenEffects.ts`（時間→値、#143 / #264）**: 画面効果の毎フレーム計算を集約する。`effectProgress(elapsedMs, durationMs)` が `min(elapsed/duration, 1)` の進行率を返し（`durationMs <= 0` / 非有限は即完了 `1`、負 elapsed は `0` にクランプ）、それを使って `computeShakeOffset`（`decay = 1 - progress`・`offsetX = sin(elapsed*0.05)*intensity*decay`・`offsetY = cos(elapsed*0.037)*intensity*decay*0.6` の減衰揺れ）、`computeFlashAlpha`（`peak*(1-progress)` の線形フェードアウト）、`computeFadeAlpha`（`from + (to-from)*progress` の線形補間、`progress>=1` で `to` ちょうど）を算出する。いずれも `done = progress >= 1` を返し、NaN/Infinity の振幅・alpha は `0` 扱い。境界値テストは `screenEffects.test.ts`
- **`frontend/src/game/textEffect.ts`（グリフ単位文字演出の時間→値・中央寄せレイアウト、#268）**: `[文字演出]` ディレクティブ（タイトルカードの enter アニメ）の純粋計算を集約する。`resolveTransformEffect(params)` がプリセット（爆発）＋個別 override ＋グローバル既定をマージして解決済みパラメータを返し（優先順位: 個別 > プリセット > 既定、負の duration/stagger は 0 クランプ）、`glyphLinearProgress(elapsed, glyphIndex, stagger, duration)` がグリフ i の `i*stagger` 遅延・duration 飽和を踏まえた線形進行率 `[0,1]` を返す。`computeGlyphTransform(resolved, elapsed, glyphIndex)` は進行率に easing を当てて開始オフセット → 整列状態（0/等倍/不透明）へ補間した 1 グリフ 1 フレーム分の transform を返し、`textEffectTotalDurationMs(resolved, glyphCount)` が最後のグリフが整列し終わる総時間（`(n-1)*stagger + duration`、0 グリフは 0）を返す。`layoutGlyphCenters(widths)` はグリフ幅配列から行全体を原点中央に寄せた各グリフ中心 x 配列を返す（空配列は `[]`）。プリセット定数（`EXPLODE_PRESET` / `TYPEWRITER_PRESET` / `TEXT_EFFECT_DEFAULTS`）はテストが期待値を直書きして陳腐化しないよう export する。CharacterLayer.applyTextEffect はこれらの値を各グリフ PixiText に当てるだけ（配線のみ）で `this`/PixiJS には触れない。easing 側の `easeOutBack`（`easing.ts`、爆発の "ポップ" 用オーバーシュート。overshoot 係数 s=1.70158、t=1 で 1.0）も #268 で追加。#271 でタイプ末尾の点滅カーソルを追加: `resolveCursor(params)` が reveal かつ `cursor=on` のときだけ `enabled=true`・点滅周期（既定 600）・色を解決し、`cursorVisible(elapsedMs, blinkMs)` が `floor(t / (blinkMs/2)) % 2 === 0` の step 関数で点滅位相を返す（`t<=0` 表示・`blinkMs<=0` 常時表示）。プリセット定数 `CURSOR_DEFAULTS` も export。CharacterLayer 側はカーソルを縦矩形 Graphics として reveal head に追従させ、settle 後も点滅だけ ticker で継続する（render-only・セーブ対象外）。カーソル Graphics は生成直後は不可視で、初期 `updateTextEffectFrame()` が reveal head へ配置したあとに `cursorVisible()` の結果で表示する（#333、未配置原点の 1 フレーム表示を防ぐ）。#275 でラベル揃え対応のグリフ整列オフセット `glyphAnchorOffset(totalWidth, anchorX) = totalWidth*(0.5 - anchorX)` を追加（左揃えラベルにタイプを当てるとグリフが左端起点で右へ並ぶ。`anchorX=0.5` で 0＝従来の中央寄せと一致。カーソルは container の子なので自動追従する）。境界値・デシジョンテーブルテストは `textEffect.test.ts` / `easing.test.ts`
- **`frontend/src/game/underline.ts`（下線ビームの時間→値・幾何・色パース、#270）**: `[下線]` ディレクティブ（OP タイトルカードの巨神兵ビーム）の純粋計算を集約する。`resolveUnderline(params)` がプリセット既定（`UNDERLINE_DEFAULTS`: 色 `#1a4a7a` / 太さ 3 / 700ms / EaseIn）と個別 override をマージし数値色・太さ（負は 0 クランプ）・duration・easing を解決、`underlineScaleX(elapsedMs, resolved)` が経過 ms → `scaleX [0,1]`（easing 適用、`elapsed<=0` で 0・`duration` 経過後 1・`duration<=0` は即 1）を返す。`layoutUnderline(textWidth, textBottomY, resolved, autoOffset)` がテキスト実 measure 幅から線の幾何（左端 x = `-width/2`・y = `textBottomY + offset`・幅・太さ）を算出する（offset 未指定なら autoOffset を補う）。色パース `parseColorToNumber` は **#273 で `novelLayout.ts`（色/幾何の純関数置き場）へ移設**し（下線ビーム・タイトル文字色・背景色が共有するため。doctrine 規律4=純粋関数の単一の置き場所）、`underline.ts` はここから re-export して既存 import（CharacterLayer / underline.test）の互換を保つだけ。CharacterLayer.applyUnderline は解決値を Pixi Graphics の矩形に当て scale.x で左から伸ばすだけ（配線のみ）。プリセット定数は export。`Math.random` 不使用・`TimeController` 駆動で決定論的。境界値テストは `underline.test.ts`
- **`frontend/src/game/wordwrap.ts`（日本語禁則ワードラップ、#400）**: `wrapTextWithMeasure(text, maxWidth, measure)` が
  Canvas/DOM 非依存の折り返し中核。`wordwrap(text, maxWidth, font)` は Canvas `measureText` を注入する薄い
  ラッパーとして既存 API を維持する。行頭禁止文字（句読点・閉じ括弧・促音など）は前行へ押し込むが、その1文字ぶんの
  超過を許した時点で行を確定し、`」って` のような閉じ括弧+促音+通常文字が右端を越えて連鎖しないようにする。
  そのため、超過行を確定した直後の次行では促音などの行頭禁止文字始まりを許容する場合がある。右端見切れ防止を
  優先し、禁則の押し込みを無制限に連鎖させない方針。行末禁止文字（開き括弧など）を次行へ送る既存禁則は維持する。
  境界値テストは `wordwrap.test.ts`。
- **`frontend/src/game/novelLayout.ts`（幾何・色パース・URL 解決・state 変換・フォント解決・表示値・シーンルックアップ・2D 位置解決、#265 / #260 / #273 / #274 / #275）**: NovelRenderer の純粋計算 13 種を集約する（#273 で `parseColorToNumber` を `underline.ts` から移設、#274/#275 で 2D 位置解決を追加）。`computeCoverFit(textureWidth, textureHeight, screenWidth, screenHeight)` は背景画像をアスペクト比維持で画面に「カバー」し中央寄せした `{width, height, x, y}` を返す（`scale = max(screenW/texW, screenH/texH)` で短辺を画面に合わせ長辺を溢れさせ、はみ出し分を中央でトリミング）。`parseHexColor(hex)` は `#RRGGBB` を PixiJS 用数値色に変換（先頭 '#' を 1 つだけ除去 → `parseInt(_, 16)`、NaN は白 `0xffffff` フォールバック）。`parseColorToNumber(color, fallback)`（#270 で導入、**#273 で `underline.ts` からこのモジュールへ移設**）は CSS カラー（`#rgb` 短縮形も展開）を PixiJS 数値色に変換し解釈不能・`undefined`・純 hex 以外は引数の `fallback` を返す（`parseHexColor` と違い fallback 可変・3 桁展開・符号付き弾き）。下線ビーム（#270）・タイトル文字色／背景色（#273）が共有し、`underline.ts` は re-export で互換維持。`resolveAssetUrl(baseUrl, kind, path)` はアセット相対パスを `${baseUrl}/${kind}/${path 先頭 '/' を 1 つ除去}` の配信 URL に解決（`kind` は `'images' | 'sounds'`）。`saveSlotToGameState(data, normalizedFade)` は `SaveSlotData` を復元用 `NovelGameState` に写像する（video/isBlackout/characters/currentBgmPath は古いセーブ向け後方互換フォールバック付き、fade は PixiJS 非依存を保つため正規化済みの値を引数で受け取る）。`resolveFontFamily(perLine, perGameDefault, runtimeDefault)` は `perLine ?? perGameDefault ?? runtimeDefault` の優先順チェーン（元 render() / TitleShow の 2 箇所重複を集約。空文字は指定扱いで素通し）。`formatCounterText(displayIndex, total)` は `"{displayIndex} / {total}"` の整形。`computeSeekBarPosition(displayIndex, total)` は SeekBar 用 `{current: max(0, displayIndex-1), total}`（1-based を 0-based 化しクランプ）。`describeEventForDebug(event)` はデバッグ HUD 用に 1 イベントから `{kind, text}` を取り出す（`Object.keys()[0]` の kind + text 配列/line/path/target の優先順抽出、配列は先頭を JSON 化し 120 文字切り詰め。引数型は任意入力耐性のため `unknown`）。`findSceneById(scenes, sceneId)` は `scenes.find((s) => s.id === sceneId)`（先頭一致の `EventScene | undefined`、未発見時の分岐は呼び出し側責任。`jumpToScene` / `loadFromSaveData` / `startFrom` / `resolveSceneTitle` 内部の 4 箇所で同形だったルックアップを集約）。`resolveSceneTitle(scenes, sceneId)` はセーブ表示用のシーンタイトル解決（`sceneId` が falsy なら即 `null`、それ以外は `findSceneById(...)?.title ?? null`。元 `quickSave` / `openSaveMenu` の 2 箇所にバイト単位で重複していた式を集約）。`resolveLayoutPosition(position)` は縦＋横を結合した 2D 位置トークン（縦 `上`0.16/`中上`0.34/`中`0.5/`中下`0.64/`下`0.84 ＋横 `左`0.1875/`中央`0.5/`右`0.8125）を `{xRatio, yRatio}` に解決する（完全一致を優先して `中央`↔`中` の衝突を避ける・`左下` 等の結合は順序非依存・英語 alias・未知/空は中央 (0.5,0.5)。横 ratio は立ち絵 `CHARACTER_X_RATIO` と同値で揃える、#274）。`resolvePositionWithOverride(position, x?, y?)` はそのトークン由来比率に数値 `x`/`y`（有限かつ 0..1 の値のみ採用、NaN/Infinity/範囲外は軸ごとにトークンへフォールバック）を軸独立に被せ、テンプレ厳密合わせを可能にする（#275）。両者を `[ラベル]`（showLabel）/`[画像]`（showImage）/`[タイトル]`（showTitle）が共有し、縦位置トークンと厳密配置を全要素で一貫させる（タイトルも #275 で縦トークンを尊重）。境界値・リファレンス等価性テストは `novelLayout.test.ts`。**#260 の純粋計算抽出はこれで出し切った**（シーンタイトル解決・シーンルックアップを含め、`this`/PixiJS/DOM/audio に触れない決定論的な計算は残っていない）: 残る NovelRenderer の責務（Sprite/Container/Graphics の生成・配置・破棄、Ticker/タイマー駆動、AudioManager/DOM 副作用、フラグ/履歴の状態遷移）は PixiJS 表示オブジェクト管理そのものであり純粋化不能

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
  savedAt: string; // ISO 8601
  sceneName: string | null; // 表示用シーン名
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

### 動画エクスポート用キャプチャ (#228)

- `AudioManager.enableCapture()` で `MediaStreamAudioDestinationNode` を生成し、`bgmMasterGain` / `seMasterGain` を分岐配線する
- 通常の `ctx.destination` への配線は維持されるため、録画中もスピーカーで音をモニタできる
- 別アプリの音声・他ブラウザタブ・システム音は混入しない（Web Audio グラフ内の音のみキャプチャ）
- `disableCapture()` で MediaStream destination を切断する

## 動画エクスポート (#228)

llll-ll-media など、シナリオを動画ファイルとして書き出す用途のための Phase 1 実装。

### 方式: MediaRecorder リアルタイム録画

```
canvas.captureStream(fps) ─┐
                            ├─ MediaStream ─ MediaRecorder ─ Blob (video/webm)
AudioManager.enableCapture ─┘
```

- 映像: `<canvas>` 要素の描画フレームのみキャプチャ
- 音声: AudioManager の master gain 経由音のみキャプチャ
- 出力: WebM（VP9/opus 優先、VP8 フォールバック）

### モジュール構成

| ファイル                                  | 役割                                                                                                    |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `frontend/src/game/VideoExporter.ts`      | `exportVideo()` / `pickSupportedMimeType()` / `downloadBlob()`                                          |
| `frontend/src/game/AudioManager.ts`       | `enableCapture()` / `disableCapture()`                                                                  |
| `frontend/src/game/NovelRenderer.ts`      | `getCanvas()` / `getAudioManager()` / `getCurrentSceneId()` / `getAllSceneIds()` / `setOnSceneChange()` |
| `frontend/src/components/NovelPlayer.tsx` | `onRendererReady` prop                                                                                  |
| `frontend/src/screens/EditorScreen.tsx`   | 録画ボタン + モーダル UI                                                                                |

### 終了検出

`exportVideo` 開始時に `setOnSceneChange` を上書きし、以下のいずれかで `MediaRecorder.stop()` する:

1. シーンが一度 `endSceneId` になり、その後別シーンへ遷移した
2. `renderer.onEnd` が発火（全イベント完走、`endSceneId` が最終シーンだったケース）

stop 後に `postRollMs` (デフォルト 1200ms) の余韻録音を経て Blob を確定する。BGM 既定フェード 1000ms を完全に録音するための値。
録画開始前は `preRollMs` (デフォルト 50ms) の遅延を挟んで「前回プレビューの最終フレーム」と「BGM 頭欠け」を最小化する。AudioContext のバッファ遅延 20-50ms を吸収する目安。

### VideoExporter が依存する公開 API

| メソッド                                                                                            | 役割                                                                               |
| --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `NovelRenderer.getCanvas()`                                                                         | `canvas.captureStream(fps)` の対象を取得                                           |
| `NovelRenderer.getAudioManager()`                                                                   | AudioManager 経由で音声 MediaStream を分岐                                         |
| `NovelRenderer.setOnSceneChange()` / `takeOnSceneChange()`                                          | 終端検出用のリスナ占有と退避復元                                                   |
| `NovelRenderer.setOnEnd()` / `takeOnEnd()`                                                          | 全イベント完走の検出用、退避復元（VideoExporter は登録も復元も `setOnEnd` に統一） |
| `AudioManager.enableCapture()` / `disableCapture()`                                                 | 音声 MediaStreamAudioDestinationNode の分岐管理                                    |
| `VideoExporter.exportVideo()` / `pickSupportedMimeType()` / `sanitizeFilename()` / `downloadBlob()` | エクスポートの本体と補助関数                                                       |

UI 側からは `NovelRenderer.getCurrentSceneId()` / `getAllSceneIds()` も使えるが、EditorScreen は doc から直接シーン ID 一覧を作っているので未使用。

`take*` 系は破壊的 getter（取り出し後 null クリア）。VideoExporter 内部で同 renderer に対する並行起動を防ぐため、モジュールスコープで `isExporting` フラグも持つ（HMR で再ロードされた場合のみリセットされる。録画中はソースコードを触らないこと）。

### Phase 1 の制約

- **実時間がかかる**: シナリオ 3 分なら録画も 3 分。virtual time 化していないため
- **キャンセル不能**: 録画開始後に途中で止める手段は今のところ無い（ページリロードで強制終了）。長尺録画は事前に範囲を確認すること
- **WebM のみ**: mp4 変換は Phase 2 で ffmpeg.wasm を追加する
- **タブ非アクティブで品質劣化**: ブラウザが rAF を間引くと PixiJS Ticker が薄まり、描画フレームが捨てられる。録画中はタブをアクティブに保つ必要がある
- **コールバックの占有**: `setOnSceneChange` / `setOnEnd` を録画中に上書きするため、録画中の手動操作と競合する想定はしていない
- **多重録画不可**: モジュールスコープの `isExporting` フラグで防衛しているが、HMR (Vite dev) でファイル保存すると false にリセットされる。録画中はソースを触らない

### Phase 2 構想

決定論的 virtual time 経路（`TimeController` 既設）+ `OffscreenCanvas` 毎フレーム render + ffmpeg.wasm 連結。Phase 1 のモジュール境界 (`VideoExporter`) を保ったまま実装本体を差し替える想定。

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
- `UiNpcData` — UI / runtime 側の NPC 型（parser 側 `NpcData`（WASM 経由スキーマ、`frontend/src/types.ts`）から `rpgProjectFromDoc` 変換層で詰め替える）。フィールド追加時は parser / UI / 変換層の 3 箇所を揃える #103。グリッド座標・名前・会話メッセージ・表示色・オプション: `sprite`（スプライトシートパス）・`frames`（歩行アニメフレーム数 / 方向あたり、未指定なら 2）・`direction`（アイドル時の向き、未指定なら `down`）
- `RPGProject` — 上記の集合（+ 将来の `EventData`）

`TILE_COLORS_HEX` がタイルの描画色（PixiJS `Graphics` で矩形塗りつぶしに使用）。

### レンダラー共通インタフェース（TopDownRenderer / RaycastRenderer）

| API               | 説明                                                    |
| ----------------- | ------------------------------------------------------- |
| `init(container)` | PixiJS `Application` を生成し `<canvas>` を親要素に追加 |
| `load(gameData)`  | マップ・プレイヤー・NPC を描画して入力受付開始          |
| `destroy()`       | ticker・イベントリスナー解除、PIXI `Application` 破棄   |

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
- **向き**: `UiNpcData.direction`（未指定なら `down`）に対応する行を表示。アイドル中は固定（自律移動・プレイヤー追従は未対応）
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

- **レイヤ順**: `worldLayer` 直下に `worldGraphics`（空のベタ塗り + 床の per-tile floor casting、奥）、`wallSpritesContainer`（壁 Sprite プール、その手前）、`stepWallSpritesContainer`（段差壁面 Sprite プール、さらに手前）を配置。NPC は stage 直下の `npcLayer` にあるため、空 → 床 → 壁 → 段差壁 → NPC の順で重なる（段差壁は常に壁より手前なので、段差壁ピクセルは壁の上に描かれる）
- **ストライプ Sprite プール**: `numStripes = ceil(screenWidth / stripeWidth)` 個の `Sprite` を `wallSpritesContainer` に保持。毎フレーム texture / x / height / tint / visible を更新して再利用する。画面リサイズで `numStripes` が変わるときは `ensureStripePool(target)` で余剰を destroy、不足を生成
- **テクスチャ**: `wallTextureSheet.ts` が TREE / WATER ごとに `TEXTURE_WIDTH=64` × `TEXTURE_HEIGHT=64` のベース RenderTexture を作り、左から 1 列ずつ 64 本の縦ストライプ Texture に切り分けてキャッシュする。`loadWallTexture(kind, renderer, externalPath?)` が非同期でこのシートを返す。ロード前は従来の `worldGraphics` ベタ塗り fallback を使う
- **u 座標の算出**: DDA で hit した壁の位置から `computeWallU(side, perpDist, px, py, rdx, rdy)` → [0, 1) の u を求め、`uToColumn(u, width)` で列 index に変換して `sheet.columns[col]` を Sprite.texture に設定する。Lodev 方式の u 反転（side=0 && rdx>0、side=1 && rdy<0）を純粋関数内で処理
- **テクスチャ切り出し（crop モード、Issue #86 Phase 2-5）**: 短い壁（wallHeight<1）はテクスチャの下部 `wallHeight` 分のみを 1:1 スケールで表示する。純粋関数 `computeWallTextureCrop(textureHeight, wallHeight)` が `{frameY, frameHeight}` を返し、RaycastRenderer は `new Texture({ source, frame: new Rectangle(col, frameY, 1, frameHeight) })` を毎フレーム生成して Sprite に割り当てる。pixel scale = `lineHeight/textureHeight` が wallHeight に依らず一定 → レンガ模様が縦潰れしない。wallHeight>=1 は texture 全体を使う従来 stretch 挙動（tiling は別 Issue）。wallHeight<=0 / NaN / Infinity は `frameHeight=0` で描画スキップ
- **フォグ**: `tint = applyFog(base, fog)` で暗く落とす。y-side（side=1）は `darken(0xffffff, 0.7)` を基底にしてから fog 適用し、壁面の立体感を保つ
- **デモテクスチャ**: リポに画像アセットを持たずに「色ベタではないテクスチャ」の体験が成立するよう、`__demo_tree`（緑系の木目 + 節目）と `__demo_water`（青系の波模様）を手続き生成する。`(renderer, kind)` 組で `WeakMap<Renderer, Map>` にキャッシュされ、`clearDemoWallCache(renderer)` で一括解放
- **テスト**: 純粋関数 `uToColumn` / `computeWallU` / `computeWallTextureCrop` の境界値テストは `wallTextureSheet.test.ts`。PixiJS 描画自体は手動確認

#### 床描画（Raycast）

床は壁と同じく「2D マップ上の各タイルが、透視投影で先細りした四角として見える」状態を狙う。`worldGraphics` に対するスキャンライン floor casting で実装する。

- **アルゴリズム**: ホライゾン以下の各 y スキャンラインについて、純粋関数 `computeFloorRowDist(y, horizonY, screenHeight, cameraZ)` で「そのスキャンラインが地表で何タイル先か」（= `rowDist = cameraZ / ((y - horizon) / (h/2))`）を求め、画面左端 (cameraX=-1) / 右端 (cameraX=+1) を貫くレイの世界座標を線形補間する。x ピクセルごとに純粋関数 `sampleFloorTileColor(mapTiles, mapWidth, mapHeight, wx, wy, palette, fallback)` でタイル色を引き、連続同色のランを 1 つの `g.rect(x, y, runWidth, 1).fill(color)` にまとめる
- **カメラベクトル共有**: `dirX/Y` と `planeX/Y` は `renderFrame` 冒頭で 1 度だけ計算し、床 floor casting と壁 DDA の両方が同じ値を参照する。途中で `playerAngle` を書き換えないため両者は必ず同一フレームの値で揃う
- **色対応**: `TILE_COLORS_HEX[tile]` を palette に渡す（TopDown 側と同じ単一情報源）。マップ範囲外や palette に無いタイル種別、`mapTiles[ty]` 行が undefined のケースは fallback `TILE_COLORS_HEX[TileType.TREE]` に倒す。WATER タイルは palette に登録があるため青 (`0x4169e1`) で描画される（2D マップと一致する見た目）。歩ける床ではないが、視界の遠方の水面が視覚的に伝わる
- **per-tile な見え方**: 1 マスだけ ROAD があるマップなら、画面上に茶色のタイルが 1 枚だけ「透視投影で先細りした四角」として現れる（厳密にはハイパボリック投影なので奥行きが非線形に圧縮されるが、見た目は台形に近い）。NPC ビルボードと同じく「遠くは小さく近くは大きく」見える。1 サンプル/スキャンライン方式（旧 #172）の「踏み込んだ瞬間に画面全体が切り替わる」見栄えはここで解消される
- **計算量**: `w × (h - horizon)` の `sampleFloorTileColor` 呼び出し + ランチェック。800 × 300 ≈ 240k ops/frame、fill 呼び出しは 1 行あたり通常数個に収束する
- **既知の制限**: 床テクスチャは未対応（壁の `wallTextureSheet` 相当はない）。pitch が大きいときの遠近歪みも単色塗り分けなので許容範囲
- **テスト**: `computeFloorRowDist` / `sampleFloorTileColor` の境界値（horizon 直下、`row` 穴あき、palette 未登録、`NaN/Infinity`、マップ範囲外）は `raycastProjection.test.ts` で網羅

#### スワイプ 90° 旋回アニメ（Raycast）

スマホのスワイプ ← / → による 90° 旋回は瞬間スナップではなく `turnAnimSpeed = 10 rad/s` での角度補間で進める。π/2 ≈ 1.5708 rad を 0.157 秒で消化する。

- **データモデル**: `RaycastRenderer.turnAnimRemaining: number`（rad、符号付き）に「あと回す角度」を積む
- **予約 (`queueTurn`)**: スワイプ left → `-π/2`、right → `+π/2` を積む。連打すると加算され 180°/270°/360° と連続回転する。残量は `±turnAnimMaxAbs = ±2π` にクランプ（4 連打で同向きへ戻る挙動を維持しつつ、100 連打で 16 秒回り続ける UX 事故を防ぐ）
- **消費 (`advanceTurnAnim`)**: `onTick` の dialog ガード**外**で毎フレ呼ぶ。ダイアログ / メニュー表示中も補間は進む（M1: 表示中に消費が止まると、閉じた瞬間に残量が残っていて角度がカクッと変わる事故を防ぐ）。純粋関数 `consumeTurnAnim(remaining, dt, animSpeed)` に消費ロジックを委譲
- **flush (`flushTurnAnim`)**: `snapStep` の先頭で残量を即時消費して角度を確定する。S4: 旋回アニメ中にタイル単位の移動（`Math.round(cos/sin)`）が走ると中間角度を拾って想定外のタイルに進む事故が起きるため、移動前に必ず flush する
- **minimap 連動**: 表示中だけでなく非表示中も `setPlayerAngle` でバッファだけは更新する。ダイアログを閉じて minimap が再表示された瞬間に矢印がカクッと飛ばないようにする
- **テスト**: `consumeTurnAnim` の境界値（残量ぴったり消化、符号反転、`dt=0` / `animSpeed=0`、`NaN/Infinity`、複数フレーム消化）は `raycastProjection.test.ts` で網羅

#### 壁高さ（wallHeights, Issue #49 Phase 1）

タイル座標ごとに壁の高さを変えられる。低い柵・高い塔のような段差表現が可能。

- **データモデル**: `MapData.wallHeights?: number[][]`（`tiles` と同じ `[y][x]` レイアウト）。`1.0` = 標準（従来挙動）、`0.5` = 腰高、`1.5` = 二階建て塔、`0` 以下 = 描画なし
- **未指定時**: `wallHeights` 自体が undefined、または該当行/セルが未定義の場合は `1.0` 扱い（既存マップは挙動不変）
- **TREE/WATER 以外のタイル**: `wallHeights` の値は無視される（壁でないので描画されない）
- **純粋関数**: `frontend/src/game/raycastProjection.ts` の `computeWallYRange(lineHeight, wallHeight, screenHeight)` が `drawStartY` / `drawEndY` を返す。地面位置（`drawEndY`）は wallHeight に依らず不変で、上端（`drawStartY`）が伸縮する。遠方カリング・フォグの伸長は `computeEffectiveFogMaxDist(baseFogMaxDist, wallHeight)`（Phase 2）。境界値テストは `raycastProjection.test.ts`
- **Sprite 配置**: 壁ストライプ Sprite は `anchor.set(0, 0)` で上端を `drawStartY` に置き、`height = drawEndY - drawStartY` で下端を地面に揃える。Phase 1 は縦方向全体スケール（壁が低いと texture 自体が圧縮されレンガ模様が潰れる）だったが、Issue #86 Phase 2-5 で `wallHeight<1` のときテクスチャ上端クロップ（`computeWallTextureCrop`）に切り替え、pixel scale が wallHeight に依らず一定になるようにした。`wallHeight>=1` は引き続き全体スケール
- **Phase 2 として残課題**: 視覚的な天井レンダリング（per-column ceiling texture）、真の斜面 + pitch の ray Z 成分導入（Issue #99）は別 Issue。pitch（上下視線）は #80 Phase 2-1、ジャンプ（z 方向の動き）は #80 Phase 2-2、床段差（踏み込むとカメラ z が上がる MVP）は Issue #84、天井段差（頭ぶつけ判定 MVP）は Issue #87、視覚的な床段差壁面レンダリングは Issue #88 Phase 2-7a で対応済み（下記参照）。Markdown 構文 / エディタ UI からの wallHeights / floorHeights / ceilingHeights 指定は #90 / #91 で対応済み
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

#### 床段差（floorHeights, Issue #84 / Phase 2-7a Issue #88）

タイルごとに床の高さを変えられる。プレイヤーが踏み込むとカメラ高さが自動で上昇する。Issue #88 Phase 2-7a で、隣接タイル間の床高さ差が垂直な段差壁面として描画されるようになった。

- **データモデル**: `MapData.floorHeights?: number[][]`（`tiles` と同じ `[y][x]` レイアウト）。`0.0` = 地面標準（従来挙動）、`0.5` = 半段、`1.0` = 1 タイル分上。負値は沈み込み表現として許容
- **未指定時**: `floorHeights` 自体が undefined、または該当行/セルが未定義の場合は `0.0` 扱い（既存マップは挙動不変）
- **純粋関数**: `frontend/src/game/raycastProjection.ts` の `resolveFloorHeight(grid, tx, ty)` が床高さを返す。`getWallHeight` と同構造だが fallback は `0`（地面）。境界値テストは `raycastProjection.test.ts`
- **プレイヤー状態の分離**: `RaycastRenderer.playerGroundZ`（現在踏んでいるタイルの床高さ、床段差由来）と `playerJumpZ`（ジャンプ由来の相対高、旧 `playerZ` をリネーム）に分離。カメラ総オフセット `totalCameraZ = playerGroundZ + playerJumpZ` を `h/2` 倍して px に換算し、pitch オフセットと合算して純粋関数に渡す
- **更新タイミング**: `updateMovement(dt)` の移動処理後に `playerGroundZ = resolveFloorHeight(floorHeights, floor(x), floor(y))` で瞬時切替（補間なし）。段差の境界で視点が段階的にカクっと上がる
- **ジャンプとの関係**: ジャンプは床面（`playerGroundZ`）からの相対高 `playerJumpZ` で管理し、着地判定は `playerJumpZ <= 0`。床段差の上でも通常通りジャンプできる
- **寸法ミスマッチ**: `wallHeights` と同様、行数・列数が `tiles` と一致しない場合は `load()` で `console.warn` を出すが描画は止めない
- **段差壁面の描画（Issue #88 Phase 2-7a）**: DDA ループ中、ray がタイル境界を跨ぐ都度 `detectFloorStep(prevFloorZ, nextFloorZ)` で段差情報（`FloorStepInfo: lowerZ / upperZ / heightDiff / upperSide`）を検出し、壁ヒットまでに通過した境界のうち手前から最大 `maxStepsPerColumn = 3` 個を記録する。列ごとに `computeFloorStepWallYRange(lineHeight, lowerZ, upperZ, h, pitchOffsetPx)` で画面 Y 範囲を求め、`stepWallSpritesContainer` の Sprite プール（サイズ = `numStripes × maxStepsPerColumn`）から slot を取り出してテクスチャ・位置・フォグ tint を設定して描画する。テクスチャは MVP では TREE 壁の `wallTextureSheet` を流用（両隣は非壁タイルなので壁タイルの種類を参照できない）。u 座標は通常壁と同じ `computeWallU` を使う
- **段差の zBuffer / wallTopYBuffer 扱い**: 列ごとに段差のうち最も手前の depth を `frontStepDepth`、その drawStartY を `frontStepDrawStartY` として追跡する。`frontStepDepth < zBuffer[i]` なら `zBuffer[i]` を更新、`frontStepDrawStartY < wallTopYBuffer[i]` なら `wallTopYBuffer[i]` を更新する。これにより「段差の手前にいる NPC は段差で遮蔽」「段差の奥にいる NPC の頭が段差の上端より上に出ている部分のみ可視化」の両方が整合する。段差は常に壁より手前（DDA は壁ヒットで止まる前の境界）なので、この上書きは「より厳しい遮蔽」として安全に働く。`hit=false`（壁が視界外、`wallTopYBuffer[i]=h` のまま）のケースでも、段差が最前面なら wallTopYBuffer が段差の drawStartY で上書きされる
- **描画順と視覚重なり**: `stepWallSpritesContainer` を `wallSpritesContainer` の後に addChild するため、同じ列内では段差壁 Sprite が壁 Sprite の上に重ねて描かれる。列内で複数の段差がある場合は「奥から手前」の順に slot 0 → N に割り当て、子配列の描画順で自然に奥が先に塗られる
- **段差テクスチャの縦 pixel scale**: 通常壁の `computeWallTextureCrop` を段差にも流用する（Phase 2-7a R1 対応）。`computeWallTextureCrop(WALL_TEXTURE_HEIGHT, heightDiff)` で下部 `heightDiff` 分をクロップ（例: `heightDiff=0.25` → ベーステクスチャの下 16px のみ）。pixel scale = `lineHeight/WALL_TEXTURE_HEIGHT` が heightDiff に依らず一定になり、段差壁でもレンガ模様が縦潰れしない。`heightDiff > 1` のケース（stacked sheet が必要）は MVP では未対応 → tileCount>1 になったらフォールバックしてベーステクスチャ全体を `WALL_TEXTURE_HEIGHT` で切る（heightDiff>1 かつ frameHeight=WALL_TEXTURE_HEIGHT なので、stepDrawHeight > frameHeight となり、視覚的には縦に引き伸ばされる）
- **既知の制限**:
  - **u 座標の近似**: 段差の u 座標は「ray と段差面の交差点のタイル内位相」を近似的に `computeWallU`（通常壁向けの側面 u 計算）で算出している。真に正しい u は段差境界の「長辺方向の位置」だが、MVP では視覚的違和感が小さいので採用。隣接列で u が不連続になる可能性があり、レンガの横ラインが境界で段ズレする場合がある（Q1）。手動確認できないため、破綻しているケースが見つかったら Issue #99 と合わせて真の u を実装する
  - **1 列あたり段差最大 3 個**: `maxStepsPerColumn = 3` を超える段差は奥側から無視される。実測データに基づくチューニングは未実施（Q2）
  - **テクスチャは TREE シート固定**: 両隣が非壁タイルのため、段差側面の wallType を自動選択できない。MVP では TREE を流用
  - 真の斜面（連続高低差を ray 射影する）や CornerHeights、Camera.pitch の本物化（ray に Z 成分）は Issue #99 で別途扱う
  - Markdown 構文 / エディタ UI からの `floorHeights` 指定は別 Issue

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
- 見た目・状態管理は `RpgDialogBox` クラス（`frontend/src/game/RpgDialogBox.ts`）に集約。TopDownRenderer / RaycastRenderer は `show(name, message, portrait?)` / `hide()` / `redraw(w, h)` / `isShowing` のみを呼ぶ
- **portrait 顔枠（Issue #73 Phase 1 + #104）**: NPC に `portrait=path.png` が指定されているとダイアログ左側に 80×80 の顔枠を表示し、テキスト開始 x を顔枠右側（140px）にシフトする。VN 風の固定 1 枚、**contain（アスペクト比保持で内接）でセンター配置**し余白は portraitFrame の半透明黒で埋まる。portrait 未指定時は従来どおり顔枠なし。画像ロードは `PIXI.Assets.load` + path 単位キャッシュ（`portraitCache`、成功時のみキャッシュ保持、失敗時は delete して再試行を許す）。ロード失敗時は黒枠プレースホルダのみ表示。`Assets.load` の戻り値は `instanceof Texture` で型 guard。パス解決は vite の `public/` 起点（= `/` 起点）で、サンプル画像として `frontend/public/elder_portrait.png`（80×80 単色 PNG）を同梱。連続 show 時のちらつき抑制（同一 path 維持 + 失敗時のみ visible を落とす）・レイアウト定数集約（`PORTRAIT_SIZE` / `PORTRAIT_MARGIN` / `PORTRAIT_X` / `DIALOG_HEIGHT` 等 export）済み。動的表情切替と NPCEditor UI での portrait 入力フィールドは Phase 2 (#101) スコープ

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
- **ゲームプロジェクト**: 別リポジトリ（例: ogurasia, friday-1930, skirts-colour, gymnasia）
- 永続化は GitHub の各ゲームリポをそのまま使う（D1/R2 を介さない、ADR `0001-hosting-architecture.md` 参照）
- 本番: Worker が GitHub Contents API 経由で読み書き
- dev: `npm run dev -- --local` でローカル作業ツリーを直読みできる（`worker/scripts/local-fs-proxy.mjs`）

## 下流プロジェクトのスモークテスト

name-name の parser / emitter を壊すと下流ゲームが一斉に動かなくなるため、代表プロジェクトの最小 Markdown を `parser/tests/fixtures/` に fixture として取り込み、構造を検証するスモークテストを置く。

| fixture                         | テスト                     | 対象下流                                               | カバー                                                                                                             |
| ------------------------------- | -------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `fixtures/friday1930-sample.md` | `friday1930_smoke_test.rs` | [friday-1930](https://github.com/kako-jun/friday-1930) | ノベル（ダイアログ/ナレーション/背景/BGM/暗転/SE/退場/場面転換）+ RPG（RpgMap/PlayerStart/Npc/view=raycast）の混在 |

**運用ルール:**

- 下流の `script.md` を更新したら、対応する fixture も手動で同期する（ファイルコピー）
- fixture はあくまで「代表的な構造例」。バイト一致を要求する必要はなく、view / RpgMap / NPC の抽出が期待通りかを assert する
- スモークテストで扱うのは **ハッピーパスの構造検証のみ**。parser の異常系（空ファイル、不正値、ミスマッチ等）は `integration_test.rs` で担保する
- 下流ごとに fixture とテストを1セット追加していく（ogurasia 等、将来の通常 RPG 下流も同じ方式で展開する想定）

## 型チェック

`frontend/tsconfig.json` は references 構成（`files: []`）。
ルート直下に `tsc --noEmit` を走らせてもノーチェックになるため、`npm run type-check` は `tsc -b --noEmit` を使う。
CI でも同じコマンドで app + node 両方の tsconfig が検証される。
