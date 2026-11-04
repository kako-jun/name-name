/**
 * 敵の前列・後列 (#896) の純関数。FF のように、最前列でない敵への通常攻撃（近接物理）のダメージを軽減する。
 *
 * - 有効化は frontmatter `battle_enemy_row: on`（既定 off。off なら従来の挙動・乱数の消費順は完全に不変）
 * - 敵の列の決め方（優先順）:
 *   1. モンスター定義の `隊列: 前衛 | 後衛`（`BattleEntity.formationRow`）
 *   2. `battle_enemy_grid` がある戦闘は、グリッド上の位置から導出する。生存している敵のうち、占有セルの右端の列が最も手前（右）の敵が前列、
 *      それ以外は後列。倒れた敵が出れば最前列は繰り上がる（攻撃のたびに再評価）。`隊列:` を書いた敵は、この「最も手前の列」の判定に加えない
 *   3. どちらも無い敵は前列（軽減なし）
 * - 軽減の係数は味方の後衛と同じ（`battleEngine.ts` の `applyRowToPhysicalDamage`。1 か所の定数）。魔法・特技・アイテムは影響しない
 * - 戦闘中の列変更は範囲外（#887）
 */
import type { BattleEntity, BattleRow } from './spellDsl'
import { placeEnemies, type EnemyGridSize } from './enemyGrid'
import { normalizeBattleRow } from './battleLayout'

/**
 * frontmatter `battle_enemy_row` の正規化。`on`（大小無視）だけ true、`off`・未指定・空は false。
 * それ以外は警告して false（`warn=false` は警告だけ止める。効かない組み合わせのとき）
 */
export function normalizeBattleEnemyRow(raw: string | null | undefined, warn = true): boolean {
  if (typeof raw !== 'string' || raw.trim() === '') return false
  const v = raw.trim().toLowerCase()
  if (v === 'on') return true
  if (v === 'off') return false
  if (warn) console.warn(`battle_enemy_row '${raw}' は on でも off でもないため無効にした`)
  return false
}

/**
 * モンスター定義の `隊列:`（生文字列）を `BattleEntity.formationRow` にする。書かない・空は何も付けない。
 * 値は parser が検証済み（前衛/後衛/前列/後列/front/back）。味方の `normalizeBattleRow` と同じ解釈
 */
export function formationRowField(
  raw: string | null | undefined
): { formationRow: BattleRow } | Record<string, never> {
  if (typeof raw !== 'string' || raw.trim() === '') return {}
  return { formationRow: normalizeBattleRow(raw) }
}

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
 * 敵 1 体の今の列。`隊列:` の宣言が最優先、無ければグリッドの右端の列から（生存している敵の中で最も手前なら前列）。
 * グリッドの位置が無い敵は `undefined`（＝呼び出し側の既存の `row` に任せる＝前列）
 */
export function resolveEnemyRow(
  enemy: BattleEntity,
  enemies: readonly BattleEntity[],
  edges: ReadonlyMap<BattleEntity, number>
): BattleRow | undefined {
  if (enemy.formationRow) return enemy.formationRow
  const mine = edges.get(enemy)
  if (mine === undefined) return undefined
  let front = -1
  for (const e of enemies) {
    if (e.hp <= 0 || e.formationRow) continue
    const edge = edges.get(e)
    if (edge !== undefined && edge > front) front = edge
  }
  return mine >= front ? 'front' : 'back'
}
