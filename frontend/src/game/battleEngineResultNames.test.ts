/** 戦闘後リザルト用の表示名 (#1039): newlyLearnedSpellNames / itemDisplayName */
import { describe, expect, it } from 'vitest'
import { BattleEngine, type SkillExecution } from './battleEngine'
import type { BattleEntity } from './spellDsl'

const ent = (id: string, over: Partial<BattleEntity> = {}): BattleEntity => ({
  id,
  name: id,
  hp: 500,
  maxHp: 500,
  mp: 9,
  maxMp: 9,
  atk: 1,
  def: 0,
  agi: 9,
  exp: 1,
  gold: 1,
  ...over,
})
const skills: Record<string, SkillExecution> = {
  a: { name: 'ほのおのいき', target: '相手単体', effect: 'damage 5..5', learns: 'flame' },
  b: { name: 'こおりのいき', target: '相手単体', effect: 'damage 5..5', learns: 'ice' },
}
const finish = (e: BattleEngine): void => {
  for (let i = 0; i < 300 && !e.isOver(); i++) e.selectAttack()
}
const make = (opts: ConstructorParameters<typeof BattleEngine>[2]) =>
  new BattleEngine([ent('hero')], [ent('boss', { hp: 100, maxHp: 100, actions: ['候補=b'] })], {
    rng: () => 0,
    skills,
    ...opts,
  })

describe('newlyLearnedSpellNames (#1039)', () => {
  it('覚えていなければ空', () => {
    const e = new BattleEngine([ent('hero', { atk: 999 })], [ent('s', { hp: 1, maxHp: 1 })], {
      rng: () => 0,
    })
    finish(e)
    expect(e.newlyLearnedSpellNames()).toEqual([])
  })

  it('初期の習得済みは含まず、この戦闘で新たに覚えたものだけを名前で返す', () => {
    const e = make({ learnedSpells: ['flame'], spellNames: { flame: 'ファイア', ice: 'ブリザド' } })
    finish(e)
    expect(e.getResult()?.learnedSpells).toContain('flame')
    expect(e.getResult()?.learnedSpells).toContain('ice')
    expect(e.newlyLearnedSpellNames()).toEqual(['ブリザド'])
  })

  it('名前が無い id は id のまま。spellNames 自体が無くても動く', () => {
    const e = make({ learnedSpells: ['flame'] })
    finish(e)
    expect(e.newlyLearnedSpellNames()).toEqual(['ice'])
  })

  it('初期値が全部で新規なしなら空（再び食らっても増えない）', () => {
    const e = make({ learnedSpells: ['flame', 'ice'], spellNames: { flame: 'ファイア' } })
    finish(e)
    expect(e.newlyLearnedSpellNames()).toEqual([])
  })
})

describe('itemDisplayName (#1039)', () => {
  it('名前があればその名前（個数なし）、無い id・プロトタイプ名は id のまま', () => {
    const e = new BattleEngine([ent('hero')], [ent('s')], { itemNames: { potion: 'ポーション' } })
    expect(e.itemDisplayName('potion')).toBe('ポーション')
    expect(e.itemDisplayName('elixir')).toBe('elixir')
    expect(e.itemDisplayName('toString')).toBe('toString')
    expect(new BattleEngine([ent('hero')], [ent('s')]).itemDisplayName('x')).toBe('x')
  })
})
