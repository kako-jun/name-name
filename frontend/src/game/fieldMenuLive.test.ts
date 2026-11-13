/** 全画面メニューの中身の組み立てと「使う」の解決 (#880 / fieldMenuLive.ts) のテスト */
import { describe, expect, it } from 'vitest'
import type { BattleItemEntry, BattleSkillEntry, BattleSpellEntry } from './battleMenu'
import type { FieldMenuItemDef } from './fieldMenu'
import {
  applyLiveContent,
  buildItemTabs,
  buildMagicByParty,
  buildStatusRows,
  categoryOfEffect,
  isFieldUsableEntry,
  itemCategory,
  orderedItems,
  sortItemsByCategory,
  useFieldItem,
  useFieldSpell,
  type LiveRpg,
} from './fieldMenuLive'
import type { BattleEntity } from './spellDsl'
import type { LevelUpDef } from './levelUp'

const ent = (id: string, over: Partial<BattleEntity> = {}): BattleEntity => ({
  id,
  name: id.toUpperCase(),
  hp: 10,
  maxHp: 40,
  mp: 6,
  maxMp: 6,
  atk: 1,
  def: 1,
  agi: 1,
  ...over,
})

const items: BattleItemEntry[] = [
  { id: 'bomb', name: 'ばくだん', effect: 'damage 5..9', count: 2 },
  { id: 'potion', name: 'ポーション', effect: 'heal 20..20', count: 3, description: '回復薬' },
  { id: 'antidote', name: 'どくけし', effect: 'cure 毒', count: 1 },
  { id: 'phoenix', name: 'フェニックス', effect: 'revive hp=half', count: 1 },
  { id: 'ether', name: 'エーテル', effect: 'heal 1..1', count: 0 },
  { id: 'key', name: 'さびたかぎ', key: true, count: 1, description: '古い扉を開ける' },
  { id: 'chimera', name: 'つばさ', builtin: 'wing_of_chimera', count: 1 },
]
const spells: BattleSpellEntry[] = [
  { id: 'fire', name: 'ほのお', mp: 3, target: '敵単体', effect: 'damage 8..14' },
  { id: 'cure', name: 'ケアル', mp: 2, target: '味方単体', effect: 'heal 15..15' },
  { id: 'curaga', name: 'ケアルガ', mp: 5, target: '味方全体', effect: 'heal 10..10' },
  { id: 'pray', name: 'いのり', mp: 1, target: '自分', effect: 'heal 5..5' },
  { id: 'raise', name: 'レイズ', mp: 4, target: '味方単体', effect: 'revive hp=half' },
]
const skills: BattleSkillEntry[] = [{ id: 'slash', name: 'きる', target: '相手単体' }]

function rpg(over: Partial<LiveRpg> = {}): LiveRpg {
  return {
    party: [ent('a'), ent('b', { hp: 40 })],
    items,
    inventory: Object.fromEntries(items.map((i) => [i.id, i.count ?? 0])),
    itemOrder: [],
    spells,
    skills,
    equipment: {},
    ...over,
  }
}

describe('種類・フィールドで使えるか', () => {
  it('効果の kind から種類を推す（builtin・未知は other）', () => {
    expect(categoryOfEffect('heal 1..2')).toBe('heal')
    expect(categoryOfEffect('revive')).toBe('heal')
    expect(categoryOfEffect('cure all')).toBe('status')
    expect(categoryOfEffect('damage 1..2')).toBe('battle')
    expect(categoryOfEffect(undefined)).toBe('other')
    expect(categoryOfEffect('???')).toBe('other')
  })
  it('category の明示が効果より優先', () => {
    expect(itemCategory({ category: 'tool', effect: 'heal 1..1' })).toBe('tool')
    expect(itemCategory({ effect: 'heal 1..1' })).toBe('heal')
    expect(itemCategory({ category: '', effect: 'damage 1..1' })).toBe('battle')
  })
  it('回復・蘇生・状態解除だけ使える。builtin・効果なしは fieldUse: true の明示だけ', () => {
    expect(isFieldUsableEntry({ effect: 'heal 1..1' })).toBe(true)
    expect(isFieldUsableEntry({ effect: 'heal_full' })).toBe(true)
    expect(isFieldUsableEntry({ effect: 'revive' })).toBe(true)
    expect(isFieldUsableEntry({ effect: 'cure 毒' })).toBe(true)
    expect(isFieldUsableEntry({ effect: 'damage 1..1' })).toBe(false)
    expect(isFieldUsableEntry({ builtin: 'x' })).toBe(false)
    expect(isFieldUsableEntry({})).toBe(false)
    expect(isFieldUsableEntry({ builtin: 'x', fieldUse: true })).toBe(true)
    expect(isFieldUsableEntry({ effect: 'heal 1..1', fieldUse: false })).toBe(false)
  })
})

describe('buildItemTabs', () => {
  it('3タブ（つかう・せいとん・たいせつなもの）の働きが use / sort / info', () => {
    const t = buildItemTabs(rpg())
    expect(t.map((x) => x.label)).toEqual(['つかう', 'せいとん', 'たいせつなもの'])
    expect(t.map((x) => x.action)).toEqual(['use', 'sort', 'info'])
  })
  it('つかう: 所持数 0 とたいせつなものは出さない。所持数を右に出す', () => {
    const use = buildItemTabs(rpg())[0].entries
    expect(use.map((e) => e.id)).toEqual(['bomb', 'potion', 'antidote', 'phoenix', 'chimera'])
    expect(use.find((e) => e.id === 'potion')?.detail).toBe('×3')
  })
  it('つかう: 使えるものは明るく（enabled）、フィールドで使えない・対象なしは暗く＋理由', () => {
    const e = (id: string) => buildItemTabs(rpg())[0].entries.find((x) => x.id === id)!
    expect(e('potion').enabled).toBe(true)
    expect(e('potion').description).toBe('回復薬')
    expect(e('potion').target).toBe('single')
    expect(e('bomb').enabled).toBe(false)
    expect(e('bomb').description).toContain('フィールドでは')
    // 毒の人がいない → 対象なし
    expect(e('antidote').enabled).toBe(false)
    expect(e('antidote').description).toContain('対象がいません')
    // 倒れている人がいれば蘇生は使える。いなければ暗い
    expect(e('phoenix').enabled).toBe(false)
    const dead = buildItemTabs(rpg({ party: [ent('a', { hp: 0 }), ent('b')] }))[0].entries
    expect(dead.find((x) => x.id === 'phoenix')?.enabled).toBe(true)
  })
  it('つかう: 全員 HP 満タンなら回復薬は対象なしで暗い', () => {
    const full = buildItemTabs(rpg({ party: [ent('a', { hp: 40 }), ent('b', { hp: 40 })] }))[0]
    expect(full.entries.find((x) => x.id === 'potion')?.enabled).toBe(false)
  })
  it('つかう: 人物がいなくても壊れず全部暗い', () => {
    const none = buildItemTabs(rpg({ party: [] }))[0].entries
    expect(none.every((x) => x.enabled === false)).toBe(true)
  })
  it('たいせつなもの: key だけ・説明のみ（使う対象 target なし）', () => {
    const key = buildItemTabs(rpg())[2].entries
    expect(key).toHaveLength(1)
    expect(key[0]).toMatchObject({ id: 'key', description: '古い扉を開ける' })
    expect(key[0].target).toBeUndefined()
    expect(key[0].enabled).toBeUndefined()
  })
  it('せいとん: 所持品を現在の並びで種類つきに出す', () => {
    const sort = buildItemTabs(rpg())[1].entries
    expect(sort.map((e) => e.id)).toEqual(['bomb', 'potion', 'antidote', 'phoenix', 'chimera'])
    expect(sort[0].detail).toContain('せんとう')
  })
  it('所持品が何もなければ全タブ空', () => {
    const t = buildItemTabs(rpg({ inventory: {} }))
    expect(t.every((x) => x.entries.length === 0)).toBe(true)
  })
})

describe('せいとん（並べ替え）', () => {
  it('orderedItems: order を優先し、無いものは定義順で後ろ。key は含めない', () => {
    expect(orderedItems(items, ['potion', 'ghost', 'potion']).map((i) => i.id)).toEqual([
      'potion',
      'bomb',
      'antidote',
      'phoenix',
      'ether',
      'chimera',
    ])
  })
  it('種類順（かいふく → じょうたい → せんとう → そのほか）で、同じ種類の中は今の並びを保つ', () => {
    expect(sortItemsByCategory(items, [])).toEqual([
      'potion',
      'phoenix',
      'ether',
      'antidote',
      'bomb',
      'chimera',
    ])
  })
  it('冪等（並べ直しても変わらない）。未知の種類は既知の後ろに現れた順', () => {
    const once = sortItemsByCategory(items, [])
    expect(sortItemsByCategory(items, once)).toEqual(once)
    const custom: BattleItemEntry[] = [
      { id: 'z', name: 'Z', category: 'tool' },
      { id: 'y', name: 'Y', category: 'toy' },
      { id: 'x', name: 'X', effect: 'heal 1..1' },
    ]
    expect(sortItemsByCategory(custom, [])).toEqual(['x', 'z', 'y'])
  })
  it('空の定義でも壊れない', () => {
    expect(sortItemsByCategory([], [])).toEqual([])
  })
})

describe('useFieldItem', () => {
  it('対象を回復し、所持数を 1 減らす（元の状態は書き換えない）', () => {
    const r0 = rpg()
    const r = useFieldItem(r0, 'potion', 'a', () => 0)
    expect(r.ok).toBe(true)
    expect(r.party.find((p) => p.id === 'a')?.hp).toBe(30)
    expect(r.inventory.potion).toBe(2)
    expect(r0.party[0].hp).toBe(10)
    expect(r0.inventory.potion).toBe(3)
    expect(r.notice).toContain('回復')
  })
  it('回復は maxHp で止まる', () => {
    const r = useFieldItem(rpg({ party: [ent('a', { hp: 30 })] }), 'potion', 'a')
    expect(r.party[0].hp).toBe(40)
  })
  it('HP 満タンの対象には効果がなく、所持数は減らない', () => {
    const r = useFieldItem(rpg(), 'potion', 'b')
    expect(r.ok).toBe(false)
    expect(r.inventory.potion).toBe(3)
    expect(r.notice).toContain('こうかが')
  })
  it('倒れた人には回復薬は使えない・蘇生薬は倒れた人にだけ', () => {
    const party = [ent('a', { hp: 0 }), ent('b', { hp: 5 })]
    const heal = useFieldItem(rpg({ party }), 'potion', 'a')
    expect(heal.ok).toBe(false)
    expect(heal.notice).toContain('たおれている')
    const live = useFieldItem(rpg({ party }), 'phoenix', 'b')
    expect(live.ok).toBe(false)
    const revive = useFieldItem(rpg({ party }), 'phoenix', 'a')
    expect(revive.ok).toBe(true)
    expect(revive.party[0].hp).toBeGreaterThan(0)
    expect(revive.inventory.phoenix).toBe(0)
  })
  it('状態解除（cure）は状態のある人だけ', () => {
    const poisoned = rpg({ party: [ent('a', { status: { 毒: 3 } })] })
    const r = useFieldItem(poisoned, 'antidote', 'a')
    expect(r.ok).toBe(true)
    expect(r.party[0].status?.毒).toBeUndefined()
    expect(useFieldItem(rpg(), 'antidote', 'a').ok).toBe(false)
  })
  it.each([
    ['存在しない id', 'nope', 'a', /ありません/],
    ['所持数 0', 'ether', 'a', /もっていません/],
    ['たいせつなもの', 'key', 'a', /つかえません/],
    ['フィールドで使えない効果', 'bomb', 'a', /ここでは/],
    ['builtin（fieldUse なし）', 'chimera', 'a', /ここでは/],
    ['存在しない対象', 'potion', 'zzz', /対象がいません/],
    ['対象未指定', 'potion', undefined, /対象がいません/],
  ])('使えない: %s は何も変えず理由を返す', (_n, id, target, re) => {
    const r0 = rpg()
    const r = useFieldItem(r0, id, target)
    expect(r.ok).toBe(false)
    expect(r.notice).toMatch(re)
    expect(r.inventory).toEqual(r0.inventory)
    expect(r.party).toBe(r0.party)
  })
})

describe('buildMagicByParty / useFieldSpell', () => {
  it('人物ごとに全魔法を並べ、使えるものだけ enabled。MP は右端', () => {
    const by = buildMagicByParty(rpg())
    expect(Object.keys(by)).toEqual(['a', 'b'])
    const a = by.a
    expect(a.map((e) => e.id)).toEqual(['fire', 'cure', 'curaga', 'pray', 'raise'])
    expect(a[0].enabled).toBe(false)
    expect(a[0].description).toContain('フィールドでは')
    expect(a[1]).toMatchObject({ enabled: true, detail: 'MP 2', target: 'single' })
    expect(a[2].target).toBe('all')
    expect(a[3].target).toBe('self')
    // 倒れた人がいないので蘇生は対象なし
    expect(a[4].enabled).toBe(false)
    expect(a[4].description).toContain('対象がいません')
  })
  it('MP 不足は使い手ごとに暗い・倒れた使い手は全部暗い', () => {
    const by = buildMagicByParty(
      rpg({ party: [ent('a', { mp: 1 }), ent('b', { hp: 0 }), ent('c')] })
    )
    expect(by.a.find((e) => e.id === 'cure')?.description).toContain('MPが')
    expect(by.a.find((e) => e.id === 'pray')?.enabled).toBe(true)
    expect(by.b.every((e) => e.enabled === false)).toBe(true)
    expect(by.c.find((e) => e.id === 'cure')?.enabled).toBe(true)
  })
  it('魔法が無ければ人物ごとに空', () => {
    expect(buildMagicByParty(rpg({ spells: [] }))).toEqual({ a: [], b: [] })
  })
  it('単体: 対象を回復し MP を消費する', () => {
    const r = useFieldSpell(rpg(), 'cure', 'a', 'a', () => 0)
    expect(r.ok).toBe(true)
    expect(r.party[0].hp).toBe(25)
    expect(r.party[0].mp).toBe(4)
    expect(r.notice).toContain('ケアル')
  })
  it('別の人への単体: 使い手の MP が減り対象が回復', () => {
    const r = useFieldSpell(rpg(), 'cure', 'b', 'a')
    expect(r.party.find((p) => p.id === 'a')?.hp).toBe(25)
    expect(r.party.find((p) => p.id === 'b')?.mp).toBe(4)
  })
  it('全体: 生きている全員（蘇生でなければ）、MP は 1 回分', () => {
    const r = useFieldSpell(
      rpg({ party: [ent('a', { hp: 10 }), ent('b', { hp: 20 }), ent('c', { hp: 0 })] }),
      'curaga',
      'a',
      undefined
    )
    expect(r.ok).toBe(true)
    expect(r.party.map((p) => p.hp)).toEqual([20, 30, 0])
    expect(r.party[0].mp).toBe(1)
    expect(r.notice).toContain('2人')
  })
  it('本人: target 指定を無視して使い手に', () => {
    const r = useFieldSpell(rpg(), 'pray', 'a', 'b')
    expect(r.party[0].hp).toBe(15)
    expect(r.party[1].hp).toBe(40)
  })
  it('蘇生の魔法は倒れた人にだけ', () => {
    const party = [ent('a'), ent('b', { hp: 0 })]
    expect(useFieldSpell(rpg({ party }), 'raise', 'a', 'a').ok).toBe(false)
    const r = useFieldSpell(rpg({ party }), 'raise', 'a', 'b')
    expect(r.ok).toBe(true)
    expect(r.party[1].hp).toBeGreaterThan(0)
  })
  it('効果が無ければ MP を減らさない', () => {
    const r = useFieldSpell(rpg({ party: [ent('a', { hp: 40 })] }), 'cure', 'a', 'a')
    expect(r.ok).toBe(false)
    expect(r.party[0].mp).toBe(6)
  })
  it.each([
    ['存在しない魔法', 'zzz', 'a', 'a', /ありません/],
    ['存在しない使い手', 'cure', 'zzz', 'a', /つかう人/],
    ['戦闘用（敵対象）の魔法', 'fire', 'a', 'a', /ここでは/],
    ['存在しない対象', 'cure', 'a', 'zzz', /対象がいません/],
  ])('使えない: %s', (_n, id, caster, target, re) => {
    const r0 = rpg()
    const r = useFieldSpell(r0, id, caster, target)
    expect(r.ok).toBe(false)
    expect(r.notice).toMatch(re)
    expect(r.party).toBe(r0.party)
  })
  it('MP 不足・倒れた使い手は使えない', () => {
    expect(useFieldSpell(rpg({ party: [ent('a', { mp: 1 })] }), 'cure', 'a', 'a').notice).toContain(
      'MP'
    )
    const dead = useFieldSpell(rpg({ party: [ent('a', { hp: 0 })] }), 'cure', 'a', 'a')
    expect(dead.ok).toBe(false)
    expect(dead.notice).toContain('たおれている')
  })
  it('fieldUse: false の回復魔法は使えない', () => {
    const r = useFieldSpell(rpg({ spells: [{ ...spells[1], fieldUse: false }] }), 'cure', 'a', 'a')
    expect(r.ok).toBe(false)
  })
})

describe('buildStatusRows', () => {
  it('装備・わざはデータがあるときだけ出す', () => {
    const none = buildStatusRows(rpg({ skills: [], equipment: {} }))
    expect(none.a).toEqual([])
    const some = buildStatusRows(rpg({ equipment: { a: ['potion', 'zzz'] } }))
    expect(some.a).toEqual([
      { label: 'そうび', value: 'ポーション、zzz' },
      { label: 'わざ', value: 'きる' },
    ])
    expect(some.b).toEqual([{ label: 'わざ', value: 'きる' }])
  })
})

describe('applyLiveContent', () => {
  const defs: FieldMenuItemDef[] = [
    { id: 'item', label: 'どうぐ' },
    { id: 'magic', label: 'まほう' },
    { id: 'status', label: 'ステータス' },
    { id: 'config', label: 'せってい' },
    { id: 'equip', label: 'そうび' },
  ]
  const kindOf = (d: FieldMenuItemDef): string =>
    d.id === 'item'
      ? 'item'
      : d.id === 'magic' || d.id === 'equip'
        ? 'party-list'
        : d.id === 'status'
          ? 'status'
          : 'config'
  const opts = [{ key: 'a', label: 'A', choices: ['x'] }]
  it('content の無い項目に差し込み、他の項目は触らない', () => {
    const out = applyLiveContent(defs, kindOf, { rpg: rpg(), configOptions: opts })
    expect(out[0].content?.tabs).toHaveLength(3)
    expect(Object.keys(out[1].content?.entriesByParty ?? {})).toEqual(['a', 'b'])
    expect(out[2].content?.statusByParty?.a).toBeDefined()
    expect(out[3].content?.options).toBe(opts)
    expect(out[4]).toBe(defs[4])
  })
  it('定義側の content は上書きしない（tabs / entries / options）', () => {
    const own: FieldMenuItemDef[] = [
      { id: 'item', label: 'どうぐ', content: { tabs: [{ label: 'x', entries: [] }] } },
      { id: 'magic', label: 'まほう', content: { entries: [{ label: 'm' }] } },
      { id: 'config', label: 'せってい', content: { options: opts } },
    ]
    const out = applyLiveContent(own, kindOf, {
      rpg: rpg(),
      configOptions: [{ key: 'b', label: 'B', choices: ['y'] }],
    })
    expect(out[0].content?.tabs).toHaveLength(1)
    expect(out[1].content?.entriesByParty).toBeUndefined()
    expect(out[2].content?.options).toBe(opts)
  })
  it('ステータスは定義側の行（固有素質など）を先に、実状態の行を後ろに足す', () => {
    const own: FieldMenuItemDef[] = [
      {
        id: 'status',
        label: 'ステータス',
        content: {
          statusByParty: {
            a: [{ label: '固有素質', value: 'V' }],
            ghost: [{ label: 'G', value: '1' }],
          },
        },
      },
    ]
    const out = applyLiveContent(own, kindOf, { rpg: rpg(), configOptions: opts })
    const by = out[0].content?.statusByParty ?? {}
    expect(by.a[0]).toEqual({ label: '固有素質', value: 'V' })
    expect(by.a[by.a.length - 1]?.label).toBe('わざ')
    expect(by.ghost).toEqual([{ label: 'G', value: '1' }])
  })
  it('configOptions が無ければ config は触らない', () => {
    const out = applyLiveContent([defs[3]], kindOf, { rpg: rpg(), configOptions: undefined })
    expect(out[0]).toBe(defs[3])
  })
})

describe('buildMagicByParty: 味方ごとの習得 (#1161)', () => {
  const levelUp: Record<string, LevelUpDef> = {
    a: {
      level: 1,
      expTable: [10, 30],
      learns: [
        { level: 1, spell: 'pray' },
        { level: 3, spell: 'cure' },
      ],
    },
    b: { level: 1, expTable: [10, 30], learns: [{ level: 2, spell: 'curaga' }] },
  }
  const ids = (l: readonly { id?: string }[]) => l.map((x) => x.id)

  it('人物ごとに自分の習得（保存した Lv 以下）と習得に載らない魔法だけが並ぶ', () => {
    const by = buildMagicByParty(
      rpg({ levelUp, party: [ent('a', { level: 3 }), ent('b', { level: 1 })] })
    )
    expect(ids(by.a)).toEqual(['fire', 'cure', 'pray', 'raise'])
    expect(ids(by.b)).toEqual(['fire', 'raise'])
  })

  it('Lv 未設定は初期 Lv で絞る', () => {
    const by = buildMagicByParty(rpg({ levelUp }))
    expect(ids(by.a)).toEqual(['fire', 'pray', 'raise'])
    expect(ids(by.b)).toEqual(['fire', 'raise'])
  })

  it('MP 不足・倒れた人・対象なしの暗転理由は従来どおり', () => {
    const by = buildMagicByParty(
      rpg({
        levelUp,
        party: [ent('a', { level: 3, mp: 1 }), ent('b', { level: 2, hp: 0 }), ent('c')],
      })
    )
    expect(by.a.find((e) => e.id === 'cure')?.description).toContain('MPが')
    expect(by.a.find((e) => e.id === 'pray')?.enabled).toBe(true)
    expect(by.a.find((e) => e.id === 'fire')?.description).toContain('フィールドでは')
    // b は Lv2 で curaga が並ぶが、倒れているので全部暗い
    expect(ids(by.b)).toContain('curaga')
    expect(by.b.every((e) => e.enabled === false)).toBe(true)
    expect(by.b.find((e) => e.id === 'curaga')?.description).toContain('たおれています')
    // 習得の定義に居ない c は初期 Lv の和集合（pray）と習得に載らない魔法
    expect(ids(by.c)).toEqual(['fire', 'pray', 'raise'])
  })

  it('levelUp 省略は従来どおり全員に全魔法', () => {
    const by = buildMagicByParty(rpg({ party: [ent('a', { level: 9 }), ent('b')] }))
    expect(ids(by.a)).toEqual(['fire', 'cure', 'curaga', 'pray', 'raise'])
    expect(ids(by.b)).toEqual(['fire', 'cure', 'curaga', 'pray', 'raise'])
  })

  it('保存した Lv が上がった後に次に開いたメニューで新しい魔法が並ぶ', () => {
    const before = rpg({ levelUp, party: [ent('a', { level: 2 }), ent('b', { level: 1 })] })
    expect(ids(buildMagicByParty(before).a)).not.toContain('cure')
    expect(ids(buildMagicByParty(before).b)).not.toContain('curaga')
    const after = rpg({ levelUp, party: [ent('a', { level: 3 }), ent('b', { level: 2 })] })
    expect(ids(buildMagicByParty(after).a)).toContain('cure')
    expect(ids(buildMagicByParty(after).b)).toContain('curaga')
    // 並んだ魔法はそのまま使える
    const r = useFieldSpell(after, 'cure', 'a', 'a', () => 0)
    expect(r.ok).toBe(true)
  })
})
