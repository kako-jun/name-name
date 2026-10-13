# ADR 0003: シーン入場を「進行」「新規開始」「復元」の3種に分け、遅延ロードを1か所で通す

- 起票日: 2026-10-13
- ステータス: Proposed
- 関連 Issue: #734, #729, #724, #726, #733, #759, #220
- 置き換える記述: [ADR 0002](./0002-deterministic-state-and-debuggability.md) の §3（`startFrom` は同期の `void` で、シーン探索は呼び出し側の責務とする部分）と、§「関連」の `setConfinedSceneIds`。本 ADR が Accepted になった時点で、0002 の該当箇所から本 ADR へリンクする

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
| 背景・背景板・大道具・幕・紙人形輪郭 | 持ち越す | クリアする | 状態どおり |
| 立ち絵 | 遷移用の退場（`clearForSceneTransition`） | クリアする | 状態どおり |
| イベント絵・テロップ・暗転・カメラ・スポットライト・SE シーケンス | リセット（現状どおり） | リセット | 状態どおり（演出の中間状態は持たない） |
| flags | 保持 | 適用の前に、要求どおりに置換（省略時は空） | 状態どおりに置換 |
| `storyEnded` | 適用の前に false | 適用の前に false | 状態どおり |
| `consecutiveJumps` | 継続（本文を描画したらリセット） | 0 | 0 |
| Jump の遷移状態 | 遷移先が Jump なら到達時と同じく予約 | 位置から再導出（#733） | 同左 |
| 既読 | 出発元のシーンは、Choice か Jump に到達した時点で既読（現状どおり） | 付けない | 付けない（Jump 位置への復元だけ到達扱い） |
| history | 空から積む | 空から積む（位置を指定したときは `[snapshot]`） | `[snapshot]` |
| `onSceneChange` | 発火する | 発火する（ただし初期入場の分は自動セーブしない。§5） | 発火しない |
| 失敗（遷移先不在・resolver 失敗） | 位置から遷移状態を再導出する。選択肢由来なら選択肢を再表示（TUI と同じ）、Jump 由来なら `stalled`（現状どおり） | 状態を変えない。位置が動かないので、遷移状態を位置から再導出する | flags だけ反映（現状どおり）し、遷移状態を位置から再導出する |

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
  | { status: 'failed'; reason: 'not-found' | 'resolver-error' }
  | { status: 'superseded' }   // 待っている間に、より新しい入場要求が来た
```

`pendingEntry` は真偽値ではなく、`{ generation, kind, sceneId, promise }` として持つ。進行中の入場の Promise を誰でも待てるようにするためで、`playScript` はこれを使う（§4）。`[ジャンプ:]` は、`armJump` の時点（`setTimeout(0)` が発火する前）で deferred を作って `pendingEntry` に載せる。こうしておかないと、予約から発火までの間に待つべき Promise が存在しない。

処理の順序:

1. 世代を進めて捕捉し、`pendingEntry` を立てる。新規開始と復元では、予約中の Jump タイマーを止める
2. 進行のときだけ confinement を判定する。圏外なら `endStory()` を呼び、`ended` を返す
3. `resolveScene(sceneId)` でシーンを引く。`allScenes` にあれば**同期のまま**続行する（同期描画のタイミングを変えない。動画書き出しの preRoll と既存テストの前提を守る）。無ければ `requestMissingScene`（Promise の共有）を await する。await の後は、世代と `initialized` を**この1か所で**判定する。不一致なら `superseded` を返し、成功・失敗とも何もしない（後始末は世代を進めた新しい側が担う）
4. 見つからなければ、§2 の「失敗」列に従って処理し、`failed` を返す。位置が動かないので、遷移状態を位置から再導出する（`rederiveTransitionAtCurrentPosition()`。`rearmPendingJumpAfterFailedRestore` を一般化したもの）。現在位置が Jump なら再予約し、Choice なら選択肢を再表示する。これにより、選択肢由来の進行が遅延ロード中にプログラム発の新規開始や復元に置き換えられ、その新しい側も失敗して位置が変わらなかった場合も、選択肢が閉じたまま残らない
5. **適用の前処理**（解決できた後、描画の前）として、種類ごとの文脈を確定する。新規開始では、flags の置換・confinement の置き換え・`storyEnded = false`・`consecutiveJumps = 0` を行う。進行では `storyEnded = false`。適用の中で `resetAndStartEvents` → `processUntilNextTextEvent` が同期で走り、全 option が圏外の Choice の先回り終劇（#398）が `confinedSceneIds` を読む。`endStory()` の二重発火ガードは `storyEnded` を見る。そのため、この2つは適用より前に確定していなければならない
6. 種類ごとに適用する。進行は `resetAndStartEvents(carryPolicyFor('progress'))`。新規開始は、先頭からなら `resetAndStartEvents(carryPolicyFor('fresh'))`、位置指定なら最小 state で `restoreToScene` する。復元は `restoreToScene(state)`（`storyEnded` は state から入る）
7. 後処理は、`pendingEntry` を下ろすことと、§2 に従って `onSceneChange` を発火することだけにする

これで、遅延ロードの後処理3本（不整合13）は `resolveScene` 1本になる。要求の時点で世代を進め、待つ間はゲートで止めるので、不整合4・6も解消する。

### 4. 公開 API の写像（互換用のバイパスは作らず、呼び出し側を書き換える）

| 現在の API | 新しい契約 | 呼び出し側の書き換え |
|---|---|---|
| `jumpToScene(sceneId): void` | `jumpToScene(sceneId): Promise<SceneEntryResult>`。**進行専用**にする | ChoiceOverlay のコールバック・`armJump`・`playScript` の choice。`VideoExporter` からは呼ばない |
| `startFrom(opts): void` | `startFrom(opts): Promise<SceneEntryResult>`。**新規開始専用**にする。`sceneId` を省略するとエントリ文書の線形ストリームから始める。`confinedSceneIds` を受け取る | `NovelPlayer` の初期入場、`VideoExporter`、`PlayerScreen` の「はじめから」 |
| `restart(): void` | 廃止。`startFrom({})` に置き換える | `PlayerScreen` の `onNewGame`/`onContinue`（セーブなし時）。`window.__renderer` のダックタイプをやめ、`NovelPlayerHandle` の型付きメソッド経由にする |
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

**初期入場は自動セーブしない**。自動セーブ（`setOnSceneChange` → `quickSave`）の配線は、初期入場が確定した後に行う。そうしないと、新規開始の `onSceneChange` が、有効なクイックセーブをエントリ冒頭の位置で上書きする（4 から 5 へ倒れた場合が特に問題になる）。さらに、4 の失敗理由が `resolver-error`（通信失敗などの一時的な失敗）だった場合は、そのセッションでは自動セーブを配線せず、トーストでその旨を知らせる。一時的な失敗で正しいセーブを消さないためである。理由が `not-found`（原稿が変わってセーブのシーンが消えた）なら、そのセーブはもう戻れないので、通常どおり配線する。

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

## 判断を保留している点

- confinement 中の復元: `?scene=` で埋め込んでいるときに F8 を押すと、圏外シーンのセーブも復元できる。本件では扱わない（記録のみ）

## 関連

- [`architecture.md` のシーン入場経路の網羅表](../architecture.md#シーン入場経路の網羅表734)
- [ADR 0002: 決定論的状態管理とデバッグ可能性](./0002-deterministic-state-and-debuggability.md)（§3 の `startFrom` の契約を本 ADR が置き換える）
- [`docs/spec/markdown-v0.1.md`](../spec/markdown-v0.1.md) の「シーン遷移時の BGM（#724）」「ジャンプ（#725）」
