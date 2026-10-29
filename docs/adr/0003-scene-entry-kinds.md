# ADR 0003: シーン入場を「進行」「新規開始」「復元」の3種に分け、遅延ロードを1か所で通す

- 起票日: 2026-10-13
- ステータス: Accepted（2026-10-13）
- 関連 Issue: #734, #729, #724, #726, #733, #759, #220
- 置き換える記述: [ADR 0002](./0002-deterministic-state-and-debuggability.md) の §3（`startFrom` は同期の `void` で、シーン探索は呼び出し側の責務とする部分）と、`setConfinedSceneIds` の記述。0002 の該当箇所には、本 ADR への注記を付けた（実装は PR1〜PR5）

## Context（背景）

`NovelRenderer` には、シーンに入る経路がいくつもある。選択肢の確定、`[ジャンプ:]`、`?scene=`、`?debug_scene=`、`?debug_script=`、クイックロードとロードメニュー、fluid 再マウント時の `restoreSnapshot`、動画書き出し、「はじめから」（`restart`）、文書の再供給（`setEvents`）。
TUI 版（`tui/src/playback.rs`）にも、選択肢・`[ジャンプ:]`・自動クイックロード・`--debug-scene` の経路がある。

これらの経路は、横断的な機能を経路ごとにばらばらに実装してきた。横断的な機能とは、遅延ロード（`missingSceneResolver`）、BGM と背景の持ち越し、confinement（在圏）、遷移世代（`transitionGeneration`）、Jump の遷移状態（`jumpState`）、既読、history、自動クイックセーブなどを指す。
「物語の流れの中の遷移（進行）」と「文脈を捨ててある局面から始める（新規開始）」の区別は、API 上で暗黙のままになっている。全経路を機能ごとに洗い出した表は [`architecture.md` の「シーン入場経路の網羅表」](../architecture.md#シーン入場経路の網羅表734) にある。表から読み取れる不整合は次のとおり。

### 表から読み取れる不整合

1. **`startFrom` が遅延ロードを通らない**。未ロードの sceneId に対しては no-op になる。そのため `PlayerScreen` が `?scene=`（#386）と `?debug_scene=`（#726）を呼び出し側で1つずつ事前解決している。[デバッガガイド](../guide/debugger.md)で public API として案内している `startFrom` を直接呼ぶと、サブ MD のシーンでは黙って何もしない
2. **`debug_script` の choice が遅延ロードを待たない（#729）**。`playScript` の choice は `jumpToScene` を呼ぶ。しかし選択肢由来の遷移は `jumpState` を `pending` にしないので、`drainPendingJump()` が即座に false を返し、次のステップが遷移前のシーンで消化される。`[ジャンプ:]` 由来なら `pending` の間ポーリングで待つので、同じ遅延ロードでも由来によって待つかどうかが変わる
3. **`?scene=` と `debug_script` を併用すると confinement が残る（#729 追記）**。choice が別ファイルを指すと、圏外として終劇になる。`debug_scene` は解決できたら confinement を外す（#726、後勝ち）ので、debug 系の経路同士で方針が揃っていない
4. **選択肢確定による遅延ロードの往復中に、遷移中のゲートが無い**。選択肢を閉じたあとも `jumpState` は `idle`、`waitingForChoice` は false のままになる。その間に `advance` すると、Choice を素通りして後続のイベントへ進み、末尾なら終劇する。`quickSave` も通る。spec は「遅延ロード往復中はセーブできない」としているが、実際に守られているのは `[ジャンプ:]` 由来の遷移だけ。復元（クイックロード・ロードメニュー・`restoreSnapshot`）の遅延ロード中も、Jump 予約がなければ `advance` が通る
5. **選択肢の遷移先が見つからないとき、GUI と TUI で挙動が違う**。GUI は警告を出すだけで選択肢は閉じたまま残り、`advance` で Choice の後ろへ進んでしまう。TUI の `select_current_choice` は `false` を返し、選択肢に留まる
6. **選択肢由来の `jumpToScene` は、要求の時点で遷移世代を進めない**。世代が進むのは、解決後の `resetAndStartEvents` に入ったとき。そのため、先行する非同期の入場と同じ世代を捕捉してしまい、後勝ちが崩れる。不整合4のとおり復元の遅延ロード中に選択肢を押せるので、たとえば fluid 再マウント直後の `restoreSnapshot` の遅延ロード中にエントリ冒頭の選択肢を確定すると、両方が同じ世代を捕捉し、先に解決した側が勝つ（ゲートが無いと起きる例）
7. **新規開始のはずの `startFrom`（index 0）が、背景や立ち絵を持ち越す**。`startScene` は `preserveBackgroundForTransition: true` を固定で渡すので、背景・背景板・大道具・幕・紙人形輪郭が持ち越され、立ち絵は遷移用の退場になる。マウント時は直前の `setEvents` がエントリ冒頭をすでに実行している。ハブ背景のテクスチャがまだロード中なら、`bgLoadToken++` で破棄されて画面には描かれない。それでも次のものは漏れる
   - `currentBackgroundPath` などの状態。再マウント時のスナップショット・`getSnapshot`・HUD がハブの背景を指す
   - 対象シーンの `[背景:]` がハブと同じパスのとき、フェードせずに即時表示される
   - ハブの話者の立ち絵の退場演出

   BGM だけは、#724 で独立オプション `carryBgm` に分けたため止まる
8. **初期入場が1回で済んでいない**
   - `setEvents` がエントリ冒頭を自動進行（SE・ボイス・`[待機]` を含む）してから、`startFrom` や `restoreSnapshot` や `playScript` が上書きする
   - `NovelPlayer` の events 変化 effect（`[events, scenes]` 依存）は、マウント時にも1回走る。init effect が `rendererRef` を同期で代入した直後なので、`init()` が解決する前の renderer に対して `setEvents` を呼んでいる（コード上の読み。実機での確認が要る）
   - `?scene=` と `?debug_scene=` を併用すると、`startFrom` が2回呼ばれる
   - `willAutoQuickLoad` は `initialSceneId` しか見ていない。そのため `?debug_scene=` や `?debug_script=` を単独で指定しても自動クイックロードが走り、非同期の復元と `playScript` が競合する
9. **動画書き出しは新規開始なのに、進行用の `jumpToScene` を使っている**。BGM は打ち消し用の `stopBgmForFreshStart()` を前置きして止めている。それ以外の背景等、flags、`consecutiveJumps` はプレビューから持ち越す。confinement 判定も進行の規則で受ける。開始シーンが見つからなくても結果を返さないので、プレビューの内容のまま録画が始まる
10. **`setEvents` と `restart` で、文書の先頭からの新規開始の扱いが食い違う**
    - `restart` は flags をクリアするが、`setEvents` はクリアしない。エディタのライブ再パースでは、旧 flags と旧 `currentSceneId` が残る
    - 両方とも `storyEnded` を戻さない（コード上の読み）。終劇後に再供給しても `advance` が弾かれ続ける
    - `setEvents({ skipAutoAdvance })`・`pendingAutoAdvance`・`resumeAutoAdvanceIfPending()` は、「直後に別の入場で上書きするので先頭の自動進行を止める」ための打ち消し API になっている
    - `PlayerScreen` は `window.__renderer` をダックタイプで読んで `renderer?.restart?.()` を呼ぶ（「はじめから」「つづきから」）。型検査を通らないので、API を変えても検出されない
11. **`consecutiveJumps` のリセットが経路ごとにばらつく**。`applyState`・`setScenes`・`advance` ではリセットするが、`startFrom`（index 0）・`restart`・`setEvents` ではリセットしない（軽微）
12. **`--debug-scene`（TUI）と `?debug_scene=`（GUI）で意味が違う**
    - TUI 版は進行ジャンプ（`jump_to_scene_id`）として動く。自動クイックロードで復元した flags・BGM・同一ファイル内のランニング状態を持ち越したまま、指定シーンへ飛ぶ。GUI 版は新規開始として動く（flags を置換し、BGM を止める）
    - TUI は `--debug-scene` があっても、先に自動クイックロードを実行する
    - TUI はシーンが切り替わるたびに `save_quick` を呼ぶ（`main.rs` のシーン切替検知）。これは `--debug-scene` 中も同じなので、デバッグ起点の進行で通常のセーブが上書きされる。GUI は deep-link・debug 起動時には自動セーブを配線しない（#664）
13. **遅延ロードの後処理を3か所で書いている**。`resolveMissingSceneAndJump`・`loadFromSaveDataMissingScene`・`resolveMissingSceneAndRestore` は、`requestMissingScene` の共有（#733）と世代の捕捉（#759）までは揃っている。しかし、世代の捕捉・`initialized` の判定・失敗時の処理は、それぞれが別々に書いている
14. **fluid 再マウントで debug 起点を再実行する**。デバッグ起点のブロックは、マウント effect（依存は `fluidRemountKey`）の中で無条件に走る。そのため、`?debug_scene=` / `?debug_script=` を付けたまま向きのカテゴリが変わると、`restoreSnapshot` で引き継いだ位置をデバッグ起点が上書きする（コード上の読み）

いずれも、入場の種類が API に現れていないことから生じている。各機能の扱いを経路ごとに決めているので、経路を足すたびに呼び出し側で穴埋めが要る。持ち越す状態が増えるたびに、打ち消し用の API も要る。

### コードで確認した前提

- **マウント後に events が変わる経路**: `/play`（`PlayerScreen`）では、`novelEvents` が `doc` の `useMemo`、`doc` はプロジェクト読み込み effect の中でしか `setDoc` されない。そのため、マウント後に変わるのはプロジェクトを切り替えて全体を読み直すときだけになる。遅延ロードが変えるのは `allScenes`（`jumpSceneIndex`）で、events ではない（#671 で effect を分離済み）。マウント後に events が変わる経路は、エディタ（`EditorScreen` の `novelEvents`）のライブ再パースだけ。これとは別に、マウント時に init 前の renderer へ1回 `setEvents` が走る（不整合8）
- **`?debug_scene=` 単独時にタイトル画面を出すかどうかの正本**: `PlayerScreen` の `hasDebugStart`（`parseDebugQuery(window.location.search) !== null`）。URL に debug 指定が**あるかどうか**だけを見ており、解決できたかどうかは見ない。タイトルを出す条件は `startSceneId === null && !hasDebugStart && !titleDismissed`。したがって、`?debug_scene=` が不在の ID を指していてもタイトルは出ず、エントリから始まる。本 ADR の初期入場（§5）は、この判定と同じパース結果を `NovelPlayer` に渡して使い、URL を2か所で別々に解釈しない

## Decision（決定）

### 1. 入場の種類を3つに固定する

| 種類 | 意味 | 該当する経路 |
|---|---|---|
| **進行**（progress） | 物語の流れの中の遷移。直前の文脈を引き継ぐ | 選択肢の確定、`[ジャンプ:]`、`playScript` の choice |
| **新規開始**（fresh） | 文脈を捨て、ある局面から始める | `?scene=`、`?debug_scene=`（index 指定を含む）、動画書き出し、「はじめから」、文書の(再)供給（`setEvents`/`setScenes`） |
| **復元**（restore） | 保存された完成状態へ宣言的に戻す | クイックロード、ロードメニュー、`restoreSnapshot` |

`goBack`/`seekTo` は入場ではない。history は入場のたびにリセットされるので、この2つは同じシーンの中で `applyState` を使って戻すだけになる。

`debug_scene` の index 指定（途中局面からの起動）は、種類としては**新規開始**に入る。冒頭からのディレクティブ実行ではなく宣言的復元（`restoreToScene`）で組み立てる点は、位置の指定方法の違いにすぎない。文脈を捨てる意味論（flags の置換・持ち越しなし）は、index 0 の場合と同じ。

### 2. 種類ごとに各機能の扱いを決める（あるべき挙動）

| 機能 | 進行 | 新規開始 | 復元 |
|---|---|---|---|
| 遅延ロード | 共通の解決口（下記 §3） | 同左 | 同左 |
| 遷移世代 | 要求の時点で進めて捕捉する（後勝ち） | 同左 | 同左 |
| 遷移中のゲート | 解決を待つ間は入場中ゲート（`pendingEntry`）で、ユーザー入力（advance・goBack・seek・セーブ・ロード・選択肢の確定）を止める | 同左 | 同左（Jump の `jumpState` は #759 どおり据え置く） |
| confinement 判定 | する（圏外は終劇） | しない。解決できたら、適用の前に要求の confinement で**置き換える**（省略時は解除） | しない（設定は変えない） |
| BGM | 持ち越す（#724） | 止める | 状態どおり |
| 背景・背景板・壁・床・舞台前面・天候・大道具・幕・スポットライト・紙人形輪郭 | 持ち越す | クリアする | 状態どおり |
| 立ち絵 | 遷移用の退場（`clearForSceneTransition`） | クリアする | 状態どおり |
| イベント絵・テロップ・暗転・カメラ・SE シーケンス | リセット（現状どおり） | リセット | 状態どおり（演出の中間状態は持たない） |
| flags | 保持 | 適用の前に、要求どおりに置換（省略時は空） | 状態どおりに置換 |
| `storyEnded` | 適用の前に false | 適用の前に false | 状態どおり |
| `consecutiveJumps` | 継続（本文を描画したらリセット） | 0 | 0 |
| Jump の遷移状態 | 遷移先が Jump なら到達時と同じく予約 | 位置から再導出（#733） | 同左 |
| 既読 | 出発元のシーンは、Choice か Jump に到達した時点で既読（現状どおり） | 付けない | 付けない（Jump 位置への復元だけ到達扱い） |
| history | 空から積む | 空から積む（位置を指定したときは `[snapshot]`） | `[snapshot]` |
| `onSceneChange` | 発火する | 発火する（ただし初期入場の分は自動セーブしない。§5） | 発火しない |
| 失敗（遷移先不在・resolver 失敗） | 位置から遷移状態を再導出する。選択肢由来なら選択肢を再表示（TUI と同じ）、Jump 由来なら `stalled`（現状どおり） | 状態を変えない。位置が動かないので、遷移状態を位置から再導出する | 位置・flags とも現状維持する（flags を適用しない。#765）。遷移状態は位置から再導出する |

持ち越しの方針は、`carryPolicyFor(kind)` のような純粋関数として1か所にまとめる。`resetAndStartEvents` が受け取る `preserveBackgroundForTransition`/`carryBgm` のような個別フラグは、この関数から導出する（規律4.5: 持ち越し対象ごとの独立性は保つが、どの種類で何を持ち越すかの決定は1か所に置く）。新しく持ち越す状態を足すときは、方針表に1列足すだけで済み、打ち消し用の API は要らない。

ゲートの判定も、規律4.5 の適用として1つの述語 `isTransitionGated()` にまとめる。この述語は `waitingForChoice`・`waitingForWait`・`jumpState`・`pendingEntry` を合成する。`advance`・`goBack`・`seekTo`・`quickSave`・`quickLoad`・セーブ／ロードメニュー（開いた時と確定時）・選択肢の確定は、この述語だけを見る。状態フィールドは独立のまま持ち、「どの状態のときに何を止めるか」の判断は1か所に置く（`!waitingForWait && isAtJump()` のような組み合わせ判定が各所に散った #731 の再発防止）。

### 3. 内部の単一入口 `enterScene`

公開 API はすべて、private の `enterScene(request)` を通す薄いラッパにする。

```ts
type SceneEntryRequest =
  | { kind: 'progress'; sceneId: string; origin: 'choice' | 'jump' | 'script' }
  | { kind: 'fresh'; target: { sceneId: string } | 'entry'; flags?: Record<string, FlagValue>;
      position?: { eventIndex: number; textIndex?: number; sentenceIndex?: number };
      confinedSceneIds?: string[] | null; autoSave?: boolean }
  // source: 失敗時の警告文言と、復元元に応じた後処理（snapshot は storyEnded の重複発火防止 #460）を分けるため
  | { kind: 'restore'; state: NovelGameState; source: 'save' | 'snapshot' }

type SceneEntryResult =
  | { status: 'entered'; sceneId: string | null }
  | { status: 'ended' }        // 進行のみ: confinement の圏外で終劇した
  | { status: 'failed'; reason: 'not-found' | 'resolver-error' | 'apply-error' | 'out-of-range' }  // out-of-range: 復元位置が範囲外 (#789)。apply-error: 適用中の例外（実装・データの不具合）。一時的な通信失敗（resolver-error）と区別する
  | { status: 'superseded' }   // 待っている間に、より新しい入場要求が来た
```

`pendingEntry` は真偽値ではなく、`{ generation, kind, sceneId, promise }` として持つ。進行中の入場の Promise を誰でも待てるようにするためで、`playScript` はこれを使う（§4）。`[ジャンプ:]` は、`armJump` の時点（`setTimeout(0)` が発火する前）で deferred を作って `pendingEntry` に載せる。こうしておかないと、予約から発火までの間に待つべき Promise が存在しない。

処理の順序:

1. 世代を進めて捕捉し、`pendingEntry` を立てる。新規開始と復元では、予約中の Jump タイマーを止める
2. 進行のときだけ confinement を判定する。圏外なら `endStory()` を呼び、`ended` を返す
3. `SceneIndex.resolve(sceneId)`（#823 で `NovelRenderer.resolveScene` から移した）でシーンを引く。索引（`allScenes`）にあれば**同期のまま**続行する（同期描画のタイミングを変えない。動画書き出しの preRoll と既存テストの前提を守る）。無ければ `SceneIndex.requestMissingScene`（Promise の共有）を await する。await の後は、世代と `initialized` を**この1か所で**判定する。不一致なら `superseded` を返し、成功・失敗とも何もしない（後始末は世代を進めた新しい側が担う）
4. 見つからなければ、§2 の「失敗」列に従って処理し、`failed` を返す。位置が動かないので、遷移状態を位置から再導出する（`rederiveTransitionAtCurrentPosition()`。`rearmPendingJumpAfterFailedRestore` を一般化したもの）。現在位置が Jump なら再予約し、Choice なら選択肢を再表示する。これにより、選択肢由来の進行が遅延ロード中にプログラム発の新規開始や復元に置き換えられ、その新しい側も失敗して位置が変わらなかった場合も、選択肢が閉じたまま残らない
5. **適用の前処理**（解決できた後、描画の前）として、種類ごとの文脈を確定する。新規開始では、flags の置換・confinement の置き換え・`storyEnded = false`・`consecutiveJumps = 0` を行う。進行では `storyEnded = false`。適用の中で `resetAndStartEvents` → `processUntilNextTextEvent` が同期で走り、全 option が圏外の Choice の先回り終劇（#398）が `confinedSceneIds` を読む。`endStory()` の二重発火ガードは `storyEnded` を見る。そのため、この2つは適用より前に確定していなければならない
6. 種類ごとに適用する。進行は `resetAndStartEvents(carryPolicyFor('progress'))`。新規開始は、先頭からなら `resetAndStartEvents(carryPolicyFor('fresh'))`、位置指定なら最小 state で `restoreToScene` する。復元は `restoreToScene(state)`（`storyEnded` は state から入る）
7. 後処理は、`pendingEntry` を下ろすことと、§2 に従って `onSceneChange` を発火することだけにする

予約中の Jump のタイマーを取り消す経路はすべて、`armJump` の時点で作った deferred を `superseded` で解決する。該当するのは、新規開始・復元の手順1、`applyState`、`resetAndStartEvents` の `clearJumpTimer` など。こうしないと、`playScript` が二度と解決しない `pendingEntry.promise` を待ち続けて止まる。取り消しは `clearJumpTimer` の1か所に集め、deferred の解決もそこで行う。

これで、遅延ロードの後処理3本（不整合13）は `SceneIndex.resolve` 1本になる。要求の時点で世代を進め、待つ間はゲートで止めるので、不整合4・6も解消する。

### 4. 公開 API の写像（互換用のバイパスは作らず、呼び出し側を書き換える）

| 現在の API | 新しい契約 | 呼び出し側の書き換え |
|---|---|---|
| `jumpToScene(sceneId): void` | `jumpToScene(sceneId): Promise<SceneEntryResult>`。**進行専用**にする | ChoiceOverlay のコールバック・`armJump`・`playScript` の choice。`VideoExporter` からは呼ばない |
| `startFrom(opts): void` | `startFrom(opts): Promise<SceneEntryResult>`。**新規開始専用**にする。`sceneId` を省略するとエントリ文書の線形ストリームから始める。`confinedSceneIds` を受け取る | `NovelPlayer` の初期入場、`VideoExporter`、`PlayerScreen` の「はじめから」 |
| `restart(): void` | 廃止（PR5 で実施）。`startFrom({})` に置き換える | `PlayerScreen` の `onNewGame`/`onContinue`（セーブなし時）。`window.__renderer` のダックタイプをやめ、`NovelPlayerHandle` の型付きメソッド経由にする |
| `setEvents(events, { skipAutoAdvance })` | `setEvents(events)` は、文書を読み込んでから `startFrom({})` する。開始しない読み込み用に `loadEvents(events)` を新設する | `NovelPlayer` のマウントでは `loadEvents` を使う。events 変化 effect（エディタのライブ再パース）は `setEvents` のまま。ただし初回（マウント時）は実行せず、`rendererReady` の後の変化にだけ反応する |
| `setScenes(scenes, opts)` | 索引と `scenes[0]` を読み込んでから `startFrom({})`。開始しない読み込みとして `loadScenes(scenes)` を新設する | `setEvents` と同じ |
| `pendingAutoAdvance` / `resumeAutoAdvanceIfPending()` | 廃止。開始しない読み込みと明示的な入場に分けたので不要になる | `NovelPlayer` のフォールバック |
| `stopBgmForFreshStart()` | 廃止 | `VideoExporter` |
| `setConfinedSceneIds(ids)` | 廃止。confinement は新規開始の入場属性として、解決できた時点で確定する | `NovelPlayer` が `startFrom({ sceneId, confinedSceneIds })` で渡す |
| `quickLoad(): boolean` | `quickLoad(): Promise<SceneEntryResult \| null>`。null は、データが無いかゲートで弾かれた場合 | F8 は結果を待ってからトーストを出す（遅延ロードが失敗しても「クイックロードしました」と出ていた点も直る）。マウント時の扱いは §5 |
| `restoreSnapshot(snapshot): void` | `restoreSnapshot(snapshot): Promise<SceneEntryResult>` | `NovelPlayer` の fluid 再マウント |
| `playScript(steps)` | choice は `jumpToScene` の結果を await する。`entered` 以外なら警告を出して以降のステップを打ち切る。advance の後は、`pendingEntry.promise` があればそれを待つ（ポーリングの `drainPendingJump` は廃止） | なし |

名前は既存の `jumpToScene`/`startFrom` を残す。2つの名前はすでに「進行」と「新規開始」を表しているので、正すべきは契約のほうになる。`progressTo`/`startFresh` に改名すると、デバッガガイドや外部の利用者の手順が無駄に壊れる。

### 5. 初期入場は1回にし、優先順位を純粋関数で決める

`NovelPlayer` のマウント時に行う入場は、`resolveInitialEntry({ snapshot, debugQuery, initialSceneId, confinedSceneIds, hasQuickSave })` という純粋関数が順序付きの試行リストとして返す（規律4: 判定ロジックは純粋関数に出してテストする）。`debugQuery` は、`PlayerScreen` がタイトル画面の判定（`hasDebugStart`）に使うものと同じパース結果を渡す。

1. fluid 再マウントのスナップショット → `restoreSnapshot`（**debug 起点は再実行しない**。不整合14）
2. `?debug_scene=` → `startFrom({ sceneId, flags, position, confinedSceneIds: null })`。debug は confinement なし（#652）
3. `?scene=` → `startFrom({ sceneId, confinedSceneIds })`。`?debug_script=` を併用する場合は、confinement を `null` にする（不整合3。debug 系は confinement なしという方針に揃える）
4. 自動クイックロード → `quickLoad()`。**debug 指定も `?scene=` も無いときだけ**行う（不整合8）
5. エントリ → `startFrom({})`。4 から倒れてきた場合は `startFrom({ flags: <セーブの flags> })` とし、進行の flags は保って位置だけ失う。ルートの入口（ハブのゲート）がマイルストーンの flags に依存する作品があり、位置を失ったうえ flags まで失うと、進めたルートが閉じてしまうため

`NovelPlayer` は試行を順に実行する。次の試行へ進むのは、結果が `failed` か `null`（`quickLoad` でデータが無い場合）のときだけ。`superseded` を受けたら、より新しい入場がすでに始まっているので、連鎖を打ち切る。

`?debug_script=` がある場合は、上の入場が確定（`entered`）してから `playScript` を実行する。debug_scene が見つからない場合は、2 が `failed` になって 3 へ進む。こうして「解決できなければ `?scene=` の confinement が残る」という #726 の挙動を、`PlayerScreen` の事前解決なしで再現する。

**初期入場は自動セーブしない**。自動セーブ（`setOnSceneChange` → `requestAutoSave`）の配線は、初期入場が確定した後に行う。`onSceneChange` は入場の適用の途中で発火し、シーン冒頭の `[待機: 表示完了]` などでゲートが閉じていると保存が黙って弾かれる。そのため `onSceneChange` では保存を要求する（保留を立てる）だけにし、そのシーンで最初の本文が表示されゲートが開いた時点で renderer が1回保存する（#768。冒頭が Jump だけ・選択肢のシーンは保存されず、遷移先の本文で保存される。保留は次の入場・復元で破棄）。そうしないと、新規開始の `onSceneChange` が、有効なクイックセーブをエントリ冒頭の位置で上書きする（4 から 5 へ倒れた場合が特に問題になる）。さらに、4 の失敗理由が `resolver-error`（通信失敗などの一時的な失敗）だった場合は、そのセッションでは自動セーブを配線せず、トーストでその旨を知らせる。トーストは renderer の `showToast`（PixiJS 描画、#630）で出す。一時的な失敗で正しいセーブを消さないためである。理由が `not-found`（原稿が変わってセーブのシーンが消えた）なら、そのセーブはもう戻れないので、通常どおり配線する。

`PlayerScreen` の事前解決のうち、`?debug_scene=`（#726）の分は不要になる。`?scene=` の分は、confinement の算出（`findConfinedSceneIds` は対象の doc を要する）と、タイトル画面を出すかどうかの判定（`startSceneId`）に必要なので残す。これは「`startFrom` を動かすための穴埋め」ではなく、confinement の算出だけに役割が絞られる。HUD の `debug_scene: … → resolved / not found` は、初期入場の結果を `NovelPlayer` から通知する形で出す。

### 6. TUI 側の対応

TUI はすべての .md をマージして読むので、遅延ロードは無い。`?scene=` に相当するものも無いので、confinement も無い（spec に「GUI 版のみ」と書く）。入場の種類は GUI と揃える。

- 進行: `jump_to_scene_id`（選択肢・`[ジャンプ:]`。現状どおり）
- 新規開始: `Playback::start_fresh_at(scene_id, flags) -> bool` を新設する。flags を引数で受け取って置換し（GUI の `debug_flags` と対称。CLI 側に flags 指定が無いうちは空を渡す）、`scan_state` を初期化して、そのシーンから items を作り直す。`--debug-scene` はこれを使う
- `--debug-scene` を指定したときは、自動クイックロードを行わず（GUI の §5-4 と対称）、シーン切替ごとの自動クイックセーブ（`save_quick`）も行わない（GUI の #664 と対称。不整合12）。クイックロードを省くので、`read_positions`（既読位置）も復元されない。この副作用は spec に明記する
- 復元: `restore_playback`（`set_flags` に続けて `jump_to_scene_id_with_continuation`）。意味としてはすでに復元なので、名前を `Playback::restore_to_scene(scene_id, flags, continuation)` に揃えるのは任意。TUI の復元はシーン先頭単位で、GUI はイベント単位という粒度の差は spec に明記する

### 7. #729 の解消

- choice ステップが `jumpToScene` の Promise を await するので、遅延ロードの完了を待ってから後続のステップへ進む（§4）
- `?scene=` と `debug_script` を併用した場合は confinement を外す（§5-3）
- `debug_script` が指定されていれば自動クイックロードを行わないので、非同期の復元と競合しない（§5-4）

### 8. 個別の決定

- **新規開始では背景等をクリアする**。実データで目に見える影響は、theo-hayami の `main/act1-02.md` の1セルの出だしが即時表示から 700ms のフェードインになることだけで、gymnasia と skirts-colour には影響しない。保険として PR2 で、新規開始の対象シーンが最初のテキストまでに `[背景:]` を持たないとき、DEV ビルドで `console.warn` を出す
- **動画書き出しの flags**: PR4 で `VideoExportOptions.flags` を足す。既定は空（決定論的に録れる）。エディタ側には、プレビュー中の flags を明示的にコピーして渡す選択肢を用意する。実際に使った flags は `onProgress` に出す

## Consequences（影響）

**良くなること**

- 経路を足しても、`kind` を選ぶだけで遅延ロード・世代・ゲート・持ち越しが揃う。呼び出し側で穴埋めや打ち消しをする必要がなくなる（`stopBgmForFreshStart`・`skipAutoAdvance`/`pendingAutoAdvance`・`setConfinedSceneIds`・`PlayerScreen` の debug_scene 事前解決が消える）
- 遅延ロードの後処理・世代の判定・ゲートの判定が、それぞれ1か所になる（規律3「非同期の遷移は世代で守る」と規律4.5 の実装も1か所になる）
- 入場の結果が Promise で返るので、デバッグリプレイと動画書き出しが「入場が確定した後」を待てる

**変わること（目に見える挙動）**

- `?scene=` / `?debug_scene=` で開始したとき、ハブの背景の状態（`currentBackgroundPath`）を持ち込まなくなる。ハブと同じパスの背景も、フェードインで表示される。ハブの話者の退場演出も出なくなる。対象シーンの冒頭に `[背景:]` が無い場合は、背景が地色（`background_color`）になる
- 動画書き出しは、プレビューの背景・flags・立ち絵を持ち込まない。条件分岐（`[条件:]`）は、指定した flags（既定は空）で解決される
- エディタでライブ再パースすると flags が空に戻り、終劇状態も解除される
- 選択肢の遷移先が見つからないと、選択肢が再表示される（TUI と同じ）。遅延ロードの往復中（進行・新規開始・復元のすべて）は、advance・セーブ・ロード・goBack・選択肢の確定を受け付けない
- TUI の `--debug-scene` は、クイックセーブを読まず、書きもしない

**コスト**

- 公開 API の戻り値が Promise に変わるので、`NovelPlayer.test.tsx`・`PlayerScreen.test.tsx` などのモック、`VideoExporter`、`PlayerScreen` を同じ PR で追従させる
- `NovelRenderer` に `enterScene`/`resolveScene` を足すが、遅延ロードの後処理3本と打ち消し用 API を消すので、正味の行数は減る見込み。置き場所は #735（責務単位の分割）の「シーン遷移制御」に合わせる

## 移行計画（PR 分割）

各 PR の共通の完了条件: `npm run type-check`・`npm run lint`・`npm test -- --run`（全テスト。モックの追従も含む）・`cargo fmt --all --check`・`cargo clippy --workspace --all-targets -- -D warnings`・`cargo test --workspace` がすべて緑。遷移の意味論を変える PR では、両ランタイムと `docs/spec/markdown-v0.1.md` の「シーン入場の種類」節（PR1 で新設し、「シーン遷移時の BGM（#724）」節を吸収する）を同じ PR で揃える。

### PR1: 入場の単一入口と進行の契約

- 内容: `enterScene`/`resolveScene`/`pendingEntry`（Promise 付き）/`carryPolicyFor`/`isTransitionGated`/`rederiveTransitionAtCurrentPosition` を導入する。`jumpToScene` を進行専用の Promise 版にする。要求の時点で世代を進める。復元経路（`loadFromSaveData`・`restoreSnapshot`）も `resolveScene` に乗せて、遅延ロードの後処理3本を統合する。進行・復元の遅延ロード中は入場中ゲートで止める。選択肢の遷移失敗時は選択肢を再表示する。不整合4（復元中に `advance` が通る点を含む）・5・6・13 を解消する
- テスト観点
  - 選択肢から未ロードのシーンへの遷移中に、`advance`/`quickSave`/`goBack`/`seekTo`/ロードメニューを弾くこと
  - `restoreSnapshot` の遅延ロード中は、選択肢の確定がゲートで弾かれ、選択肢が表示されたままであること。同じく `advance` も弾くこと
  - 後勝ちは、プログラムから出す2つの要求で検証する。`restoreSnapshot`（遅延ロード）の後に `startFrom`、および解決順を入れ替えた復元→復元。どちらも後から要求した側が適用されること
  - 不在の遷移先で選択肢が再表示され、`advance` で Choice を素通りしないこと。選択肢由来の進行の待機中に、プログラム発の入場で置き換えられ、その入場も失敗した場合に、選択肢が再表示されること
  - `[ジャンプ:]` の予約中に復元や新規開始が来ても、`playScript` が止まらないこと（deferred が `superseded` で解決されること）
  - `[ジャンプ:]`・復元の既存テスト（#725/#733/#759）が緑のままであること
  - `carryPolicyFor` の表と `isTransitionGated` の組み合わせを検証するテスト
- 実ブラウザ確認: scriptsDir 構成のプロジェクトで、ハブから未ロードのサブ MD へ選択肢で遷移する。ネットワークを低速化し、ロード中にクリックを連打したり F5 を押したりしても先へ進まないこと、到着後の BGM と背景が持ち越されていることを確認する。不在 ID の選択肢を含む ad-hoc シナリオで選択肢が再表示されることを確認する

### PR2: 新規開始の契約と初期入場の一本化

- 内容
  - `startFrom` を新規開始専用の Promise 版にする（`target: 'entry'` を含む）。遅延ロード・持ち越しなし・`confinedSceneIds`・`storyEnded`/`consecutiveJumps` のリセットを、§3 の前処理で行う
  - `setConfinedSceneIds` を廃止する
  - 開始しない読み込み `loadEvents`/`loadScenes` を新設し、`skipAutoAdvance`/`pendingAutoAdvance`/`resumeAutoAdvanceIfPending` を廃止する
  - `quickLoad` を Promise 版にする
  - 純粋関数 `resolveInitialEntry` を作り、`NovelPlayer` の初期入場を1回にする。試行の打ち切り規則、`quickLoad` が失敗したときに `startFrom({ flags })` へ倒す処理、自動セーブの配線を初期入場の確定後にする処理（`resolver-error` のときは配線しない）を含める
  - events 変化 effect は、初回（マウント時）は実行せず、`rendererReady` の後の変化にだけ反応するようにする
  - `PlayerScreen` の debug_scene 事前解決を撤去し、HUD は結果の通知で出す
  - DEV ビルドで、新規開始の対象シーンが最初のテキストまでに `[背景:]` を持たないとき警告を出す
  - `docs/guide/debugger.md` の `startFrom` 節を新しい契約に書き換え、#734 の注記（現状の制限）を削除する
  - 不整合1・7・8・14 を解消する（debug_script の部分は PR3）
- テスト観点
  - `startFrom` が未ロードのシーンを解決して入場すること。不在なら状態が一切変わらないこと
  - confinement が成功時にだけ置き換わり、適用の前に確定していること。対象シーンの冒頭が全 option 圏外の Choice のとき、その場で終劇すること（#398）
  - 終劇中に新規開始すると、`endStory` が二重発火ガードで潰れずに解除されること
  - 新規開始で背景・背景板・大道具・幕・紙人形・立ち絵がクリアされ、`currentBackgroundPath` もハブを指さないこと
  - `resolveInitialEntry` の決定表（スナップショット / debug_scene / ?scene= / 併用 / クイックセーブの有無 / どれも無い）と、打ち切り規則（`superseded` で止まり、`failed`/`null` で次へ進む）
  - fluid 再マウントで debug 起点を再実行しないこと
  - マウント時の `quickLoad` が失敗したら、セーブの flags を保ってエントリから始まること。そのとき自動セーブで既存のクイックセーブが上書きされないこと（`resolver-error` と `not-found` の両方）
  - マウント時に `setEvents` が1回も呼ばれないこと（`loadEvents` だけが呼ばれること）
- 実ブラウザ確認
  - `?scene=<サブ MD のシーン>` で入場が1回であること（コンソールとネットワークで確認）。再マウント後のスナップショットと HUD がハブの背景を指さないこと
  - theo-hayami の `main/act1-02.md` のセルが、フェードインで始まること
  - `?scene=` と `?debug_scene=<不在>` を併用すると、`?scene=` の confinement が保たれること
  - `?debug_scene=<サブ MD>` 単独で、事前解決なしに入場できること
  - `aspect_ratio: auto` の作品で、`?debug_scene=` を付けたまま向きを変えても位置を保つこと
  - F8 で、遅延ロードが失敗したときに成功トーストが出ないこと
  - resolver を失敗させた状態でリロードし、元のクイックセーブがエントリ冒頭で上書きされないこと

### PR3: debug 起点（#729）を GUI/TUI で揃える

- 内容
  - `playScript` の choice で入場結果を await し、失敗したら打ち切る。advance の後は `pendingEntry.promise` を待つ（`armJump` の時点で deferred を作る）
  - `?debug_script=` を指定したら自動クイックロードを行わず、`?scene=` を併用したら confinement を外す
  - TUI に `start_fresh_at(scene_id, flags)` を追加し、`--debug-scene` を新規開始にする。`--debug-scene` 指定時は、自動クイックロードとシーン切替ごとの自動クイックセーブを行わない
  - spec（`read_positions` が復元されない副作用を含む）とデバッガガイドを更新する
  - 不整合2・3・12 を解消し、#729 を close する
- テスト観点
  - scriptsDir 構成で、`choice:<未ロードのサブ MD>` の後の `advance` が遷移先のシーンで消化されること（resolver の解決を遅延させたモックで確認する）
  - `advance` が `[ジャンプ:]` に到達した直後（タイマー発火前）の次ステップが、遷移完了を待つこと
  - `?scene=` と `debug_script` の choice で別ファイルへ移っても終劇しないこと
  - TUI では、クイックセーブがある状態で `--debug-scene` を指定しても、flags と BGM が持ち越されないこと。シーンを切り替えてもクイックセーブファイルが変わらないこと（`main()` レベルの統合テスト）
- 実ブラウザ確認: 実際の URL で `?debug_script=choice:<サブ MD のシーン>,advance,advance` を開き、遷移先の2行目に着くこと。`?scene=…&debug_script=…` で終劇しないこと。TUI で `--debug-scene` を実際に起動し、BGM が鳴っていないこと（指定シーンに `[BGM:]` があれば、それだけが鳴ること）、終了後にクイックセーブの日時が変わっていないこと

### PR4: 動画書き出しを新規開始へ移す

- 内容: `VideoExporter` は `stopBgmForFreshStart()` と `jumpToScene` をやめ、`await renderer.startFrom({ sceneId: startSceneId, flags })` を使う。`entered` 以外なら録画を始めずに reject する。`VideoExportOptions.flags` を足し（既定は空。エディタにはプレビューの flags をコピーする選択肢を置く）、使った flags を `onProgress` に出す。新規開始では背景が地色からフェードインし、未キャッシュの背景は preRoll（50ms）では間に合わない。そのため、録画を始める前に開始シーンの背景のロード完了を待つ。`stopBgmForFreshStart` を削除する。architecture.md の「VideoExporter が依存する公開 API」を更新する。不整合9 を解消する
- テスト観点: 書き出しの開始時に、BGM・背景・プレビューの flags を持ち込まないこと。`flags` 指定が `[条件:]` の解決に効くこと。開始シーンが無いときに reject すること。`startSceneId === endSceneId` での終端検知（`onSceneChange` の発火）が保たれること。背景のロードが終わるまで録画が始まらないこと
- 実ブラウザ確認: エディタで、プレビューを別のシーン（別の背景と BGM）まで進めてから書き出す。webm を再生して確認する。先頭にプレビューの背景や曲が入らないこと。先頭フレームが地色から開始シーンの背景へフェードインしていて、背景が欠けた区間が無いこと。キャッシュを消した状態でも確認する

### PR5: 文書の(再)供給と「はじめから」を新規開始へ揃える

- 内容: `restart` を廃止して `startFrom({})` へ置き換える。`PlayerScreen` の `window.__renderer` のダックタイプ（`renderer?.restart?.()` など）をやめ、`NovelPlayerHandle` 経由の型付きの `startFrom({})` 呼び出しにする。`setEvents`/`setScenes` を「読み込み＋`startFrom({})`」にする（flags のクリアと `storyEnded` の解除が揃う）。不整合10・11 を解消する
- テスト観点: 終劇後に `setEvents` すると入力可能に戻ること。ライブ再パースで flags が空になること。「はじめから」「つづきから（クイックセーブなし）」の既存テスト（#637/#662）が緑であること。`PlayerScreen.test.tsx` の `__renderer` モックを、`NovelPlayerHandle` のモックへ追従させること
- 実ブラウザ確認: エディタで終劇まで進めてから原稿を編集し、プレビューが先頭から操作できること。タイトルの「はじめから」で直前のルートの内容が出ないこと（#662 の回帰確認）。「つづきから」がクイックセーブの有無の両方で正しい位置から始まること

PR1 は他の PR の前提になる。PR2 は PR1 の後、PR3・PR4・PR5 は PR2 の後で、互いに独立している。

## PR1 実装時の差分（2026-10-13）

PR1 の実装で、上の記述から次のとおり変えた。挙動の方針は変えていない。

- **`SceneEntryRequest` から fresh を外した。** `startFrom` が入口に移る PR2 で足す。`carryPolicyFor` の表には fresh 行を含めてある
- **`ProgressOrigin` は `'choice' | 'jump'` の2値にした。** `playScript` の choice は選択肢と挙動が同じで、`'script'` を区別する理由が無かった。`playScript` は `jumpToScene` を呼ぶ
- **restore の `origin` を判別共用体にした。** `{ source: 'save'; origin: LoadOrigin } | { source: 'snapshot' }`。成功トーストの出し分けを、同期の成功時も同期で出すため入口の中で行う
- **`isTransitionGated(op, state)` は操作名を引数に取る。** 述語は1つのまま、操作ごとの規則を表で持つ。既存の規則（停止中の Jump で `goBack`・シーク・クイックロードを通す、メニューは選択肢の表示中・待機中も開ける、など）を保つため。操作は `advance`・`quickSave`・`saveMenu`・`navigate`（`goBack`・`seekTo`・`quickLoad`）・`autoAdvance`（オート送り・スキップのタイマー）・`loadMenu`・`confirmChoice`。理由を返す `gateReason()` も同じ表を使う
- **`playScript` の `pendingEntry` 待機を PR1 に前倒しした。** 予約中の `[ジャンプ:]` の deferred を `superseded` で解決するテスト観点の土台のため。ポーリングの `drainPendingJump` は PR1 で廃止した。choice の結果を見た打ち切りは PR3 のまま
- **`SceneEntryResult` の `failed` に `reason: 'apply-error'` を足した。** 適用中の例外は、§5 の「`resolver-error` なら自動セーブを配線しない」の判定キーと混ざらないよう区別する。選択肢由来なら閉じていた選択肢を再表示し、Jump 由来なら停止する
- **ゲートで弾かれた選択肢の確定は、確定音を鳴らさない。** `ChoiceOverlay` の確定コールバックが `false` を返すと音を出さない
- **遷移先が確実に無い（解決手段も無い）選択肢は、閉じずにその場に留める。** 遅延ロードの失敗後は、閉じていた選択肢を `rederiveTransitionAtCurrentPosition` が再表示する
- **入場を待つ間に弾かれたオート送り・スキップは、失敗後に再開する。** `[待機]` が明けても入場の決着を待ってから進める（待機明けの `armJump` が世代を進めてロードを破棄するのを防ぐ）

## PR2 実装時の差分（2026-10-13）

PR2 の実装で、上の記述から次のとおり変えた。挙動の方針は変えていない。

- **入場 API の例外の扱いを統一した。** PR1 の非対称（同期で入場すると例外が呼び出し元へ伝播する）をやめ、全ての入場 API で適用中の例外を `failed`（`apply-error`）の結果にした
- **`SceneEntryRequest` の fresh から `autoSave` を外した。** 自動セーブの配線は `NovelPlayer` が初期入場の確定後に行う（§5）ので、入場の要求に持たせる理由が無かった
- **target `'entry'` の `currentSceneId`。** `loadScenes` は `scenes[0].id`、`loadEvents` は null（従来のマウント結果を保つ）。`restart()` は `allScenes[0]` を使うので、この食い違いは PR5（`restart` 廃止）で揃える
- **`setEvents` / `setScenes` は「読み込み＋エントリ冒頭の実行」のまま。** `skipAutoAdvance` オプションだけを廃止した。`startFrom({})` への置き換え（flags のクリアと `storyEnded` の解除）は PR5
- **スナップショットの復元が失敗したら、スナップショットの flags を保ってエントリへ倒す。** §5 の「`quickLoad` が失敗したら flags を保つ」と同じ扱い。この場合は debug 起点・自動クイックロードを挟まない（引き継いだ位置を上書きしない）
- **`?debug_script=` と `?scene=` の併用時に confinement を外す処理は PR3 に残した。** 自動クイックロードを行わない条件には `?debug_script=` を含めた（`debug も ?scene= も無いとき` の「debug」に script を含む。不整合8）
- **`quickLoad` の失敗時の flags 取得のため、`getQuickSaveFlags()` を足した。** 読むだけで状態を変えない
- **適用中の例外（`apply-error`）で倒れた場合は、自動セーブを配線する。** 配線しないのは `resolver-error` だけ（§5 のとおり）
- **位置指定の新規開始も `onSceneChange` を発火する。** 従来の index 指定の `startFrom` は発火しなかったが、§2 の「新規開始は発火する」に揃えた（初期入場は自動セーブ未配線なので影響しない）
- **初期入場の結果を待たずに `rendererReady` を立てる。** 遅延ロードの往復が長いとタイトル画面の表示が遅れるのを避ける。遅延ロード中は入場中ゲートが入力を止める。`?debug_script=` の `playScript` は入場の確定後に実行する
- **HUD の通知は `NovelPlayer` の `onInitialEntry` prop。** `PlayerScreen` が `debug_scene: … → resolved / not found (…)` の行を足す
- **DEV 警告は、冒頭に `[条件:]` を持つシーンでは出さない。** 条件の中に `[背景:]` があるかもしれず、断定できないため（警告が出ないだけで安全側）。テキストの無い原稿でも出さない
- **既存テストの `setConfinedSceneIds` は、テスト専用ヘルパー `confineForTest`（`src/test/confinement.ts`）に置き換えた。** 「開始位置を変えずに一覧だけを仕込む」テスト用で、公開の setter は無い。入場属性としての確定は `startFrom` 経由のテストで検証する

## PR3 実装時の差分（2026-10-14）

PR3 の実装で、上の記述から次のとおり変えた。挙動の方針は変えていない。

- **`--debug-scene` + `--new-game` は、セーブ削除を行う。** `--new-game` は明示指示なので、`--debug-scene` を指定していても従来どおりクイックセーブを削除する。自動クイックセーブも止まるので、この組み合わせで起動すると、起動後はクイックセーブが1つも残らない
- **自動クイックセーブの停止は、`autosave: bool` で明示的に渡す。** TUI の `run` / `run_screens` / `event_loop` に `StartupEntry { playback_restored, autosave }` を渡し、`--debug-scene` では `autosave = false`、`playback_restored = false`（`read_positions` も復元しない）にする。`config.quicksave_path` は保存先の意味だけを持ち、`None` にして停止を兼ねることはしない。GUI の `InitialEntryOutcome.autoSave` と対称
- **起動時の入場を `apply_startup_entry(cli, config, playback) -> StartupEntry` に切り出した。** `main()` は生ターミナルを扱って直接呼べないため、`main()` レベルの統合テスト（クイックセーブがある状態で `--debug-scene` を指定しても、flags・BGM が持ち越されず、シーンを切り替えてもセーブファイルの内容と更新日時が変わらない）をここで行う
- **`--debug-scene` の ID が存在しないときは、`start_fresh_at` が何も変えず `false` を返し、alternate screen に入る前に stderr へ警告を出してエントリから始める**
- **`playScript` の choice は、打ち切るとき `console.warn` で通知する。** `[ジャンプ:]` の遅延ロード失敗では `playScript` を打ち切らない（Jump はその位置で停止し、以降の `advance` が無視される。打ち切りの対象は ADR どおり choice だけ）
- **`advance` 側の待機（`awaitPendingEntry`）は PR1 の時点で入っていたため、PR3 では変更していない**

## 判断を保留している点

- confinement 中の復元: `?scene=` で埋め込んでいるときに F8 を押すと、圏外シーンのセーブも復元できる。本件では扱わない（記録のみ）

## #789 での追記（2026-10-14）

- **復元位置が範囲外なら復元失敗にする。** 文書の編集後は、セーブの `eventIndex` / `textIndex` が解決したイベント列の外を指しうる。全ての復元経路（`restore` の通常シーン・sceneId が null のエントリ・`fresh` の位置指定）で、適用の前に範囲を判定し、範囲外は `failed`（`out-of-range`）にする。位置・flags とも変えず、クランプはしない。通知は §2 の「失敗」列のとおり（ロード系はトースト、`restoreSnapshot` は警告ログのみ）
- **判定する長さは、復元する flags で `[条件:]` を展開した後の列。** `eventIndex` は展開後の列を指す（`restoreToScene` が展開してから `applyState` が当てる）ため。終端（イベント数と等しい値）は終劇かどうかに関わらず有効（`textIndex` は 0 のみ）。最後の本文の後ろに命令だけが続くと、進めたときに命令を消化して終端で止まり（終劇ではなくクリック待ち）、その位置はセーブできるため。展開後の長さが 0 のシーンも同じ
- **`out-of-range` を `not-found` と別の理由にした。** どちらも再試行しても直らず、初期入場の自動セーブは配線する（§5 のとおり配線しないのは `resolver-error` だけ）ので挙動は同じだが、原因（シーンが無い／位置が無い）を診断で区別できるようにするため
- **`textIndex` の上限はレイアウト非依存の場合だけ見る。** テキスト以外のイベントは 0 のみ、adv の本文は行数未満。ノベルの改頁数は表示幅で変わり、fluid 再マウントの復元は最終ページへ寄せる設計（#663）なので上限を見ない
- **ライブ切り替えで textIndex を範囲内に戻す。** `setDialogStyle` / `setSentencePerPage` はページ構成を変えるので、`textIndex` が現在のページ数以上なら最終ページへ寄せ `sentenceIndex` を 0 にする（#663 の寄せと同じ）。寄せないと範囲外のスナップショットが次の再マウントで復元失敗になる
- **範囲内で脚本が変わったこと（ハッシュ等による検知）は扱わない。**

## #777 での追記（2026-10-14）

動画書き出しの範囲指定（開始 a・終了 c）が、線形に連結したシーンで a の末尾で終わっていた。エントリ文書は「シーンの間に `SceneTransition` を挟んで flatten した線形ストリーム」で再生するのに、新規開始が対象シーンの events だけをストリームにしていたため。

- **線形ストリームを流す新規開始は、動画書き出しが明示的に選ぶオプション（`startFrom({ linear: true })`、既定 false。#817）。** 対象がエントリの線形ストリーム上のシーンなら、最後のシーンも含めてストリーム全体をそのシーン先頭から流す。`startScene(X, X.events)` ではなく、エントリの元イベント列を展開後のシーン先頭位置（`startIndex`）から開始する。文脈を捨てる契約（§2: BGM・背景・立ち絵を持ち越さない、flags の置換、confinement の置き換え）は変えない。シーン冒頭の演出は先頭からの開始と同じく最初の本文まで実行する。`linear` を渡さない新規開始（`?scene=`・`?debug_scene=`・`startFrom({ sceneId })` の既定）は、#777 より前と同じく指定シーンの events だけを流して末尾で終劇する。`linear: true` でも従来どおりなのは、エントリ文書の外のシーン、`position` 付きの新規開始（シーン内の位置の意味）、エントリ自身が対象の場合（`sceneId` を省略した `'entry'`）だけ。開始位置は新規開始の flags で `[条件:]` を展開して求める。当初（#777）は `linear` を持たず常に流していたため、エントリ内のシーンを指す `?scene=` 埋め込みが指定シーンの末尾で終劇せず `story-ended` が親ページに届かなくなった。それを #817 で是正した
- **シーン境界の `SceneTransition` を通過したら `onSceneChange` を発火する。** 作者の `[場面転換]` も同じ文字列イベントなので、種別では区別できない。エントリの元イベント列の先頭に照合できるシーンを `allScenes` から見つけ、以降は `allScenes` 上の次のシーンを順に、同一オブジェクト参照で照合して区間に分解する（`findLinearSegments`。エントリ文書のシーンは `allScenes` 上で連続・文書順。先頭の候補が複数あれば一番長く続く連鎖を採る。events が空のシーンは長さ0の区間）。現在の flags で展開した境界の位置（`[条件:]` で長さが変わる）と一致するものだけを境界とする。パーサ・型は変えない。通知は本編ストリームの処理（`processUntilNextTextEvent`）だけで行い、intermission のタブローの `SceneTransition` では通知しない
- **`currentSceneId`（ストリームの持ち主）は変えない。** セーブ・既読・履歴はストリームの持ち主と eventIndex の組で意味を持つ。線形ストリーム再生中の持ち主はエントリのままなので、セーブは従来どおり sceneId = エントリ（`loadEvents` なら null）+ eventIndex で、`restoreEntryStream` が復元できる。「いま再生位置があるシーン」は `getPlayheadSceneId()` が eventIndex から導出し（派生値として持たない）、`getCurrentSceneId()` はストリームの持ち主のまま。セーブ一覧のタイトル・クイックセーブのタイトル・`getDebugState().sceneId` は再生位置のシーンを使う（セーブデータの `sceneId` は持ち主のまま）
- **`?scene=` / `?debug_scene=` は挙動を変えない（`linear` を渡さない）。** エントリ内のシーンを指すときも、他のファイルのシーンを指すときも、指定シーンの末尾で終劇する（`story-ended` が親ページに届く）。閉じ込め外のシーン境界に入ったら `endStory` で終劇にする処理（線形ストリーム再生中の防御）は、`linear: true` の新規開始でも効くよう残す
- **（#799 で置き換え）Flag による再展開は廃止した。** 当初（#777）は、Flag を実行するたびに全体を現在の flags で展開し直して eventIndex を決定的に写像していた（`remapEventIndexAfterReResolve` / `countSurvivingBefore`）。セーブが eventIndex と最新の flags だけを持つので、再展開を flags の関数に保つ必要があったため。その結果、自己否定ブロック（`[条件: x]` の中で `x` を偽にする）の残りが GUI 版でだけ消えていた。#799 で `[条件:]` を入場時に1回だけ評価して列を固定する方式に置き換え、この箇条書きの挙動（再展開・写像・自己否定ブロックの残りが消える）は無くなった。経緯と現行の規則は下の「#799 での追記」を参照
- **既読は再生位置のシーンに付ける。** `markCurrentSceneRead` は `getPlayheadSceneId()` を使い、線形のシーン境界を越えるとき抜けたシーンにも既読を付ける（選択肢・Jump に到達しない通常再生で従来欠けていた既読も付く）
- **autosave への影響。** `onSceneChange` は自動セーブの配線にも使われるので、線形ストリームのシーン境界でもシーン入場の自動セーブが1回走る（§5 の「新しいシーンの最初の本文で1回保存」と同じ扱い）
- **シーク操作との関係。** `goBack` で境界を戻ってから進むと、通知は再び発火する（入り直したため）。SeekBar・`seekTo` で境界を越えても通知は発火しない（位置の移動であって、物語の進行ではない）
- **ジャンプ・選択肢で入ったシーンは、そのシーンの events だけが流れる（従来どおり）。** その先で文書上は線形に続くシーンへは進まない。範囲指定がジャンプ先から線形で続く場合は未対応
- **TUI との差。** TUI の `start_fresh_at` はファイル内を線形に進み、ジャンプの後も先へ進み、シーン境界ごとに自動セーブする。GUI はエントリ文書の線形ストリーム上だけで、ジャンプ先はそのシーンで終わる。差は [spec](../spec/markdown-v0.1.md) の「新規開始（`startFrom`）」に明記した

## 関連

- [`architecture.md` のシーン入場経路の網羅表](../architecture.md#シーン入場経路の網羅表734)
- [ADR 0002: 決定論的状態管理とデバッグ可能性](./0002-deterministic-state-and-debuggability.md)（§3 の `startFrom` の契約を本 ADR が置き換える）
- [`docs/spec/markdown-v0.1.md`](../spec/markdown-v0.1.md) の「シーン遷移時の BGM（#724）」「ジャンプ（#725）」

## #734 PR5 実装時の差分（2026-10-14）

PR5 の実装で、上の記述から次のとおり変えた。挙動の方針は変えていない。不整合10・11 は解消した。

- **`NovelPlayerHandle` に公開したもの。** `ensureAudioContext()`・`setDocKey(docKey)`・`hasQuickSave()`・`clearQuickSave()`・`startFrom(opts?)`。`PlayerScreen` の「はじめから」「つづきから」は、`window.__renderer` のダックタイプをやめてこのハンドルを呼ぶ。ハンドルは renderer の薄い写しで、分岐（`hasQuickSave()` の真偽で `startFrom({})` を呼ぶか）は `PlayerScreen` に残した。renderer が未生成のときは no-op、`hasQuickSave()` は偽、`startFrom` は `failed`（`not-found`）を返す。`window.__renderer` への代入はデバッグ用に残したが、本番のロジックは読まない。`audioManager` は private なので、`NovelRenderer.ensureAudioContext()` を公開メソッドとして足した
- **`restart()` を廃止した。** `startFrom({})` に置き換えた。バイパス・ラッパーは残していない。`entryRawEvents` が空（エントリ文書が未読み込み）のときの早期 return は無くなった。新規開始は空の文書も新規開始する（flags をクリアし `currentSceneId` は null になる）
- **`setEvents(events)` / `setScenes(scenes)` は `Promise<SceneEntryResult>` を返す。** 「`loadEvents` / `loadScenes` + `startFrom({})`」で、エントリの新規開始は同期で適用される（Promise は既に `entered` で解決済み）。呼び出し元（`NovelPlayer` の events 変化 effect）は結果を待たない。`setScenes([])` は `setEvents([])` と同じく空の文書として新規開始し（`loadScenes([])` が `entryRawEvents` / `entrySceneId` を空にする）、`entered` を返す。旧文書がエントリに残り、次の `startFrom({})` で再生されるのを避けるため
- **target `'entry'` の `currentSceneId` が揃った。** `loadScenes` / `setScenes` は `scenes[0].id`、`loadEvents` / `setEvents` は null。`setEvents` が旧 `currentSceneId` を残さなくなった
- **`onSceneChange` は scenes 経路（`loadScenes` / `setScenes`）の新規開始でだけ発火する。** `loadEvents` 経路（`PlayerScreen` の `events` + `jumpSceneIndex`）は `entrySceneId` が null で、線形ストリームは発火 ID を持たないので発火しない。したがって `PlayerScreen` の「はじめから」の直後には自動セーブは走らず、最初のシーン境界・ジャンプで走る。旧 `restart()` が発火しなかった点は、この経路では変わらない。`PlayerScreen` は引き続き `startFrom({})` の前に `clearQuickSave()` を呼ぶ（自動セーブが走るまでの間にリロードされても旧セーブが復活しないようにするため）
- **DEV 警告（背景なしの開始シーン）は target `'entry'` では出さない。** `setScenes` が `scenes[0].id` を持って新規開始するようになったため。エディタのライブ再パースで毎回出てしまう
- **`consecutiveJumps`** は新規開始（`startFrom` の全経路、`setEvents`、`setScenes`）でリセットする（不整合11）

## #823 での追記（2026-10-15、#735 2/8）

シーンの索引・エントリ文書・遅延ロードの共有 Promise・線形区間のキャッシュを、`NovelRenderer` から `frontend/src/game/SceneIndex.ts` に分けた。挙動は変えていない。

- **置き場の変更。** `resolveScene` / `requestMissingScene` / `indexLoaded` / `isDefinitelyUnresolvable` は `SceneIndex` のメソッド（`resolve` / `requestMissingScene` / `indexLoaded` / `isDefinitelyUnresolvable`）になった。フィールドは `allScenes` / `missingSceneResolver` / `pendingMissingScenes` / `entryRawEvents` / `entrySceneId` / `linearSegmentsCache`。`enterScene` は `this.sceneIndex.resolve(sceneId)` を呼ぶ。手順 3 の契約（読み込み済みなら同期・未ロードなら共有 Promise・await 後の世代と `initialized` の判定は呼び出し側の1か所）は不変で、`SceneIndex` は世代も `initialized` も知らない。
- **同期の契約。** `SceneIndex.resolve` は索引にあれば `SceneLookup` を同期で返し、無いときだけ Promise を返す。遅延ロードで取れたシーン群は、世代の判定を通った後に呼び出し側が `indexLoaded` で索引へ反映する（破棄された入場は何も書き換えない）。
- **再生中の配列は持たない。** `SceneIndex` は `rawEvents`（再生中の元イベント配列）を持たない。`entryRawEvents`（エントリ文書本来の events, #662）との兼務を避けるためで、再生中かどうかが要る判定（`isEntryStreamActive` / `resolveLinearSegmentsNow`）は、呼び出し側が `currentSceneId` と `rawEvents` を引数で渡す。
- **`loadEvents` / `loadScenes` / `setJumpSceneIndex`** はレンダラに残り、索引部だけを `SceneIndex`（`setEntry(events, sceneId)` / `setJumpSceneIndex`。エントリ文書と新規開始の sceneId は一緒に入れ替える）へ委譲する。`currentSceneId` と `onSceneChange` に触れる処理はレンダラ側に残り、#734 PR5 の記述（`loadScenes` は `scenes[0].id`、`loadEvents` は null）のとおり。
- 以後の #826（#735 5/8, `SceneEntryController`）は `SceneIndex` をコンストラクタ注入で使う。

## #824 での追記（2026-10-15、#735 3/8）

再生カーソルとイベント配列・履歴を、`NovelRenderer` から `frontend/src/game/PlaybackCursor.ts` に分けた。挙動は変えていない。

- **書き手の一本化。** `rawEvents` / `resolvedEvents` / `displayEventCount` / `eventIndex` / `textIndex` / `sentenceIndex` / `novelPagesCache` / `advSentencePagesCache` / `history` / `currentSceneId` / `playbackStarted` への書き込みは `PlaybackCursor` のメソッドだけになった。レンダラは getter で読むだけで、setter は無い。`advance` / `goBack` / `seekTo` / `pushSnapshot` / `resetAndStartEvents` / `restoreToScene` / `applyState` / `reResolveEvents` / `loadEntry` / `startScene` の「カーソルを書く行」はメソッド呼び出しに置き換わり、それ以外の処理（演出・タイマー・描画・ゲート）はレンダラに残る。
- **不変条件の保持（#777 追記の再掲）。** 展開後の列は履歴に依存しない。3点セット（`rawEvents` / `resolvedEvents` / `displayEventCount`）は内部の `expand` 1か所でしか更新されない。（#799 で、入口は `replaceEvents` / `load` の2つになり、`restorePosition` と `reResolve` は再展開しない。下の「#799 での追記」を参照。）
- **範囲外復元の拒否（#789）。** 範囲外の判定は入場側（`checkRestorePosition`）の責務のまま。カーソルは受け取った位置を `restorePosition` でそのまま置き、ページ数超過だけを `clampToPageCount` で最終ページへ寄せる。（`reResolve` と `remapEventIndexAfterReResolve` は #799 で廃止した。）
- **`currentSceneId` / `onSceneChange`。** `currentSceneId` の書き込みは `setCurrentSceneId`（`startScene` と `restoreToScene` のみ）。`onSceneChange` の発火箇所と順序は変えていない。
- 以後の #826（#735 5/8, `SceneEntryController`）は、カーソルの書き込みをメソッド越しにだけ行う。

## #825 での追記（2026-10-15、#735 4/8）

遷移ゲートと Jump 予約の状態機械を、`NovelRenderer` から `frontend/src/game/TransitionState.ts` に分けた。挙動は変えていない。本文中の `armJump` / `clearJumpTimer` / `advanceGeneration` / `awaitPendingEntry` / `isTransitionGated` / `gateState` は、次のとおり `TransitionState` のメソッドへ移った（読み替え表）。

| 旧（レンダラの private） | 新 |
| --- | --- |
| `armJump(target)` | レンダラに薄いラッパー `armJump` が残り、状態の遷移は `transition.arm(target, handlers)`。発火時の入場の実行と警告だけをハンドラで渡す |
| `clearJumpTimer()` | `transition.clear()`（deferred を `superseded` で解決する**唯一の口**） |
| `stallJump()` | `transition.stall()`（`pending` → `stalled`。遷移したときだけスキップ解除のフック `onStall` を呼ぶ）。レンダラに薄いラッパーが残る |
| `advanceGeneration()` | `transition.advanceGeneration()`（`pendingEntry` を下ろす） |
| `awaitPendingEntry()` | `transition.awaitPending()` |
| `isTransitionGated(op)` / `gateState()` | `transition.isGated(op)` / `transition.gateReason(op)` / `transition.gateState()`（規則本体は従来どおり `sceneEntry.ts` の純粋関数） |
| `waitingFor* = …` / `jumpState = …` / `justSelectedChoice` / `suppressNextAdvance` / `consecutiveJumps` の直書き | `enterChoiceWait` / `leaveChoiceWait` / `enterWait` / `leaveWait` / `markChoiceJustSelected` / `consumeJustSelectedChoice` / `suppressNextAdvance` / `consumeSuppressNextAdvance` / `noteChainHop` / `resetChain` など |

- **書き手の一本化。** `waitingForChoice` / `waitingForWait` / `justSelectedChoice` / `suppressNextAdvance` / `jumpState` / `jumpTimer` / `jumpDeferred` / `consecutiveJumps` / `pendingEntry` / `transitionGeneration` への書き込みは `TransitionState` のメソッドだけになった。レンダラは getter で読むだけで、setter は無い。
- **重複ブロックの集約。** `waitingFor*=false; jumpState='idle'; advanceGeneration(); clearJumpTimer()` の重複は `resetForNewPosition()`（`resetAndStartEvents`）と `resetJumpForRestore()`（`applyState`。選択肢・待機のフラグは触らない）に分けた。`restoreToScene` の選択肢・待機・入力抑制のリセットは、それぞれ `leaveChoiceWait` / `leaveWait` / `clearJustSelectedChoice`。
- **契約の保持。** ADR 本文の契約はすべて `TransitionState` の不変条件になった: 予約中の Jump の取り消しは `clear()` を通り deferred を `superseded` で解決する／`arm()` は予約時点（タイマー発火前）に `pendingEntry` を立てる／`advanceGeneration()` は `pendingEntry` を下ろす／`JUMP_CHAIN_LIMIT`（100）超過で `stalled`。復元後の位置が Jump なら再予約する（#733）規則と、停止状態を復元をまたいで持ち越さない規則（#758）は、レンダラの `applyState` が `resetJumpForRestore()` のあとで `rearmJumpAtCurrentPosition()` を呼ぶ形のまま。
- **依存。** `TransitionState` は DOM / Pixi / レンダラ / シーン内容を知らず、`NovelRenderer` を import しない。タイマーはコンストラクタで注入した `TimeController` を使う。`JUMP_CHAIN_LIMIT` は `TransitionState.ts` の export になった。
- **テスト。** private への直接アクセスは `src/test/rendererInternals.ts` の `exposeTransitionFields`（実体の `_` 付きフィールドへ委譲、存在チェック付き）に集約した。状態機械の単体テスト（`TransitionState.test.ts`。旧 `armJump` 等のオラクルとの等価性照合を含む）と、レンダラとの結線テスト（`onStall` によるスキップ解除・選択肢確定直後の抑制）を同じ PR で追加した。
- 以後の #826（#735 5/8, `SceneEntryController`）は `TransitionState` をコンストラクタ注入で使う。

## #826 での追記（2026-10-15、#735 5/8）

「単一入口 `enterScene`」とその適用・失敗処理を、`NovelRenderer` から `frontend/src/game/SceneEntryController.ts` に分けた。**実装の置き場は `SceneEntryController`** である。挙動と本 ADR の契約は変えていない。本文中の `enterScene` 等は、次のとおり読み替える。

| 旧（レンダラの private） | 新 |
| --- | --- |
| `enterScene(req)` | `SceneEntryController.enter(req)`（手順 1〜5 とそれぞれの順序はそのまま） |
| `runEntry(req)` | `SceneEntryController.run(req)`（発火して忘れる呼び出し元用） |
| `jumpToScene(id)` / `startFrom(opts)` | 公開 API とシグネチャ・戻り値はレンダラに残り、`SceneEntryController.jumpTo(id)` / `startFrom(opts)`（オプションの整形）へ委譲する薄いラッパー |
| `restoreSnapshot` / `loadFromSaveData` | レンダラに残る（`ensureContext()` と `SaveSlotData` の変換の後で `entry.enter({ kind: 'restore', ... })`） |
| `restoreEntryStream` / `failApply` / `handleApplyError` / `finishEntry` / `applyFresh` / `checkRestorePosition` / `warnEntryFailure` / `failEntry` / `startScene` | `SceneEntryController` の private メソッド |
| `confinedSceneIds` | `SceneEntryController` が唯一の書き手（getter `confinedSceneIds`。レンダラは読むだけ） |
| `stallJump()` | 呼び出しが `SceneEntryController` の中だけになったため、レンダラのラッパーは削除し `transition.stall()` を直接呼ぶ |
| `rederiveTransitionAtCurrentPosition()` | レンダラに残る（`processDirective` を呼ぶため）。Host の `rederiveTransition` 経由で呼ばれる |

- **Host 越しの適用。** コントローラは `NovelRenderer` を import しない。「何を描くか」は、コントローラが定義する `EntryHost`（8 メソッド: `isActive` / `endStory` / `applyFreshContext` / `startEvents` / `restoreToScene` / `notify` / `rederiveTransition` / `isTextPaginated`）に委譲し、レンダラがオブジェクトとして渡す（`implements` にしないので、Host のメソッドはレンダラの公開 API にならない）。`SceneIndex`（引き当て）・`TransitionState`（世代・入場中ゲート・Jump 予約）・`PlaybackCursor`（`playbackStarted` の読み取りのみ）は、コンストラクタ注入された参照として使う。
- **手順の順序と同期の契約は不変。** 世代捕捉（`beginEntry`）→ confinement 判定 → 解決 → 適用前の文脈確定 → 適用 → 後処理。読み込み済みのシーンへの入場は同期のまま適用する。`await` の後の `superseded` 判定（世代と `isActive`）は `enter` の1か所だけ。
- **適用前の文脈確定の分担。** 新規開始では `confinedSceneIds` の置き換え（コントローラ）→ flags の置換と `storyEnded = false`（Host の `applyFreshContext`）→ `consecutiveJumps = 0`（`transition.resetChain()`）の順で、いずれも適用より前に済ませる。`storyEnded = false` は、通常の入場でも `startEvents` が適用の前に行う（先回り終劇 #398 の二重発火ガード）。スナップショットの復元は `restoreToScene` の `presetStoryEnded` で、適用の前に `storyEnded` を直接セットする（#460）。
- **テスト。** private へのアクセスは `src/test/rendererInternals.ts` に集約した（`confinedSceneIds` は `exposeEntryFields`、入場の内部メソッドを `vi.spyOn` する場合は `entryControllerOf`）。

## #827 での追記（2026-10-15、#735 6/8）

クイックセーブ・自動セーブ・セーブ/ロードメニュー・ロード通知を、`NovelRenderer` から `frontend/src/game/SaveController.ts` に分けた。**実装の置き場は `SaveController`** である。挙動と本 ADR の契約（保存内容・トースト文言・自動セーブの時点・通知の順序）は変えていない。本文中の語は、次のとおり読み替える。

| 旧（レンダラの private / public） | 新 |
| --- | --- |
| `quickSave()` / `quickLoad(origin)` / `requestAutoSave()` / `getQuickSaveFlags()` / `hasQuickSave()` / `clearQuickSave()` | 公開 API とシグネチャ・戻り値はレンダラに残り、`SaveController` の同名メソッドへ委譲する薄いラッパー |
| `saveQuick(origin)` / `flushAutoSave()` / `openSaveMenu()` / `openLoadMenu()` / `loadFromSaveData(data, origin)` / `notifyLoadFailure()` / `notifyLoadSuccess(origin)` | `SaveController` の同名メソッド（レンダラからは消えた。キー操作と入場の通知は `save.*` を直接呼ぶ） |
| `autoSavePending` | `SaveController` の private。保留の書き込みはクラス内（`requestAutoSave` / `flushAutoSave`）と `discardPendingAutoSave()` だけ。新しい入場（`resetAndStartEvents`）・復元（`applyState`）が `discardPendingAutoSave()` を呼ぶ（#768 の「保留は次の入場・復元で破棄」） |
| `saveManager` | `SaveController.saveManager`（`setDocKey` と `SaveLoadOverlay` の生成にレンダラが使う） |
| `applyState` / `restoreToScene` / `getSnapshot` | レンダラに残る（ステージとカーソルを横断する合成。Host の `getSnapshot` と、`enter` 経由の `restoreToScene` として使われる） |

- **Host 越し。** `SaveController` は `NovelRenderer` も pixi も import せず、自分で定義する `SaveHost`（7 メソッド: `getSnapshot` / `isStoryEnded` / `getPlayheadSceneId` / `showToast` / `ensureAudioContext` / `normalizeBackgroundFade` / `enter`）だけを見る。ゲート判定は `TransitionState`、本文位置の判定は `PlaybackCursor`、シーン名の解決は `SceneIndex` をコンストラクタ注入で使う。`SaveLoadOverlay`（pixi）はレンダラが生成し、`attachMenu` で渡す。
- **テスト。** private へのアクセスは `src/test/rendererInternals.ts` に集約した（`saveManager` / `autoSavePending` / `saveQuick` / `openSaveMenu` / `openLoadMenu` は `exposeSaveMembers`、コントローラ内部の呼び出しを `vi.spyOn` する場合は `saveControllerOf`）。

## #828 7a での追記（2026-10-15、#735 7/8 の第1段）

背景（クロスフェード・端フェードマスク・明るさ・下地ベタ・地色・テクスチャキャッシュ・ロードトークン）を、`NovelRenderer` から `frontend/src/game/BackgroundController.ts` に分けた。**実装の置き場は `BackgroundController`** である。挙動と本 ADR の契約は変えていない。本文中の語は、次のとおり読み替える。

| 旧（レンダラの private / public） | 新 |
| --- | --- |
| `bgEntries` / `bgMaskSprite` / `bgCrossfadeTimer` / `currentBackgroundPath` / `Color` / `Fade` / `Brightness` / `defaultBackgroundColor` / `textureCache` / `bgLoadToken` / `pendingBackgroundLoadToken` / `pendingBackgroundLoad` | `BackgroundController` の private（唯一の書き手）。`bgGraphics` → `graphics`、`bgContainer` → `container` |
| `setBackground` / `clearBackground` / `setBackgroundColor` / `clearBackgroundColor` / `fadeOutBackgroundEntries` / `finishBackgroundCrossfadeInstant` / `updateBackgroundFadeFrame` / `hasActiveBackgroundFade` / `hasPendingBackgroundLoad` ほか背景系 | `BackgroundController` の同名メソッド。`clearBackground()` は動画レイヤに触れず、動画の寿命管理はレンダラに残る。`resetAndStartEvents` / `[場面転換]` では背景クリア直後、`applyState` では背景復元後に `videoLayer.remove()` を呼ぶ。`destroy` は先に動画を消し、後で背景 entries を解放する |
| `setDefaultBackgroundColor` / `waitForBackgroundLoad`（公開） | シグネチャ不変。レンダラに残る薄いラッパー |
| `getSnapshot` の背景 4 フィールド / `applyState` の背景復元 | `background.capture()` / `background.restore(state)`（フィールド集合と復元順〔画像 → 地色〕は不変。セーブ形式不変） |

- **持ち越し規律は不変。** `resetAndStartEvents` の背景の分岐は従来どおり `preserveBackgroundForTransition` の1か所だけ。持ち越し時は `cancelPendingLoad()`（`bgLoadToken` を進める）→ `finishBackgroundCrossfadeInstant()` → `videoLayer.remove()`、非持ち越し時は `clearBackground()` → `videoLayer.remove()` → 背景板 → `clearBackgroundColor()` の順で、旧実装と同じ順序。このリセット処理内で単独の `cancelPendingLoad()` を呼ぶのは持ち越し時のみ。トークン自体は `clearBackground` / 終劇の `forgetBackground` に加え、`setBackground` の各要求でもキャッシュヒットを含めて進める。
- **Host 越し。** `BackgroundController` は `NovelRenderer` を import せず、自分で定義する `BackgroundHost`（5 メソッド: `getAssetBaseUrl` / `isSkipMode` / `isInitialized` / `getScreenSize` / `getCrossfadeMs`）だけを見る。`TimeController` はコンストラクタ注入。
- **テスト。** private へのアクセスは `src/test/rendererInternals.ts` に集約した（フィールド・メソッドは `exposeBackgroundMembers`、コントローラ内部の呼び出しを `vi.spyOn` する場合は `backgroundControllerOf`）。

## #828 7b での追記（2026-10-20、#735 7/8 の第2段）

画面効果（揺れ・フラッシュ・フェード・終劇の黒フェード・暗転・novel スクリム）を、`NovelRenderer` から `frontend/src/game/ScreenEffectsController.ts` に分けた。**実装の置き場は `ScreenEffectsController`** である。挙動と本 ADR の契約は変えていない。本文中の語は、次のとおり読み替える。

| 旧（レンダラの private） | 新 |
| --- | --- |
| `effectOverlay` / `shakeTimer` / `shakeStartMs` / `effectTimer` / `novelScrim` / `scrimRetreatActive` / `scrimRetreatTimer` / `scrimVisibilityTimer` / `blackoutOverlay` | `ScreenEffectsController` の private（唯一の書き手）。`blackoutOverlay` だけは readonly の公開（ステージ積みはコントローラの `attachTo`） |
| `startShake` / `startFlash` / `startFade` / `startEndStoryBlackoutFade` / `setBlackout` / `updateNovelScrim` / `retreatNovelScrim` / `resetNovelScrimState` / `applyNovelScrimRegion` / `resetNovelScrimRegion` | `ScreenEffectsController` の同名メソッド（`setNovelScrimImmediate` 等の内部部品は private） |
| `resetAndStartEvents` / `applyState` / `endStory` / `destroy` 内の「timer を止めてオーバーレイを消す」重複ブロック | `reset()`（stage 位置は戻さない）／`reset()` + `resetStagePosition()`／`stopAllTimers()`／`hideEffectOverlay()` を呼び分ける |
| `getSnapshot` の `isBlackout` / `applyState` の暗転復元 | `screenEffects.capture()` / `screenEffects.restore(state)`（フィールド集合不変。セーブ形式不変） |
| `NOVEL_SCRIM_*` 定数 | 定義は `ScreenEffectsController.ts`、`NovelRenderer` から再エクスポート |

- **リセット規律は不変。** `resetAndStartEvents` の順序（タイマー停止 → 演出消去 → BGM → カーソル → 再生開始）はそのまま。ここで効果を消す `reset()` は **stage 位置を戻さない**（旧実装と同じ。原点へ戻すのは `applyState` と `endStory` だけ）。持ち越しは `carryPolicyFor` 経由のみで、画面効果は持ち越し対象に加えていない（暗転は従来どおり `setBlackout(false)` で新しい列の頭に戻す）。
- **camera 3つ組と `paperDollOutline` は触っていない**（7c の範囲）。
- **Host 越し。** `ScreenEffectsController` は `NovelRenderer` を import せず、自分で定義する `ScreenEffectsHost`（5 メソッド: `getScreenSize` / `setStagePosition` / `isNovelStyle` / `setDialogAlpha` / `setSeekBarBlackoutHidden`）だけを見る。`TimeController` はコンストラクタ注入。
- **テスト。** private へのアクセスは `src/test/rendererInternals.ts` に集約した（フィールド・メソッドは `exposeScreenEffectsMembers`、レンダラ本体からの呼び出しを `vi.spyOn` で観測する場合は `screenEffectsControllerOf`）。分離前の実装を写した参照実装との1フレーム刻みの状態列比較は `ScreenEffectsController.equivalence.test.ts`。

## #828 7c での追記（2026-10-21、#735 7/8 の第3段）

背景（7a）・画面効果（7b）・カメラ3つ組・紙人形輪郭を束ねる薄いコンポジタ `Stage` を、`frontend/src/game/Stage.ts` に置いた。これで #828（演出レイヤー群の分離）は完了する。**実装の置き場は `Stage`** である。挙動と本 ADR の契約は変えていない。本文中の語は、次のとおり読み替える。

| 旧（レンダラの private） | 新 |
| --- | --- |
| `cameraMode` / `cameraOrientation` / `cameraElevation` / `paperDollOutline` | `Stage` の private（唯一の書き手）。読み取りは getter（`stage.cameraMode` など） |
| `processDirective` の `[カメラ:]` / `[紙人形輪郭:]` が行っていた、フィールド更新と背景板・大道具・立ち絵への伝播 | `stage.setCamera(mode, orientation, elevation)` / `stage.setPaperDollOutline(config)`（伝播は Host の `applyCamera` / `applyPaperDollOutline`。順序は旧実装どおり、カメラは 背景板 → 大道具 → 立ち絵、輪郭は 立ち絵 → 大道具） |
| `resetAndStartEvents` の演出消去（画面効果のタイマー停止・背景・輪郭・暗転・カメラ・スクリム退避リセット） | `stage.reset(carry)`（`carry` は `carryPolicyFor` の戻り値の `CarryPolicy`） |
| `applyState` の演出の消去と復元 | `stage.restore(state)` |
| `getSnapshot` の演出フィールド（背景4・`isBlackout`・カメラ3・`paperDollOutline` の計9個） | `stage.capture()`（セーブ形式のフィールド集合は不変） |
| `destroy` の画面効果・背景タイマー停止と背景解放 | `stage.cancelAllTimers()` / `stage.release()` |

- **複数モジュールをまたいでリセットしてよいのは `resetAndStartEvents` / `applyState` / `destroy` の3つだけ。** この3つの本体のうち演出部分が `stage.*` の呼び出しになった。立ち絵・大道具・背景板・動画・幕・スポットライト・テロップなど演出以外のレイヤーは Stage に入れず、レンダラが前後で呼ぶ。`endStory` の `screenEffects.reset()` + `resetStagePosition()` と、`[場面転換]` の背景クリアは個別の経路なので Stage には寄せていない。
- **`reset(policy)` の順序（`resetAndStartEvents` の実行順序）。** レンダラのタイマー停止 → 動画・背景板・大道具・幕・スポットライト（持ち越さないときだけ）・立ち絵のクリア → `stage.reset(carry)`（画面効果のタイマー停止とオーバーレイ消去 → 背景: 持ち越しなら `cancelPendingLoad()`（`bgLoadToken` を進める）→ `finishBackgroundCrossfadeInstant()`、持ち越さないなら `clearBackground()`（内部で同じくトークンを進める）→ `clearBackgroundColor()` → 輪郭: 持ち越さないときだけ解除 → 暗転解除 → カメラ既定へ → スクリム退避リセット）→ 選択肢を隠す → BGM → SE → イベント絵・テロップ → ダイアログ → カーソル読み込み → 再生開始。Issue #828 の「タイマー停止 → 演出消去 → BGM → カーソル → 再生開始」に揃い、7b で別々だった「画面効果の消去（BGM の前）」と「スクリム退避リセット（BGM の後）」は `stage.reset` の中にまとまった（音声と独立で、同一の同期区間内なので観測できる差はない）。**カメラの伝播を立ち絵のクリア / 退場開始より後に置く順序は旧実装のまま**（持ち越しで退場に入る立ち絵が、退場開始の後で再配置される）。
- **持ち越しは `carryPolicyFor` 経由のみ。** `Stage.reset` が見るのは `CarryPolicy.preserveBackgroundForTransition` の1か所だけで、個別フラグは増やしていない（`carryBgm` は音声の持ち越しなのでレンダラが見る）。`resetAndStartEvents` が受け取る方針は `SceneEntryController` が `carryPolicyFor` から渡したものだけで、省略は「持ち越さない」。
- **`restore(state)` は `reset` と別に、持ち越しなしで宣言的に復元する。** 画面効果（揺れ・フラッシュ/フェード）の停止 → stage 位置を原点へ → スクリム退避リセット → 背景画像 → 地色 → 暗転 → 輪郭 → カメラ、の順。`reset(carryPolicyFor('restore'))` を経由しない（経由すると一度背景を消してから置き直すことになり、同一パスのときのクロスフェードやテクスチャ再利用の挙動が変わるため）。`resetAndStartEvents` は stage 位置を戻さず `applyState` / `endStory` は戻す、という 7b の挙動もそのまま。揺れ中の `resetAndStartEvents` で位置が戻らない件は #913 として別に判断する（テストでは現状を固定してある）。
- **`applyState` 内で処理の位置が動いた点。** 旧実装は演出の消去・復元を `applyState` の随所に散らしていたが、`stage.restore` にまとめたため次が動いた。① 効果停止・stage 位置・スクリム退避のリセットが、`gameState.fromJSON`・`cursor.restorePosition`・ページ数による clamp・`onStoryEndedChangeCallback`・`syncEndingOverlayVisibility` より後へ、また `cancelSeSequence`・`clearTelopLayer` より後へ移った。② 背景・地色・暗転・輪郭・カメラ（背景板・大道具・立ち絵への `setCamera` と輪郭の伝播）が、動画・イベント絵の restore と `applyEventImageVisibility`、背景板・大道具・幕の restore より前へ移った（暗転の復元は動画とイベント絵の restore より前、立ち絵の `setCamera` は背景板・大道具・幕の restore より前）。いずれも同一の同期区間内で、移した処理同士は互いの状態を読まず独立のため、観測できる差はない（`applyEventImageVisibility` はレイヤーの `visible` を書くだけ、`setCamera` と輪郭の伝播は動画・イベント絵に触れない、SE とテロップは画面効果と独立、`onStoryEndedChangeCallback` の受け手は NovelPlayer の `setState` と postMessage だけでレンダラへ同期的に戻らない）。
- **`cancelAllTimers()` は背景のクロスフェードタイマーも止める。** 旧 `destroy` は画面効果のタイマー停止だけで、背景のタイマーは後段の `clearBackgroundEntries()` が止めていた。同一の同期区間内で、止める順序を前に出すだけなので観測できる差はない。
- **`getSnapshot` はキー順を保つ。** セーブ JSON 回帰テスト（`snapshotJson` / `playbackCursor`）がキー順まで固定しているため、レンダラは `stage.capture()` の値を従来の位置に並べ直して入れる（`...` で展開しない）。
- **Host 越し。** `Stage` は `NovelRenderer` を import せず、自分で定義する `StageHost`（`BackgroundHost` + `ScreenEffectsHost` + `applyCamera` / `applyPaperDollOutline`）だけを見る。`BackgroundController` と `ScreenEffectsController` は Stage がコンストラクタで作る（`stage.background` / `stage.effects`）。z 順のため、積むのは `attachBackground`（下地ベタ・背景画像）と `attachEffects`（スクリム・暗転・効果オーバーレイ）の2回に分ける。
- **ファイル名は `Stage.ts`。** 既存に大文字小文字だけが違うファイル（`stage.ts`）は無い。
- **テスト。** 単体は `Stage.test.ts`（新規開始 / 進行 / 復元の `reset(policy)` 後の状態、クロスフェード中の復元、capture のフィールド集合、capture → restore の往復、`cancelAllTimers` 後にタイマーが残らないこと）。旧実装との等価性は `Stage.equivalence.test.ts`（Stage 導入前の演出まわりの呼び出し順を写した参照実装と、メソッド呼び出し列・毎フレームの状態を比較）。レンダラとの配線は `NovelRenderer.stage.test.ts`（`stage.reset` の呼び出し位置と引数、`applyState` の伝播順、`destroy` の順序）。他レイヤーとの相対順序と見た目は、実 WebGL で同一シナリオを固定時刻で撮った画素ハッシュの比較（base と新ブランチで差分0）で確認した。

## #829 での追記（2026-10-21、#735 8/8）

`processDirective` の演出系ディレクティブを `frontend/src/game/directives/` の領域別の表（ステージ / 立ち絵 / オーディオ）へ移した。**実装の置き場が変わっただけで、本 ADR の契約（入場の種類・持ち越し規律）は変えていない。**

- `[場面転換]` のクリア対象と順序は旧 `processDirective` と同じ（`stageSignalDirectives.SceneTransition`）。クリア対象は旧と同じで、背景・動画・背景板・大道具・幕（z-order も既定へ）・照明・イベント絵・テロップ・暗転・novel スクリムをクリアする。`resetAndStartEvents` の新規開始（`stage.reset`・立ち絵・BGM・カメラ・輪郭・文字窓の枠の復帰を含む）より狭く、立ち絵・BGM・カメラ・輪郭・文字窓の枠・フラグは触らない。動画レイヤの `remove()` が 2 回呼ばれる旧実装の呼び出し列も保っている（等価性テストで固定）。
- `Flag` / `Choice` / `Jump` / `Wait` / `WaitDisplayComplete` は遷移ゲートと再生カーソルを触るためレンダラに残り、`rederiveTransitionAtCurrentPosition()` などが `processDirective` を呼ぶ経路は変わらない。
- 立ち絵ロード待ち（`showCharacterThenRender`、#293）はレンダラに残る。`[登場:]` / `[退場:]` / `[表情:]` のハンドラは旧と同じ引数で `CharacterLayer` を呼ぶだけで、`lastSpeaker` や話者交代 nudge には触らない。

## #799 での追記（2026-10-21）

GUI 版で `[条件: x]` の中で `x` を偽にする（自己否定ブロック）と、そのブロックの残りが消えていた。TUI はシーン構築時に先頭から逐次評価するので残りを流す。GUI を TUI に揃え、かつセーブから同じ列・同じ位置を決定的に再現できるようにした。

- **`[条件:]` はシーン訪問の入口で1回だけ、入場時の flags から逐次に評価して展開し、訪問中は列を固定する。** `expandEvents(raw, { flags, fromRawIndex })`（`GameState.ts`）は、元列を先頭から1イベントずつ走査し、走査用の flags の複製に `Flag` を適用しながら、`Condition` に達した時点の複製で真偽を判定して真なら内側を再帰する（TUI の `build_scene_items` と同じ手順）。`Flag` イベント自体は展開後の列に残り、実フラグを書くのは再生時の `processDirective` のまま。ブロックに入った後でそのフラグを変えても、入場済みのブロックの残りは流れる。偽のブロックは内側の `Flag` も実行しない。`PlaybackCursor` の入口は `load`（`resetAndStartEvents`・`loadEntry`）と `replaceEvents`（`restoreToScene`）だけで、`restorePosition`（goBack・seekTo）は再展開しない。訪問が変わるのは、シーンへの入場（選択肢・`[ジャンプ:]`・新規開始）と復元だけで、履歴は訪問ごとに作り直すので、履歴の要素は常に現在の列に対する `eventIndex` を持つ。SeekBar の番号付け（表示上の番号 → 履歴要素）のずれと、`displayEventCount` が戻した先の flags で変わる問題は、列が訪問中不変になったことで構造的に解消した。
- **決定性の根拠。** 訪問中に `[条件:]` の評価へ効く flags は「入場時の flags + 位置までに実行した `[フラグ:]`」で一意に決まる（シーン訪問の中で flags を書き換える経路は `[フラグ:]` の実行だけ。`gameState.fromJSON` は新規開始・復元・`applyState` の flags 置換のみ）。#798 が壊れたのは、セーブが「入場時の flags」を持たず「位置後の最新 flags」だけを持っていたため。そこで、列を決める唯一の自由度である入場時の flags をセーブに載せる。**この前提（`setFlag` の呼び出し元が Flag 分岐だけ）は静的テストで固定している。** 将来、再生中に flags を書く経路（戦闘結果→フラグなど）を足すときは、同じ変更で展開をプログラム側（`CondBranch` 付きの平坦列と、PC を位置とする遅延展開）へ移す。
- **セーブの形式（加算のみ）。** `NovelGameState` / `SaveSlotData` に任意フィールドを足した: `entryFlags`（入場時の flags）、`entryResumeIndex`（旧セーブから復元した訪問だけが持つ再開位置。保存時の `eventIndex`）、`entryRawIndex`（線形ストリームの途中から始めた訪問の元列での開始位置。非0のときだけ）。`getSnapshot()` は元列に `[条件:]` を含むときだけ出力し、キーはスナップショットの末尾・`SaveSlotData` の `savedAt` の直前に置く（既存のキーの値と順序は不変。`[条件:]` を使わない脚本の JSON は従来と 1 バイトも変わらない）。`eventIndex` の意味（展開後の列の添字）は変えない。新→旧: 旧アプリは `entryFlags` を無視し、従来どおり最新の flags で展開する（位置のずれは自己否定ブロックをまたぐときだけで、従来と同じ）。
- **旧セーブ（`entryFlags` が無い）。** 旧セーブの位置は旧実装の展開（`[フラグ:]` の実行ごとに最新 flags で再展開）に対する添字なので、`entryFromState(state, raw)` は、保存された `flags` での静的展開の長さで位置が範囲内かを調べ、範囲内なら `{ flags, resumeIndex: eventIndex, fromRawIndex: 0 }` を返す。`expandEvents` は、展開後の列の長さが `resumeIndex` に達するまでは `[条件:]` を `flags` で静的に評価して `[フラグ:]` を走査に適用せず（保存位置までの添字は旧実装と一致する。位置を囲む `[条件:]` ブロックには入った状態になる）、達した後は `[フラグ:]` を適用しながら1イベントずつ逐次に評価する（位置より後ろの `[フラグ:]` で切り替わる `[条件:]` も旧実装どおり評価し直される。位置を囲むブロックの内側にある `[条件:]` も、位置より後ろの `[フラグ:]` を反映して評価される）。旧形式のクイックセーブから `s0 → s1 → [フラグ: y = true] → [条件: y] Y → end` を再生すると、旧実装と同じ `s0 → s1 → Y → end`。範囲外・終端の位置は全体を静的に展開する（`fromRawIndex` = 元列の長さ）。再保存すると `entryFlags` と `entryResumeIndex`（0 も出す）を付けるので、専用の印は要らない。範囲検証（`checkRestorePosition`）も同じ `entryFromState` を共有するので、旧セーブの検証結果は不変。**旧実装との差**: `[条件:]` を、再展開でなく到達した時点で1回だけ評価する（ブロック入場時評価。本 ADR 全体の方針）点だけで、ブロックの内側で入場後に条件が変わる脚本でのみ現れる。以前の方式（位置を含むトップレベル要素 k を保存時の `flags` で丸ごと静的に展開）にあった「k の内側の `[条件:]` が評価し直されず、その影響が k より後ろの要素にも波及する」制約は、要素の途中まで静的・以降を逐次にする再開位置で解消した。固定フィクスチャ（`NovelRenderer.legacySave.test.ts`）で旧実装と再生列が一致することを確かめ、ランダムな脚本（入れ子は深さ3まで）×保存時 flags 3通り×全位置の、独立実装の理想形との差分テスト（`legacyEntry.differential.test.ts`）でも固定している。
- **線形ストリーム。** `resolveLinearSegments` は断片ごとの独立展開をやめ、展開が持つ `rawOffsets`（元列のトップレベル i 番目の展開後の開始位置）から境界を出す。`startFrom({ linear: true })` の開始シーンは `entryRawIndex`（そのシーン先頭の元列位置）として持ち、それより前は入場時の flags で静的に展開し（前のシーンの `[フラグ:]` は実行しない。「開始シーンの先頭時点の flags」という従来の契約を守る）、以降を逐次評価する。
- **新規開始の位置指定（`debug_eventIndex`）。** `buildFreshPositionState` が、指定した flags を `entryFlags` として渡す（意味は従来と同じ）。
- **TUI との関係。** TUI は位置を保存せず、シーン先頭で保存してシーン構築時に評価するため、セーブ形式の波及は無い。GUI の評価アルゴリズムは TUI と同じ逐次走査になった。GUI は実フラグを再生時に更新し、TUI は構築中に実フラグも更新する差は残るが、再生順に到達する位置での flags は同じで、差が出るのは到達しない領域の `Flag` だけ。TUI は `[ジャンプ:]` に達するとそのシーンの走査を打ち切る（`build_scene_items` の `pending_jump`）が、`expandEvents` はジャンプの後ろも走査して列に残す。差が出るのはジャンプの後ろの、到達しない領域だけだが、その本文は SeekBar の総数（`displayEventCount`）に数えられる（旧実装でも同じで、#799 の退行ではない）。TUI との機械的な突き合わせ（共有フィクスチャ）は #923。
- **スコープ外。** `[条件:]` の else・複合条件・比較は無い。入るときは `expandEvents` と TUI の `build_scene_items` を同時に拡張する。
