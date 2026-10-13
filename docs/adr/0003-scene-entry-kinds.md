# ADR 0003: シーン入場を「進行」「新規開始」「復元」の3種に分け、遅延ロードを1か所で通す

- 起票日: 2026-10-13
- ステータス: Proposed
- 関連 Issue: #734, #729, #724, #726, #733, #759, #220

## Context（背景）

`NovelRenderer` には、シーンに入る経路がいくつもある。選択肢の確定、`[ジャンプ:]`、`?scene=`、`?debug_scene=`、`?debug_script=`、クイックロードとロードメニュー、fluid 再マウント時の `restoreSnapshot`、動画書き出し、「はじめから」（`restart`）、文書の再供給（`setEvents`）。
TUI 版（`tui/src/playback.rs`）にも、選択肢・`[ジャンプ:]`・自動クイックロード・`--debug-scene` の経路がある。

これらの経路は、横断的な機能を経路ごとにばらばらに実装してきた。横断的な機能とは、遅延ロード（`missingSceneResolver`）、BGM と背景の持ち越し、confinement（在圏）、遷移世代（`transitionGeneration`）、Jump の遷移状態（`jumpState`）、既読、history などを指す。
「物語の流れの中の遷移（進行）」と「文脈を捨ててある局面から始める（新規開始）」の区別は、API 上で暗黙のままになっている。全経路を機能ごとに洗い出した表は [`architecture.md` の「シーン入場経路の網羅表」](../architecture.md#シーン入場経路の網羅表734) にある。表から読み取れる不整合は次のとおり。

### 表から読み取れる不整合

1. **`startFrom` が遅延ロードを通らない**。未ロードの sceneId に対しては no-op になる（`startFrom`）。そのため `PlayerScreen` が `?scene=`（#386）と `?debug_scene=`（#726）を呼び出し側で1つずつ事前解決している。[デバッガガイド](../guide/debugger.md)で public API として案内している `startFrom` を直接呼ぶと、サブ MD のシーンでは黙って何もしない
2. **`debug_script` の choice が遅延ロードを待たない（#729）**。`playScript` の choice は `jumpToScene` を呼ぶ。しかし選択肢由来の遷移は `jumpState` を `pending` にしないので、`drainPendingJump()` が即座に false を返し、次のステップが遷移前のシーンで消化される。`[ジャンプ:]` 由来なら `pending` の間ポーリングで待つので、同じ遅延ロードでも由来によって待つかどうかが変わる
3. **`?scene=` と `debug_script` を併用すると confinement が残る（#729 追記）**。choice が別ファイルを指すと、圏外として終劇になる。`debug_scene` は解決できたら confinement を外す（#726、後勝ち）ので、debug 系の経路同士で方針が揃っていない
4. **選択肢確定による遅延ロードの往復中に、遷移中のゲートが無い**。選択肢を閉じたあとも `jumpState` は `idle`、`waitingForChoice` は false のままになる。その間に `advance` すると、Choice を素通りして後続のイベントへ進み、末尾なら終劇する。`quickSave` も通る。spec は「遅延ロード往復中はセーブできない」としているが、実際に守られているのは `[ジャンプ:]` 由来の遷移だけ
5. **選択肢の遷移先が見つからないとき、GUI と TUI で挙動が違う**。GUI は警告を出すだけで選択肢は閉じたまま残り、`advance` で Choice の後ろへ進んでしまう。TUI の `select_current_choice` は `false` を返し、選択肢に留まる
6. **選択肢由来の `jumpToScene` は、要求の時点で遷移世代を進めない**。世代が進むのは、解決後の `resetAndStartEvents` に入ったとき。そのため、先行する非同期の入場と同じ世代を捕捉してしまい、後勝ちが崩れる。たとえば fluid 再マウント直後に `restoreSnapshot` が遅延ロードしている間にエントリ冒頭の選択肢を押すと、先に解決した側が勝つ
7. **新規開始のはずの `startFrom`（index 0）が、背景や立ち絵を持ち越す**。`startScene` は `preserveBackgroundForTransition: true` を固定で渡す。そのため、背景・背景板・大道具・幕・紙人形輪郭が持ち越され、立ち絵は遷移用の退場になる。マウント時は直前の `setEvents` がエントリ冒頭をすでに実行しているので、ハブの背景などが `?scene=` の対象シーンへ漏れる。BGM だけは #724 で独立オプション `carryBgm` に分けたため止まる
8. **初期入場が1回で済んでいない**
   - `setEvents` がエントリ冒頭を自動進行（SE・ボイス・`[待機]` を含む）してから、`startFrom` や `restoreSnapshot` や `playScript` が上書きする
   - `?scene=` と `?debug_scene=` を併用すると、`startFrom` が2回呼ばれる
   - `willAutoQuickLoad` は `initialSceneId` しか見ていない。そのため `?debug_scene=` や `?debug_script=` を単独で指定しても自動クイックロードが走り、非同期の復元と `playScript` が競合する
9. **動画書き出しは新規開始なのに、進行用の `jumpToScene` を使っている**。BGM は打ち消し用の `stopBgmForFreshStart()` を前置きして止めている。それ以外の背景等、flags、`consecutiveJumps` はプレビューから持ち越す。confinement 判定も進行の規則で受ける。開始シーンが見つからなくても結果を返さないので、プレビューの内容のまま録画が始まる
10. **`setEvents` と `restart` で、文書の先頭からの新規開始の扱いが食い違う**
    - `restart` は flags をクリアするが、`setEvents` はクリアしない。エディタのライブ再パースでは、旧 flags と旧 `currentSceneId` が残る
    - 両方とも `storyEnded` を戻さない（コード上の読み）。終劇後に再供給しても `advance` が弾かれ続ける
    - `setEvents({ skipAutoAdvance })`・`pendingAutoAdvance`・`resumeAutoAdvanceIfPending()` は、「直後に別の入場で上書きするので先頭の自動進行を止める」ための打ち消し API になっている
11. **`consecutiveJumps` のリセットが経路ごとにばらつく**。`applyState`・`setScenes`・`advance` ではリセットするが、`startFrom`（index 0）・`restart`・`setEvents` ではリセットしない（軽微）
12. **`--debug-scene`（TUI）と `?debug_scene=`（GUI）で意味が違う**。TUI 版は進行ジャンプ（`jump_to_scene_id`）として動く。自動クイックロードで復元した flags・BGM・同一ファイル内のランニング状態を持ち越したまま、指定シーンへ飛ぶ。GUI 版は新規開始として動く（flags を置換し、BGM を止める）。TUI は `--debug-scene` があっても、先に自動クイックロードを実行する
13. **遅延ロードの後処理を3か所で書いている**。`resolveMissingSceneAndJump`・`loadFromSaveDataMissingScene`・`resolveMissingSceneAndRestore` は、`requestMissingScene` の共有（#733）と世代の捕捉（#759）までは揃っている。しかし、世代の捕捉・`initialized` の判定・失敗時の処理は、それぞれが別々に書いている
14. **fluid 再マウントで debug 起点を再実行する**。デバッグ起点のブロックは、マウント effect（依存は `fluidRemountKey`）の中で無条件に走る。そのため、`?debug_scene=` / `?debug_script=` を付けたまま向きのカテゴリが変わると、`restoreSnapshot` で引き継いだ位置をデバッグ起点が上書きする（コード上の読み）

いずれも、入場の種類が API に現れていないことから生じている。各機能の扱いを経路ごとに決めているので、経路を足すたびに呼び出し側で穴埋めが要る。持ち越す状態が増えるたびに、打ち消し用の API も要る。

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
| 遷移中のゲート | 解決を待つ間は入場中ゲート（`pendingEntry`）で、ユーザー入力（advance・goBack・seek・セーブ・ロード・選択肢）を止める | 同左 | 同左（Jump の `jumpState` は #759 どおり据え置く） |
| confinement 判定 | する（圏外は終劇） | しない。入場が成功した時点で、要求に含まれる confinement に**置き換える**（省略時は解除） | しない（設定は変えない） |
| BGM | 持ち越す（#724） | 止める | 状態どおり |
| 背景・背景板・大道具・幕・紙人形輪郭 | 持ち越す | クリアする | 状態どおり |
| 立ち絵 | 遷移用の退場（`clearForSceneTransition`） | クリアする | 状態どおり |
| イベント絵・テロップ・暗転・カメラ・スポットライト・SE シーケンス | リセット（現状どおり） | リセット | 状態どおり（演出の中間状態は持たない） |
| flags | 保持 | 要求どおりに置換（省略時は空） | 状態どおりに置換 |
| `storyEnded` | false | false | 状態どおり |
| `consecutiveJumps` | 継続（本文を描画したらリセット） | 0 | 0 |
| Jump の遷移状態 | 遷移先が Jump なら到達時と同じく予約 | 位置から再導出（#733） | 同左 |
| 既読 | 出発元のシーンは、Choice か Jump に到達した時点で既読（現状どおり） | 付けない | 付けない（Jump 位置への復元だけ到達扱い） |
| history | 空から積む | 空から積む（位置を指定したときは `[snapshot]`） | `[snapshot]` |
| `onSceneChange`（自動クイックセーブ） | 発火する | 発火する | 発火しない |
| 失敗（遷移先不在・resolver 失敗） | 選択肢由来なら選択肢を再表示する（TUI と同じ）。Jump 由来なら `stalled`（現状どおり） | 何もしない（状態を変えない） | flags だけ反映する（現状どおり） |

持ち越しの方針は、`carryPolicyFor(kind)` のような純粋関数として1か所にまとめる。`resetAndStartEvents` が受け取る `preserveBackgroundForTransition`/`carryBgm` のような個別フラグは、この関数から導出する（規律4.5: 持ち越し対象ごとの独立性は保つが、どの種類で何を持ち越すかの決定は1か所に置く）。新しく持ち越す状態を足すときは、方針表に1列足すだけで済み、打ち消し用の API は要らない。

### 3. 内部の単一入口 `enterScene`

公開 API はすべて、private の `enterScene(request)` を通す薄いラッパにする。

```ts
type SceneEntryRequest =
  | { kind: 'progress'; sceneId: string; origin: 'choice' | 'jump' | 'script' }
  | { kind: 'fresh'; target: { sceneId: string } | 'entry'; flags?: Record<string, FlagValue>;
      position?: { eventIndex: number; textIndex?: number; sentenceIndex?: number };
      confinedSceneIds?: string[] | null }
  | { kind: 'restore'; state: NovelGameState; source: 'save' | 'snapshot' }

type SceneEntryResult =
  | { status: 'entered'; sceneId: string | null }
  | { status: 'ended' }        // 進行のみ: confinement の圏外で終劇した
  | { status: 'failed'; reason: 'not-found' | 'resolver-error' }
  | { status: 'superseded' }   // 待っている間に、より新しい入場要求が来た
```

処理の順序:

1. 世代を進めて捕捉し、`pendingEntry` を立てる（ユーザー入力のゲート）。新規開始と復元では、予約中の Jump タイマーを止める
2. 進行のときだけ confinement を判定する。圏外なら `endStory()` を呼び、`ended` を返す
3. `resolveScene(sceneId)` でシーンを引く。`allScenes` にあれば**同期のまま**続行する（同期描画のタイミングを変えない。動画書き出しの preRoll と既存テストの前提を守る）。無ければ `requestMissingScene`（Promise の共有）を await する。await の後は、世代と `initialized` を**この1か所で**判定する。不一致なら `superseded` を返し、成功・失敗とも何もしない
4. 見つからなければ、§2 の「失敗」列に従って処理し、`failed` を返す。位置が動かず、止めていた Jump が `pending` なら再予約する（`rearmPendingJumpAfterFailedRestore` を全種類に一般化する）
5. 見つかれば、種類ごとに適用する。進行は `resetAndStartEvents(carryPolicyFor('progress'))`。新規開始は、flags を置換したうえで、先頭からなら `resetAndStartEvents(carryPolicyFor('fresh'))`、位置指定なら最小 state で `restoreToScene` する。復元は `restoreToScene(state)`
6. 共通の後処理として、`pendingEntry` を下ろす。`storyEnded`・`consecutiveJumps`・confinement（新規開始のみ）・`onSceneChange` を §2 の表どおりに確定する

これで、遅延ロードの後処理3本（不整合13）は `resolveScene` 1本になる。要求の時点で世代を進めるので、不整合6も解消する。

### 4. 公開 API の写像（互換用のバイパスは作らず、呼び出し側を書き換える）

| 現在の API | 新しい契約 | 呼び出し側の書き換え |
|---|---|---|
| `jumpToScene(sceneId): void` | `jumpToScene(sceneId): Promise<SceneEntryResult>`。**進行専用**にする | ChoiceOverlay のコールバック・`armJump`・`playScript` の choice。`VideoExporter` からは呼ばない |
| `startFrom(opts): void` | `startFrom(opts): Promise<SceneEntryResult>`。**新規開始専用**にする。`sceneId` を省略するとエントリ文書の線形ストリームから始める。`confinedSceneIds` を受け取る | `NovelPlayer` の初期入場、`VideoExporter`、`PlayerScreen` の「はじめから」 |
| `restart(): void` | 廃止。`startFrom({})` に置き換える | `PlayerScreen` の `onNewGame`/`onContinue`（セーブなし時） |
| `setEvents(events, { skipAutoAdvance })` | `setEvents(events)` は、文書を読み込んでから `startFrom({})` する。マウント時に読み込むだけの用途には `loadEvents(events)`（開始しない）を新設する | `NovelPlayer` のマウントでは `loadEvents` を使う。events 変化 effect（エディタのライブ再パース）は `setEvents` のまま |
| `setScenes(scenes, opts)` | 索引と `scenes[0]` を読み込んでから `startFrom({})` | 同上 |
| `pendingAutoAdvance` / `resumeAutoAdvanceIfPending()` | 廃止。開始しない読み込みと明示的な入場に分けたので不要になる | `NovelPlayer` のフォールバック |
| `stopBgmForFreshStart()` | 廃止 | `VideoExporter` |
| `setConfinedSceneIds(ids)` | 廃止。confinement は新規開始の入場属性として、成功時に確定する | `NovelPlayer` が `startFrom({ sceneId, confinedSceneIds })` で渡す |
| `quickLoad(): boolean` | `quickLoad(): Promise<SceneEntryResult \| null>`。null は、データが無いかゲートで弾かれた場合 | F8 は結果を待ってからトーストを出す（遅延ロードが失敗しても「クイックロードしました」と出ていた点も直る）。マウント時は、`entered` 以外なら `startFrom({})` へ倒す |
| `restoreSnapshot(snapshot): void` | `restoreSnapshot(snapshot): Promise<SceneEntryResult>` | `NovelPlayer` の fluid 再マウント |
| `playScript(steps)` | choice は `jumpToScene` の結果を await する。`entered` 以外なら警告を出して以降のステップを打ち切る。advance 後の Jump は、ポーリング（`drainPendingJump`）ではなく、進行中の入場の Promise を待つ | なし |

名前は既存の `jumpToScene`/`startFrom` を残す。2つの名前はすでに「進行」と「新規開始」を表しているので、正すべきは契約のほうになる。`progressTo`/`startFresh` に改名すると、デバッガガイドや外部の利用者の手順が無駄に壊れる。

### 5. 初期入場は1回にし、優先順位を純粋関数で決める

`NovelPlayer` のマウント時に行う入場は、`resolveInitialEntry({ snapshot, debugQuery, initialSceneId, confinedSceneIds, hasQuickSave })` という純粋関数が順序付きの試行リストとして返す。`NovelPlayer` はそれを、`entered` になるまで順に実行する（規律4: 判定ロジックは純粋関数に出してテストする）。

1. fluid 再マウントのスナップショット → `restoreSnapshot`（**debug 起点は再実行しない**。不整合14）
2. `?debug_scene=` → `startFrom({ sceneId, flags, position, confinedSceneIds: null })`。debug は confinement なし（#652）
3. `?scene=` → `startFrom({ sceneId, confinedSceneIds })`。`?debug_script=` を併用する場合は、confinement を `null` にする（不整合3。debug 系は confinement なしという方針に揃える）
4. 自動クイックロード → `quickLoad()`。**debug 指定も `?scene=` も無いときだけ**行う（不整合8）
5. エントリ → `startFrom({})`

`?debug_script=` がある場合は、上の入場が確定（`entered`）してから `playScript` を実行する。debug_scene が見つからない場合は、2 が `failed` になって 3 へ進む。こうして「解決できなければ `?scene=` の confinement が残る」という #726 の挙動を、`PlayerScreen` の事前解決なしで再現する。

`PlayerScreen` の事前解決のうち、`?debug_scene=`（#726）の分は不要になる。`?scene=` の分は、confinement の算出（`findConfinedSceneIds` は対象の doc を要する）と、タイトル画面を出すかどうかの判定に必要なので残す。これは「`startFrom` を動かすための穴埋め」ではなく、confinement の算出だけに役割が絞られる。HUD の `debug_scene: … → resolved / not found` は、初期入場の結果を `NovelPlayer` から通知する形で出す。

### 6. TUI 側の対応

TUI はすべての .md をマージして読むので、遅延ロードは無い。`?scene=` に相当するものも無いので、confinement も無い（spec に「GUI 版のみ」と書く）。入場の種類は GUI と揃える。

- 進行: `jump_to_scene_id`（選択肢・`[ジャンプ:]`。現状どおり）
- 新規開始: `Playback::start_fresh_at(scene_id) -> bool` を新設する。flags と `scan_state` を初期化し、そのシーンから items を作り直す。`--debug-scene` はこれを使う。また、`--debug-scene` を指定したときは自動クイックロードを行わない（GUI の §5-4 と対称。不整合12）
- 復元: `restore_playback`（`set_flags` に続けて `jump_to_scene_id_with_continuation`）。意味としてはすでに復元なので、名前を `Playback::restore_to_scene(scene_id, flags, continuation)` に揃えるのは任意。TUI の復元はシーン先頭単位で、GUI はイベント単位という粒度の差は spec に明記する

### 7. #729 の解消

- choice ステップが `jumpToScene` の Promise を await するので、遅延ロードの完了を待ってから後続のステップへ進む（§4）
- `?scene=` と `debug_script` を併用した場合は confinement を外す（§5-3）
- `debug_script` が指定されていれば自動クイックロードを行わないので、非同期の復元と競合しない（§5-4）

## Consequences（影響）

**良くなること**

- 経路を足しても、`kind` を選ぶだけで遅延ロード・世代・ゲート・持ち越しが揃う。呼び出し側で穴埋めや打ち消しをする必要がなくなる（`stopBgmForFreshStart`・`skipAutoAdvance`/`pendingAutoAdvance`・`setConfinedSceneIds`・`PlayerScreen` の debug_scene 事前解決が消える）
- 遅延ロードの後処理と世代の判定が1か所になる（規律3「非同期の遷移は世代で守る」の実装も1か所になる）
- 入場の結果が Promise で返るので、デバッグリプレイと動画書き出しが「入場が確定した後」を待てる

**変わること（目に見える挙動）**

- `?scene=` / `?debug_scene=` の開始で、ハブの背景・背景板・大道具・幕が漏れなくなる。対象シーンの冒頭に `[背景:]` が無い場合は、背景が地色（`background_color`）になる
- 動画書き出しは、プレビューの背景・flags・立ち絵を持ち込まない。条件分岐（`[条件:]`）は空の flags で解決される
- エディタでライブ再パースすると flags が空に戻り、終劇状態も解除される
- 選択肢の遷移先が見つからないと、選択肢が再表示される（TUI と同じ）。遅延ロードの往復中は、advance・セーブ・ロード・goBack を受け付けない

**コスト**

- 公開 API の戻り値が Promise に変わるので、`NovelPlayer.test.tsx` などのモック、`VideoExporter`、`PlayerScreen` を同じ PR で追従させる
- `NovelRenderer` に `enterScene`/`resolveScene` を足すが、遅延ロードの後処理3本と打ち消し用 API を消すので、正味の行数は減る見込み。置き場所は #735（責務単位の分割）の「シーン遷移制御」に合わせる

## 移行計画（PR 分割）

各 PR の共通の完了条件: `npm run type-check`・`npm run lint`・`npm test -- --run`（全テスト。モックの追従も含む）・`cargo fmt --all --check`・`cargo clippy --workspace --all-targets -- -D warnings`・`cargo test --workspace` がすべて緑。遷移の意味論を変える PR では、両ランタイムと `docs/spec/markdown-v0.1.md` の「シーン入場の種類」節（PR1 で新設し、「シーン遷移時の BGM（#724）」節を吸収する）を同じ PR で揃える。

### PR1: 入場の単一入口と進行の契約

- 内容: `enterScene`/`resolveScene`/`pendingEntry`/`carryPolicyFor` を導入する。`jumpToScene` を進行専用の Promise 版にする。要求の時点で世代を進める。選択肢由来の遅延ロード中にゲートをかける。選択肢の遷移失敗時は選択肢を再表示する。遅延ロードの後処理3本を `resolveScene` に統合する（復元経路も乗せる）。不整合4・5・6・13 を解消する
- テスト観点: 選択肢から未ロードのシーンへの遷移中に、`advance`/`quickSave`/`goBack`/`seekTo`/ロードメニューを弾くこと。不在の遷移先で選択肢が再表示され、`advance` で Choice を素通りしないこと。`restoreSnapshot` の遅延ロード中に選択肢を確定すると、後から要求した選択肢側が勝つこと（解決順を入れ替えた2通り）。`[ジャンプ:]`・復元の既存テスト（#725/#733/#759）が緑のままであること。`carryPolicyFor` の表を検証するテスト
- 実ブラウザ確認: scriptsDir 構成のプロジェクトで、ハブから未ロードのサブ MD へ選択肢で遷移する。ネットワークを低速化し、ロード中にクリックを連打したり F5 を押したりしても先へ進まないこと、到着後の BGM と背景が持ち越されていることを確認する。不在 ID の選択肢を含む ad-hoc シナリオで選択肢が再表示されることを確認する

### PR2: 新規開始の契約と初期入場の一本化

- 内容: `startFrom` を新規開始専用の Promise 版にする（遅延ロード・持ち越しなし・`confinedSceneIds`・`storyEnded`/`consecutiveJumps` のリセット）。`setConfinedSceneIds` を廃止する。`resolveInitialEntry` を純粋関数として作り、`NovelPlayer` の初期入場を1回にする。`loadEvents` を新設し、`skipAutoAdvance`/`pendingAutoAdvance`/`resumeAutoAdvanceIfPending` を廃止する。`quickLoad` を Promise 版にする。`PlayerScreen` の debug_scene 事前解決を撤去し、HUD は結果の通知で出す。不整合1・7・8・14（debug_script 部分は PR3）を解消する
- テスト観点: `startFrom` が未ロードのシーンを解決して入場すること。不在なら状態が一切変わらないこと。confinement が成功時にだけ置き換わること。新規開始で背景・背景板・大道具・幕・紙人形・立ち絵がクリアされること。`resolveInitialEntry` の決定表（スナップショット / debug_scene / ?scene= / 併用 / クイックセーブの有無 / どれも無い）。fluid 再マウントで debug 起点を再実行しないこと。マウント時の `quickLoad` が失敗したらエントリから始まること
- 実ブラウザ確認: `?scene=<サブ MD のシーン>` で、ハブの背景が漏れず、入場が1回であること（コンソールとネットワークで確認）。`?scene=` と `?debug_scene=<不在>` を併用すると `?scene=` の confinement が保たれること。`?debug_scene=<サブ MD>` 単独で、事前解決なしに入場できること。`aspect_ratio: auto` の作品で、`?debug_scene=` を付けたまま向きを変えても位置を保つこと。F8 で、遅延ロードが失敗したときに成功トーストが出ないこと

### PR3: debug 起点（#729）を GUI/TUI で揃える

- 内容: `playScript` の choice で入場結果を await し、失敗したら打ち切る。advance 後の Jump は入場の Promise を待つ。`?debug_script=` を指定したら自動クイックロードを行わず、`?scene=` を併用したら confinement を外す。TUI に `start_fresh_at` を追加し、`--debug-scene` を新規開始にして、自動クイックロードを行わないようにする。spec とデバッガガイドを更新する。不整合2・3・12 を解消し、#729 を close する
- テスト観点: scriptsDir 構成で、`choice:<未ロードのサブ MD>` の後の `advance` が遷移先のシーンで消化されること（resolver の解決を遅延させたモックで確認する）。`?scene=` と `debug_script` の choice で別ファイルへ移っても終劇しないこと。TUI では、クイックセーブがある状態で `--debug-scene` を指定しても、flags と BGM が持ち越されないこと（`main()` レベルの統合テスト）
- 実ブラウザ確認: 実際の URL で `?debug_script=choice:<サブ MD のシーン>,advance,advance` を開き、遷移先の2行目に着くこと。`?scene=…&debug_script=…` で終劇しないこと。TUI で `--debug-scene` を実際に起動し、BGM が鳴っていないこと（指定シーンに `[BGM:]` があれば、それだけが鳴ること）

### PR4: 動画書き出しを新規開始へ移す

- 内容: `VideoExporter` は `stopBgmForFreshStart()` と `jumpToScene` をやめ、`await renderer.startFrom({ sceneId: startSceneId })` を使う。`entered` 以外なら録画を始めずに reject する。`stopBgmForFreshStart` を削除する。architecture.md の「VideoExporter が依存する公開 API」を更新する。不整合9 を解消する
- テスト観点: 書き出しの開始時に BGM・背景・flags を持ち込まないこと。開始シーンが無いときに reject すること。`startSceneId === endSceneId` での終端検知（`onSceneChange` の発火）が保たれること
- 実ブラウザ確認: エディタで、プレビューを別のシーン（別の背景と BGM）まで進めてから書き出す。webm の先頭にプレビューの背景や曲が入らないことを、再生して確認する

### PR5: 文書の(再)供給と「はじめから」を新規開始へ揃える

- 内容: `restart` を廃止して `startFrom({})` へ置き換える。`setEvents`/`setScenes` を「読み込み＋`startFrom({})`」にする（flags のクリアと `storyEnded` の解除が揃う）。不整合10・11 を解消する
- テスト観点: 終劇後に `setEvents` すると入力可能に戻ること。ライブ再パースで flags が空になること。「はじめから」「つづきから（クイックセーブなし）」の既存テスト（#637/#662）が緑であること
- 実ブラウザ確認: エディタで終劇まで進めてから原稿を編集し、プレビューが先頭から操作できること。タイトルの「はじめから」で、直前のルートの内容が出ないこと（#662 の回帰確認）

PR1 は他の PR の前提になる。PR2 は PR1 の後、PR3・PR4・PR5 は PR2 の後で、互いに独立している。

## 判断を保留している点

- 動画書き出しの flags: 新規開始なので空が既定。プレビュー中の flags で分岐を録りたい用途があるなら、`VideoExportOptions.flags` を足す（既定は空）
- confinement 中の復元: `?scene=` で埋め込んでいるときに F8 を押すと、圏外シーンのセーブも復元できる。本件では扱わない（記録のみ）

## 関連

- [`architecture.md` のシーン入場経路の網羅表](../architecture.md#シーン入場経路の網羅表734)
- [ADR 0002: 決定論的状態管理とデバッグ可能性](./0002-deterministic-state-and-debuggability.md)
- [`docs/spec/markdown-v0.1.md`](../spec/markdown-v0.1.md) の「シーン遷移時の BGM（#724）」「ジャンプ（#725）」
