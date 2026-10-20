/**
 * 戦闘の「ゲームバランス上限」の定数と、HP 書き込みの共通口 (#877 段階 1)。
 *
 * 置くのは規則の外側にある定数だけ。次の現行定数は意味が違う（表示バッファ・安全弁）ので移していない:
 * - `battleEngine.ts`: `LOG_MAX` / `EVENT_MAX`（表示用バッファ）、`resolveDeaths` の回数ガード
 * - `battleAtb.ts`: `ATB_GAUGE_MAX` / `ATB_FILL_PER_AGI_MS` / `ATB_MAX_TICK_MS`、tick ループの安全弁
 * - `affinity.ts`: `DEATH_CHANCE_CAP`（即死の成功率の頭打ち。値の確定は #877 の後続段階）
 *
 * 上限を置かないもの: 敵 HP は kako-jun の決定（ラスボスは何万も必要）。味方 HP・回復量は未決のため、現状は上限なし。
 */

/** 1 回のダメージの上限（kako-jun 決定 2026-10-20）。HP の上限ではない */
export const MAX_DAMAGE = 9999

/**
 * 1 回の行動に含められるヒット数の上限（効果 DSL `damage … 回数=N` の `N` の上限、#879）。
 * 上限値は未決（#877 の検証で決める）。99 は暫定。ダメージ上限 `MAX_DAMAGE` はヒット 1 回ごとで、この回数とは独立
 */
export const MAX_HITS_PER_ACTION = 99

/** HP の下限。負値の回復などで HP を 0 未満にしない */
export const MIN_HP = 0

/** ダメージ量を `MAX_DAMAGE` で頭打ちにする。下限側は触らない（0 以下はそのまま返す） */
export function clampDamage(amount: number): number {
  return amount > MAX_DAMAGE ? MAX_DAMAGE : amount
}

/** HP を `MIN_HP`〜`maxHp` に収める。`maxHp` を省くと下限だけ適用（HP に上限を置かない） */
export function clampHp(hp: number, maxHp: number = Infinity): number {
  return Math.max(MIN_HP, Math.min(maxHp, hp))
}

/**
 * ダメージを HP に適用する唯一の口。ダメージを `MAX_DAMAGE` で頭打ちにし、HP は `MIN_HP` 未満にしない。
 * 実際に適用した（頭打ち後の）ダメージ量を返す。ログ・ダメージ表示にはこの戻り値を使う。
 */
export function applyDamageToHp(entity: { hp: number }, damage: number): number {
  const dealt = clampDamage(damage)
  entity.hp = clampHp(entity.hp - dealt)
  return dealt
}
