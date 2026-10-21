/**
 * DQ4 式エンカウント抽選の純関数実装 (#172)。
 *
 * - rate=0 / groups 空 / masters が解決不能で全滅 → null（不発）
 * - rate=1 で毎歩確実エンカウント（debug knob）
 * - rate=N で `rng() < 1/N` 抽選、当選したら groups から（重み指定があれば重み付きで、なければ均等に）1 つ選び、
 *   `+` 連結を分解してマスターから BattleEntity を組み立てる
 *
 * RaycastRenderer / TopDownRenderer の maybeRollEncounter から呼ばれる。
 * テストでは `rng` に固定値関数を渡して挙動を assert する。
 */

import type { MonsterDef } from '../types'
import type { BattleEntity, EnemyLayout } from './spellDsl'
import { hasOwn } from './ownProperty'
import { posesField } from './battleMotion'
import { affinityField } from './affinity'
import { lootField } from './loot'
import { parseEncounterGroup, pickGroupIndex, resolveEncounterGroup } from './enemyGroup'

/**
 * 敵の隊形上の大きさ・倍率・配置指定 (#839) を `BattleEntity.layout` にする。
 * `サイズ:`・`倍率:`・群の配置 `@C1` のどれも無い敵は何も付けない（従来の挙動を変えない）。
 * 戦闘エンジンは読まない（描画専用）。`def.size` / `def.scale` は parser が丸め済みなので再検証しない
 */
export function enemyLayoutField(
  def: MonsterDef,
  at: { col: number; row: number } | undefined
): { layout: EnemyLayout } | Record<string, never> {
  if (!def.size && def.scale === undefined && !at) return {}
  return {
    layout: {
      w: def.size?.w ?? 1,
      h: def.size?.h ?? 1,
      scale: def.scale ?? 1,
      ...(at ? { at: { col: at.col, row: at.row } } : {}),
    },
  }
}

export function rollEncounter(input: {
  rate: number
  groups: ReadonlyArray<string>
  masters: Record<string, MonsterDef>
  rng: () => number
}): BattleEntity[] | null {
  if (input.rate === 0) return null
  if (input.groups.length === 0) return null
  if (input.rng() >= 1 / input.rate) return null

  // 群の書式 (#839 段2): 配置 `@C1`・個数 `*3` `*1..3`・重み `:3`。修飾なしの群は従来と同じ解釈。
  // 重みがどの群にも無ければ従来の等確率抽選（乱数消費も同一）
  const parsedGroups = input.groups.map(parseEncounterGroup)
  const picked =
    parsedGroups[
      pickGroupIndex(
        parsedGroups.map((g) => g.weight),
        input.rng
      )
    ]
  for (const w of picked.warnings) console.warn(`[name-name] encounter group: ${w}`)
  const resolved = resolveEncounterGroup(picked, input.rng)
  const enemies = buildEnemyEntities(resolved, input.masters)
  return enemies.length > 0 ? enemies : null
}

/**
 * 解決済みの敵（id と配置）から、マスターの定義どおりに `BattleEntity` を組み立てる。マスターに無い id は警告して飛ばす。
 * `rollEncounter`（ランダムエンカウント）と、脚本制御の戦闘 (#741) の敵の組み立てが共有する（組み立て方は一か所）
 */
export function buildEnemyEntities(
  resolved: ReadonlyArray<{ id: string; at?: { col: number; row: number } }>,
  masters: Record<string, MonsterDef>
): BattleEntity[] {
  const enemies: BattleEntity[] = []
  for (const { id, at } of resolved) {
    // own-property のみ見る (#368)。素朴な `input.masters[id]` は Object.prototype も辿ってしまい、
    // エンカウントグループの id が `constructor` 等と一致すると `!def` ガードをすり抜けて
    // 関数オブジェクトを敵マスターとして組み立ててしまう。
    const def = hasOwn(masters, id) ? masters[id] : undefined
    if (!def) {
      console.warn(`[name-name] encounter group references unknown monster '${id}'`)
      continue
    }
    enemies.push({
      id: def.id,
      name: def.name,
      hp: def.hp,
      maxHp: def.hp,
      mp: def.mp ?? 0,
      maxMp: def.mp ?? 0,
      atk: def.atk,
      def: def.def,
      agi: def.agi,
      exp: def.exp,
      gold: def.gold,
      sprite: def.sprite,
      ...posesField(def.poses),
      ...(def.actions && def.actions.length > 0 ? { actions: [...def.actions] } : {}),
      ...(def.counters && def.counters.length > 0 ? { counters: [...def.counters] } : {}),
      ...(def.onDeath ? { onDeath: def.onDeath } : {}),
      ...affinityField(def.affinity),
      ...lootField(def.loot),
      ...enemyLayoutField(def, at),
    })
  }
  return enemies
}
