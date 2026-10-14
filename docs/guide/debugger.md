# デバッグガイド（決定論的デバッグ API）

Name×Name のノベルプレイヤーは、**任意のシーン・状態を URL 1 本／コード 1 行で再現**できる。
「フェードの途中」「タイプライタ表示中」のような演出の中間状態を持たない設計（[ADR 0002](../adr/0002-deterministic-state-and-debuggability.md)）なので、`sceneId` + フラグ + インデックスだけで局面が一意に決まる。バグ報告の再現・特定シーンの作業に使う。

エディタ／プレイヤーの基本操作は [操作ガイド](./controls.md)・[エディタガイド](./editor.md) を参照。

> **`?scene=` との違い**: このページで扱う `debug_scene` 系クエリは production ビルドでも常時
> 有効なデバッグ起点（#652）。sceneId 単体のみ指定できる production 向けの特定シーン直接
> ディープリンクは `?scene=<sceneId>`（#386）で、別系統・別パーサ（`sceneQuery.ts`）。
> `?scene=` は対象ファイル自身に confinement（在圏）されて hub 等の圏外へは「終劇」扱いになるが、
> `debug_scene` は confinement なしで任意のシーンへ遷移できる（1ルートが複数ファイルに分割された
> 構成の実機デバッグ用）。詳細は [`docs/architecture.md`](../architecture.md) の「production 向け
> シーン直接ディープリンク `?scene=`」セクションと
> [ADR 0002](../adr/0002-deterministic-state-and-debuggability.md) を参照。
>
> **隠蔽についての設計方針（#652）**: `debug_scene` 系クエリは有効化条件・認証を持たない。
> 「知らなければ踏まない URL パラメータ」自体が十分な隠蔽であるという kako-jun確定の判断による
> （過剰な設計を避ける）。

## URL クエリで起点を指定する（production ビルドでも常時有効）

`NovelPlayer` のマウント時の初期入場で解決される（`NovelPlayer.tsx`。#734 PR2 以降は `loadScenes`/`loadEvents` で文書を読み込んだ後の入場として動く）。#652 以前は
`import.meta.env.DEV` ガード付きで dev ビルド限定だったが、gymnasia のような1ルートが複数
ファイルに分割された構成の実機デバッグのため production ビルドでも常時有効化した。

開発サーバー（`npm run dev`）に限らず、本番デプロイ先の URL にも以下のクエリを付けられる。

`debug_scene`/`debug_script` を指定した起動はタイトル画面を出さず、指定した局面から直接開始する
（`PlayerScreen.tsx` の `hasDebugStart` 判定、#656）。

`debug_scene` が指すシーンがエントリ `script.md` に無く、`scriptsDir` 配下のサブ MD にある場合も
動作する（#726）。`NovelPlayer` の初期入場が `startFrom` で入場し、その中でサブ MD を遅延ロード
（`missingSceneResolver`）して解決する（`PlayerScreen` は `debug_scene` を事前解決しない、#734）。
`debug_scene` は confinement なしで入場する。`debug_script` を指定した場合も、`?scene=` と併用したときの confinement は外れる（リプレイの選択肢が別ファイルへ移っても終劇にならない、#729）。`?scene=` と併用しても、`debug_scene` に入場できれば
confinement は外れる（後勝ち。別ファイルの `debug_scene` 内の選択肢ジャンプが終劇にならない）。
入場できなかった場合（存在しない ID）は `?scene=` の入場に進み、その confinement が保たれる。
`?scene=` も無ければエントリ先頭から開始し、デバッグ HUD に
`debug_scene: <id> → not found (fallback to entry)` と表示する（`?scene=` が解決済みなら
`not found (ignored)`）。デバッグ指定がある起動では、クイックセーブの自動ロードは行わない。

| クエリ | 意味 | 例 |
|---|---|---|
| `debug_scene` | 開始シーン ID（confinement なし。ファイル境界を無視して直接遷移） | `?debug_scene=1-2` |
| `debug_flags` | 開始時に立てるフラグ（`key:val` をカンマ区切り） | `&debug_flags=saw_characters:true,gold:100` |
| `debug_eventIndex` | 開始イベント index（省略時 0）。`[ジャンプ:]` を指すと、そこから遷移を再予約して先へ進む（遷移先不在なら警告して停止、#733） | `&debug_eventIndex=3` |
| `debug_textIndex` | 開始テキスト index（省略時 0） | `&debug_textIndex=2` |
| `debug_script` | クリック操作列を自動再生（カンマ区切り） | `?debug_script=advance,advance,choice:2-1` |
| `debug_unlock_all` | `1` で全選択肢の `[条件: flag]` ロックを強制解放（#652） | `?debug_unlock_all=1` |

### 全ルート強制解放（`debug_unlock_all`）

`?debug_unlock_all=1` を付けると、選択肢の `[条件: flag]` ロック判定（`NovelRenderer.ts` の
Choice 分岐）が `option.condition` を一切見ずに全選択肢を選択可能にする。個別のフラグを
`debug_flags=route01_cleared:true,route02_cleared:true,...` のように積んでも同じ効果を得られる
ケースもあるが、どのフラグが必要かを事前に把握せずに全ルートを一括解放できるため、gymnasia の
ような未知/大量のルートフラグを扱う実機デバッグではこちらの方が使い勝手が良い。
`debug_scene`/`debug_flags`/`debug_script` とは独立して評価されるため、通常のハブ経由フロー
（`debug_scene` を使わない起動）でも併用できる。

```
# ハブから通常起動しつつ、以降出会う全選択肢のロックを解除する
http://localhost:5173/play/<id>?debug_unlock_all=1
```

### フラグ値の型推論（`debug_flags`）

`debug_flags` の各値は文字列から自動で型付けされる（`debugQuery.ts` の `toFlagValue`）。

- `true` / `false` → 真偽値（Bool）
- 数値文字列（`100`、`-3` 等） → 数値（Number）
- それ以外 → 文字列（String）。空文字は `0` に化けるのを避けて String 扱い

### `debug_script` のトークン

クリック相当の操作を順に自動再生する。`startFrom`（状態指定）より**優先**される。ただし空・全トークン無効で 0 件になった場合は `debug_scene` 指定にフォールスルーする（空 script が有効な scene 指定を握り潰さない）。

| トークン | 動作 |
|---|---|
| `advance` | 次のテキスト／次のイベントへ進む（クリック1回相当） |
| `choice:<jump>` | 選択肢表示をスキップして `<jump>` 先シーンへ直接遷移。未ロードのサブ MD のシーンなら、遅延ロードの完了を待ってから次のトークンへ進む。遷移できなかったら（不在・ロード失敗など）残りのトークンは実行せず打ち切る |
| `wait:<ms>` | `<ms>` ミリ秒待つ（将来の非同期イベント用） |

`[ジャンプ:]` (#725) に到達した `advance`／`choice` の直後は、遷移（次の macrotask）を、Jump のみの中継シーンを含めて自動で待ち切ってから次のトークンへ進むので、Jump の後に `wait` を挟む必要はない（遷移先が見つからず停止した場合は、以降の `advance` は無視される）。

不正トークン（未知の種別、`choice:` で jump 空、`wait:` で数値にならない等）は黙ってスキップされる。

### 例

```
# シーン 1-2 を、saw_characters フラグを立てた状態で開く
http://localhost:5173/play/<id>?debug_scene=1-2&debug_flags=saw_characters:true

# 冒頭から2回クリックして選択肢 2-1 を選んだ局面まで自動で進める
http://localhost:5173/play/<id>?debug_script=advance,advance,choice:2-1

# シーン 3-1 のイベント index 3・テキスト index 2 から再開
http://localhost:5173/play/<id>?debug_scene=3-1&debug_eventIndex=3&debug_textIndex=2
```

> URL のテンプレートは実際のルーティングに合わせて読み替える。重要なのは query string（`?debug_*=...`）の部分。

## コードから使う（テスト・自動操作）

URL クエリは、内部的に `NovelRenderer` の 2 つの public API を呼ぶだけのパーサ（`debugQuery.ts` の `parseDebugQuery`）。同じことをテストや任意のコードから直接呼べる。

### `playScript(steps: Step[]): Promise<void>`

クリック操作列を決定論的に再生する。再生中は `msPerChar=0`（タイプライタ演出を飛ばす）、再入ガードつき。完了・例外時に状態を復元する。

```ts
import type { Step } from '../game/GameState'

const steps: Step[] = [
  { type: 'advance' },
  { type: 'advance' },
  { type: 'choice', jump: '2-1' },
]
await renderer.playScript(steps)
```

`Step` は `GameState.ts` 定義の判別共用体:

```ts
type Step =
  | { type: 'advance' }            // 次のテキスト／イベントへ
  | { type: 'choice'; jump: string } // jump 先シーンへ
  | { type: 'wait'; ms: number }   // ms ミリ秒待つ
```

### `startFrom(opts: StartFromOptions): Promise<SceneEntryResult>`

**新規開始**の入口。文脈を捨てて、任意のシーン・フラグ・インデックスから起動する。URL の `?scene=` / `?debug_scene=` もこれを呼んでいる。

- `sceneId` を**省略**すると、エントリ文書（ハブ）の先頭から始める。指定したシーンがまだ読み込まれていなければ、遅延ロード（`missingSceneResolver`）で解決してから入場する。サブ MD のシーンを直接指定してもよい
- 指定したシーンがエントリ文書でシーンが順に続く並び（線形ストリーム）にあれば、そのシーンの末尾で止まらず、続くシーンもそのまま再生される（シーンを越えるたびに `onSceneChange` が発火する。動画書き出しの範囲指定が使う）。`?scene=` はエントリ以外のファイルのシーンを指すときだけ confinement が付くので、そのシーンの末尾で終劇になる（エントリのシーンを指す `?scene=` は後続へ流れる）。閉じ込め外のシーン境界に入ったら終劇にする処理は防御として残してある。ジャンプ先のシーンや `eventIndex` 指定の開始は、そのシーンの末尾で終わる。再生位置のシーンは `getPlayheadSceneId()` で読める（`getCurrentSceneId()` はストリームの持ち主で、線形ストリームの再生中は変わらない）
- flags は**置換**（省略時は空でクリア）。`confinedSceneIds`（`?scene=` 埋め込みの在圏一覧）も置き換える（省略時は解除）。終劇中に呼べば終劇は解除される
- 直前の文脈は持ち込まない。BGM・背景・背景板・大道具・幕・立ち絵・イベント絵・テロップはクリアされる。開始シーンの冒頭に `[背景:]` が無いと、背景は地色から始まる（開発ビルドでは警告が出る）
- 結果は Promise で返る。`{ status: 'entered', sceneId }`（入場した）、`{ status: 'failed', reason }`（不在・遅延ロード失敗。この場合は flags・位置・confinement など状態が**一切変わらない**）、`{ status: 'superseded' }`（待っている間により新しい入場が始まった）。`await` すると入場が確定したあとの状態を読める
- 遅延ロードの往復中は、`advance`・セーブ・ロード・`goBack` などが受け付けられない（入場中ゲート）

```ts
import type { StartFromOptions } from '../game/GameState'

const result = await renderer.startFrom({
  sceneId: '1-2',
  flags: { saw_characters: { Bool: true } },
  eventIndex: 0,
  textIndex: 0,
})
if (result.status !== 'entered') console.warn('入場できなかった', result)

// エントリ（ハブ）の先頭から。進めたルートの flags を保って始め直すなら flags を渡す
await renderer.startFrom({ flags: savedFlags })
```

```ts
interface StartFromOptions {
  sceneId?: string                         // 開始シーン ID（省略するとエントリ文書の先頭から）
  flags?: Record<string, FlagValue>        // 置換セマンティクス（省略時クリア）
  eventIndex?: number                      // 省略時 0
  textIndex?: number                       // 省略時 0
  sentenceIndex?: number                   // 省略時 0（novel の現ページ内の文）
  confinedSceneIds?: string[] | null       // 在圏一覧（省略・null は解除）
}
```

URL からの初期入場は1回だけで、`?debug_scene=` → `?scene=` → クイックセーブの自動ロード（debug 指定も `?scene=` も無いときだけ）→ エントリの順に、入場できなかったときだけ次へ進む（詳細は仕様書の「初期入場」）。`?debug_scene=` が存在しない ID を指していても、`?scene=` の在圏はそのまま保たれる。

## TUI 版（`--debug-scene` / `--debug-unlock-all`）（#652）

Web 版の `debug_scene`/`debug_unlock_all` と対称の CLI フラグを TUI 版にも用意している
（[操作ガイド](./controls.md) の起動オプション一覧も参照）。

| フラグ | 意味 | 例 |
|---|---|---|
| `--debug-scene <sceneId>` | 開始シーン ID（confinement 概念自体が TUI に無いため常にファイル境界を無視して直接遷移） | `--debug-scene 1-2` |
| `--debug-unlock-all` | 選択肢の `[条件: flag]` ロックを強制解放（値を取らないブールフラグ） | `--debug-unlock-all` |

```bash
# シーン 1-2 から、全選択肢のロックを解除した状態で起動する
cargo run -p name-name-tui -- --debug-scene 1-2 --debug-unlock-all
```

`--debug-scene` は**新規開始**で、クイックセーブを読まず、書きもしない（Web 版の `debug_scene` と対称、#734）。
`Playback::start_fresh_at(sceneId, 空の flags)` で、直前の flags・BGM・イベント絵を持ち込まずに指定シーンから
始める。シーン切替ごとの自動クイックセーブも止まるので、デバッグ中にクイックセーブファイルが書き換わらない。
クイックロードをしないため、既読位置（`read_positions`）も復元されない。`--new-game` のセーブ削除だけは
従来どおり行うため、`--debug-scene` + `--new-game` で起動すると、起動後はクイックセーブが1つも残らない（自動セーブも止まるため）。存在しない sceneId は何も変えず、stderr に警告を出してエントリから始まる（fail-soft）。
シーンの遅延ロードと confinement は Web 版だけの概念で、TUI にはない。

`--debug-unlock-all` は `Playback::with_debug_unlock_all` で `Playback` 内部の
`is_option_locked` を bypass する——`current_choice_locked()`（UI 描画）と
`select_current_choice()`（選択確定）の両方に効くため、ロック中の選択肢も見た目・
選択可否ともに解放される（Web 版 `NovelRenderer.setDebugUnlockAllChoices` と同じ設計）。

> **例外（中継ゲートは `--debug-unlock-all` の影響を受けない）**: 単一選択肢＋`[条件: flag]`の
> シーンを意思決定不要な中継とみなして自動で素通りする機能（中継シーン自動継続、
> `jump_to_scene_idx`、#574）は、条件未達の判定に `is_option_locked` ではなく専用の
> `is_option_condition_unmet` ヘルパーを使う。`is_option_locked` は `--debug-unlock-all`
> 有効時に常に `false`（未達なし）を返すため、これで判定すると本来一度止めて表示す
> べき条件付き未達ゲートまで誤って自動継続してしまう。そのため中継ゲートは
> `--debug-unlock-all` の有無に関わらず、条件未達なら必ず一度止まる。停止後に表示される
> 選択肢自体は引き続き `is_option_locked` 経由で `--debug-unlock-all` の効果を受け、見た目・
> 選択可否ともに解放される（#652 セルフレビュー must 指摘対応）。

## 設計背景

- `startFrom`（途中局面指定・`eventIndex>0`）とセーブ復元は、共通コア `restoreToScene(scene, state)` を経由して状態を宣言的に組み立てる（[#256](https://github.com/kako-jun/name-name/issues/256)）。復元ロジックは 1 本に集約されている。復元後の `eventIndex` が `[ジャンプ:]` を指す場合は、`applyState` が Jump の遷移を再予約する（#733）。ただし `startFrom` の `eventIndex=0`（本番 `?scene=` 埋め込みの既定）だけは通常入場と同じ経路（`startScene` → `resetAndStartEvents`）に乗り、冒頭の `[背景:]`/`[BGM:]` を実行し最初の話者の立ち絵を出す（[#399](https://github.com/kako-jun/name-name/issues/399)）。どちらも入場の種類は「新規開始」で、持ち越しなし・遅延ロード・flags の置換は共通である（[ADR 0003](../adr/0003-scene-entry-kinds.md)、#734）。
- 「任意の state から起動・再開できる」ことは、状態と描画が分離できている**機械的な証明**でもある。新しいレンダラ／モードを足すときは、この API で任意局面を再現できることを完了条件にする。
- 詳しい設計判断は [ADR 0002 — 決定論的状態とデバッグ容易性](../adr/0002-deterministic-state-and-debuggability.md) を参照。

## 戦闘画面サンプルページ（開発用・#749）

戦闘画面（`BattleScreen`）の見た目を、ゲーム本編を経由せずに確認・比較するための独立ページ。ビルド成果物の `battle-sample.html` として出力される（本編からはリンクしない）。本編と同じ `BattleEngine` + `BattleScreen` を載せるので、`layout` / `background` / `spriteStyle` / `windowStyle` / `backgroundTone` / `backgroundDof` / `logTypewriter` / `presentation` の描画は本編と同じコードパス（ATB の `tick` だけはこのページの ticker が渡す）。

- 開発サーバー: `http://localhost:7374/battle-sample.html`。ビルド後は `dist/battle-sample.html` を静的配信して開く
- 設定 JSON は `?config=<URL>` で渡す（絶対 URL、またはこのページからの相対 URL）。なければ内蔵既定（色四角のスプライト）で表示する
- 設定 JSON が不正・取得失敗のときは、画面上部に赤いエラーを出し、内蔵既定で表示を続ける

### ツールバーとブリンク比較

| 項目 | 内容 |
|---|---|
| layout | `front` / `side` |
| spriteStyle | `none` / `acrylic` |
| windowStyle | `dark` / `ff-blue`（パネルの配色テーマ。ブリンク比較の対象に含まれる） |
| 背景を落とす | `on`（既定）/ `off`。背景スプライトにだけ彩度・明度を落とすフィルタ（#753）をかけるかどうか。背景ありのときだけ見た目が変わる。ブリンク比較の対象に含まれる |
| 被写界深度（手前ぼかし） | `on` / `off`（既定）。背景スプライトにだけ、画面の下側ほど強くぼかす縦グラデーション（#753）をかけるかどうか。背景ありのときだけ見た目が変わる。「背景を落とす」とは独立。ブリンク比較の対象に含まれる |
| ドット絵（nearest） | `on` / `off`（既定）。`on` で戦闘のテクスチャ（背景・前景・味方・敵）を nearest のまま使う（本編の frontmatter `pixel_art: true`・#466 と同じ）。`off` は mipmap＋linear で縮小をなめらかにする（#760）。`Assets` のキャッシュは mipmap の有無ごと使い回されるため、**この値が前回から変わったときだけ**、背景・前景・味方・敵の画像を unload して読み直してから描き直す（他のトグルでは unload しない。ブリンク比較で切り替わるときも同様。本編と同じ「最初からその設定で読み込んだ」見た目になる）。ブリンク比較の対象に含まれる |
| ログを1文字ずつ表示 | `on` / `off`（既定）。演出が `ff`（`layout=side`）のときは使わないので無効になる。戦闘ログの新しく積まれた行だけを 1 文字ずつ表示する（#755）。たたかう等でログが積まれると確認できる。タイプ中にコマンドかログ帯をタップすると全文を即時表示（そのタップではコマンドは実行しない。ただし ATB が `on` のときはコマンドのタップで全文表示せずそのまま実行し、全文表示はログ帯のタップだけ）。ブリンク比較の対象に含まれる |
| 演出 | `dq（ログ・動かない）`（既定）/ `ff（モーション・ダメージ数字）`。`ff` は `layout=side` のときだけ効く（#745。`layout=front` では選べない）。たたかう等で、行動する側が踏み出して斬って戻り、対象がのけぞり（HP 0 なら倒れ）、対象の位置にダメージ数字が跳ねて消える。上のログ帯には呪文・アイテムの名前だけが中央寄せで出て、通常攻撃では窓ごと出ない。従来ターン制では演出が終わるまで次の行動・コマンドは受けない。ATB が `on` なら演出中もゲージが進み、敵の行動は順に再生され、行動可能な味方は演出中でも入力できる。各キャラの `poses`（下記）があればポーズごとに絵が差し替わる。ブリンク比較の対象に含まれる。切り替えると戦闘が最初からやり直しになる |
| ATB（ゲージ順に行動） | `on` / `off`（既定）。`on` のとき味方・敵にゲージが付き、AGI に比例して溜まり、満タンの順に行動する（#205）。各ステータス行の右端の短い棒（数文字ぶんの幅）がゲージで、番の味方は名前の左に「▶」が付いて黄色になる。時間はこのページの ticker から `BattleScreen.tick` で渡す。切り替えると戦闘が最初からやり直しになる。ブリンク比較の対象に含まれる |
| commandLayout | `grid（2x2）`（既定）/ `cross（十字・矢印キー）`。`cross` は `side` のとき、コマンド窓を十字（上=たたかう・左=じゅもん・右=どうぐ・下=にげる）にし、矢印キー 1 押しでその方向を決定する（#204）。ブリンク比較の対象に含まれる。切替直後にフォーム部品へフォーカスが残らないよう自動で外す |
| ATB 進行 | `待機（コマンド選択中は停止）`（既定）/ `アクティブ（止めない）`。ATB が `on` のときだけ選べる（#205）。ブリンク比較の対象に含まれる |
| 戦闘をやり直す | 現在の設定のまま戦闘を最初からやり直す（ATB は決着がつくと進まなくなるため） |
| 奥行き（行ごとの縮尺） | `on` / `off`（既定）。`on` のとき設定 JSON の `horizon`（既定 0.3）と `perspective`（既定 0.8）で、奥の行ほど小さく・上に描く（#747）。`layout=side` のときだけ見た目が変わる。ブリンク比較の対象に含まれる |
| 前景あり | 設定 JSON に `foreground` があるときだけ切り替え可（#747）。ブリンク比較の対象に含まれる |
| 隊列 | `設定どおり`（既定。`party[].row`）/ `全員前衛` / `後ろ半分を後衛`（前衛が人数の半分（切り上げ）で、残りが後衛。1 人=後衛なし / 2 人=1 人 / 3 人=1 人 / 4 人=2 人）（#747）。後衛は斜め一列の位置から右寄りに半歩下がり、たたかうのダメージが半分になる（従来ターン制の BattleEngine は攻撃側・被弾側とも `firstAlive(party)` の 1 人だけなので、後衛のダメージ半減は**先頭の生存者が後衛のときだけ**見える。ATB オン（#205）なら全員が行動し敵の狙いもランダムなので、常に見える。）。`layout=front` では隊列を使わない。ブリンク比較の対象に含まれる |
| 背景あり | 設定 JSON に `background` があるときだけ切り替え可 |
| 味方 / 敵 | 1〜4 人（設定の件数を超えたぶんは内蔵既定で補う）。`layout=front` のときは味方人数を選べない（下記） |
| 画面サイズ | `360x640` / `800x450` / `1280x720` / `640x360`（論理サイズ） |
| 解像度 | `本編相当(1)`（既定）/ `実DPR`。ブリンク比較の対象に含まれる |

切り替えるたびに `BattleScreen` を作り直す（戦闘の進行はリセットされる）。**スペースキー**（またはボタン）で、現在の設定とひとつ前の設定を即座に入れ替える。「1秒ごとに自動交互」をオンにすると 1 秒間隔で交互に表示する。見た目が変わる変更をライブ A/B で判定するための機能。ひとつ前の設定が無い間（起動直後）は、切替ボタンと自動交互は無効で、画面にその旨を案内する。表示中の設定・論理サイズ・`window.devicePixelRatio`・`renderer.resolution`・物理ピクセル数は画面上に表示される。

**解像度の差**: 本編の `app.init`（`RaycastRenderer`）は `resolution` を指定しない（= 1）。サンプルの既定も本編相当の 1 にしてあり、`実DPR` に切り替えると `devicePixelRatio` 倍の解像度で描く（高 DPI 端末でくっきり見えるが、本編の見た目とは異なる）。見た目を本編と比較するときは既定の `本編相当(1)` を使う。`実DPR` は描き直しのたびに `devicePixelRatio` を読み直すだけで、ブラウザのズームやモニター移動には、次に設定を変えるまで追従しない。

**front の味方人数**: 本編は `layout=front` のとき先頭 1 人（hero）だけを戦闘エンジンに渡す（`fieldBattle.ts` の `openFieldBattle`）。サンプルも同じ条件にし、`layout=front` では味方人数の選択を無効にして常に 1 人で表示する。`side` は選択どおりの人数を渡す。

**ビルド成果物**: 本編のビルドは、マルチページ化により共通チャンク（`battleEngine-*.js` など）に分かれる。動作は同じ。

### 設定 JSON の例

```json
{
  "layout": "side",
  "spriteStyle": "acrylic",
  "windowStyle": "ff-blue",
  "backgroundTone": "on",
  "backgroundDof": "off",
  "pixelArt": "off",
  "logTypewriter": "off",
  "presentation": "dq",
  "atb": "off",
  "atbMode": "wait",
  "commandLayout": "grid",
  "commandLabels": { "spell": "魔石" },
  "horizon": 0.3,
  "perspective": 0.8,
  "foreground": "battle/foreground.png",
  "background": "battle/background.png",
  "party": [
    { "id": "a", "name": "アリス", "hp": 30, "maxHp": 30, "mp": 8, "maxMp": 8, "atk": 8, "def": 4, "agi": 6, "sprite": "battle/party-a.png",
      "poses": { "idle": "battle/a-idle.png", "step": "battle/a-step.png", "slash": "battle/a-slash.png", "hurt": "battle/a-hurt.png", "down": "battle/a-down.png", "victory": "battle/a-victory.png" } },
    { "id": "b", "name": "ボブ", "hp": 28, "maxHp": 28, "mp": 4, "maxMp": 4, "atk": 9, "def": 5, "agi": 4, "sprite": "battle/party-b.png" }
  ],
  "enemies": [
    { "id": "dragon", "name": "ドラゴン", "hp": 120, "maxHp": 120, "mp": 0, "maxMp": 0, "atk": 14, "def": 8, "agi": 5, "sprite": "battle/enemy-dragon.png" }
  ]
}
```

- トップレベルの項目（`layout` / `spriteStyle` / `windowStyle` / `backgroundTone` / `backgroundDof` / `pixelArt` / `logTypewriter` / `presentation` / `atb` / `atbMode` / `commandLayout` / `commandLabels` / `horizon` / `perspective` / `foreground` / `background` / `party` / `enemies`）と、各キャラのフィールド（`row` は `front` / `back`）はすべて省略可。省略は内蔵既定で補う
- 次はエラー（赤表示のうえ内蔵既定で表示する）: JSON として読めない・ルートがオブジェクトでない、`layout` が `front`/`side` 以外、`spriteStyle` が `none`/`acrylic` 以外、`windowStyle` が `dark`/`ff-blue` 以外、`backgroundTone` が `on`/`off` 以外、`backgroundDof` が `on`/`off` 以外、`pixelArt` が `on`/`off` 以外、`logTypewriter` が `on`/`off` 以外、`presentation` が `dq`/`ff` 以外、`atb` が `on`/`off` 以外、`atbMode` が `wait`/`active` 以外、`commandLayout` が `grid`/`cross` 以外、`commandLabels` がオブジェクトでない・キーが `attack`/`spell`/`item`/`escape` 以外・値が空でない文字列でない、`horizon` / `perspective` が 0〜1 の数値以外、`foreground` が null・空文字以外の非文字列、各キャラの `row` が文字列でない、`party` / `enemies` が配列でない、または空配列（`[]`）、要素がオブジェクトでない、各キャラの `name` / `sprite` が文字列でない、`background` が null・空文字以外の非文字列、URL を解決できない
- 各キャラの `poses`（#745）は `{ "idle": URL, "ready": URL, "step": URL, "slash": URL, "cast": URL, "hurt": URL, "down": URL, "victory": URL }`（部分指定可）。`presentation=ff` のときだけ使う。オブジェクトでない・値が文字列でない・URL を解決できないときはエラー。未知のキーは無視する。無いポーズは近い絵に落ち（`slash`→`step`→`ready`→`idle`、`cast`→`ready`→`idle` など。`special` は必殺技の配線時に対応するため今は未知のキーとして無視）、`down` が無ければ沈み込み、全部無ければ `sprite` の 1 枚のまま動きだけ付く。`pixelArt` の切り替えではポーズの画像も unload して読み直す
- `party` / `enemies` は最大 4 件（超えた分は無視）。`maxHp` 省略時は `hp` を最大値とする。`sprite` を省くとその枠は色四角
- `background` / `sprite` の URL は、設定 JSON の URL を基準に解決される（絶対 URL も可）
- 設定 JSON と画像が別オリジンの場合、そのオリジンが CORS を許可している必要がある
- 計算部（検証・補完・URL 解決・ブリンク履歴）は `frontend/src/battleSample/config.ts` の純粋関数、ブラウザ API 部は `main.ts`

## 一枚絵フィールドサンプルページ（開発用・#807）

一枚絵の上を主人公が歩き、絵の端で隣の絵へ移る「一枚絵フィールド」の試作を確認する独立ページ。ビルド成果物の `field-sample.html` として出力される（本編からはリンクしない・既存の `TopDownRenderer` とは別モードで、MD パイプラインにも組み込んでいない。設定は JSON で持つ）。

- 開発サーバー: `http://localhost:7374/field-sample.html`。ビルド後は `dist/field-sample.html` を静的配信して開く
- 設定 JSON は `?config=<URL>`（なければ `frontend/src/fieldSample/teramachi.sample.json`＝sit-by-me の寺町 4 枚の例）。画像はコピーせず URL で指す。sit-by-me のリポジトリのルートを CORS 付きで配信する前提（例: ルートで `python3 -m http.server 8765` に `Access-Control-Allow-Origin: *` を付けたもの。サンプルの URL は `http://localhost:8765/...`）。画像は fetch で取得するので CORS が必須
- 操作: 矢印キー / WASD（斜めを含む 8 方向）、またはキャンバスを押し続ける（ドラッグ）と足元から指の方向へ連続した向きで歩く。操作の案内は画面に常に出る。「歩行マスクと足元を表示」で歩ける領域（緑）と足元の点（赤）を重ねる
- 歩行マスク: 背景と同じ大きさの白黒画像（白=歩ける）。判定は足元 1 点。壁にぶつかったときは通れる軸だけ滑る。向きは移動ベクトルの支配軸（きっちり斜めのときは直前の向きを保つ）。歩行スプライトは 4 方向 × 3 コマ
- 端のリンク: 足元が端のしきい値（`edgeThreshold`）内で、`links` の `range` に入り、その端へ向かって進むと遷移する（フェード）。遷移先では、遷移先シーンの「元のシーンへ戻るリンク」の `range` に、出た位置の相対位置を写して端から少し内側に出る（歩けなければ近い歩ける点へずらす）。到着直後は、その端へ向かう入力が途切れるまでそのリンクを無効にし、折り返しを防ぐ
- エラー表示: 背景とマスクの大きさが違うシーンは読み込み失敗としてエラーを画面に出す。`start` の近くに歩ける点がなければ警告を出す。遷移先に歩ける点がない、またはシーンの読み込みに失敗したときは、遷移を中止して元のシーンに留まり、エラーを出す（その端へ向かう入力が途切れるまで同じリンクは再試行しない）。画像の fetch が失敗したときは URL と CORS（`Access-Control-Allow-Origin`）の可能性を添えて表示する。モンスター・味方の `hp` は 1 以上
- 設定 JSON の主なキー: `startScene` / `start`（初期の足元）/ `speed`（背景ピクセル/秒）/ `edgeThreshold` / `assetBaseUrl`（指定時は RPG の画像と同じく `${base}/images/...` に解決 #746）/ `player.sprites`（`up|down|left|right` それぞれ 3 コマの URL）・`height`・`frameMs` / `scenes.<id>`（`background`・`mask`・`links[]`＝`{ edge, range, to }`）
- 純粋関数は `frontend/src/game/fieldWalk.ts`（マスク判定・移動・向き・歩行アニメ・端のリンク・出現位置）、設定の検証は `frontend/src/fieldSample/config.ts`、ブラウザ API 部は `main.ts`

### ランダムエンカウント（#809）

フィールドサンプルは、歩いた距離でランダムエンカウントし、既存の `BattleEngine` / `BattleScreen` で戦って、終わると同じ位置に戻る。

- 設定 JSON: `encounter`（`stepDistance`＝抽選 1 回分の歩行距離（既定 80）、`minSteps`＝戦闘後に飛ばす抽選回数（既定 3））/ `monsters`（id → `name`・`hp`・`atk`・`def`・`agi`・`exp`・`gold`・`sprite`）/ `party`（戦闘に出す味方。`sprite` に主人公のポーズ画像）/ `battle`（`layout`・`spriteStyle`・`background`・`width`・`height`）/ `scenes.<id>.encounter`（`rate`・`groups`・`background`）
- `rate` は `rollEncounter`（#172）と同じ: `0` = エンカウントなし、`N` = 抽選のたび 1/N、`1` = 毎回。`groups` は `"slime+slime"` のようにモンスター id を `+` で連結（`monsters` にない id は設定エラー）
- 歩いた距離だけが進む。壁に押しつけて動けていないときは進まない。エンカウントなしのシーンでは貯めない。当選したら貯めた距離を捨て、戦闘後 `minSteps` 回の抽選を飛ばす
- 戦闘中は歩きの入力は無視される（戦闘側は戦闘画面が自前で入力を受ける）。戦闘後は `sceneId` / 足元 / 向きを保ったまま復帰する。ツールバーの「今すぐエンカウント」は確認用で、抽選を 1 回で必ず当てる
- 画面下の表示（`encounter=貯めた距離/刻み 抑制=経過/最低`、`lastBattle`）で状態を確認できる
- 純粋関数は `frontend/src/game/fieldEncounter.ts`（`advanceEncounter`・`initialEncounterState`・`afterBattleState`。乱数は注入）
