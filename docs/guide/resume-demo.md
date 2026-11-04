# 状態を用意して起動する（セーブから途中再開）

任意の局面（パーティ・所持品・装備・所持金・フィールドの現在地・戦闘中の状態）を**セーブデータとして先に用意し、そこから再開して起動する**ための手順。デモ・不具合の再現・見た目の確認は、すべてこの一通りで行う（専用のサンプルマップや状態の作り方は持たない。#1021）。

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
- 所持品は設定の `items` に宣言されたものだけ（セーブにあって設定に無い id は警告して無視）
- 戦闘中状態は、敵の id がマスターに 1 つでも無ければ丸ごと無視して警告する（ATB の添字がずれるため）
- **一枚絵フィールドは `battle.script`（脚本制御の戦闘）を扱わない**: 設定から脚本を渡さないので、セーブの `battle.script` は無視される（エンジンは `restore.script` で脚本の進行を戻せるが、`script` オプションを渡した戦闘にだけ効く）。途中参戦（joiners）も同じく未使用
- **エンカウントの歩数（`encState`）は保存しない**: 再開直後は「戦闘後」と同じ初期状態（貯めた歩数 0・抑制あり）から数え直す
- **ATB の `wait` でもゲージは進む**: コマンド待ちの味方がいても、設定の ATB 方式（`wait` の停止範囲）に従って他の者のゲージは進みうる。再開直後に `rpg()` を読むと、保存した値から時間分だけ進んでいる（完全一致は保存した瞬間の値だけ）
- 戦闘中に保存して `?resume=` で再開した場合、敗北時に戻る「戦闘前」はそのセーブ時点（戦闘中の HP のまま始めた戦闘）の味方
- ノベル本編の再生（`NovelPlayer`）はこの `rpg` を使って戦闘へ入らない（本編パイプラインへの統合は別の話）
