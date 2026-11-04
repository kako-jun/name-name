/** 戦闘エンジンを通した `gold` 効果 (#881 段階4)。エンジンは所持金を持たないので、今は警告だけで何も起きない */
import { describe, expect, it } from 'vitest'
import { BattleEngine } from './battleEngine'
import type { BattleEntity } from './spellDsl'

const ent = (id: string, over: Partial<BattleEntity> = {}): BattleEntity => ({
  id,
  name: id,
  hp: 100,
  maxHp: 100,
  mp: 9,
  maxMp: 9,
  atk: 1,
  def: 0,
  agi: 1,
  exp: 1,
  gold: 7,
  ...over,
})
const gold = (effect: string) => ({ name: 'おかね', mp: 0, target: '敵単体', effect })

describe('戦闘エンジン × gold 効果', () => {
  it.each(['gold +10', 'gold -10', 'gold_all'])(
    '%s は警告だけで、例外も状態変化も起きない',
    (e) => {
      const foe = ent('foe')
      const hero = ent('hero')
      const eng = new BattleEngine([hero], [foe, ent('b')], { rng: () => 0.5 })
      expect(() => eng.selectSpell(gold(e), 'foe')).not.toThrow()
      expect(eng.getState().log).toContain('(警告: 所持金はこの場面では使えない)')
      expect(foe.hp).toBe(100)
      expect(hero.mp).toBe(9) // mp 0 の呪文。HP は同ターンの敵の通常攻撃で減るので見ない
      expect(eng.getState().earnedGold).toBe(0)
    }
  )

  it('特技・アイテム経由でも警告だけで、例外も状態変化も起きない', () => {
    const foe = ent('foe')
    const hero = ent('hero')
    const eng = new BattleEngine([hero], [foe, ent('b')], { rng: () => 0.5, currencyName: '円' })
    expect(() =>
      eng.selectSkill({ name: 'おかね', target: '敵単体', effect: 'gold +10' }, 'foe')
    ).not.toThrow()
    expect(eng.getState().log).toContain('(警告: 所持金はこの場面では使えない)')
    expect(foe.hp).toBe(100)
    const eng2 = new BattleEngine([hero], [foe, ent('b')], { rng: () => 0.5, currencyName: '円' })
    expect(() => eng2.selectItem({ name: 'さいふ', effect: 'gold_all' }, 'hero')).not.toThrow()
    expect(eng2.getState().log).toContain('(警告: 所持金はこの場面では使えない)')
    expect(foe.hp).toBe(100)
  })

  it('勝利ログの通貨名は既定が ゴールド、currencyName で差し替えられる', () => {
    const win = (opts: { currencyName?: string }) => {
      const eng = new BattleEngine([ent('hero', { atk: 999 })], [ent('foe', { hp: 1 })], {
        rng: () => 0.5,
        ...opts,
      })
      eng.selectAttack('foe')
      return eng.getState().log
    }
    expect(win({})).toContain('7 ゴールドを てに いれた！')
    expect(win({ currencyName: '円' })).toContain('7 円を てに いれた！')
  })
})
