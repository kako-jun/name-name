# 状態を用意して起動する（セーブから途中再開）

任意の局面（パーティ・所持品・装備・所持金・フィールドの現在地・戦闘中の状態）を**セーブデータとして先に用意し、そこから再開して起動する**ための手順。デモ・不具合の再現・見た目の確認は、すべてこの一通りで行う（専用のサンプルマップや状態の作り方は持たない。#1021）。

- 従来のデモの入口（`?fixture=dummy`）は無い。戦闘画面の機能別サンプル `battle-sample.html` は、一枚絵フィールドの設定に未搭載の機能（ジョブ・魔石・脚本・敵の行動パターンや耐性等。状態異常の宣言と付与は搭載済み）のため暫定で残る
- 状態の与え方は **localStorage のセーブ（JSON）を先に作ってから、`?resume=` で開く** の一通り
- セーブ形式が正（`frontend/src/game/rpgSave.ts` の `RpgSaveState`）。`startFrom({ rpg })` も同じ形式を受ける（[デバッガガイド](./debugger.md) / [ADR 0002 §6](../adr/0002-deterministic-state-and-debuggability.md)）
- 再開できるのは一枚絵フィールド（`field-sample.html`）。ノベル側（`NovelRenderer`）は `rpg` を解釈せず持ち回すだけ

## 手順

1. セーブ JSON を用意する（下の「セーブの書き方」。寺町の例: [`examples/teramachi-bathhouse-battle.save.json`](./examples/teramachi-bathhouse-battle.save.json)）
2. 開く URL と同じオリジンで、ブラウザの開発者ツールのコンソールから localStorage に書く（キーは `name-name-save-field-sample-<スロット>`。スロットは `0`〜`2`、クイックは `quick`）

   ```js
   localStorage.setItem('name-name-save-field-sample-0', JSON.stringify(/* セーブ JSON */))
   ```

   自動操作（playwright など）ならページを開く前に同じオリジンの任意のページで `localStorage.setItem` してから `field-sample.html?resume=0` へ移動する
3. `field-sample.html?resume=0`（`?config=<URL>` で世界の設定を差し替えるのは従来どおり。設定は「世界」、セーブは「状態」で別物）を開く
4. 画面下の表示（`scene=… foot=… facing=… gold=… party=…`）と、`window.fieldSample.rpg()`（今の局面をセーブ形式で返す）で復元を確かめる。`window.fieldSample.saveRpg(1)` で今の局面をスロットに書け、同じ形式で読み戻せる
5. 失敗したとき（スロットが空・`rpg` が無い・検証に落ちた）は理由を画面に出し、設定の開始位置から始める。パーティが設定に 1 人もいないセーブも同じ扱い

## セーブの書き方

localStorage に入れるのは通常のセーブ（`SaveSlotData`）で、RPG 状態は `rpg` キーに入る。ノベル側の必須キー（`slot` `sceneId` `eventIndex` `textIndex` `flags` `backgroundPath` `isBlackout` `characters` `currentBgmPath` `savedAt` `sceneName`）は一枚絵フィールドでは使わないので中立の値でよい（`buildRpgSaveSlot(rpg)` がそれを埋めて返す）。

```jsonc
{
  "slot": 0, "sceneId": null, "eventIndex": 0, "textIndex": 0, "flags": {},
  "backgroundPath": null, "isBlackout": false, "characters": [], "currentBgmPath": null,
  "savedAt": "2026-11-04T00:00:00.000Z", "sceneName": "bathhouse",
  "rpg": {
    "version": 1,
    // パーティ: 設定のパーティの id（無指定の id は party1, party2, …）。書いたキーだけ設定に上書きする。書いた順が並び順、書かなかった者は離脱
    // form（任意）: 人物の形態＝時期＋車椅子（例 "elementary-wheelchair"）。設定の既定を上書きし、その形態の戦闘ポーズ・歩行絵を使う（下の「人物の形態」）
    "party": [{ "id": "party1", "hp": 22, "mp": 4, "form": "elementary-wheelchair" }, { "id": "party4", "hp": 0 }],
    // 所持品: 設定の items の id → 個数。書かなかった id は 0 個
    "items": { "sit_herb_tea_heal": 1 },
    // 装備: メンバー id → アイテム id の配列。保存・復元・読み出しはするが、能力値への反映はしない（下の「未対応」）
    "equipment": { "party2": ["heshikiri-hasebe"] },
    "gold": 120,
    // フィールドの現在地（省略は設定の開始位置）。x / y は足元（背景ピクセル）。facing は 8 方向
    "field": { "sceneId": "bathhouse", "x": 768, "y": 716, "facing": "up", "flags": {} },
    // 戦闘中（省略はフィールドを歩いている局面）
    "battle": {
      // 敵: モンスターのマスター id（同じ id が複数いてよい）＋マスターと違うキー。hp <= 0 は倒れた状態で残す
      "enemies": [{ "id": "M149", "hp": 21 }, { "id": "M147", "hp": 20, "status": { "sleep": 2 } }],
      // ATB（ターン制の設定なら省略）: ゲージは 0〜1000、queue はコマンド待ちの味方の並び順（party の添字。溜まった順）
      "atb": { "partyGauge": [1000, 620, 300, 0], "enemyGauge": [400, 150], "queue": [0] },
      // 敵の記憶: `行動:` を持つ敵がいる戦闘にだけ効く（無い戦闘では書いても無視される。寺町の例の敵は持たないので書いていない）
      "enemyMemory": [{ "acted": 2 }, { "acted": 0 }],
      "background": "…戦闘背景の URL（省略は設定の背景）"
    }
  }
}
```

- 敵の `id` は設定の `monsters` のキー。寺町の同梱設定では sit-by-me の台帳の敵（`M108` 蓋の開いたマンホール・`M148` 凍った水たまり＝用水の合流、`M145` 割れた酒瓶・`M147` 扇風機の羽根・`M149` 石油ストーブ・`M150` ライター・`M151` 古いたこ足配線＝銭湯）
- 状態異常は `status`（名前 → 残ターン）、強化・弱体は `buffs`。味方も敵も `BattleEntity` のキーをそのまま書ける
- ATB のゲージは戦闘が起きている間の「安定した状態」だけを持つ（ダメージ数字・モーションなど演出の中間状態は持たない。ADR 0002）。戦闘開始のログ（「…があらわれた！」）は再開時にも出る
- 戦闘中に復元したセーブは遷移の演出（暗転・ズーム）を挟まず戦闘画面を開く

## 人物の形態（時期・車椅子）(#1020)

味方の `form`（例 `elementary-wheelchair` / `elementary` / `uniform` / `teen-wheelchair`。時期＋車椅子の有無）をセーブに書くと、再開した局面でその形態の絵になる。

- 戦闘ポーズ（待機・構え・踏み出し・斬る・詠唱・被弾・倒れ・勝利）と歩行絵は、sit-by-me の命名規則 `{人物}-{形態}-{ポーズ}.webp` から**導く**（絵を設定やセーブに並べない）。仕組み・優先ルール（人物単体版 `-character` の優先）・ポーズが無いときの動作は [デバッガガイド](./debugger.md)「人物の形態から絵を導く」
- 形態を書かなければ設定の既定（寺町は ナム=`elementary-wheelchair`・ほか 3 人=`elementary`）
- `form` は設定の `party[].form`（既定）を持つ味方にだけ効く。形態が目録に無いときは警告して既定に戻る。セーブで指定した `form` は `window.fieldSample.rpg()` にも出る（指定の無い味方は出さない）
- 歩行絵は、先頭から数えて同じ人物の味方の形態に従う（ナムの `form` を `teen-wheelchair` にすると、歩く主人公もその時期の車椅子になる）

## 持ち越しの規則（戦闘後）

- 所持品の残数・所持金（勝利時の獲得分）・味方の HP / MP / 状態異常は戦闘のあとも持ち越す（以前の「戦闘のたびに設定へ戻る」ことはしない）
- 敗北のときだけ味方を戦闘前（その戦闘を始めた時点。戦闘中のセーブから再開した戦闘ではセーブ時点）に戻す（全滅のまま次へ進めなくなるのを防ぐ）。所持品・所持金は戻さない

## 刀の確認（寺町サンプルの味方の刀。#1035）

寺町サンプルの味方（C001〜C004）は、目録から導いた刀を手元に持つ（導き方は [デバッガガイド](./debugger.md) の「刀の指定を目録から導く」）。戦闘中セーブ再開で、通常攻撃の ready → windup → slash → followthrough → ready の 5 段に刀が付くことを確かめる手順:

1. sit-by-me のルートを CORS（`Access-Control-Allow-Origin: *`）付きで配信する（寺町の設定の URL は `http://localhost:8765/...`。別ポートで配信するときは設定 JSON（`teramachi.sample.json`）をコピーして `8765` を置き換え、`?config=<そのURL>` で渡す。さらに感情吹き出しの `teramachi-emotions.json`（`8765` が 3 箇所。設定の `emotionsUrl` は相対なので、ビルド出力の `field-sample/teramachi-emotions.json` を置換する）も置き換える。感情 JSON を置換しないと、別ポート配信時に感情吹き出しの画像で CORS の console error と警告が出る（刀とは無関係で非致命）。セーブの `battle.background` の URL も同様）
2. `cd frontend && npx vite build --outDir <出力先>` の本番ビルドを静的配信する（`field-sample.html`）
3. [`examples/teramachi-bathhouse-battle.save.json`](./examples/teramachi-bathhouse-battle.save.json) を localStorage（`name-name-save-field-sample-0`）に入れて `field-sample.html?resume=0` を開く。味方の並びは party1=ナム C002（車椅子）・party2=オットン C001・party3=シャー C003・party4=ペー子 C004（HP 0 なので、確かめるときはセーブの `party4` の `hp` を上げ、`battle.atb.partyGauge` を確かめたい者だけ 1000・`queue` をその添字にする）
4. **「たたかう」をクリックする前に**仮想時計（`requestAnimationFrame` / `performance.now` の差し替え。playwright なら `addInitScript` で入れ、ページ読み込み後に仮想へ切り替えてからクリックする）を入れる。クリック時点でターゲットが自動決定され攻撃が即始まるので、後から時計を差し替えると最初のコマで既にヒット後になる。「たたかう」を選ぶ（攻撃は数百 ms で終わるので、目視では追えない。playwright なら `requestAnimationFrame` / `performance.now` を差し替えた仮想時計で 30 ms ずつ進めてコマ撮りする）。5 段で、手元に刀が付き、ready の構え・windup の振りかぶり・slash の突き出し・followthrough の振り抜きに追従すること

実測（2026-11-04、本番ビルド・chromium + swiftshader のコマ撮り）: C001〜C004 の 4 人とも 5 段で刀が手元に付き、読み込み警告なし。C001 の swing も巨大表示にならない（#165 解消後）。被弾の傾き・死亡の回転への追従はこの手順では確かめていない（同じ container の子なので追従する設計。#1027 で確認済み）。刀の位置・見た目の最終判断は人の実機で行う。

## 敵レベルとレベル条件即死の確認（#1043）

一枚絵フィールドの設定 JSON の `monsters.<id>.level`（書式は [デバッガガイド](./debugger.md)）が、戦闘に効くことを確かめる手順。確認用の設定は [`examples/teramachi-enemy-level.config.json`](./examples/teramachi-enemy-level.config.json)（寺町の同梱設定 `teramachi.sample.json` と同じ素材・敵・味方で、差分は銭湯の敵 `M149`=Lv50 / `M147`=Lv3 / `M145`=レベルなし、呪文「ほろび」＝`damage_full レベル倍数=5` の追加だけ。寺町の本編相当の設定は変えない）。

1. 本番ビルドして静的配信する。`cd frontend && npx vite build --outDir <出力先>` のあと、`<出力先>` を静的配信する（空きポートを使う。他のプロセスは止めない）
2. 確認用の設定を `<出力先>` の直下（`field-sample.html` と同じ場所）にコピーする。設定内の相対 URL（`scriptUrl` など `field-sample/...`）は設定ファイル自身の位置から解決されるため、ここに置くと壊れない
3. sit-by-me のルートを CORS（`Access-Control-Allow-Origin: *`）付きで配信する。設定の素材 URL は `http://localhost:8765/...` なので、別ポートで配信するときは、コピーした設定の `8765` を置き換える（「刀の確認」と同じ。セーブの `battle.background` の URL も同様）。感情吹き出しの `field-sample/teramachi-emotions.json`（`8765` が 3 箇所）も、「刀の確認」の手順1と同じく置き換える（置換しないと CORS の console error と警告が出る。非致命）
4. [`examples/teramachi-bathhouse-battle.save.json`](./examples/teramachi-bathhouse-battle.save.json) を localStorage（`name-name-save-field-sample-0`）に入れ、`field-sample.html?resume=0&config=teramachi-enemy-level.config.json` を開く。敵は `M149`（Lv50）と `M147`（Lv3）の戦闘中で再開する。`ff-mosaic` の導入演出で、操作できるまで約 8〜12 秒かかる。操作は `cross` レイアウトで、矢印↑=たたかう・←=じゅもん、↑↓=ターゲット選択、Enter=決定（Enter だけ押しても何も起きない。先に↑でコマンドを選ぶ）
5. レベル条件の即死: 味方に「ほろび」（`damage_full レベル倍数=5`。MP 1）を使わせる（操作は ←（じゅもん窓）→ ↓ を 3 回で「ほろび」→ Enter → ターゲットを↑↓で選ぶ → Enter。窓の先頭は「ほのお」で、MP が足りない呪文は灰色表示）。Lv50 の `M149`（50 は 5 の倍数）は倒れ、Lv3 の `M147`（5 の倍数でない）は `きかなかった` で HP が変わらない。レベルを持たない敵（この設定では `M145`。「今すぐエンカウント」の抽選に入っている）にも効かない。つまりレベル条件の即死は、レベルを持つ敵のうち倍数のものにだけ効く

**見た目の最終判断（ダメージ表示・「きかなかった」の読みやすさ）は KJ の実機で行う**。この手順は値の確認までで、見た目の合格判定ではない。

## motion / 敵名窓 / エフェクトの確認（#1051）

戦闘サンプル（`battle-sample.html`）で見ていた 3 機能を、実際のゲームと同じ形式の設定（`battle.motion` / `battle.enemyList` / `battle.effects`。書式は [デバッガガイド](./debugger.md)）で確かめる手順。確認用の設定は、寺町とは別の最小の一枚絵世界（シーン 1 つ・敵はデモ用の名前と数値。寺町の同梱設定には足さない）。

| 機能 | 設定 | セーブ | 見えるもの |
|---|---|---|---|
| motion | [`demo-motion.config.json`](./examples/demo-motion.config.json) | [`demo-motion.save.json`](./examples/demo-motion.save.json) | `battle.motion: "snappy"`。戦闘開始の横スライド登場・キビキビした踏み出し・桁ごとに跳ねるダメージ数字 |
| 敵名窓 | [`demo-enemy-list.config.json`](./examples/demo-enemy-list.config.json) | [`demo-enemy-list.save.json`](./examples/demo-enemy-list.save.json) | `battle.enemyList: "window"`。コマンド窓の右隣に敵名窓が出て、同名の敵が「扇風機・換気扇の羽根 ×3」にまとまる（倒すと個数が減り、全滅した行は消える） |
| エフェクト | [`demo-effects.config.json`](./examples/demo-effects.config.json) | [`demo-effects.save.json`](./examples/demo-effects.save.json) | `battle.effects` の `cast` / `impact` / `slash` / `magic`。通常攻撃の命中で `slash`（味方）・`impact`（敵）、「じゅもん」の「ひかり」で `cast` と `magic` |

手順は「敵レベルとレベル条件即死の確認」と同じ（`<名前>` は上表の機能名 `motion` / `enemy-list` / `effects`）:

1. 本番ビルドして静的配信する（手順 1）
2. `demo-<名前>.config.json` を `<出力先>` の直下にコピーする（手順 2）
3. sit-by-me を CORS 付きで配信し、コピーした設定とセーブの `8765` を置き換える（手順 3。この設定は感情吹き出しを使わないので `teramachi-emotions.json` の置換は要らない）
4. `demo-<名前>.save.json` を localStorage（`name-name-save-field-sample-0`）に入れ、`field-sample.html?resume=0&config=demo-<名前>.config.json` を開く。戦闘中のセーブの再開は、`battle.transition` の設定に関わらず遷移の演出を挟まず戦闘画面を開く（3 つの設定とも `transition` は未指定＝`none`。敵レベル節の `ff-mosaic` のような約 8〜12 秒の導入演出はない）。操作できるまでは、敵名窓・エフェクトは約 1 秒、motion は `snappy` の横スライド登場が終わる約 4〜5 秒（それ以前のクリックは効かない）。3 つともコマンドが 3 つ（たたかう・じゅもん・にげる）で、`commandLayout: "cross"` は 4 コマンドのときだけ有効なため `grid` 配置になり、矢印キーでは操作できない。コマンドはクリック（タップ）で選ぶ。「たたかう」はクリックでターゲットが自動で決まり、すぐ始まる。「じゅもん」は窓から「ひかり」を選んでターゲットをクリックする

**見た目の最終判断は KJ の実機で行う**。この手順は値が反映されることの確認までで、見た目の合格判定ではない。

## 状態異常の確認（#1051）

戦闘サンプル（`battle-sample.html`）の状態異常（毒・眠り・混乱・ゾンビ・死の宣告）を、実際のゲームと同じ形式の設定（トップレベルの `statuses`。書式は [デバッガガイド](./debugger.md)）で確かめる手順。確認用の設定は、寺町とは別の最小の一枚絵世界（シーン 1 つ・敵は同名の通常攻撃だけの「扇風機・換気扇の羽根」2 体。寺町の同梱設定には足さない）。敵の行動パターン・耐性は未搭載なので、どくのりゅうのような特技を使う敵は出ない。

| 設定 | セーブ | 見えるもの |
|---|---|---|
| [`demo-statuses.config.json`](./examples/demo-statuses.config.json) | [`demo-statuses.save.json`](./examples/demo-statuses.save.json) | 「じゅもん」の「どくのこな」「スリプル」「メダパニ」「デスぜんこく」で敵に状態が付く（敵は名前の後ろに `[どく]` のように出る）。「ケアル」「エスナ」「ゾンビのこな」は味方に使う。「ゾンビのこな」で味方がゾンビになると、敵の攻撃が回復になる |

手順は「motion / 敵名窓 / エフェクトの確認」と同じ（`<名前>` は `statuses`）。手順 4 の `demo-<名前>.save.json` を localStorage に入れ、`field-sample.html?resume=0&config=demo-statuses.config.json` を開く。コマンドは 3 つ（たたかう・じゅもん・にげる）で `grid` 配置のため矢印キーでは操作できず、コマンドはクリック（タップ）で選ぶ。「じゅもん」は窓から呪文を選んでターゲットをクリックする。

**見た目の最終判断は KJ の実機で行う**。この手順は値が反映されることの確認までで、見た目の合格判定ではない。

## 保存先の判断（localStorage のまま・IndexedDB へは移さない）

実測（`frontend/src` の型どおりに組んだ JSON の文字数。localStorage の上限は 1 オリジン 5 MiB ≒ UTF-16 で約 262 万文字を安全側に採用）:

| 項目 | 文字数 | 上限に対する割合 |
|---|---|---|
| 現行のノベルのセーブ 1 件（フラグ 40・入場時フラグ 40・立ち絵 4・背景/BGM あり） | 約 4,400 | 0.17 % |
| 寺町の例の RPG 状態（4 人・敵 2 体・戦闘中 ATB 込み） | 563 | 0.02 % |
| RPG 状態の最大級（6 人全項目・所持品 60・敵 8 体・ATB・敵の記憶） | 約 4,900 | 0.19 % |
| 1 スロット最大（ノベル 4,400 + RPG 4,900） | 約 9,300 | 0.36 % |
| 全セーブ最大（3 スロット + クイック = 4 件） | 約 37,000 | **1.4 %** |

- 余裕は 70 倍以上（上限の 1/4 以下という基準を大きく下回る）。`scriptContentCache` はすでに IndexedDB（localStorage ではない）。同じオリジンの localStorage を使う他の項目（設定・既読・エディタの下書き）を数百 KB 見込んでも、セーブが占めるのは 1 割に届かない
- 味方・敵はマスターとの差分だけを書くため、絵のデータ URI などでセーブが太らない（絵まで全部埋めると 1 エンティティ数 KB に膨らむ。差分方式にした理由）
- `SaveManager` は同期 API 前提で、IndexedDB へ移すと呼び出し箇所すべてが非同期になる。余裕が十分なので移さない（旧セーブの移行も不要）。上限が問題になったら、そのとき移す（セーブ形式 `RpgSaveState` は保存先に依存しない）

## 未対応・注意

- **装備は能力値に反映しない**: 一枚絵フィールドの設定に装備マスターが無いので、`equipment` は保存・復元・読み出しだけ。能力値への反映（`equipment.ts` の `resolveMemberEquipment` 相当）は、フィールドの設定に装備マスターを持たせる判断が要る
- **`gearShop` があるゲームで、手書きの resume セーブに `gear` が無いと、装備列にある店の刀は未購入扱いで外れる**（警告を画面とコンソールに出す。`equipment` にだけ書いても店の刀は残らない。`gear.owned` / `gear.blade` も書く）
- 所持品は設定の `items` に宣言されたものだけ（セーブにあって設定に無い id は警告して無視）
- 戦闘中状態は、敵の id がマスターに 1 つでも無ければ丸ごと無視して警告する（ATB の添字がずれるため）
- **一枚絵フィールドは `battle.script`（脚本制御の戦闘）を扱わない**: 設定から脚本を渡さないので、セーブの `battle.script` は無視される（エンジンは `restore.script` で脚本の進行を戻せるが、`script` オプションを渡した戦闘にだけ効く）。途中参戦（joiners）も同じく未使用
- **エンカウントの歩数（`encState`）は保存しない**: 再開直後は「戦闘後」と同じ初期状態（貯めた歩数 0・抑制あり）から数え直す
- **ATB の `wait` でもゲージは進む**: コマンド待ちの味方がいても、設定の ATB 方式（`wait` の停止範囲）に従って他の者のゲージは進みうる。再開直後に `rpg()` を読むと、保存した値から時間分だけ進んでいる（完全一致は保存した瞬間の値だけ）
- 戦闘中のセーブを `?resume=` で再開しても、`battle_motion` の登場スライドが有効（`snappy` など）なら戦闘画面を作り直すので、再開のたびに開始時のスライド登場をやり直す
- 戦闘中に保存して `?resume=` で再開した場合、敗北時に戻る「戦闘前」はそのセーブ時点（戦闘中の HP のまま始めた戦闘）の味方
- ノベル本編の再生（`NovelPlayer`）はこの `rpg` を使って戦闘へ入らない（本編パイプラインへの統合は別の話）
