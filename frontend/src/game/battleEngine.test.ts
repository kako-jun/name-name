import { describe, it, expect } from 'vitest'
import { BattleEngine, computeAttackDamage } from './battleEngine'
import type { BattleEntity } from './spellDsl'

function hero(overrides: Partial<BattleEntity> = {}): BattleEntity {
  return {
    id: 'hero',
    name: 'ゆうしゃ',
    hp: 20,
    maxHp: 20,
    mp: 4,
    maxMp: 4,
    atk: 5,
    def: 3,
    agi: 4,
    ...overrides,
  }
}

function slime(overrides: Partial<BattleEntity> = {}): BattleEntity {
  return {
    id: 'slime',
    name: 'スライム',
    hp: 10,
    maxHp: 10,
    mp: 0,
    maxMp: 0,
    atk: 3,
    def: 1,
    agi: 2,
    exp: 2,
    gold: 1,
    ...overrides,
  }
}

describe('computeAttackDamage', () => {
  it('atk - def/2 の最低値を 1 に保つ', () => {
    const a = hero({ atk: 1 })
    const d = hero({ def: 100 })
    expect(computeAttackDamage(a, d, () => 0)).toBe(1)
  })

  it('rng=0 で base ダメージ、rng=0.99 で base+variance', () => {
    const a = hero({ atk: 8 })
    const d = hero({ def: 4 })
    // base = max(1, 8 - 2) = 6, variance = floor(8/4) = 2
    expect(computeAttackDamage(a, d, () => 0)).toBe(6)
    expect(computeAttackDamage(a, d, () => 0.99)).toBe(8)
  })
})

describe('BattleEngine 基本フロー', () => {
  it('開始時に "あらわれた" ログが入って phase は party-input', () => {
    const eng = new BattleEngine([hero()], [slime()])
    expect(eng.getState().phase).toBe('party-input')
    expect(eng.getState().log[0]).toBe('スライム が あらわれた！')
  })

  it('attack でダメージが入り、敵が生きていれば敵ターン経由で party-input に戻る', () => {
    const eng = new BattleEngine([hero()], [slime({ hp: 100 })], { rng: () => 0 })
    eng.selectAttack()
    const s = eng.getState()
    // 味方 atk=5 def=1 → base=max(1,5-0)=5, variance=1, rng=0 → dmg=5
    expect(s.enemies[0].hp).toBe(95)
    // 敵が反撃: atk=3 def=3 → base=max(1, 3-1)=2, variance=0, rng=0 → dmg=2
    expect(s.party[0].hp).toBe(20 - 2)
    expect(s.phase).toBe('party-input')
  })

  it('敵を全て倒したら victory に遷移し exp/gold を集計', () => {
    const eng = new BattleEngine([hero({ atk: 1000 })], [slime(), slime({ id: 's2' })], {
      rng: () => 0,
    })
    eng.selectAttack('slime')
    eng.selectAttack('s2')
    const s = eng.getState()
    expect(s.phase).toBe('victory')
    expect(s.earnedExp).toBe(4) // 2 + 2
    expect(s.earnedGold).toBe(2)
  })

  it('全滅で defeat に遷移', () => {
    // 味方 hp=1、敵 atk=100 → 敵ターンで一撃死
    const eng = new BattleEngine([hero({ hp: 1, atk: 1 })], [slime({ atk: 100 })], {
      rng: () => 0,
    })
    eng.selectAttack()
    expect(eng.getState().phase).toBe('defeat')
  })

  it('escape: rng < 0.5 で escaped', () => {
    const eng = new BattleEngine([hero()], [slime()], { rng: () => 0 })
    eng.selectEscape()
    expect(eng.getState().phase).toBe('escaped')
  })

  it('escape: rng >= 0.5 で失敗、敵ターン後に party-input', () => {
    const eng = new BattleEngine([hero()], [slime()], { rng: () => 0.99 })
    eng.selectEscape()
    expect(eng.getState().phase).toBe('party-input')
    expect(eng.getState().log).toContain('しかし まわりこまれてしまった！')
  })

  it('isOver は victory / defeat / escaped で true', () => {
    const eng = new BattleEngine([hero({ atk: 1000 })], [slime()], { rng: () => 0 })
    expect(eng.isOver()).toBe(false)
    eng.selectAttack()
    expect(eng.isOver()).toBe(true)
  })
})

describe('BattleEngine 呪文 / アイテム', () => {
  it('selectSpell: builtin に解決して効果を発火', () => {
    // ザラキを敵 1 体に。rng=0 で即死
    const eng = new BattleEngine([hero()], [slime({ hp: 100 })], { rng: () => 0 })
    eng.selectSpell({
      name: 'ザラキ',
      mp: 0, // テストの簡単化
      target: '敵全体',
      builtin: 'zaraki',
    })
    expect(eng.getState().enemies[0].hp).toBe(0)
    expect(eng.getState().phase).toBe('victory')
  })

  it('selectSpell: 宣言的 effect (heal) で味方を回復', () => {
    // 敵 atk=0 にして敵ターンの反撃を無効化（heal 単独効果を assert したいため）
    const eng = new BattleEngine([hero({ hp: 5 })], [slime({ atk: 0 })], { rng: () => 0 })
    eng.selectSpell({
      name: 'ホイミ',
      mp: 0,
      target: '味方単体',
      effect: 'heal 15..15',
    })
    // heal で 5 → 20、敵 atk=0 でも最低保証 1 ダメージなので 20-1=19
    expect(eng.getState().party[0].hp).toBe(19)
  })

  it('selectSpell: MP 不足で発動しない', () => {
    const eng = new BattleEngine([hero({ mp: 0 })], [slime()], { rng: () => 0 })
    eng.selectSpell({
      name: 'メラ',
      mp: 2,
      target: '敵単体',
      effect: 'damage 8..8',
    })
    expect(eng.getState().enemies[0].hp).toBe(10) // 変化なし
    expect(eng.getState().log).toContain('MP が たりない！')
  })

  it('selectItem: builtin world_tree_drop で全員回復', () => {
    // 敵 atk=0 で反撃の最低 1 ダメージのみ反映 → 20-1=19
    const eng = new BattleEngine([hero({ hp: 1 })], [slime({ atk: 0 })], { rng: () => 0 })
    eng.selectItem({
      name: 'せかいじゅのしずく',
      builtin: 'world_tree_drop',
    })
    expect(eng.getState().party[0].hp).toBe(19)
  })
})

describe('BattleEngine ガード', () => {
  it('victory 後に attack を呼んでも何もしない', () => {
    const eng = new BattleEngine([hero({ atk: 1000 })], [slime()], { rng: () => 0 })
    eng.selectAttack()
    const before = eng.getState().log.length
    eng.selectAttack()
    expect(eng.getState().log.length).toBe(before) // 変化なし
  })

  it('escaped 後に呪文を呼んでも何もしない', () => {
    const eng = new BattleEngine([hero()], [slime()], { rng: () => 0 })
    eng.selectEscape()
    const before = eng.getState().log.length
    eng.selectSpell({ name: 'メラ', mp: 0, target: '敵単体', effect: 'damage 8..8' })
    expect(eng.getState().log.length).toBe(before)
  })
})
