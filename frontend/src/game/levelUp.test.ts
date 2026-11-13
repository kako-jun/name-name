import { describe, expect, it } from 'vitest'
import { applyBattleExp, applyVictoryExp, levelForExp, splitExp, type LevelUpDef } from './levelUp'
import { buildResultMessages } from './battleResult'
import { carryOverBattleResult } from '../field/fieldResume'
import type { BattleEntity } from './spellDsl'

const hero = (over: Partial<BattleEntity> = {}): BattleEntity => ({
  id: 'hero',
  name: 'ゆうしゃ',
  hp: 20,
  maxHp: 20,
  mp: 5,
  maxMp: 5,
  atk: 5,
  def: 3,
  agi: 4,
  exp: 0,
  ...over,
})
const def: LevelUpDef = {
  expTable: [10, 30, 70],
  growth: 'hp+5, atk+1',
  learns: [
    { level: 2, spell: 'heal', name: 'ホイミ' },
    { level: 4, spell: 'fire' },
  ],
}

describe('levelUp', () => {
  it('表から Lv を決める。終端で頭打ち', () => {
    expect(levelForExp(def, 0)).toBe(1)
    expect(levelForExp(def, 10)).toBe(2)
    expect(levelForExp(def, 69)).toBe(3)
    expect(levelForExp(def, 9999)).toBe(4)
  })

  it('1 レベル上がると成長が足され、習得を覚える', () => {
    const r = applyBattleExp(hero(), def, 12)
    expect(r.gained).toEqual([2])
    expect(r.member).toMatchObject({ level: 2, exp: 12, maxHp: 25, hp: 25, atk: 6 })
    expect(r.learnedNames).toEqual(['ホイミ'])
  })

  it('複数 Lv が同時に上がる。成長は回数分、習得は越えた分すべて（名前が無ければ id）', () => {
    const r = applyBattleExp(hero(), def, 100)
    expect(r.gained).toEqual([2, 3, 4])
    expect(r.member).toMatchObject({ level: 4, maxHp: 35, atk: 8 })
    expect(r.learnedNames).toEqual(['ホイミ', 'fire'])
  })

  it('上限 Lv では上がらない。表が無い味方・exp 0 は変わらない', () => {
    const top = hero({ level: 4, exp: 70 })
    expect(applyBattleExp(top, def, 50).gained).toEqual([])
    expect(applyBattleExp(top, def, 50).member.level).toBe(4)
    expect(applyBattleExp(hero(), undefined, 50).member).toEqual(hero())
    expect(applyBattleExp(hero(), def, 0).member).toEqual(hero())
  })

  it('初期 Lv が 1 より大きい味方は、その Lv の累計から始まる', () => {
    const r = applyBattleExp(hero(), { ...def, level: 3 }, 40)
    expect(r.gained).toEqual([4])
  })

  it('生存者に等分・端数切り捨て。倒れている味方は変わらない', () => {
    expect(splitExp(10, 3)).toBe(3)
    expect(splitExp(10, 0)).toBe(0)
    const b = hero({ id: 'b', name: 'b' })
    const dead = hero({ id: 'c', name: 'c', hp: 0 })
    const r = applyVictoryExp([hero(), b, dead], { hero: def, b: def, c: def }, 50)
    expect(r.party[0].exp).toBe(25)
    expect(r.party[2]).toBe(dead)
    expect(r.levelUps).toBe(2)
  })

  it('持ち越し: 勝利のときだけ配る。敗北・逃走は変わらない。リザルト文言に差し込む', () => {
    const run = (outcome: string) =>
      carryOverBattleResult<BattleEntity>({
        outcome,
        earnedGold: 0,
        menuItems: [],
        partyAfter: [hero()],
        before: { inventory: {}, gold: 0, party: [hero()] },
        exp: 12,
        grow: (p, e) => applyVictoryExp(p, { hero: def }, e).party,
      }).party[0]
    expect(run('victory').level).toBe(2)
    expect(run('defeat').level).toBeUndefined()
    expect(run('escaped').level).toBeUndefined()
    const lv = applyVictoryExp([hero()], { hero: def }, 12)
    expect(
      buildResultMessages({
        gold: 0,
        exp: 12,
        levelUps: lv.levelUps,
        levelLearnedSpellNames: lv.learnedNames,
        learnedSpellNames: [],
        lootNames: [],
      })
    ).toEqual(['戦いに勝った！', '12 けいけんち かくとく', 'レベルアップ', 'ホイミをおぼえた！'])
  })
})
