# 戦闘の検証ハーネス (#877 段階 3)

規則の組み合わせを総当たり・seed 固定のランダム合成で動かし、**壊れ**（進行不能・無限ループ・NaN・負 HP・maxHp 超過・ダメージ上限違反など）を一覧にする手動ツール。**検出のみ**で、上限の有効化・エンジンの修正・規則の変更はしない。

- 置き場: `frontend/src/game/battleHarness/`
- CI には入れていない（入れるかは未決）。通常の `npm test`（`vitest.config.ts`）にも総当たりは入らない。

## 使い方

```bash
cd frontend
npm run test:battle-harness                       # 総当たり（約 23,000 件・1 分弱）
HARNESS_RANDOM_COUNT=500 npm run test:battle-harness   # ランダム合成の件数を変える（既定 3000）
HARNESS_SEED=2 npm run test:battle-harness             # ランダム合成の seed を変える（既定 1）
HARNESS_SKIP=random,enemy-skill npm run test:battle-harness   # 族を省く
```

環境変数: `HARNESS_SEED` / `HARNESS_RANDOM_COUNT` / `HARNESS_SKIP`（`effect-matrix,enemy-skill,stack-order,reaction-chain,random`）/ `HARNESS_OUT`（出力先。既定 `frontend/battle-harness-out/`。git 管理外）/ `HARNESS_STRICT=1`（壊れがあれば失敗扱い。既定は一覧を出して成功）。

## 何を動かすか

| 族               | 内容                                                                                                                                                                                                                                                                                                                                                     |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `effect-matrix`  | 効果 DSL の動詞（`damage` / `heal` / `heal_full` / `damage_full` / `buff` / `debuff` / `status` / `revive` / `escape_battle` / `escape_dungeon`・不正な書式）× 範囲の境界値（0・負・min>max・極大）× `回数=N`（1・2・99・100 超・0・不正）× 対象範囲 × 耐性(`resist`)・属性相性(`affinity`) × HP（0・1・満タン・5 万・10 億）。味方が 3 回撃ってから攻撃 |
| `enemy-skill`    | 同じ効果を敵が特技（`行動:`）として使う。味方の HP は 1・100・5 万（hp0 は実質 hp1 と重複するので外した）                                                                                                                                                                                                                                                |
| `stack-order`    | 状態・バフ・デバフ・回復・ダメージの重ね順（長さ 4 の列の総当たり）× ターン制/ATB                                                                                                                                                                                                                                                                        |
| `reaction-chain` | 敵の `行動:` `反撃:` `死亡時:` に別々の特技を割り当てた組み合わせ × ターン制/ATB                                                                                                                                                                                                                                                                         |
| `random`         | seed 固定。能力値・HP を境界値から選び、呪文・敵の台本・ATB の有無・操作列（攻撃/呪文/道具/逃走/tick）をランダムに組む                                                                                                                                                                                                                                   |

エンジンの `opts.rng` に seed 固定の LCG を注入するので、同じシナリオは必ず同じ結果になる。操作列のあと、決着まで「攻撃 / ATB を進める」を最大 500 回押して、膠着していないかも見る。

## 出力

`battle-harness-out/`（再現時は `battle-harness-out/replay/`）に 2 つ。標準出力にも `report.md` と同じ内容が出る。

- `report.md`: 件数、族ごとの壊れ件数、**壊れ**（種類ごと・代表例つき）、**要判断**（`stalemate`: 行動は起きるが攻撃だけでは決着しない膠着）、**凄い組み合わせの候補**。
- `failures.json`: 壊れ・要判断のシナリオ（最大 5000 件）。seed・初期パーティ/敵・呪文/特技・操作列がそのまま入っているので、これだけで再現できる。

分類:

- 壊れ / 正常: 機械判定。違反が 1 件でもあれば壊れ。ただし負の `damage` 範囲・負の `resist` の扱いは #877 / #872 で未決で、ここでは暫定的に壊れに分類している。味方も全員 HP 0 の同時全滅で victory になる件は仕様の判断待ちで、`phase-mismatch` にはしていない。
- 凄い組み合わせ（強すぎ・許容）: **閾値を決めていない**。壊れでないシナリオの指標（1 行動の合計ダメージ・HP の減少量・回復量・ヒット数・バフ累積値）の上位を数値のまま並べるだけ。残す/潰すは人間が判断する。
- ダメージ上限違反は `damage` のヒットの量が 9999 超（`battleLimits.MAX_DAMAGE`）かで見る。`heal` は上限が未決のため検出せず、候補（`maxHealAmount`）に回す。`damage_full`（即死）の HP 減少は上限の対象外なので、`maxHpDrop` の候補に並ぶ。

検出する種類: `non-finite`（NaN/Infinity）/ `unsafe-integer` / `negative-hp` / `negative-mp` / `hp-over-max` / `mp-over-max` / `damage-over-cap` / `hit-direction`（damage で HP が増える・量が負など）/ `bad-log-text` / `phase-mismatch`（勝敗と生存者の食い違い）/ `atb-invariant`（ゲージ 0..1000・キューは生存者のみで重複なし・フェーズ整合）/ `lock`（HP・状態もイベントも変わらないまま進まない）/ `stalemate` / `event-flood` / `rng-budget` / `slow-op` / `exception`。

無限ループは「1 操作の乱数消費が 200 万回を超える」で止めて検出する（乱数を使わないループや同期的な無限ループまでは拾えない）。検出できないもの: エンジンが残すイベントは直近 30 件（`EVENT_MAX`）なので、1 操作で 30 件を超えて増えた分のヒットは検査されない。

ATB の不変条件（ゲージ 0..1000・キューは生存者のみ等）と `lcg` は `battleEngineAtb.test.ts` にもあり、正本が 2 つになっている。統合は後続。

## 失敗の再現

```bash
HARNESS_REPLAY=battle-harness-out/failures.json HARNESS_REPLAY_ID='effect-matrix/e2/敵単体/resist-1/hp100' \
  npm run test:battle-harness
```

`HARNESS_REPLAY_ID` を省くとファイル内の全件を再実行する。単体のシナリオ JSON（`Scenario` 1 件）もそのまま渡せる。結果は `battle-harness-out/replay/` の `report.md` と標準出力に出る（読み込み元の `failures.json` は上書きしない）。コードからは `runScenario(scenario)`（`run.ts`）を呼ぶ。

## テスト

ハーネス自体のテスト（`*.test.ts`）は通常の `npm test` に入る（合成エンジンで NaN・負 HP・ロック・無限ループを仕込んで検出できること、正常な戦闘で誤検出しないこと、seed 固定の再現、失敗 JSON からの再現。実行は数秒）。総当たり本体は `harness.sweep.mjs` で、通常実行からは除外している。入口が `.mjs` なので tsc / eslint には掛からない（型の無い node 入口の限界。`@types/node` が無いため `.ts` 化は見送り）。`HARNESS_RANDOM_COUNT` などの不正値と `HARNESS_SKIP` の未知の族名はエラーで止まる。
