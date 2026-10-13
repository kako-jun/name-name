import { describe, it, expect } from 'vitest'
import {
  BattleEngine,
  applyRowToPhysicalDamage,
  computeAttackDamage,
  computeRowAttackDamage,
} from './battleEngine'
import type { BattleEntity } from './spellDsl'

function ent(over: Partial<BattleEntity> = {}): BattleEntity {
  return {
    id: 'e',
    name: 'e',
    hp: 100,
    maxHp: 100,
    mp: 0,
    maxMp: 0,
    atk: 20,
    def: 4,
    agi: 1,
    ...over,
  }
}

describe('隊列によるダメージ補正 (#747)', () => {
  it('前衛・未指定は補正なし（リテラル）', () => {
    expect(applyRowToPhysicalDamage(10, undefined, undefined)).toBe(10)
    expect(applyRowToPhysicalDamage(10, 'front', 'front')).toBe(10)
  })
  it('後衛が受ける物理ダメージは半分（切り捨て・最低 1）', () => {
    expect(applyRowToPhysicalDamage(10, undefined, 'back')).toBe(5)
    expect(applyRowToPhysicalDamage(11, undefined, 'back')).toBe(5)
    expect(applyRowToPhysicalDamage(1, undefined, 'back')).toBe(1)
  })
  it('後衛が与える近接物理ダメージも半分', () => {
    expect(applyRowToPhysicalDamage(10, 'back', undefined)).toBe(5)
    expect(applyRowToPhysicalDamage(13, 'back', 'front')).toBe(6)
  })
  it('攻撃側も防御側も後衛なら 2 回半分', () => {
    expect(applyRowToPhysicalDamage(20, 'back', 'back')).toBe(5)
  })
  it('通常攻撃: atk 20 vs def 4・rng 0 で前衛 18 / 受け手が後衛なら 9 / 攻め手が後衛でも 9（リテラル）', () => {
    const rng = () => 0
    expect(computeAttackDamage(ent(), ent(), rng)).toBe(18)
    expect(computeRowAttackDamage(ent(), ent(), rng)).toBe(18)
    expect(computeRowAttackDamage(ent(), ent({ row: 'back' }), rng)).toBe(9)
    expect(computeRowAttackDamage(ent({ row: 'back' }), ent(), rng)).toBe(9)
  })
  it('エンジン: 後衛の勇者への敵の攻撃は半分、勇者の攻撃も半分', () => {
    const hero = ent({ id: 'h', name: 'h', row: 'back' })
    const foe = ent({ id: 'f', name: 'f' })
    const engine = new BattleEngine([hero], [foe], { rng: () => 0 })
    engine.selectAttack()
    expect(foe.hp).toBe(91) // 100 - 9
    expect(hero.hp).toBe(91) // 100 - 9
  })
  it('エンジン: 隊列未指定は従来どおり（18 ダメージ）', () => {
    const hero = ent({ id: 'h', name: 'h' })
    const foe = ent({ id: 'f', name: 'f' })
    const engine = new BattleEngine([hero], [foe], { rng: () => 0 })
    engine.selectAttack()
    expect(foe.hp).toBe(82)
    expect(hero.hp).toBe(82)
  })
})
