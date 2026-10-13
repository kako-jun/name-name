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

describe('隊列補正: 境界・端数 (#747)', () => {
  it('back/back・rng 0・atk 20 vs def 4 は 18→9→4（リテラル）', () => {
    expect(computeRowAttackDamage(ent({ row: 'back' }), ent({ row: 'back' }), () => 0)).toBe(4)
  })
  it('(3, back, back) は 3→1→1 で 1', () => {
    expect(applyRowToPhysicalDamage(3, 'back', 'back')).toBe(1)
  })
  it('(2, back, undefined) は 1', () => {
    expect(applyRowToPhysicalDamage(2, 'back', undefined)).toBe(1)
  })
  it('(3, back, undefined) は 1（切り捨て）', () => {
    expect(applyRowToPhysicalDamage(3, 'back', undefined)).toBe(1)
  })
  it('(11, undefined, back) は 5（切り捨て）', () => {
    expect(applyRowToPhysicalDamage(11, undefined, 'back')).toBe(5)
  })
  it('(1, back, back) は最低 1', () => {
    expect(applyRowToPhysicalDamage(1, 'back', 'back')).toBe(1)
  })
  it('row: front 明示と未指定は同じ結果', () => {
    expect(applyRowToPhysicalDamage(7, 'front', undefined)).toBe(7)
    expect(applyRowToPhysicalDamage(7, undefined, 'front')).toBe(7)
  })
})

describe('隊列補正: 乱数の消費 (#747)', () => {
  function counter() {
    const state = { n: 0 }
    return {
      state,
      rng: () => {
        state.n++
        return 0
      },
    }
  }
  it('前衛 vs 前衛: 通常攻撃 1 回で rng 1 回', () => {
    const c = counter()
    computeRowAttackDamage(ent(), ent(), c.rng)
    expect(c.state.n).toBe(1)
  })
  it('攻め手が後衛でも rng 1 回', () => {
    const c = counter()
    computeRowAttackDamage(ent({ row: 'back' }), ent(), c.rng)
    expect(c.state.n).toBe(1)
  })
  it('受け手が後衛でも rng 1 回', () => {
    const c = counter()
    computeRowAttackDamage(ent(), ent({ row: 'back' }), c.rng)
    expect(c.state.n).toBe(1)
  })
  it('back/back でも rng 1 回', () => {
    const c = counter()
    computeRowAttackDamage(ent({ row: 'back' }), ent({ row: 'back' }), c.rng)
    expect(c.state.n).toBe(1)
  })
})

describe('隊列補正: 呪文・アイテムは影響しない (#747)', () => {
  const run = (heroRow: 'back' | undefined, foeRow: 'back' | undefined) => {
    const hero = ent({ id: 'h', name: 'h', mp: 10, maxMp: 10, row: heroRow })
    const foe = ent({ id: 'f', name: 'f', row: foeRow })
    const eng = new BattleEngine([hero], [foe], { rng: () => 0 })
    eng.selectSpell({ name: 'メラ', mp: 1, target: '敵単体', effect: 'damage 8..8' })
    return foe.hp
  }
  it('DSL 攻撃呪文: 前衛でも後衛の使用者でも敵に 8 ダメージ', () => {
    expect(run(undefined, undefined)).toBe(92)
    expect(run('back', undefined)).toBe(92)
  })
  it('DSL 攻撃呪文: 後衛の敵が対象でも 8 ダメージ（半減しない）', () => {
    expect(run(undefined, 'back')).toBe(92)
  })
  it('builtin 攻撃呪文 zaraki: 後衛の敵にも rng 0 で効く', () => {
    const hero = ent({ id: 'h', name: 'h', mp: 10, maxMp: 10 })
    const foe = ent({ id: 'f', name: 'f', row: 'back' })
    const eng = new BattleEngine([hero], [foe], { rng: () => 0 })
    eng.selectSpell({ name: 'ザラキ', mp: 1, target: '敵全体', builtin: 'zaraki' })
    expect(foe.hp).toBe(0)
  })

  const healTarget = (row: 'back' | undefined) => {
    const hero = ent({ id: 'h', name: 'h', mp: 10, maxMp: 10 })
    const ally = ent({ id: 'a', name: 'a', hp: 50, row })
    const foe = ent({ id: 'f', name: 'f' })
    const eng = new BattleEngine([hero, ally], [foe], { rng: () => 0 })
    return { eng, ally }
  }
  it('DSL 回復呪文: 前衛でも後衛の対象でも +15', () => {
    for (const row of [undefined, 'back' as const]) {
      const { eng, ally } = healTarget(row)
      eng.selectSpell({ name: 'ホイミ', mp: 1, target: '味方単体', effect: 'heal 15..15' }, 'a')
      expect(ally.hp).toBe(65)
    }
  })
  it('DSL アイテム: 前衛でも後衛の対象でも +15', () => {
    for (const row of [undefined, 'back' as const]) {
      const { eng, ally } = healTarget(row)
      eng.selectItem({ name: 'やくそう', effect: 'heal 15..15' }, 'a')
      expect(ally.hp).toBe(65)
    }
  })
  it('builtin アイテム world_tree_drop: 後衛の対象も全回復', () => {
    const hero = ent({ id: 'h', name: 'h' })
    const ally = ent({ id: 'a', name: 'a', hp: 1, row: 'back' })
    const eng = new BattleEngine([hero, ally], [ent({ id: 'f', name: 'f' })], { rng: () => 0 })
    eng.selectItem({ name: 'しずく', builtin: 'world_tree_drop' }, 'a')
    expect(ally.hp).toBe(100)
  })
  it('builtin 回復呪文 zaorik: 後衛の死亡した味方を蘇生（HP 全快）', () => {
    const hero = ent({ id: 'h', name: 'h', mp: 10, maxMp: 10 })
    const ally = ent({ id: 'a', name: 'a', hp: 0, row: 'back' })
    const eng = new BattleEngine([hero, ally], [ent({ id: 'f', name: 'f' })], { rng: () => 0 })
    eng.selectSpell({ name: 'ザオリク', mp: 1, target: '味方単体', builtin: 'zaorik' }, 'a')
    expect(ally.hp).toBe(100)
  })
})

describe('隊列補正: 敵の row・戦闘不能の境界 (#747)', () => {
  it('敵に row: back を付けても被弾が半減する（判断事項: 汎用エンジン）', () => {
    const hero = ent({ id: 'h', name: 'h' })
    const foe = ent({ id: 'f', name: 'f', row: 'back' })
    const engine = new BattleEngine([hero], [foe], { rng: () => 0 })
    engine.selectAttack()
    expect(foe.hp).toBe(91) // 100 - 9
    expect(hero.hp).toBe(91) // 後衛の敵の攻撃も半分: 後衛が与えるダメージ 18→9
  })
  it('HP1 の後衛は敵の攻撃（最低 1）で戦闘不能・全滅', () => {
    const hero = ent({ id: 'h', name: 'h', hp: 1, maxHp: 1, row: 'back' })
    const foe = ent({ id: 'f', name: 'f', atk: 1, def: 0 })
    const engine = new BattleEngine([hero], [foe], { rng: () => 0 })
    engine.selectAttack()
    expect(hero.hp).toBe(0)
    expect(engine.getState().phase).toBe('defeat')
  })
  it('防御が極端に高くても後衛の与ダメージは最低 1', () => {
    const hero = ent({ id: 'h', name: 'h', atk: 1, row: 'back' })
    const foe = ent({ id: 'f', name: 'f', def: 200 })
    const engine = new BattleEngine([hero], [foe], { rng: () => 0 })
    engine.selectAttack()
    expect(foe.hp).toBe(99)
  })
})
