/** 刀・防具の所有と購入 (#881 段階1) の純関数のテスト */
import { describe, expect, it } from 'vitest'
import {
  buy,
  canBuy,
  checkGearState,
  emptyGearState,
  equipBlade,
  equippedBlade,
  ownedBladeCount,
  parseGearShopConfig,
  priceOf,
  resolveGear,
  type GearShopConfig,
  type GearState,
} from './gearShop'
import type { EquipmentRoster } from './equipment'
import type { ItemDef } from '../types'
import {
  parseRpgSave,
  resolveRpg,
  snapshotRpg,
  RPG_SAVE_VERSION,
  type RpgSaveState,
} from './rpgSave'
import type { BattleEntity } from './spellDsl'

// 基準額・防具の価格は「仮」の値（本当の値は kako-jun が決める）
const cfg: GearShopConfig = {
  multiplier: 2,
  entries: [
    { id: 'a1', kind: 'blade', owner: 'p1', basePrice: 100 },
    { id: 'a2', kind: 'blade', owner: 'p1', basePrice: 100 },
    { id: 'a3', kind: 'blade', owner: 'p1', basePrice: 100 },
    { id: 'a4', kind: 'blade', owner: 'p1', basePrice: 100 },
    { id: 'a5', kind: 'blade', owner: 'p1', basePrice: 100 },
    { id: 'b1', kind: 'blade', owner: 'p2', basePrice: 300 },
    { id: 'nobase', kind: 'blade', owner: 'p1' },
    { id: 'locked', kind: 'blade', owner: 'p2', basePrice: 50, unlockFlag: 'phone' },
    { id: 'vest', kind: 'armor', price: 800 },
    { id: 'vest0', kind: 'armor' },
  ],
}

const own = (p1: string[], extra: Record<string, string[]> = {}): GearState => ({
  owned: { p1, ...extra },
  blade: {},
})

describe('priceOf: 値段 = 基準額 × 倍率^購入済み本数', () => {
  it('本数別（0〜4 本）で 1 / 2 / 4 / 8 / 16 倍', () => {
    const ids = ['a1', 'a2', 'a3', 'a4', 'a5']
    ids.forEach((id, n) => {
      const st = own(ids.slice(0, n))
      expect(priceOf(cfg, st, 'p1', id)).toBe(100 * 2 ** n)
    })
  })
  it('倍率を変えられる・端数は切り捨て', () => {
    const c: GearShopConfig = {
      multiplier: 1.5,
      entries: [
        { id: 'x', kind: 'blade', owner: 'p1', basePrice: 10 },
        { id: 'y', kind: 'blade', owner: 'p1', basePrice: 10 },
      ],
    }
    expect(priceOf(c, own(['y']), 'p1', 'x')).toBe(15)
    expect(priceOf(c, own(['x', 'y']), 'p1', 'x')).toBe(22)
  })
  it('人物ごとに数える（他人の購入は影響しない）', () => {
    const st = own(['a1', 'a2'], { p2: [] })
    expect(priceOf(cfg, st, 'p2', 'b1')).toBe(300)
    expect(ownedBladeCount(cfg, st, 'p1')).toBe(2)
  })
  it('防具は倍々にならない・刀の本数にも影響されない', () => {
    expect(priceOf(cfg, own(['a1', 'a2', 'vest']), 'p1', 'vest')).toBe(800)
    expect(ownedBladeCount(cfg, own(['a1', 'vest']), 'p1')).toBe(1)
  })
  it('基準額・価格なし・売り物にない id は undefined', () => {
    expect(priceOf(cfg, emptyGearState(), 'p1', 'nobase')).toBeUndefined()
    expect(priceOf(cfg, emptyGearState(), 'p1', 'vest0')).toBeUndefined()
    expect(priceOf(cfg, emptyGearState(), 'p1', 'zzz')).toBeUndefined()
  })
  it('桁あふれは undefined（購入不可）', () => {
    const c: GearShopConfig = {
      multiplier: 1e300,
      entries: [{ id: 'x', kind: 'blade', owner: 'p1', basePrice: 1e300 }],
    }
    expect(priceOf(c, emptyGearState(), 'p1', 'x')).toBe(undefined)
  })
})

describe('canBuy / buy', () => {
  it('所持金ちょうどで買える・残りは 0', () => {
    const r = buy(cfg, emptyGearState(), 'p1', 'a1', 100)
    expect(r.ok).toBe(true)
    expect(r.gold).toBe(0)
    expect(r.state.owned.p1).toEqual(['a1'])
  })
  it('1 円足りないと不足（状態・所持金は変わらない・入力も不変）', () => {
    const st = emptyGearState()
    const r = buy(cfg, st, 'p1', 'a1', 99)
    expect(r).toMatchObject({ ok: false, reason: 'notEnoughGold', price: 100, gold: 99 })
    expect(r.state).toEqual(emptyGearState())
    expect(st).toEqual(emptyGearState())
  })
  it('買うたびに次の値段が倍になる', () => {
    let st = emptyGearState()
    let gold = 10000
    const paid: number[] = []
    for (const id of ['a1', 'a2', 'a3']) {
      const r = buy(cfg, st, 'p1', id, gold)
      expect(r.ok).toBe(true)
      paid.push(gold - r.gold)
      st = r.state
      gold = r.gold
    }
    expect(paid).toEqual([100, 200, 400])
    expect(st.owned.p1).toEqual(['a1', 'a2', 'a3'])
  })
  it('購入済みは再購入できない（owned）。装備はしない', () => {
    const r = buy(cfg, own(['a1']), 'p1', 'a1', 9999)
    expect(r).toMatchObject({ ok: false, reason: 'owned', gold: 9999 })
    expect(buy(cfg, emptyGearState(), 'p1', 'a1', 9999).state.blade).toEqual({})
  })
  it('他人の刀は買えない', () => {
    expect(canBuy(cfg, emptyGearState(), 'p1', 'b1', 9999)).toMatchObject({
      ok: false,
      reason: 'otherOwner',
    })
  })
  it('基準額なしは購入不可（unbuyable）・価格なしの防具も', () => {
    expect(canBuy(cfg, emptyGearState(), 'p1', 'nobase', 9999)).toMatchObject({
      ok: false,
      reason: 'unbuyable',
    })
    expect(canBuy(cfg, emptyGearState(), 'p1', 'vest0', 9999)).toMatchObject({
      ok: false,
      reason: 'unbuyable',
    })
  })
  it('売り物にない id は unknown', () => {
    expect(canBuy(cfg, emptyGearState(), 'p1', 'zzz', 9999).reason).toBe('unknown')
  })
  it('解禁前は locked（値段つき）・フラグ true で買える・false は不可', () => {
    const before = canBuy(cfg, emptyGearState(), 'p2', 'locked', 9999, {})
    expect(before).toMatchObject({ ok: false, reason: 'locked', price: 50 })
    expect(canBuy(cfg, emptyGearState(), 'p2', 'locked', 9999, { phone: false }).reason).toBe(
      'locked'
    )
    expect(canBuy(cfg, emptyGearState(), 'p2', 'locked', 49, { phone: true }).reason).toBe(
      'notEnoughGold'
    )
    expect(canBuy(cfg, emptyGearState(), 'p2', 'locked', 50, { phone: true }).ok).toBe(true)
  })
  it('防具は固定価格で同じ API・人物ごとに別々に買える', () => {
    const r = buy(cfg, emptyGearState(), 'p1', 'vest', 1000)
    expect(r).toMatchObject({ ok: true, gold: 200 })
    const r2 = buy(cfg, r.state, 'p2', 'vest', 1000)
    expect(r2).toMatchObject({ ok: true, gold: 1000 - 800 })
    expect(r2.state.owned).toEqual({ p1: ['vest'], p2: ['vest'] })
  })
  it('所持金が NaN / 負は不足扱い', () => {
    expect(canBuy(cfg, emptyGearState(), 'p1', 'a1', NaN).reason).toBe('notEnoughGold')
    expect(canBuy(cfg, emptyGearState(), 'p1', 'a1', -5).reason).toBe('notEnoughGold')
  })
})

describe('equipBlade（equipItem を再利用）', () => {
  const items: Record<string, ItemDef> = {
    a1: { id: 'a1', name: 'A1', kind: '武器', equipBonus: 'atk+3', equippableBy: ['p1'] },
    a2: { id: 'a2', name: 'A2', kind: '武器', equipBonus: 'atk+5', equippableBy: ['p1'] },
    b1: { id: 'b1', name: 'B1', kind: '武器', equippableBy: ['p2'] },
    nobase: { id: 'nobase', name: 'N', kind: '武器' },
  }
  const roster: EquipmentRoster = { items }
  const def = { id: 'p1' }
  const st = own(['a1', 'a2'])

  it('購入済みの刀を装備し、装備中の刀 id が状態に入る', () => {
    const r = equipBlade(cfg, st, def, roster, [], 'a1')
    expect(r.ok).toBe(true)
    expect(r.equipment).toEqual(['a1'])
    expect(equippedBlade(r.state, 'p1')).toBe('a1')
    expect(st.blade).toEqual({})
  })
  it('持ち替えると前の刀は装備列から外れる', () => {
    const r1 = equipBlade(cfg, st, def, roster, ['a1'], 'a1')
    const r2 = equipBlade(cfg, r1.state, def, roster, r1.equipment, 'a2')
    expect(r2.ok).toBe(true)
    expect(r2.equipment).toEqual(['a2'])
    expect(equippedBlade(r2.state, 'p1')).toBe('a2')
  })
  it('防具など他の装備は持ち替えで残る', () => {
    const r = equipBlade(
      cfg,
      { owned: { p1: ['a1'] }, blade: {} },
      def,
      { items: { ...items, v: { id: 'v', name: 'V', kind: '防具' } } },
      ['v'],
      'a1'
    )
    expect(r.equipment).toEqual(['v', 'a1'])
  })
  it('未購入は notOwned・他人の刀は otherOwner・刀でない/未定義は unknown。状態は変わらない', () => {
    expect(equipBlade(cfg, st, def, roster, [], 'nobase')).toMatchObject({
      ok: false,
      reason: 'notOwned',
    })
    expect(equipBlade(cfg, own(['a1'], { p2: ['b1'] }), def, roster, [], 'b1')).toMatchObject({
      ok: false,
      reason: 'otherOwner',
      equipment: [],
    })
    expect(equipBlade(cfg, st, def, roster, [], 'vest').reason).toBe('unknown')
    expect(equipBlade(cfg, st, def, roster, [], 'zzz').reason).toBe('unknown')
  })
  it('equipItem が拒否したら（アイテム宣言なし）失敗し、装備中も変えない', () => {
    const r = equipBlade(cfg, st, def, { items: {} }, ['a1'], 'a2')
    expect(r).toMatchObject({ ok: false, reason: 'equipFailed', equipment: ['a1'] })
    expect(r.state.blade).toEqual({})
  })
})

describe('resolveGear（セーブと定義の突き合わせ）', () => {
  it('セーブなしは空', () => {
    expect(resolveGear(undefined, cfg)).toEqual({ state: emptyGearState(), warnings: [] })
  })
  it('正常はそのまま・警告なし', () => {
    const saved: GearState = { owned: { p1: ['a1', 'vest'] }, blade: { p1: 'a1' } }
    expect(resolveGear(saved, cfg)).toEqual({ state: saved, warnings: [] })
  })
  it('定義にない品・他人の刀・重複は捨て、未購入の装備中は外す', () => {
    const r = resolveGear(
      { owned: { p1: ['a1', 'a1', 'zzz', 'b1'] }, blade: { p1: 'a2', p2: 'b1' } },
      cfg
    )
    expect(r.state.owned.p1).toEqual(['a1'])
    expect(r.state.blade).toEqual({})
    expect(r.warnings).toHaveLength(5)
  })
})

describe('parseGearShopConfig', () => {
  it('未指定・false・null はキーなし・警告なし', () => {
    for (const v of [undefined, false, null])
      expect(parseGearShopConfig(v)).toEqual({ warnings: [] })
  })
  it('正常: 倍率の既定は 2', () => {
    const r = parseGearShopConfig({
      entries: [
        { id: 'a1', kind: 'blade', owner: 'p1', basePrice: 100, unlockFlag: 'phone' }, // 仮の値
        { id: 'v', kind: 'armor', price: 800 },
      ],
    })
    expect(r.warnings).toEqual([])
    expect(r.value?.multiplier).toBe(2)
    expect(r.value?.entries[0]).toEqual({
      id: 'a1',
      kind: 'blade',
      owner: 'p1',
      basePrice: 100,
      unlockFlag: 'phone',
    })
  })
  it('画像: image / 画像 のどちらでも読まれ、無ければキーなし・不正は警告して画像なし', () => {
    const r = parseGearShopConfig({
      entries: [
        { id: 'a', kind: 'blade', owner: 'p', image: 'dummy/blade-a.png' }, // 仮パス（マスターからの派生画像は未作成）
        { id: 'b', kind: 'blade', owner: 'p', 画像: 'dummy/b.png' },
        { id: 'c', kind: 'blade', owner: 'p' },
        { id: 'd', kind: 'blade', owner: 'p', image: 3 },
      ],
    })
    const e = r.value!.entries
    expect(e[0].image).toBe('dummy/blade-a.png')
    expect(e[1].image).toBe('dummy/b.png')
    expect('image' in e[2]).toBe(false)
    expect('image' in e[3]).toBe(false)
    expect(r.warnings.filter((w) => /image/.test(w))).toHaveLength(1)
  })
  it('基準額なしの刀は値段キーなしで読まれる（購入不可）', () => {
    const r = parseGearShopConfig({ entries: [{ id: 'a1', kind: 'blade', owner: 'p1' }] })
    expect(r.value?.entries).toEqual([{ id: 'a1', kind: 'blade', owner: 'p1' }])
    expect(r.warnings).toEqual([])
  })
  it.each([
    ['オブジェクトでない', 'yes', /gearShop/],
    ['entries が配列でない', { entries: 1 }, /entries/],
    ['id なし', { entries: [{ kind: 'blade', owner: 'p' }] }, /id/],
    ['kind 不正', { entries: [{ id: 'a', kind: 'axe' }] }, /kind/],
    ['刀に owner なし', { entries: [{ id: 'a', kind: 'blade' }] }, /owner/],
    [
      'id 重複',
      {
        entries: [
          { id: 'a', kind: 'armor' },
          { id: 'a', kind: 'armor' },
        ],
      },
      /重複/,
    ],
    [
      '基準額が負',
      { entries: [{ id: 'a', kind: 'blade', owner: 'p', basePrice: -1 }] },
      /basePrice/,
    ],
    ['価格が小数', { entries: [{ id: 'a', kind: 'armor', price: 1.5 }] }, /price/],
    ['刀に price', { entries: [{ id: 'a', kind: 'blade', owner: 'p', price: 5 }] }, /price/],
    ['unlockFlag が数', { entries: [{ id: 'a', kind: 'armor', unlockFlag: 3 }] }, /unlockFlag/],
    ['倍率が 1 未満', { multiplier: 0.5, entries: [] }, /multiplier/],
  ])('不正（%s）は警告する', (_n, raw, re) => {
    const r = parseGearShopConfig(raw)
    expect(r.warnings.some((w) => re.test(w))).toBe(true)
  })
  it('不正な項目は捨て、不正な値段は値段なし（購入不可）で残す', () => {
    const r = parseGearShopConfig({
      multiplier: 0.5,
      entries: [
        { id: 'a', kind: 'axe' },
        { id: 'b', kind: 'armor', price: -3 },
      ],
    })
    expect(r.value?.multiplier).toBe(2)
    expect(r.value?.entries).toEqual([{ id: 'b', kind: 'armor' }])
  })
})

describe('checkGearState', () => {
  it('正常は null', () => {
    expect(checkGearState({ owned: {}, blade: {} })).toBeNull()
  })
  it.each([
    ['オブジェクトでない', [], /gear/],
    ['owned なし', { blade: {} }, /owned/],
    ['owned の値が配列でない', { owned: { p: 'a' }, blade: {} }, /owned\.p/],
    ['owned の要素が文字列でない', { owned: { p: [1] }, blade: {} }, /owned\.p/],
    ['blade なし', { owned: {} }, /blade/],
    ['blade の値が空', { owned: {}, blade: { p: '' } }, /blade\.p/],
  ])('不正（%s）は理由を返す', (_n, raw, re) => {
    expect(checkGearState(raw)).toMatch(re)
  })
})

describe('セーブ往復（RpgSaveState.gear）', () => {
  const hero = (id: string): BattleEntity => ({
    id,
    name: id,
    hp: 1,
    maxHp: 1,
    mp: 0,
    maxMp: 0,
    atk: 1,
    def: 1,
    agi: 1,
  })
  const base = { party: [hero('p1')], items: [], flags: {}, enemy: () => undefined }
  const declared = (extra: Record<string, unknown> = {}): RpgSaveState =>
    ({
      version: RPG_SAVE_VERSION,
      party: [{ id: 'p1' }],
      items: {},
      equipment: {},
      gold: 5,
      ...extra,
    }) as RpgSaveState

  it('旧セーブ（gear なし）はそのまま通り、解決・スナップショットとも gear キーが出ない', () => {
    expect(parseRpgSave(declared()).ok).toBe(true)
    const resolved = resolveRpg(declared(), base)
    expect('gear' in resolved).toBe(false)
    const snap = snapshotRpg({ party: resolved.party, inventory: {}, equipment: {}, gold: 5 }, base)
    expect('gear' in snap).toBe(false)
  })
  it('gear は検証を通り、解決→スナップショットで一致し、JSON 往復しても通る', () => {
    const gear: GearState = { owned: { p1: ['a1', 'a2'] }, blade: { p1: 'a2' } }
    const raw = declared({ gear })
    const parsed = parseRpgSave(raw)
    expect(parsed.ok).toBe(true)
    const resolved = resolveRpg(raw, base)
    expect(resolved.gear).toEqual(gear)
    const snap = snapshotRpg(
      { party: resolved.party, inventory: {}, equipment: {}, gold: 5, gear: resolved.gear },
      base
    )
    expect(snap.gear).toEqual(gear)
    expect(parseRpgSave(JSON.parse(JSON.stringify(snap))).ok).toBe(true)
  })
  it('不正な gear は理由つきで失敗', () => {
    const r = parseRpgSave(declared({ gear: { owned: { p1: [3] }, blade: {} } }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/gear\.owned\.p1/)
  })
})
