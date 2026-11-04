/**
 * 所持金の効果（効果 DSL `gold` / `gold_all`、#881 段階4）の純関数。
 *
 * 所持金は**パーティ共通**（人物ごとではない。`RpgSaveState.gold`）。戦闘エンジンは所持金を持たない（ADR 0002）ので、
 * 効果は `EffectContext.gold`（ホストが渡す口）経由で適用する。ホストは `applyGoldChange` を呼んで新しい所持金を保存する。
 *
 * 規則（HP・MP の下限 0 と同じ流儀）:
 * - 増やす: `+N`。結果は `MAX_GOLD` で頭打ち
 * - 減らす: `-N`。足りない分は 0 で止める（借金・マイナスにしない。実際に減った額を `delta` で返す）
 * - 全額消費: 所持金が 0 になる
 * - 入力の所持金が負・NaN・Infinity なら 0 とみなす（壊れたセーブから壊れた値を広げない）
 */

/** 所持金の上限（仮）。`Number.MAX_SAFE_INTEGER` を超えて精度が落ちるのを防ぐ安全弁で、ゲームバランス上の上限ではない */
export const MAX_GOLD = Number.MAX_SAFE_INTEGER

/** 通貨名の既定（従来の勝利ログの表記）。sit-by-me は設定（`BattleEngineOptions.currencyName`）で「円」を指定する */
export const DEFAULT_CURRENCY_NAME = 'ゴールド'

/** 戦闘ログの「手に入れた」行。勝利ログと `gold` 効果のログが共通で使う（通貨名の表記を 1 か所に揃える） */
export function gainedCurrencyLog(amount: number, currencyName: string): string {
  return `${amount} ${currencyName}を てに いれた！`
}

/** 戦闘ログの「失った」行（`gold -N` の実際に減った額） */
export function lostCurrencyLog(amount: number, currencyName: string): string {
  return `${amount} ${currencyName}を うしなった！`
}

/** 所持金の変更。`add` の `amount` は符号つきの整数（負 = 減らす）、`all` = 全額消費 */
export type GoldChange = { mode: 'add'; amount: number } | { mode: 'all' }

export interface GoldChangeResult {
  /** 変更後の所持金（0〜`MAX_GOLD` の整数） */
  gold: number
  /** 実際に動いた額（増えたら正・減ったら負。不足や頭打ちで要求より小さくなりうる） */
  delta: number
}

/** 所持金として扱える値に直す（有限の 0 以上の数を整数に切り捨て、`MAX_GOLD` で頭打ち。それ以外は 0） */
function sanitizeGold(gold: number): number {
  if (!Number.isFinite(gold) || gold <= 0) return 0
  return Math.min(MAX_GOLD, Math.floor(gold))
}

/**
 * 所持金に変更を適用して新しい所持金を返す。入力は変えない。
 * `add` の `amount` が有限でない（NaN・Infinity）ときは何もしない（`delta` 0）
 */
export function applyGoldChange(gold: number, change: GoldChange): GoldChangeResult {
  const cur = sanitizeGold(gold)
  if (change.mode === 'all') return { gold: 0, delta: cur === 0 ? 0 : -cur }
  if (!Number.isFinite(change.amount)) return { gold: cur, delta: 0 }
  const amount = Math.trunc(change.amount)
  // 大きい値同士の足し算で精度を失わないよう、頭打ちは差で見る
  const next =
    amount >= 0 ? (amount > MAX_GOLD - cur ? MAX_GOLD : cur + amount) : Math.max(0, cur + amount)
  return { gold: next, delta: next - cur }
}
