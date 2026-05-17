/**
 * equipmentState.ts (#207) のユニットテスト。
 *
 * 純粋関数なので mock を立てず、ItemDef / PartyMemberDef を直書きして検証する。
 */
import { describe, expect, it, vi } from 'vitest'
import type { ItemDef, PartyMemberDef } from '../types'
import {
  ALL_EQUIPMENT_SLOTS,
  equipItem,
  getEquipmentBonus,
  getEquippableItems,
  getEquippedItem,
  initialEquipmentFromMember,
  unequipItem,
} from './equipmentState'

function makeItem(partial: Partial<ItemDef> & { id: string }): ItemDef {
  return {
    name: partial.name ?? partial.id,
    kind: partial.kind ?? 'その他',
    ...partial,
  }
}

const copperSword = makeItem({
  id: 'copper_sword',
  kind: '武器',
  equip_slot: 'weapon',
  atk_bonus: 8,
  equippable_by: ['hero'],
})
const ironSword = makeItem({
  id: 'iron_sword',
  kind: '武器',
  equip_slot: 'weapon',
  atk_bonus: 14,
})
const clothArmor = makeItem({
  id: 'cloth_armor',
  kind: '防具',
  equip_slot: 'armor',
  def_bonus: 4,
})
const cursedHelmet = makeItem({
  id: 'cursed_helmet',
  kind: '兜',
  equip_slot: 'helmet',
  def_bonus: -2,
})
const yakusou = makeItem({ id: 'やくそう', kind: '回復', effect: 'heal 30' })

const masterItems: Record<string, ItemDef> = {
  copper_sword: copperSword,
  iron_sword: ironSword,
  cloth_armor: clothArmor,
  cursed_helmet: cursedHelmet,
  やくそう: yakusou,
}

describe('ALL_EQUIPMENT_SLOTS', () => {
  it('は 4 スロット固定', () => {
    expect(ALL_EQUIPMENT_SLOTS).toEqual(['weapon', 'armor', 'shield', 'helmet'])
  })
})

describe('initialEquipmentFromMember', () => {
  it('equip 未指定なら空オブジェクト', () => {
    const member: PartyMemberDef = {
      id: 'hero',
      name: 'ゆうしゃ',
      hp: 20,
      atk: 5,
      def: 3,
      agi: 4,
    }
    expect(initialEquipmentFromMember(member)).toEqual({})
  })

  it('equip 指定があれば反映される', () => {
    const member: PartyMemberDef = {
      id: 'hero',
      name: 'ゆうしゃ',
      hp: 20,
      atk: 5,
      def: 3,
      agi: 4,
      equip: { weapon: 'copper_sword', armor: 'cloth_armor' },
    }
    expect(initialEquipmentFromMember(member)).toEqual({
      weapon: 'copper_sword',
      armor: 'cloth_armor',
    })
  })

  it('未知スロット名は捨てる', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const member: PartyMemberDef = {
      id: 'hero',
      name: 'ゆうしゃ',
      hp: 20,
      atk: 5,
      def: 3,
      agi: 4,
      // @ts-expect-error: 不正キーのフォールバック確認
      equip: { weapon: 'copper_sword', boots: 'leather_boots' },
    }
    expect(initialEquipmentFromMember(member)).toEqual({ weapon: 'copper_sword' })
    expect(warnSpy).toHaveBeenCalledOnce()
    warnSpy.mockRestore()
  })

  it('空文字 itemId は捨てる', () => {
    const member: PartyMemberDef = {
      id: 'hero',
      name: 'ゆうしゃ',
      hp: 20,
      atk: 5,
      def: 3,
      agi: 4,
      equip: { weapon: '' },
    }
    expect(initialEquipmentFromMember(member)).toEqual({})
  })
})

describe('equipItem', () => {
  it('空スロットに装備', () => {
    const next = equipItem({}, 'weapon', 'copper_sword')
    expect(next).toEqual({ weapon: 'copper_sword' })
  })

  it('装備済みスロットを上書き', () => {
    const next = equipItem({ weapon: 'copper_sword' }, 'weapon', 'iron_sword')
    expect(next).toEqual({ weapon: 'iron_sword' })
  })

  it('別スロットには影響しない', () => {
    const prev = { weapon: 'copper_sword', armor: 'cloth_armor' }
    const next = equipItem(prev, 'helmet', 'cursed_helmet')
    expect(next).toEqual({
      weapon: 'copper_sword',
      armor: 'cloth_armor',
      helmet: 'cursed_helmet',
    })
    expect(next).not.toBe(prev) // 不変更新
  })
})

describe('unequipItem', () => {
  it('装備済みを外す', () => {
    const next = unequipItem({ weapon: 'copper_sword', armor: 'cloth_armor' }, 'weapon')
    expect(next).toEqual({ armor: 'cloth_armor' })
  })

  it('空スロットを外しても新インスタンスを返す', () => {
    const prev = { armor: 'cloth_armor' }
    const next = unequipItem(prev, 'weapon')
    expect(next).toEqual({ armor: 'cloth_armor' })
    expect(next).not.toBe(prev)
  })
})

describe('getEquippedItem', () => {
  it('装備中のアイテムを返す', () => {
    const item = getEquippedItem({ weapon: 'copper_sword' }, 'weapon', masterItems)
    expect(item?.id).toBe('copper_sword')
  })

  it('未装備なら null', () => {
    expect(getEquippedItem({}, 'weapon', masterItems)).toBeNull()
  })

  it('master に存在しない itemId なら null', () => {
    expect(getEquippedItem({ weapon: 'phantom' }, 'weapon', masterItems)).toBeNull()
  })
})

describe('getEquipmentBonus', () => {
  it('空装備は 0/0', () => {
    expect(getEquipmentBonus({}, masterItems)).toEqual({ atk: 0, def: 0 })
  })

  it('武器のみ装備で atk のみ加算', () => {
    expect(getEquipmentBonus({ weapon: 'copper_sword' }, masterItems)).toEqual({
      atk: 8,
      def: 0,
    })
  })

  it('武器 + 防具 + 呪い兜の混在', () => {
    expect(
      getEquipmentBonus(
        {
          weapon: 'iron_sword',
          armor: 'cloth_armor',
          helmet: 'cursed_helmet',
        },
        masterItems
      )
    ).toEqual({ atk: 14, def: 2 }) // 4 - 2
  })

  it('master に無いアイテムは無視', () => {
    expect(getEquipmentBonus({ weapon: 'phantom_sword' }, masterItems)).toEqual({
      atk: 0,
      def: 0,
    })
  })
})

describe('getEquippableItems', () => {
  it('スロットが weapon のもののみ返す', () => {
    const list = getEquippableItems('hero', 'weapon', masterItems)
    const ids = list.map((i) => i.id).sort()
    expect(ids).toEqual(['copper_sword', 'iron_sword'])
  })

  it('equippable_by 未指定は誰でも装備可', () => {
    const list = getEquippableItems('prince', 'weapon', masterItems)
    expect(list.map((i) => i.id)).toContain('iron_sword') // 制限なし
  })

  it('equippable_by に含まれないメンバーは弾かれる', () => {
    const list = getEquippableItems('prince', 'weapon', masterItems)
    expect(list.map((i) => i.id)).not.toContain('copper_sword') // ['hero'] 限定
  })

  it('equippable_by が空配列なら誰でも装備可', () => {
    const items = {
      open_sword: makeItem({
        id: 'open_sword',
        kind: '武器',
        equip_slot: 'weapon',
        equippable_by: [],
        atk_bonus: 3,
      }),
    }
    const list = getEquippableItems('anyone', 'weapon', items)
    expect(list.map((i) => i.id)).toEqual(['open_sword'])
  })

  it('equip_slot 未指定のアイテムは装備候補から外れる', () => {
    const list = getEquippableItems('hero', 'weapon', { やくそう: yakusou })
    expect(list).toEqual([])
  })

  it('masterItems が空ならからの配列', () => {
    expect(getEquippableItems('hero', 'weapon', {})).toEqual([])
  })
})
