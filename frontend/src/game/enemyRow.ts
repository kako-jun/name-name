/**
 * 敵の最前列 (#896) の純関数。FF のように、最前列にいない敵への通常攻撃（近接物理）のダメージを半分にする。
 *
 * - 隊列の宣言も設定も無い。敵のグリッド配置がある `battle_layout: side` の戦闘では常に効く（呼び出し側が `enemyRow: { grid }` を渡す）
 * - 最前列 = グリッドの占有セルの右端の列が最も右（手前）の列。戦闘開始時の配置で 1 回だけ決まる（倒れても変わらない）
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
