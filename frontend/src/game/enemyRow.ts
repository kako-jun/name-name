/**
 * 敵の最前列 (#896) の純関数。FF のように、最前列にいない敵への通常攻撃（近接物理）のダメージを半分にする。
 *
 * - 隊列の宣言も設定も無い。敵のグリッド配置がある `battle_layout: side` の戦闘では常に効く（呼び出し側が `enemyRow: { grid }` を渡す）
 * - 最前列 = その時点で生きている敵のうち、占有セルの右端の列が最も右（手前）の列。配置は戦闘開始時に 1 回だけ引くが、最前列は動的（倒れたら繰り上がる。判定は `battleEngine.ts`）
 * - グリッドの位置が無い敵（置けなかった・グリッド無し）は軽減しない
 * - 軽減の係数は味方の後衛と同じ（`battleEngine.ts` の `applyRowToPhysicalDamage`。1 か所の定数）。魔法・特技・アイテムは影響しない
 */
import type { BattleEntity } from './spellDsl'
import { placeEnemies, type EnemyGridSize } from './enemyGrid'

/**
 * 敵ごとの「占有セルの右端の列」（グリッド上の位置。大きいほど手前）。入力は戦闘の敵の並び（`BattleScreen` の配置と同じ入力・同じ関数）。
 * 置けなかった敵（グリッドに収まらない）は含めない。グリッドが無ければ空
 */
export function enemyRightEdges(
  grid: EnemyGridSize | undefined,
  enemies: readonly BattleEntity[]
): Map<BattleEntity, number> {
  const edges = new Map<BattleEntity, number>()
  if (!grid) return edges
  const result = placeEnemies(
    grid,
    enemies.map((e): { w: number; h: number; at?: { col: number; row: number } } => ({
      w: e.layout?.w ?? 1,
      h: e.layout?.h ?? 1,
      ...(e.layout?.at ? { at: e.layout.at } : {}),
    }))
  )
  result.cells.forEach((cell, i) => {
    if (cell) edges.set(enemies[i], cell.col + (enemies[i].layout?.w ?? 1) - 1)
  })
  return edges
}

/**
 * 最前列の列（占有セルの右端の列の最大）。その時点で生きている敵の集合から毎回求め直す純関数（結果は持ち回さない）。
 * 倒れたら繰り上がり、将来敵が元のセルに復活したら、その敵の右端が最も右なら最前列は右へ戻る。
 * `edges` は戦闘開始時に引いた配置（誰がどのセルにいたか。戦闘中保持する）、`isAlive` は生死の判定。生きている敵が置けた敵に 1 体もいなければ -1（軽減なし）
 */
export function frontColumn(
  edges: ReadonlyMap<BattleEntity, number>,
  isAlive: (e: BattleEntity) => boolean
): number {
  let front = -1
  for (const [e, col] of edges) if (isAlive(e) && col > front) front = col
  return front
}
