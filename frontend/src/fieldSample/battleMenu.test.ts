import { describe, expect, it } from 'vitest'
import type { BattleEntity } from '../game/spellDsl'
import type { BattleItemEntry, BattleSpellEntry } from '../game/battleMenu'
import { buildBattleMenu } from './battleMenu'

const member = (id: string): BattleEntity => ({
  id,
  name: id,
  hp: 10,
  maxHp: 10,
  mp: 5,
  maxMp: 5,
  atk: 1,
  def: 1,
  agi: 1,
})
const spell = (id: string): BattleSpellEntry => ({ id, name: id, mp: 3, target: '敵単体' })
const item = (id: string, count?: number): BattleItemEntry => ({
  id,
  name: id,
  ...(count !== undefined ? { count } : {}),
})

describe('buildBattleMenu (#890)', () => {
  const party = [member('a'), member('b')]

  it('呪文もアイテムも空なら menu 無し', () => {
    expect(buildBattleMenu({ party, spells: [], items: [] })).toBeUndefined()
  })

  it('呪文だけ指定ならアイテムは空配列', () => {
    const m = buildBattleMenu({ party, spells: [spell('fire')], items: [] })!
    expect(m.items).toEqual([])
    expect(Object.keys(m.spells!)).toEqual(['a', 'b'])
  })

  it('アイテムだけ指定なら、味方ごとの呪文は空配列', () => {
    const m = buildBattleMenu({ party, spells: [], items: [item('potion', 2)] })!
    expect(m.spells).toEqual({ a: [], b: [] })
    expect(m.items).toEqual([item('potion', 2)])
  })

  it('呪文は全味方 id をキーに、味方ごと・要素ごとに別インスタンス', () => {
    const spells = [spell('fire')]
    const m = buildBattleMenu({ party, spells, items: [] })!
    const a = m.spells!.a
    const b = m.spells!.b
    expect(a).toEqual(spells)
    expect(a).not.toBe(b)
    expect(a).not.toBe(spells)
    expect(a[0]).not.toBe(b[0])
    expect(a[0]).not.toBe(spells[0])
  })

  it('アイテムは config.items と非同一で、書き換えても config は変わらない（戦闘ごとに複製）', () => {
    const items = [item('potion', 2)]
    const cfg = { party, spells: [], items }
    const m1 = buildBattleMenu(cfg)!
    ;(m1.items![0] as BattleItemEntry).count = 0
    expect(items[0].count).toBe(2)
    const m2 = buildBattleMenu(cfg)!
    expect(m2.items).not.toBe(m1.items)
    expect(m2.items![0].count).toBe(2) // 次の戦闘は設定の所持数から始まる
  })
})
