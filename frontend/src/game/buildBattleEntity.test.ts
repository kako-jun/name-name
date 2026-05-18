/**
 * buildHeroBattleEntity (#207) のユニットテスト。
 *
 * 装備変更で戦闘ダメージが変わる受け入れ条件の心臓部。装備 bonus が
 * atk/def に正しく焼き込まれること、master 不在アイテムが 0 扱いになることを検証する。
 */
import { describe, expect, it } from 'vitest'
import type { ItemDef, PartyMemberDef } from '../types'
import { buildHeroBattleEntity } from './buildBattleEntity'

function makeHero(partial: Partial<PartyMemberDef> = {}): PartyMemberDef {
  return {
    id: 'hero',
    name: 'ゆうしゃ',
    hp: 20,
    mp: 4,
    atk: 5,
    def: 3,
    agi: 4,
    ...partial,
  }
}

const masterItems: Record<string, ItemDef> = {
  copper_sword: {
    id: 'copper_sword',
    name: 'どうのつるぎ',
    kind: '武器',
    equip_slot: 'weapon',
    atk_bonus: 5,
  },
  cloth_armor: {
    id: 'cloth_armor',
    name: 'ぬののふく',
    kind: '防具',
    equip_slot: 'armor',
    def_bonus: 4,
  },
  wooden_shield: {
    id: 'wooden_shield',
    name: 'きのたて',
    kind: '盾',
    equip_slot: 'shield',
    def_bonus: 2,
  },
  leather_cap: {
    id: 'leather_cap',
    name: 'かわのぼうし',
    kind: '兜',
    equip_slot: 'helmet',
    def_bonus: 1,
  },
}

describe('buildHeroBattleEntity', () => {
  it('装備無しではパーティ定義の値がそのまま反映される', () => {
    const hero = makeHero()
    const entity = buildHeroBattleEntity(hero, {}, masterItems)
    expect(entity.id).toBe('hero')
    expect(entity.name).toBe('ゆうしゃ')
    expect(entity.hp).toBe(20)
    expect(entity.maxHp).toBe(20)
    expect(entity.mp).toBe(4)
    expect(entity.maxMp).toBe(4)
    expect(entity.atk).toBe(5)
    expect(entity.def).toBe(3)
    expect(entity.agi).toBe(4)
  })

  it('武器装備で atk が +5 される', () => {
    const hero = makeHero()
    const entity = buildHeroBattleEntity(hero, { weapon: 'copper_sword' }, masterItems)
    expect(entity.atk).toBe(10) // 5 + 5
    expect(entity.def).toBe(3) // 変わらず
  })

  it('全スロット装備で atk/def 両方加算される', () => {
    const hero = makeHero()
    const entity = buildHeroBattleEntity(
      hero,
      {
        weapon: 'copper_sword',
        armor: 'cloth_armor',
        shield: 'wooden_shield',
        helmet: 'leather_cap',
      },
      masterItems
    )
    expect(entity.atk).toBe(10) // 5 + 5
    expect(entity.def).toBe(10) // 3 + 4 + 2 + 1
  })

  it('master に存在しない装備 ID は 0 扱い（atk/def 加算なし）', () => {
    const hero = makeHero()
    const entity = buildHeroBattleEntity(
      hero,
      { weapon: 'phantom_sword', armor: 'cloth_armor' },
      masterItems
    )
    expect(entity.atk).toBe(5) // phantom_sword 無視
    expect(entity.def).toBe(7) // 3 + 4 (cloth_armor)
  })

  it('mp 未指定（undefined）なら 0 として扱う', () => {
    const hero = makeHero({ mp: undefined })
    const entity = buildHeroBattleEntity(hero, {}, masterItems)
    expect(entity.mp).toBe(0)
    expect(entity.maxMp).toBe(0)
  })
})
