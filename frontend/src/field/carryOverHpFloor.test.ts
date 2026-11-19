/** 脚本戦闘の `固定`/`下限` が付ける hpFloor は戦闘中だけの状態で、持ち越し後の通常戦闘に残らない (#1222) */
import { describe, expect, it } from 'vitest'
import { BattleEngine } from '../game/battleEngine'
import type { BattleEntity } from '../game/spellDsl'
import { carryOverBattleResult } from './fieldResume'

const ent = (over: Partial<BattleEntity>): BattleEntity => ({
  id: 'e',
  name: 'E',
  hp: 100,
  maxHp: 100,
  mp: 0,
  maxMp: 0,
  atk: 5,
  def: 1,
  agi: 2,
  ...over,
})

/** 終わるまで進める（ATB wait。コマンド待ちは攻撃で消化） */
function drive(e: BattleEngine): void {
  for (let i = 0; i < 2000 && !e.isOver(); i++) {
    if (e.getState().phase === 'party-input') e.selectAttack()
    else e.tick(200)
  }
}

describe('hpFloor の持ち越し (#1222)', () => {
  it('中断で終わった脚本戦闘のあと、通常戦闘で味方の HP が 0 まで下がる', () => {
    const hero = ent({ id: 'hero', name: 'ゆうしゃ', hp: 20, maxHp: 20, atk: 10, agi: 10 })
    const scripted = new BattleEngine(
      [hero],
      [ent({ id: 'boss', name: 'ボス', atk: 12, agi: 10 })],
      {
        rng: () => 0.5,
        atb: { mode: 'wait' },
        script: { id: 'x', rules: ['固定: 結果=中断 上限ターン=3'] },
      }
    )
    drive(scripted)
    expect(scripted.getState().phase).toBe('interrupted')
    expect(scripted.getState().party[0].hpFloor).toBe(1)

    const carried = carryOverBattleResult({
      outcome: 'interrupted',
      earnedGold: 0,
      menuItems: [],
      partyAfter: scripted.getState().party,
      before: { inventory: {}, gold: 0, party: [hero] },
    })
    expect(carried.party[0]).not.toHaveProperty('hpFloor')

    const normal = new BattleEngine(
      carried.party,
      [ent({ id: 'strong', name: 'つよい', hp: 9999, maxHp: 9999, atk: 999, agi: 99 })],
      { rng: () => 0.5, atb: { mode: 'wait' } }
    )
    drive(normal)
    expect(normal.getState().party[0].hp).toBe(0)
  })
})
