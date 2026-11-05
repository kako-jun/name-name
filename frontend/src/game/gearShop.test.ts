/** 刀・防具の所有と購入 (#881 段階1) の純関数のテスト */
import { describe, expect, it } from 'vitest'
import {
  buy,
  canBuy,
  checkGearState,
  emptyGearState,
  equipBlade,
  equippedBlade,
  canSell,
  grant,
  MAX_OWNED_PER_ITEM,
  ownedBladeCount,
  ownedCount,
  sell,
  sellPriceOf,
  parseGearShopConfig,
  priceOf,
  resolveGear,
  skillsForMember,
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

// 基準額・防具の価格はテスト用の値（100 円など）。決定値（基準額 10,000 円・防具 5,000 円）とは別
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
  it('同じ刀の重複を保存から読んでも 1 本として数える（次の値段が変わらない）', () => {
    const dup: GearState = { owned: { p1: ['a1', 'a1'] }, blade: {} }
    const resolved = resolveGear(dup, cfg).state
    expect(priceOf(cfg, resolved, 'p1', 'a2')).toBe(priceOf(cfg, own(['a1']), 'p1', 'a2'))
    expect(priceOf(cfg, resolved, 'p1', 'a2')).toBe(200)
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
    expect(equipBlade(cfg, st, def, roster, [], 'vest')).toMatchObject({
      reason: 'notBlade',
      message: '刀ではありません',
    })
    expect(equipBlade(cfg, st, def, roster, [], 'zzz').reason).toBe('unknown')
  })
  it('equipItem が拒否したら（アイテム宣言なし）失敗し、装備中も変えない', () => {
    const r = equipBlade(cfg, st, def, { items: {} }, ['a1'], 'a2')
    expect(r).toMatchObject({ ok: false, reason: 'equipFailed', equipment: ['a1'] })
    expect(r.state.blade).toEqual({})
  })
})

describe('新しい挙動 (#881 レビュー)', () => {
  it('購入済みには値段を付けない', () => {
    expect(canBuy(cfg, own(['a1']), 'p1', 'a1', 9999).price).toBeUndefined()
  })
  it('桁あふれは uncomputable（unbuyable と文言が違う）', () => {
    const c: GearShopConfig = {
      multiplier: 1e300,
      entries: [{ id: 'x', kind: 'blade', owner: 'p1', basePrice: 1e300 }],
    }
    const r = canBuy(c, emptyGearState(), 'p1', 'x', Infinity)
    expect(r).toMatchObject({ ok: false, reason: 'uncomputable', message: '値段を計算できません' })
    expect(r.message).not.toBe(canBuy(cfg, emptyGearState(), 'p1', 'nobase', 1).message)
  })
  it("multiplier が数でない・非有限・1 未満（型を破った定義）は文字列 '2' も含め uncomputable で拒否", () => {
    const c = { multiplier: '2' as unknown as number, entries: cfg.entries }
    expect(canBuy(c, own(['a1']), 'p1', 'a2', 99999)).toMatchObject({
      ok: false,
      reason: 'uncomputable',
    })
    for (const m of ['x', NaN, Infinity, 0.5, 0, -2, null]) {
      const bad = { multiplier: m as unknown as number, entries: cfg.entries }
      expect(canBuy(bad, own(['a1']), 'p1', 'a2', 99999).reason).toBe('uncomputable')
    }
    // 防具は倍率を使わないので影響されない
    expect(canBuy(c, emptyGearState(), 'p1', 'vest', 99999).ok).toBe(true)
  })
  const items: Record<string, ItemDef> = {
    a1: { id: 'a1', name: 'A1', kind: '武器' },
    a2: { id: 'a2', name: 'A2', kind: '武器' },
    outside: { id: 'outside', name: 'O', kind: '武器' },
  }
  it('同じ刀の再装備（prev === id）は変更なしで ok', () => {
    const st = own(['a1'])
    const r1 = equipBlade(cfg, st, { id: 'p1' }, { items }, [], 'a1')
    const r2 = equipBlade(cfg, r1.state, { id: 'p1' }, { items }, r1.equipment, 'a1')
    expect(r2).toMatchObject({ ok: true, equipment: ['a1'] })
    expect(equippedBlade(r2.state, 'p1')).toBe('a1')
  })
  it('店の外の武器を押し出す持ち替えは replaced に出る', () => {
    const r = equipBlade(cfg, own(['a1']), { id: 'p1' }, { items }, ['outside'], 'a1')
    expect(r).toMatchObject({ ok: true, equipment: ['a1'], replaced: 'outside' })
  })
  it('直前の刀からの持ち替えでは replaced は出ない', () => {
    const st = own(['a1', 'a2'])
    const r1 = equipBlade(cfg, st, { id: 'p1' }, { items }, [], 'a1')
    const r2 = equipBlade(cfg, r1.state, { id: 'p1' }, { items }, r1.equipment, 'a2')
    expect('replaced' in r2).toBe(false)
  })
  it('resolveGear: 装備列から外した刀を除く（定義から消えた・持ち主違い・未購入）。刀以外は残す', () => {
    const saved: GearState = {
      owned: { p1: ['a1', 'gone'], p2: ['a2'] },
      blade: { p1: 'gone', p2: 'a2' },
    }
    const equipment = { p1: ['gone', 'vest', 'a1', 'x'], p2: ['a2', 'b1'], p3: ['a1'] }
    const r = resolveGear(saved, cfg, equipment)
    expect(r.equipment).toEqual({ p1: ['vest', 'a1', 'x'], p2: [], p3: [] })
    expect(r.state.blade).toEqual({})
    expect(equipment.p1).toEqual(['gone', 'vest', 'a1', 'x']) // 入力は変えない
    expect(r.warnings.some((w) => w.startsWith('equipment.p1'))).toBe(true)
  })
  it('resolveGear: 購入済みで装備中の正常な刀は装備列に残り、equipment を渡さなければ返さない', () => {
    const saved: GearState = { owned: { p1: ['a1'] }, blade: { p1: 'a1' } }
    expect(resolveGear(saved, cfg, { p1: ['a1'] }).equipment).toEqual({ p1: ['a1'] })
    expect('equipment' in resolveGear(saved, cfg)).toBe(false)
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
  it('定義にない品・他人の刀は捨て（重複は個数として残す）、未購入の装備中は外す', () => {
    const r = resolveGear(
      { owned: { p1: ['a1', 'a1', 'zzz', 'b1'] }, blade: { p1: 'a2', p2: 'b1' } },
      cfg
    )
    expect(r.state.owned.p1).toEqual(['a1', 'a1'])
    expect(ownedCount(r.state, 'p1', 'a1')).toBe(2)
    expect(r.state.blade).toEqual({})
    expect(r.warnings).toHaveLength(4)
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
        { id: 'a1', kind: 'blade', owner: 'p1', basePrice: 100, unlockFlag: 'phone' }, // テスト用の値
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
  it('equipBonus (#881 段階2): 文字列が読まれ、読めない項目・不正な型は警告する（能力値はテスト用の値）', () => {
    const r = parseGearShopConfig({
      entries: [
        { id: 'a', kind: 'blade', owner: 'p', equipBonus: ' atk+5, def-1 ' },
        { id: 'b', kind: 'blade', owner: 'p' },
        { id: 'c', kind: 'blade', owner: 'p', equipBonus: 5 },
        { id: 'd', kind: 'armor', equipBonus: 'xxx+1' },
        { id: 'e', kind: 'armor', equipBonus: '' },
      ],
    })
    const [a, b, c, d, e] = r.value!.entries
    expect(a.equipBonus).toBe('atk+5, def-1')
    expect('equipBonus' in b).toBe(false)
    expect('equipBonus' in c).toBe(false)
    expect(d.equipBonus).toBe('xxx+1')
    expect('equipBonus' in e).toBe(false)
    expect(r.warnings.some((w) => w.includes('entries[2].equipBonus は文字列'))).toBe(true)
    expect(r.warnings.some((w) => w.includes('entries[3].equipBonus') && w.includes('xxx+1'))).toBe(
      true
    )
    expect(r.warnings.some((w) => w.includes('entries[4].equipBonus は文字列'))).toBe(true)
  })
  it('name・lockedMessage (#881 レビュー): 読まれ、空・不正は警告して無視', () => {
    const r = parseGearShopConfig({
      entries: [
        { id: 'a', kind: 'armor', name: ' 赤糸威 ', lockedMessage: '香林坊で' },
        { id: 'b', kind: 'armor', name: '', lockedMessage: 3 },
      ],
    })
    const [a, b] = r.value!.entries
    expect(a).toMatchObject({ name: '赤糸威', lockedMessage: '香林坊で' })
    expect('name' in b).toBe(false)
    expect('lockedMessage' in b).toBe(false)
    expect(r.warnings.filter((w) => w.includes('entries[1]'))).toHaveLength(2)
  })
  it('画像: image が読まれ、無ければキーなし・不正は警告して画像なし。別名 画像 は読まない', () => {
    const r = parseGearShopConfig({
      entries: [
        { id: 'a', kind: 'blade', owner: 'p', image: 'dummy/blade-a.png' }, // ダミーのパス（マスターからの派生画像は未作成）
        { id: 'b', kind: 'blade', owner: 'p', 画像: 'dummy/b.png' },
        { id: 'c', kind: 'blade', owner: 'p' },
        { id: 'd', kind: 'blade', owner: 'p', image: 3 },
      ],
    })
    const e = r.value!.entries
    expect(e[0].image).toBe('dummy/blade-a.png')
    expect('image' in e[1]).toBe(false)
    expect('image' in e[2]).toBe(false)
    expect('image' in e[3]).toBe(false)
    expect(r.warnings.filter((w) => /image/.test(w))).toHaveLength(1)
  })
  it('同じ owner の刀の basePrice が食い違うと警告（揃っていれば・別人なら出ない）', () => {
    const mk = (a: number, b: number, owner2 = 'p') =>
      parseGearShopConfig({
        entries: [
          { id: 'x', kind: 'blade', owner: 'p', basePrice: a },
          { id: 'y', kind: 'blade', owner: owner2, basePrice: b },
        ],
      })
    expect(mk(100, 200).warnings.some((w) => /basePrice が食い違/.test(w))).toBe(true)
    expect(mk(100, 100).warnings).toEqual([])
    expect(mk(100, 200, 'q').warnings).toEqual([])
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
    ['倍率が文字列', { multiplier: '2', entries: [] }, /multiplier/],
  ])('不正（%s）は警告する', (_n, raw, re) => {
    const r = parseGearShopConfig(raw)
    expect(r.warnings.some((w) => re.test(w))).toBe(true)
  })
  it("倍率が文字列 '2' は警告つきで既定の 2 に戻る", () => {
    const r = parseGearShopConfig({ multiplier: '2', entries: [] })
    expect(r.value?.multiplier).toBe(2)
    expect(r.warnings.some((w) => /multiplier/.test(w))).toBe(true)
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

describe('parseGearShopConfig: abilities (#881 段階3)', () => {
  it('刀の abilities を読む（重複は除く）。防具・不正は警告して捨てる', () => {
    const r = parseGearShopConfig({
      entries: [
        { id: 'a1', kind: 'blade', owner: 'p1', abilities: ['A', 'A', 'B'] },
        { id: 'a2', kind: 'blade', owner: 'p1', abilities: 'A' },
        { id: 'v', kind: 'armor', abilities: ['A'] },
      ],
    })
    expect(r.value?.entries[0].abilities).toEqual(['A', 'B'])
    expect(r.value?.entries[1].abilities).toBeUndefined()
    expect(r.value?.entries[2].abilities).toBeUndefined()
    expect(r.warnings.filter((w) => w.includes('abilities'))).toHaveLength(2)
  })
})

describe('skillsForMember (#881 段階3)', () => {
  const sk = (id: string) => ({ id })
  const skills = [sk('fixed'), sk('X'), sk('Y')]
  const shared: GearShopConfig = {
    multiplier: 2,
    entries: [
      { id: 'a1', kind: 'blade', owner: 'p1', abilities: ['X'] },
      { id: 'b1', kind: 'blade', owner: 'p2', abilities: ['X'] }, // 同じ特技が別の刀にも
      { id: 'a2', kind: 'blade', owner: 'p1', abilities: [] },
      { id: 'a3', kind: 'blade', owner: 'p1', abilities: ['Y'] },
    ],
  }
  const ids = (st: GearState, m: string) => skillsForMember(skills, shared, st, m).map((s) => s.id)
  it('同じ特技が複数の刀に挙がっていても、各自が自分の刀を装備したときだけ出る', () => {
    const st: GearState = { owned: { p1: ['a1'], p2: ['b1'] }, blade: { p1: 'a1' } }
    expect(ids(st, 'p1')).toEqual(['fixed', 'X'])
    expect(ids(st, 'p2')).toEqual(['fixed']) // 購入済みでも装備していない
    expect(ids({ ...st, blade: { p1: 'a1', p2: 'b1' } }, 'p2')).toEqual(['fixed', 'X'])
  })
  it('abilities: [] の刀を装備すると刀のわざは出ない（固定のわざだけ）', () => {
    const st: GearState = { owned: { p1: ['a2'] }, blade: { p1: 'a2' } }
    expect(ids(st, 'p1')).toEqual(['fixed'])
  })
  it('刀に abilities の宣言が無ければ skills そのまま', () => {
    const plain: GearShopConfig = {
      multiplier: 2,
      entries: [{ id: 'a1', kind: 'blade', owner: 'p1' }],
    }
    expect(skillsForMember(skills, plain, { owned: {}, blade: {} }, 'p1')).toEqual(skills)
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
  it('__proto__ キーの人物も往復で失われず、プロトタイプも汚れない', () => {
    const raw = JSON.parse(
      JSON.stringify({
        ...declared(),
        gear: { owned: { ['__proto__']: ['a1'] }, blade: { ['__proto__']: 'a1' } },
      })
    )
    const text = JSON.stringify(raw)
    expect(text).toContain('"__proto__"')
    const parsed = parseRpgSave(JSON.parse(text))
    expect(parsed.ok).toBe(true)
    const g = resolveRpg(JSON.parse(text), base).gear!
    expect(Object.keys(g.owned)).toEqual(['__proto__'])
    const c: GearShopConfig = {
      multiplier: 2,
      entries: [{ id: 'a1', kind: 'blade', owner: '__proto__', basePrice: 10 }],
    }
    const r = resolveGear(g, c, { ['__proto__']: ['a1'] })
    expect(Object.keys(r.state.owned)).toEqual(['__proto__'])
    expect(Object.keys(r.state.blade)).toEqual(['__proto__'])
    expect(Object.keys(r.equipment!)).toEqual(['__proto__'])
    expect(({} as Record<string, unknown>).a1).toBeUndefined()
    const snap = snapshotRpg(
      { party: [], inventory: {}, equipment: {}, gold: 0, gear: r.state },
      base
    )
    expect(Object.keys(JSON.parse(JSON.stringify(snap)).gear.owned)).toEqual(['__proto__'])
  })
  it('不正な gear は理由つきで失敗', () => {
    const r = parseRpgSave(declared({ gear: { owned: { p1: [3] }, blade: {} } }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/gear\.owned\.p1/)
  })
})

// ---- 段階5: 宝箱の入手（grant）・売却（sell） ----

const st = (owned: Record<string, string[]>): GearState => ({ owned, blade: {} })

describe('grant（買わない入手）', () => {
  it('個数が増える。重複して持てる。種類数は変わらない', () => {
    let s = st({ p1: ['a1'] })
    const r = grant(cfg, s, 'p1', 'a1')
    expect(r.ok).toBe(true)
    s = r.state
    expect(ownedCount(s, 'p1', 'a1')).toBe(2)
    expect(ownedBladeCount(cfg, s, 'p1')).toBe(1)
    expect(priceOf(cfg, s, 'p1', 'a2')).toBe(200)
  })
  it('未所持の刀を入手すると種類数が増え次の値段が上がる。個数指定も可', () => {
    const r = grant(cfg, st({}), 'p1', 'a1', 3)
    expect(ownedCount(r.state, 'p1', 'a1')).toBe(3)
    expect(ownedBladeCount(cfg, r.state, 'p1')).toBe(1)
    const r2 = grant(cfg, r.state, 'p1', 'a2')
    expect(priceOf(cfg, r2.state, 'p1', 'a3')).toBe(400)
  })
  it('防具も入手できる（持ち主なしの防具は誰でも）', () => {
    expect(ownedCount(grant(cfg, st({}), 'p2', 'vest').state, 'p2', 'vest')).toBe(1)
  })
  it('異常: 定義にない・他人の刀・不正な個数は拒否し状態を変えない', () => {
    const base = st({ p1: ['a1'] })
    expect(grant(cfg, base, 'p1', 'zzz').reason).toBe('unknown')
    expect(grant(cfg, base, 'p1', 'b1').reason).toBe('otherOwner')
    for (const n of [0, -1, 1.5, NaN, 10000])
      expect(grant(cfg, base, 'p1', 'a1', n).reason).toBe('badCount')
    const r = grant(cfg, base, 'p1', 'b1')
    expect(r.ok).toBe(false)
    expect(r.state).toEqual(base)
    expect(r.state).not.toBe(base)
  })
  it('入力は変えない', () => {
    const base = st({ p1: ['a1'] })
    grant(cfg, base, 'p1', 'a1')
    expect(base.owned.p1).toEqual(['a1'])
  })
  it('買った刀を宝箱でかぶって売っても、買値以上が戻る', () => {
    const b = buy(cfg, st({}), 'p1', 'a1', 1000)
    expect(b.price).toBe(100)
    const g = grant(cfg, b.state, 'p1', 'a1')
    const s = sell(cfg, g.state, 'p1', 'a1', b.gold)
    expect(s.ok).toBe(true)
    expect(s.price).toBeGreaterThanOrEqual(b.price as number)
    expect(s.price).toBe(100) // k=1 本目の値段 = 基準額
  })
})

describe('sell（余剰の売却）', () => {
  it('余剰は売れる。個数 -1・所持金 +売値。最後の1つは残る', () => {
    const r = sell(cfg, st({ p1: ['a1', 'a1'] }), 'p1', 'a1', 50)
    expect(r.ok).toBe(true)
    expect(r.price).toBe(100)
    expect(r.gold).toBe(150)
    expect(ownedCount(r.state, 'p1', 'a1')).toBe(1)
  })
  it('最後の1つは売れない（reason last・日本語）。未所持は売れない', () => {
    const base = st({ p1: ['a1'] })
    const r = sell(cfg, base, 'p1', 'a1', 50)
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('last')
    expect(r.message).toBe('最後の1つは売れません')
    expect(r.gold).toBe(50)
    expect(r.state).toEqual(base)
    expect(sell(cfg, base, 'p1', 'a2', 50).reason).toBe('notOwned')
  })
  it('異常: 定義にない・他人の刀・値段なし', () => {
    const base = st({ p1: ['a1', 'a1', 'nobase', 'nobase'] })
    expect(canSell(cfg, base, 'p1', 'zzz').reason).toBe('unknown')
    expect(canSell(cfg, base, 'p1', 'b1').reason).toBe('otherOwner')
    expect(canSell(cfg, base, 'p1', 'nobase').reason).toBe('unbuyable')
    expect(sellPriceOf(cfg, base, 'p1', 'nobase')).toBeUndefined()
  })
  it('刀の売値 = 持っている種類数 k 本目の値段（k=1〜5 で 1 / 2 / 4 / 8 / 16 倍、基準額 10,000）', () => {
    const big: GearShopConfig = {
      multiplier: 2,
      entries: ['a1', 'a2', 'a3', 'a4', 'a5'].map((id) => ({
        id,
        kind: 'blade' as const,
        owner: 'p1',
        basePrice: 10000,
      })),
    }
    const ids = ['a1', 'a2', 'a3', 'a4', 'a5']
    const expected = [10000, 20000, 40000, 80000, 160000]
    ids.forEach((_, i) => {
      const owned = ids.slice(0, i + 1)
      const state = st({ p1: [...owned, owned[0]] })
      expect(sell(big, state, 'p1', 'a1', 0).price).toBe(expected[i])
    })
  })
  it('倍率 3 でも式は「いま買う値段の半額」から導く', () => {
    const c3: GearShopConfig = { ...cfg, multiplier: 3 }
    // k=2 → いま買う値段 100*9=900 → 450
    expect(sellPriceOf(c3, st({ p1: ['a1', 'a1', 'a2'] }), 'p1', 'a1')).toBe(450)
  })
  it('防具は固定価格の半額（奇数は切り捨て）', () => {
    const c: GearShopConfig = { multiplier: 2, entries: [{ id: 'v', kind: 'armor', price: 5001 }] }
    expect(sell(c, st({ p1: ['v', 'v'] }), 'p1', 'v', 0).price).toBe(2500)
    expect(sell(cfg, st({ p1: ['vest', 'vest'] }), 'p1', 'vest', 0).price).toBe(400)
  })
  it('売っても種類数・次に買う値段は変わらない', () => {
    const s0 = st({ p1: ['a1', 'a1', 'a2'] })
    const before = priceOf(cfg, s0, 'p1', 'a3')
    const r = sell(cfg, s0, 'p1', 'a1', 0)
    expect(ownedBladeCount(cfg, r.state, 'p1')).toBe(2)
    expect(priceOf(cfg, r.state, 'p1', 'a3')).toBe(before)
    // 続けて売っても最後の1つは売れない
    expect(sell(cfg, r.state, 'p1', 'a1', 0).reason).toBe('last')
  })
  it('装備中の刀でも余剰は売れる。装備は外れない', () => {
    const s0: GearState = { owned: { p1: ['a1', 'a1'] }, blade: { p1: 'a1' } }
    const r = sell(cfg, s0, 'p1', 'a1', 0)
    expect(r.ok).toBe(true)
    expect(r.state.blade).toEqual({ p1: 'a1' })
  })
  it('入力は変えない', () => {
    const s0 = st({ p1: ['a1', 'a1'] })
    sell(cfg, s0, 'p1', 'a1', 0)
    expect(s0.owned.p1).toEqual(['a1', 'a1'])
  })
})

describe('個数のセーブ互換・往復', () => {
  it('checkGearState: 重複ありも正常。旧セーブ（重複なし）は個数 1', () => {
    expect(checkGearState({ owned: { p1: ['a1', 'a1'] }, blade: {} })).toBeNull()
    const old = resolveGear({ owned: { p1: ['a1', 'vest'] }, blade: {} }, cfg)
    expect(ownedCount(old.state, 'p1', 'a1')).toBe(1)
    expect(ownedCount(old.state, 'p1', 'vest')).toBe(1)
    expect(old.warnings).toEqual([])
  })
  it('resolveGear: 個数は往復で保たれ、他人の刀・定義にない品は捨てる', () => {
    const saved = st({ p1: ['a1', 'a1', 'a1', 'vest', 'vest'] })
    const r = resolveGear(JSON.parse(JSON.stringify(saved)), cfg)
    expect(ownedCount(r.state, 'p1', 'a1')).toBe(3)
    expect(ownedCount(r.state, 'p1', 'vest')).toBe(2)
    expect(ownedBladeCount(cfg, r.state, 'p1')).toBe(1)
    const bad = resolveGear(st({ p1: ['b1', 'b1', 'zzz', 'zzz'] }), cfg)
    expect(bad.state.owned.p1).toEqual([])
    expect(bad.warnings).toHaveLength(2) // 同じ警告は重ねない（b1 と zzz で 1 件ずつ）
  })
  it('gear キーなしのセーブは空', () => {
    expect(resolveGear(undefined, cfg).state).toEqual(emptyGearState())
  })
})

describe('段階5 レビュー対応: 文言・所持金・個数の上限', () => {
  it('理由文: 入手済み・持っていません・売るときの値段なし', () => {
    expect(canBuy(cfg, st({ p1: ['a1'] }), 'p1', 'a1', 1000).message).toBe('入手済み')
    expect(canSell(cfg, st({}), 'p1', 'a1').message).toBe('持っていません')
    const r = canSell(cfg, st({ p1: ['nobase', 'nobase'] }), 'p1', 'nobase')
    expect(r.reason).toBe('unbuyable')
    expect(r.message).toBe('値段が決まっていないため売れません')
  })
  it('sell: 所持金は MAX_GOLD で頭打ち。不正な所持金は拒否', () => {
    const s0 = st({ p1: ['a1', 'a1'] })
    expect(sell(cfg, s0, 'p1', 'a1', Number.MAX_SAFE_INTEGER - 10).gold).toBe(
      Number.MAX_SAFE_INTEGER
    )
    for (const g of [-1, NaN, Infinity]) {
      const r = sell(cfg, s0, 'p1', 'a1', g)
      expect(r.ok).toBe(false)
      expect(r.reason).toBe('badGold')
      expect(r.state).toEqual(s0)
    }
  })
  it('grant: 合計が上限を超えるなら拒否。ちょうど上限は可', () => {
    const full = grant(cfg, st({}), 'p1', 'a1', MAX_OWNED_PER_ITEM)
    expect(full.ok).toBe(true)
    expect(ownedCount(full.state, 'p1', 'a1')).toBe(MAX_OWNED_PER_ITEM)
    const over = grant(cfg, full.state, 'p1', 'a1')
    expect(over.ok).toBe(false)
    expect(over.reason).toBe('tooMany')
    expect(over.message).toContain('上限')
    expect(grant(cfg, st({ p1: ['a1'] }), 'p1', 'a1', MAX_OWNED_PER_ITEM).reason).toBe('tooMany')
  })
  it('resolveGear: 改ざんセーブで同じ id を大量に重ねても切り詰め・警告は 1 件ずつ', () => {
    const big = Array<string>(200000).fill('a1')
    const bad = Array<string>(200000).fill('zzz')
    const t0 = Date.now()
    const r = resolveGear({ owned: { p1: [...big, ...bad] }, blade: {} }, cfg)
    expect(Date.now() - t0).toBeLessThan(2000)
    expect(ownedCount(r.state, 'p1', 'a1')).toBe(MAX_OWNED_PER_ITEM)
    expect(r.warnings).toHaveLength(2) // 定義にない id 1 件 + 上限の切り詰め 1 件
    expect(r.warnings.some((w) => w.includes('上限'))).toBe(true)
  })
})
