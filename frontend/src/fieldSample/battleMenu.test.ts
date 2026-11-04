import { describe, expect, it } from 'vitest'
import type { BattleEntity } from '../game/spellDsl'
import type { BattleItemEntry, BattleSpellEntry } from '../game/battleMenu'
import { buildBattleMenu } from './battleMenu'
import { equipBlade, resolveGear, type GearShopConfig, type GearState } from '../game/gearShop'
import type { EquipmentRoster } from '../game/equipment'
import type { ItemDef } from '../types'
import { parseRpgSave, snapshotRpg } from '../game/rpgSave'
import { EMPTY_STACK, buildMenuRows, openList, type MenuContext } from '../game/battleMenu'

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
    expect(m2.items![0].count).toBe(2) // 渡した設定そのものは書き換えない（持ち越しは呼び出し側の責務）
  })
})

describe('buildBattleMenu: わざ (#873)', () => {
  const party = [member('a'), member('b')]
  const skill = { id: 'slash', name: 'きる', target: '相手単体' }

  it('わざだけでも menu になり、味方ごと・要素ごとに別インスタンス。アイテム・呪文は空', () => {
    const skills = [skill]
    const m = buildBattleMenu({ party, spells: [], items: [], skills })!
    expect(Object.keys(m.skills!)).toEqual(['a', 'b'])
    expect(m.skills!.a).toEqual(skills)
    expect(m.skills!.a[0]).not.toBe(m.skills!.b[0])
    expect(m.skills!.a[0]).not.toBe(skills[0])
    expect(m.items).toEqual([])
  })

  it('わざが空・未指定なら skills キーを出さない（従来の形のまま）', () => {
    const m = buildBattleMenu({ party, spells: [spell('fire')], items: [], skills: [] })!
    expect('skills' in m).toBe(false)
    expect(buildBattleMenu({ party, spells: [], items: [], skills: [] })).toBeUndefined()
  })
})

describe('buildBattleMenu: たいせつなもの（#880 key）', () => {
  const party = [member('a')]
  it('key のアイテムは戦闘の候補窓に出さない', () => {
    const m = buildBattleMenu({
      party,
      spells: [],
      items: [item('potion', 1), { ...item('key', 1), key: true }],
    })
    expect(m?.items?.map((i) => i.id)).toEqual(['potion'])
  })
  it('たいせつなものしか無ければ menu 無し', () => {
    expect(
      buildBattleMenu({ party, spells: [], items: [{ ...item('key', 1), key: true }] })
    ).toBeUndefined()
  })
})

describe('buildBattleMenu: 装備中の刀のアビリティ (#881 段階3)', () => {
  const party = [member('p1'), member('p2')]
  const sk = (id: string) => ({ id, name: id, target: '相手単体' })
  // 刀 a1 = わざ A、a2 = わざ B（p1 の刀）。b1 = わざ C（p2 の刀）。`common` はどの刀にも属さない固定のわざ
  const skills = [sk('common'), sk('A'), sk('B'), sk('C')]
  const shop: GearShopConfig = {
    multiplier: 2,
    entries: [
      { id: 'a1', kind: 'blade', owner: 'p1', basePrice: 100, abilities: ['A'] },
      { id: 'a2', kind: 'blade', owner: 'p1', basePrice: 100, abilities: ['B'] },
      { id: 'b1', kind: 'blade', owner: 'p2', basePrice: 100, abilities: ['C'] },
    ],
  }
  const items: Record<string, ItemDef> = Object.fromEntries(
    shop.entries.map((e) => [
      e.id,
      { id: e.id, name: e.id, kind: '武器', equippableBy: [e.owner!] },
    ])
  )
  const def = { id: 'p1' }
  const roster: EquipmentRoster = { items }
  const ids = (m: ReturnType<typeof buildBattleMenu>, who: string) =>
    (m?.skills?.[who] ?? []).map((s) => s.id)
  const menu = (state: GearState) =>
    buildBattleMenu({ party, spells: [], items: [], skills, gear: { shop, state } })

  it('刀A装備 → Aが出る → 刀Bへ持ち替え → BになりAは出ない', () => {
    let st: GearState = { owned: { p1: ['a1', 'a2'] }, blade: {} }
    let eq: string[] = []
    const r1 = equipBlade(shop, st, def, roster, eq, 'a1')
    expect(r1.ok).toBe(true)
    st = r1.state
    eq = r1.equipment
    expect(ids(menu(st), 'p1')).toEqual(['common', 'A'])
    const r2 = equipBlade(shop, st, def, roster, eq, 'a2')
    expect(r2.ok).toBe(true)
    expect(ids(menu(r2.state), 'p1')).toEqual(['common', 'B'])
  })
  it('他人の刀・未購入の刀・装備していない刀は出ない（他人はそれぞれ自分の刀）', () => {
    const st: GearState = { owned: { p1: ['a1', 'a2'], p2: ['b1'] }, blade: { p1: 'a1', p2: 'b1' } }
    const m = menu(st)
    expect(ids(m, 'p1')).toEqual(['common', 'A']) // 購入済みでも装備していない a2(B) は出ない
    expect(ids(m, 'p2')).toEqual(['common', 'C']) // p1 の刀 A・B は p2 に出ない
    // 他人の刀を装備中と書かれても反映しない／未購入の刀を装備中と書かれても反映しない
    expect(ids(menu({ owned: { p1: [] }, blade: { p1: 'a1', p2: 'a1' } }), 'p1')).toEqual([
      'common',
    ])
    expect(ids(menu({ owned: { p1: ['a1'] }, blade: { p2: 'a1' } }), 'p2')).toEqual(['common'])
  })
  it('刀を装備していない人物は刀のわざが無い・固定のわざだけ（刀しかわざが無ければ skills キーなし）', () => {
    const m = menu({ owned: {}, blade: {} })
    expect(ids(m, 'p1')).toEqual(['common'])
    const only = buildBattleMenu({
      party,
      spells: [],
      items: [],
      skills: [sk('A')],
      gear: { shop, state: { owned: {}, blade: {} } },
    })
    expect(only).toBeUndefined()
  })
  it('gear なし・刀にアビリティの宣言なしは従来と同一', () => {
    const base = buildBattleMenu({ party, spells: [], items: [], skills })
    expect(ids(base, 'p1')).toEqual(['common', 'A', 'B', 'C'])
    const plain: GearShopConfig = {
      multiplier: 2,
      entries: [{ id: 'a1', kind: 'blade', owner: 'p1', basePrice: 100 }],
    }
    const withGear = buildBattleMenu({
      party,
      spells: [],
      items: [],
      skills,
      gear: { shop: plain, state: { owned: { p1: ['a1'] }, blade: { p1: 'a1' } } },
    })
    expect(withGear).toEqual(base)
  })
  it('セーブ → 再開で装備中の刀のわざが保たれる（持ち替えた後の刀）', () => {
    const rpgBase = { party: [member('p1')], enemy: () => undefined }
    const st: GearState = { owned: { p1: ['a1', 'a2'] }, blade: { p1: 'a2' } }
    const snap = snapshotRpg(
      { party: [member('p1')], inventory: {}, equipment: { p1: ['a2'] }, gold: 0, gear: st },
      rpgBase
    )
    const parsed = parseRpgSave(JSON.parse(JSON.stringify(snap)))
    if (!parsed.ok) throw new Error(parsed.error)
    const resolved = resolveGear(parsed.value.gear, shop, parsed.value.equipment)
    expect(resolved.warnings).toEqual([])
    expect(ids(menu(resolved.state), 'p1')).toEqual(['common', 'B'])
  })
  it('カーソル記憶: 持ち替えでわざ一覧が短くなり記憶位置が範囲外でも、先頭の選べる行から始まる', () => {
    const st: GearState = { owned: { p1: ['a1'] }, blade: { p1: 'a1' } }
    const rows = menu(st)!.skills!.p1 // common, A の 2 行
    const ctx: MenuContext = {
      rows: buildMenuRows('skill', rows, party[0]),
      maxRows: 4,
      entries: rows,
      party,
      enemies: [],
      actorIndex: 0,
    }
    const opened = openList(EMPTY_STACK, 'skill', ctx, 3) // 以前の刀では 4 行目を選んでいた
    expect(opened[0]).toMatchObject({ type: 'list', cursor: 0 })
  })
  it('カーソル記憶: 記憶位置がグレーの行でも使わず、先頭の選べる行から始まる', () => {
    const rows = [sk('x'), sk('y'), sk('z')]
    const ctx: MenuContext = {
      rows: buildMenuRows('skill', rows, party[0]).map((r, i) =>
        i === 1 ? { ...r, disabled: true } : r
      ),
      maxRows: 4,
      entries: rows,
      party,
      enemies: [],
      actorIndex: 0,
    }
    expect(openList(EMPTY_STACK, 'skill', ctx, 1)[0]).toMatchObject({ type: 'list', cursor: 0 })
    expect(openList(EMPTY_STACK, 'skill', ctx, 2)[0]).toMatchObject({ type: 'list', cursor: 2 })
  })
})
