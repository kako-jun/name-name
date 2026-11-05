/** アプリストア・そうび画面の計算部 (#881 段階2 / gearMenu.ts) のテスト。値段・能力値の数値はテスト用の値（決定値とは別） */
import { describe, expect, it } from 'vitest'
import {
  bonusDelta,
  buildAppStoreTabs,
  buildEquipContent,
  changeGear,
  equipmentDelta,
  formatDelta,
  formatPrice,
  gearRoster,
  purchase,
  type GearMenuContext,
} from './gearMenu'
import { emptyGearState, type GearShopConfig, type GearState } from './gearShop'
import { parseRpgSave, resolveRpg, snapshotRpg, RPG_SAVE_VERSION } from './rpgSave'
import type { BattleEntity } from './spellDsl'

const cfg: GearShopConfig = {
  multiplier: 2,
  entries: [
    { id: 'a1', kind: 'blade', owner: 'p1', basePrice: 100, equipBonus: 'atk+5', image: 'a1.png' },
    { id: 'a2', kind: 'blade', owner: 'p1', basePrice: 100, equipBonus: 'atk+8, agi-1' },
    { id: 'b1', kind: 'blade', owner: 'p2', basePrice: 300 },
    { id: 'nobase', kind: 'blade', owner: 'p1' },
    { id: 'locked', kind: 'blade', owner: 'p2', basePrice: 50, unlockFlag: 'phone' },
    { id: 'vest', kind: 'armor', price: 800, equipBonus: 'def+4' },
    { id: 'vest2', kind: 'armor', price: 900, equipBonus: 'def+6, hp+10' },
    { id: 'vest0', kind: 'armor' },
  ],
}
const names = { a1: '正宗', a2: '村正', b1: '菊一', vest: '赤糸威', vest2: '紫糸威' }

function ctx(over: Partial<GearMenuContext> = {}): GearMenuContext {
  return {
    cfg,
    state: emptyGearState(),
    gold: 1000,
    flags: {},
    names,
    equipment: {},
    members: ['p1', 'p2'],
    ...over,
  }
}
const have = (p1: string[], p2: string[] = [], blade: Record<string, string> = {}): GearState => ({
  owned: { p1, p2 },
  blade,
})

describe('formatPrice / 差分の文', () => {
  it('3 桁区切り＋通貨名（既定は円）。不正値は 0', () => {
    expect(formatPrice(1234567)).toBe('1,234,567円')
    expect(formatPrice(50, 'ゴールド')).toBe('50ゴールド')
    expect(formatPrice(-5)).toBe('0円')
    expect(formatPrice(Number.NaN)).toBe('0円')
  })
  it('差分は 0 を落とし、符号つき。変化なしは文で言う', () => {
    expect(bonusDelta({ atk: 5, def: 2 }, { atk: 8, def: 2, agi: -1 })).toEqual({ atk: 3, agi: -1 })
    expect(formatDelta({ atk: 3, agi: -1 })).toBe('ちから +3  すばやさ -1')
    expect(formatDelta({})).toBe('能力値は かわりません')
  })
})

describe('buildAppStoreTabs（人物ごとの一覧）', () => {
  it('タブは刀・防具。刀は選んだ人物の刀だけ、防具は誰でも', () => {
    const tabs = buildAppStoreTabs(ctx())
    expect(tabs.map((t) => t.label)).toEqual(['刀', '防具'])
    expect(tabs[0].entriesByParty!.p1.map((e) => e.id)).toEqual(['a1', 'a2', 'nobase'])
    expect(tabs[0].entriesByParty!.p2.map((e) => e.id)).toEqual(['b1', 'locked'])
    expect(tabs[1].entriesByParty!.p1.map((e) => e.id)).toEqual(['vest', 'vest2', 'vest0'])
  })
  it('値段は通貨名つき。買える行は明るく、画像と装備時の能力値を持つ', () => {
    const e = buildAppStoreTabs(ctx({ currencyName: '円' }))[0].entriesByParty!.p1[0]
    expect(e).toMatchObject({
      id: 'a1',
      label: '正宗',
      detail: '100円',
      enabled: true,
      image: 'a1.png',
    })
    expect(e.description).toContain('ちから +5')
    const other = buildAppStoreTabs(ctx({ currencyName: 'ゴールド' }))[0].entriesByParty!.p1[0]
    expect(other.detail).toBe('100ゴールド')
  })
  it('所持金ちょうどは買える・1 足りないと暗くなり、足りない額を理由に出す', () => {
    const just = buildAppStoreTabs(ctx({ gold: 100 }))[0].entriesByParty!.p1[0]
    expect(just.enabled).toBe(true)
    const short = buildAppStoreTabs(ctx({ gold: 99 }))[0].entriesByParty!.p1[0]
    expect(short.enabled).toBe(false)
    expect(short.detail).toBe('100円')
    expect(short.description).toContain('所持金が足りません（あと 1円）')
  })
  it('購入済みは印・選べない。次の刀の値段は倍になる', () => {
    const tabs = buildAppStoreTabs(ctx({ state: have(['a1']), gold: 150 }))
    const [a1, a2] = tabs[0].entriesByParty!.p1
    expect(a1).toMatchObject({ detail: '購入済み', enabled: false })
    expect(a1.description).toContain('購入済み')
    expect(a2).toMatchObject({ detail: '200円', enabled: false })
    expect(a2.description).toContain('あと 50円')
  })
  it('基準額なしは値段未定で買えず、解禁前は値段つきで理由を言う', () => {
    const t = buildAppStoreTabs(ctx())
    const nobase = t[0].entriesByParty!.p1[2]
    expect(nobase).toMatchObject({ detail: '値段未定', enabled: false })
    expect(nobase.description).toContain('値段が決まっていない')
    const locked = t[0].entriesByParty!.p2[1]
    expect(locked).toMatchObject({ detail: '50円', enabled: false })
    expect(locked.description).toContain('まだ買えません')
    const open = buildAppStoreTabs(ctx({ flags: { phone: true } }))[0].entriesByParty!.p2[1]
    expect(open.enabled).toBe(true)
  })
  it('人物を切り替えると一覧が変わる（他人の刀は出ない・値段も人物ごと）', () => {
    const t = buildAppStoreTabs(ctx({ state: have(['a1', 'a2'], []) }))[0].entriesByParty!
    expect(t.p1.map((e) => e.detail)).toEqual(['購入済み', '購入済み', '値段未定'])
    expect(t.p2[0].detail).toBe('300円')
  })
  it('定義にない id の名前は id のまま。人物が 0 人なら空', () => {
    const t = buildAppStoreTabs(ctx({ names: {} }))[0].entriesByParty!.p1[0]
    expect(t.label).toBe('a1')
    expect(buildAppStoreTabs(ctx({ members: [] }))[0].entriesByParty).toEqual({})
  })
})

describe('purchase', () => {
  it('買うと所有に足し、所持金を引く。装備はしない', () => {
    const r = purchase(ctx(), 'p1', 'a1')
    expect(r.ok).toBe(true)
    expect(r.gold).toBe(900)
    expect(r.state.owned.p1).toEqual(['a1'])
    expect(r.state.blade).toEqual({})
    expect(r.notice).toContain('正宗')
    expect(r.notice).toContain('100円')
  })
  it('所持金ちょうどで買え、0 円になる', () => {
    const r = purchase(ctx({ gold: 100 }), 'p1', 'a1')
    expect(r.ok).toBe(true)
    expect(r.gold).toBe(0)
  })
  it.each([
    ['不足', { gold: 99 }, 'p1', 'a1', '所持金が足りません（あと 1円）'],
    ['購入済み', { state: have(['a1']) }, 'p1', 'a1', '購入済み'],
    ['他人の刀', {}, 'p1', 'b1', '他の人の刀'],
    ['解禁前', {}, 'p2', 'locked', 'まだ買えません'],
    ['基準額なし', {}, 'p1', 'nobase', '値段が決まっていない'],
    ['売っていない', {}, 'p1', 'zzz', '売っていない'],
  ])('買えない（%s）は状態も所持金も変えない', (_n, over, member, id, msg) => {
    const c = ctx(over as Partial<GearMenuContext>)
    const r = purchase(c, member, id)
    expect(r.ok).toBe(false)
    expect(r.notice).toContain(msg)
    expect(r.gold).toBe(c.gold)
    expect(r.state).toEqual(c.state)
  })
})

describe('changeGear（持ち替え・差分）', () => {
  it('刀: 購入済みを装備すると装備列と blade が更新され、前の刀は外れ、差分が出る', () => {
    const c = ctx({
      state: have(['a1', 'a2'], [], { p1: 'a1' }),
      equipment: { p1: ['a1'] },
    })
    const r = changeGear(c, 'p1', 'a2')
    expect(r.ok).toBe(true)
    expect(r.equipment).toEqual(['a2'])
    expect(r.state.blade.p1).toBe('a2')
    expect(r.delta).toEqual({ atk: 3, agi: -1 })
  })
  it('刀: 何も装備していない状態からは全額が差分', () => {
    const r = changeGear(ctx({ state: have(['a1']) }), 'p1', 'a1')
    expect(r.ok).toBe(true)
    expect(r.equipment).toEqual(['a1'])
    expect(r.delta).toEqual({ atk: 5 })
  })
  it('刀: すでに装備中は変更なし（失敗扱いで状態不変）', () => {
    const c = ctx({ state: have(['a1'], [], { p1: 'a1' }), equipment: { p1: ['a1'] } })
    const r = changeGear(c, 'p1', 'a1')
    expect(r.ok).toBe(false)
    expect(r.notice).toContain('すでに装備')
    expect(r.equipment).toEqual(['a1'])
  })
  it('未購入・他人の品・売っていない品は装備できない', () => {
    expect(changeGear(ctx(), 'p1', 'a1')).toMatchObject({ ok: false })
    expect(changeGear(ctx({ state: have([], ['b1']) }), 'p1', 'b1').notice).toContain('他の人')
    expect(changeGear(ctx(), 'p1', 'zzz').notice).toContain('売っていない')
  })
  it('防具: 付けると 防具 枠に入り、別の防具へは入れ替わり、装備中の品を選ぶと外れる', () => {
    const c = ctx({ state: have(['vest', 'vest2']) })
    const on = changeGear(c, 'p1', 'vest')
    expect(on.ok).toBe(true)
    expect(on.equipment).toEqual(['vest'])
    expect(on.delta).toEqual({ def: 4 })
    const swap = changeGear({ ...c, equipment: { p1: ['vest'] } }, 'p1', 'vest2')
    expect(swap.equipment).toEqual(['vest2'])
    expect(swap.delta).toEqual({ def: 2, hp: 10 })
    const off = changeGear({ ...c, equipment: { p1: ['vest'] } }, 'p1', 'vest')
    expect(off.ok).toBe(true)
    expect(off.equipment).toEqual([])
    expect(off.delta).toEqual({ def: -4 })
  })
  it('刀と防具は別の枠で共存する。店の外の装備（魔石など）は触らない', () => {
    const c = ctx({ state: have(['a1', 'vest']), equipment: { p1: ['stoneX', 'a1'] } })
    const r = changeGear(c, 'p1', 'vest')
    expect(r.equipment).toEqual(['stoneX', 'a1', 'vest'])
  })
  it('入力は変えない', () => {
    const c = ctx({ state: have(['a1']), equipment: { p1: [] } })
    const snap = JSON.stringify(c)
    changeGear(c, 'p1', 'a1')
    expect(JSON.stringify(c)).toBe(snap)
  })
  it('equipmentDelta: 店にない id は 0 扱い', () => {
    expect(equipmentDelta(cfg, ['x'], ['a1', 'x'])).toEqual({ atk: 5 })
  })
  it('gearRoster: 刀は 武器・防具は 防具、持ち主だけが装備できる', () => {
    const r = gearRoster(cfg, names)
    expect(r.items!.a1).toMatchObject({ kind: '武器', equippableBy: ['p1'], name: '正宗' })
    expect(r.items!.vest).toMatchObject({ kind: '防具', equipBonus: 'def+4' })
    expect(r.items!.vest.equippableBy).toBeUndefined()
  })
})

describe('buildEquipContent（そうび画面）', () => {
  it('購入済みだけを刀 → 防具の順に出し、装備中の印と 2 枠の見出しを持つ', () => {
    const c = ctx({
      state: have(['a1', 'a2', 'vest'], ['b1'], { p1: 'a1' }),
      equipment: { p1: ['a1'] },
    })
    const out = buildEquipContent(c)
    expect(out.entriesByParty.p1.map((e) => [e.id, e.detail])).toEqual([
      ['a1', '装備中'],
      ['a2', '刀'],
      ['vest', '防具'],
    ])
    expect(out.entriesByParty.p2.map((e) => e.id)).toEqual(['b1'])
    expect(out.headerByParty.p1).toEqual([
      { label: 'スマホ（刀）', value: '正宗' },
      { label: 'タブレット（防具）', value: 'なし' },
    ])
    expect(out.headerByParty.p2[0].value).toBe('なし')
  })
  it('説明は持ち替えたときの差分。装備中の刀は「すでに」、装備中の防具は外した差分', () => {
    const c = ctx({
      state: have(['a1', 'a2', 'vest'], [], { p1: 'a1' }),
      equipment: { p1: ['a1', 'vest'] },
    })
    const rows = buildEquipContent(c).entriesByParty.p1
    expect(rows[0].description).toContain('すでに装備しています')
    expect(rows[1].description).toContain('ちから +3')
    expect(rows[1].description).toContain('すばやさ -1')
    expect(rows[2].description).toContain('はずすと まもり -4')
  })
  it('何も買っていない人は一覧が空。人物 0 人は空', () => {
    expect(buildEquipContent(ctx()).entriesByParty.p1).toEqual([])
    expect(buildEquipContent(ctx({ members: [] })).entriesByParty).toEqual({})
  })
  it('購入すると次の構築で「そうび」に現れる（購入→持ち替えの通し）', () => {
    let c = ctx()
    const bought = purchase(c, 'p1', 'a1')
    c = { ...c, state: bought.state, gold: bought.gold }
    expect(buildEquipContent(c).entriesByParty.p1.map((e) => e.id)).toEqual(['a1'])
    const eq = changeGear(c, 'p1', 'a1')
    c = { ...c, state: eq.state, equipment: { p1: eq.equipment } }
    expect(buildEquipContent(c).headerByParty.p1[0].value).toBe('正宗')
  })
})

describe('購入・持ち替え後のセーブ往復', () => {
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
  it('gear・所持金・装備列が保存され、JSON 往復して読み戻せる', () => {
    let c = ctx({ equipment: { p1: [] } })
    const b = purchase(c, 'p1', 'a1')
    c = { ...c, state: b.state, gold: b.gold }
    const e = changeGear(c, 'p1', 'a1')
    const snap = snapshotRpg(
      {
        party: [hero('p1')],
        inventory: {},
        equipment: { p1: e.equipment },
        gold: b.gold,
        gear: e.state,
      },
      base
    )
    const raw = JSON.parse(JSON.stringify(snap))
    expect(parseRpgSave(raw).ok).toBe(true)
    const back = resolveRpg(raw, base)
    expect(back.gold).toBe(900)
    expect(back.equipment).toEqual({ p1: ['a1'] })
    expect(back.gear).toEqual({ owned: { p1: ['a1'] }, blade: { p1: 'a1' } })
    // 読み戻した状態からアプリストアは「購入済み」・そうびは装備中になる
    const again = ctx({ state: back.gear!, gold: back.gold, equipment: back.equipment })
    expect(buildAppStoreTabs(again)[0].entriesByParty!.p1[0].detail).toBe('購入済み')
    expect(buildEquipContent(again).headerByParty.p1[0].value).toBe('正宗')
  })
  it('旧セーブ（gear なし）は従来どおり読め、gear キーが出ない', () => {
    const old = {
      version: RPG_SAVE_VERSION,
      party: [{ id: 'p1' }],
      items: {},
      equipment: {},
      gold: 5,
    }
    expect(parseRpgSave(old).ok).toBe(true)
    expect('gear' in resolveRpg(old as never, base)).toBe(false)
  })
})

describe('レビュー対応 (#881 段階2)', () => {
  it('表示名: 定義の name → [アイテム] の名前 → id の順（アプリストア・そうび・購入通知）', () => {
    const c = ctx({
      cfg: {
        multiplier: 2,
        entries: [
          { id: 'x1', kind: 'blade', owner: 'p1', basePrice: 10, name: '独自名' },
          { id: 'x2', kind: 'blade', owner: 'p1', basePrice: 10 },
          { id: 'x3', kind: 'blade', owner: 'p1', basePrice: 10 },
        ],
      },
      names: { x1: '無視される', x2: 'アイテム名' },
    })
    const labels = buildAppStoreTabs(c)[0].entriesByParty!.p1.map((e) => e.label)
    expect(labels).toEqual(['独自名', 'アイテム名', 'x3'])
    expect(purchase(c, 'p1', 'x1').notice).toContain('独自名')
    expect(gearRoster(c.cfg, c.names).items!.x1.name).toBe('独自名')
  })
  it('人物の定義の枠: 武器枠が 2 つなら刀を足しても店の外の武器が残る（枠の計算に定義を使う）', () => {
    const c = ctx({
      state: have(['a1']),
      equipment: { p1: ['oldsword'] },
      otherKinds: { oldsword: '武器' },
      defs: { p1: { id: 'p1', equipmentSlots: ['武器', '武器', '防具'] } },
    })
    const r = changeGear(c, 'p1', 'a1')
    expect(r.ok).toBe(true)
    expect(r.equipment).toEqual(['oldsword', 'a1'])
  })
  it('店の外の武器は同じ種類の枠に数えられ、枠 1 つなら入れ替わる（武器が 2 本並ばない）', () => {
    const c = ctx({
      state: have(['a1']),
      equipment: { p1: ['oldsword'] },
      otherKinds: { oldsword: '武器' },
    })
    expect(changeGear(c, 'p1', 'a1').equipment).toEqual(['a1'])
    // 種類を知らせない（従来）と枠に数えられない
    expect(changeGear({ ...c, otherKinds: undefined }, 'p1', 'a1').equipment).toEqual([
      'oldsword',
      'a1',
    ])
  })
  it('装備中の防具の判定は購入済みだけ（未購入の防具が装備列に居ても見出しに出さない）。複数枠は並べる', () => {
    const c = ctx({ state: have([], []), equipment: { p1: ['vest'] } })
    expect(buildEquipContent(c).headerByParty.p1[1].value).toBe('なし')
    const two = ctx({
      state: have(['vest', 'vest2']),
      equipment: { p1: ['vest', 'vest2'] },
      defs: { p1: { id: 'p1', equipmentSlots: ['武器', '防具', '防具'] } },
    })
    expect(buildEquipContent(two).headerByParty.p1[1].value).toBe('赤糸威、紫糸威')
  })
  it('解禁前の理由は定義側の文を書ける（既定は「まだ買えません」）', () => {
    const cfg2: GearShopConfig = {
      multiplier: 2,
      entries: [
        {
          id: 'l1',
          kind: 'armor',
          price: 10,
          unlockFlag: 'f',
          lockedMessage: '香林坊で話を聞くと買えます',
        },
        { id: 'l2', kind: 'armor', price: 10, unlockFlag: 'f' },
      ],
    }
    const e = buildAppStoreTabs(ctx({ cfg: cfg2 }))[1].entriesByParty!.p1
    expect(e[0].description).toContain('香林坊で話を聞くと買えます')
    expect(e[1].description).toContain('まだ買えません')
  })
})
