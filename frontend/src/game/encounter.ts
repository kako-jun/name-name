/**
 * DQ4 式エンカウント抽選の純関数実装 (#172)。
 *
 * - rate=0 / groups 空 / masters が解決不能で全滅 → null（不発）
 * - rate=1 で毎歩確実エンカウント（debug knob）
 * - rate=N で `rng() < 1/N` 抽選、当選したら groups から重み均等で 1 つ選び、
 *   `+` 連結を分解してマスターから BattleEntity を組み立てる
 *
 * RaycastRenderer / TopDownRenderer の maybeRollEncounter から呼ばれる。
 * テストでは `rng` に固定値関数を渡して挙動を assert する。
 */

import type { MonsterDef } from '../types'
import type { BattleEntity } from './spellDsl'
import { hasOwn } from './ownProperty'

export function rollEncounter(input: {
  rate: number
  groups: ReadonlyArray<string>
  masters: Record<string, MonsterDef>
  rng: () => number
}): BattleEntity[] | null {
  if (input.rate === 0) return null
  if (input.groups.length === 0) return null
  if (input.rng() >= 1 / input.rate) return null

  const groupSpec = input.groups[Math.floor(input.rng() * input.groups.length)]
  const monsterIds = groupSpec
    .split('+')
    .map((s) => s.trim())
    .filter(Boolean)
  const enemies: BattleEntity[] = []
  for (const id of monsterIds) {
    // own-property のみ見る (#368)。素朴な `input.masters[id]` は Object.prototype も辿ってしまい、
    // エンカウントグループの id が `constructor` 等と一致すると `!def` ガードをすり抜けて
    // 関数オブジェクトを敵マスターとして組み立ててしまう。
    const def = hasOwn(input.masters, id) ? input.masters[id] : undefined
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
    })
  }
  return enemies.length > 0 ? enemies : null
}
