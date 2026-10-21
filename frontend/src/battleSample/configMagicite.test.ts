/** 戦闘画面サンプルの設定 JSON の魔石 (#889): `magicites` / `party[].magicites` / `commands` */
import { describe, it, expect } from 'vitest'
import magiciteSample from '../../public/battle-sample/magicite.json?raw'
import {
  buildBattleSetup,
  defaultConfig,
  initialView,
  parseConfig,
  parseConfigText,
} from './config'
import { BattleEngine } from '../game/battleEngine'

const BASE = 'https://example.com/dir/x.json'

const STONE = { id: 'sea', name: 'うみ', elements: ['Water'], effect: 'damage 20..20 type=water' }

describe('magicites の読み込み', () => {
  it('省略は空。既定の設定にも空で入る', () => {
    const r = parseConfig({}, BASE)
    expect(r.ok && r.value.magicites).toEqual({})
    expect(r.ok && r.value.summons).toEqual({})
    expect(r.ok && r.value.commands).toBeUndefined()
    const d = defaultConfig()
    expect([d.magicites, d.summons, d.commands]).toEqual([{}, {}, undefined])
  })

  it('id をキーにした MagiciteDef になる（属性は正規化・重複排除、対象の既定は相手単体、空文字は未指定、mp は整数）', () => {
    const r = parseConfig(
      {
        magicites: [
          {
            ...STONE,
            id: ' sea ',
            elements: ['ＷＡＴＥＲ', 'water', 'ice'],
            summon: 'うみの主',
            mp: 3.7,
            equipBonus: 'hp+10',
            growth: '',
            equippableBy: ['hero', ' '],
          },
          { id: 'plain', name: 'ただ' },
        ],
      },
      BASE
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.magicites).toEqual({
      sea: {
        id: 'sea',
        name: 'うみ',
        summon: 'うみの主',
        elements: ['water', 'ice'],
        target: '相手単体',
        effect: 'damage 20..20 type=water',
        mp: 3,
        equipBonus: 'hp+10',
        equippableBy: ['hero'],
      },
      plain: { id: 'plain', name: 'ただ', target: '相手単体' },
    })
  })

  it.each([
    ['配列でない', { magicites: {} }, 'magicites は配列'],
    ['要素がオブジェクトでない', { magicites: [1] }, 'magicites[0] はオブジェクト'],
    ['id が無い', { magicites: [{ name: 'x' }] }, 'magicites[0].id'],
    ['name が空', { magicites: [{ id: 'a', name: ' ' }] }, 'magicites[0].name'],
    ['effect が文字列でない', { magicites: [{ id: 'a', name: 'x', effect: 1 }] }, '.effect'],
    ['mp が負', { magicites: [{ id: 'a', name: 'x', mp: -1 }] }, '.mp'],
    ['mp が文字列', { magicites: [{ id: 'a', name: 'x', mp: '1' }] }, '.mp'],
    [
      'elements が配列でない',
      { magicites: [{ id: 'a', name: 'x', elements: 'fire' }] },
      '.elements',
    ],
    [
      'elements が 3 つ',
      { magicites: [{ id: 'a', name: 'x', elements: ['fire', 'ice', 'wind'] }] },
      '最大 2 つ',
    ],
    [
      'equippableBy が配列でない',
      { magicites: [{ id: 'a', name: 'x', equippableBy: 'a' }] },
      '.equippableBy',
    ],
  ])('不正: %s はエラーにする', (_n, raw, msg) => {
    const r = parseConfig(raw, BASE)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain(msg)
  })
})

describe('commands の読み込み', () => {
  it('summon を含む並びを読む。重複・未知の id・文字列でない要素はエラー', () => {
    const ok = parseConfig({ commands: ['attack', 'summon', 'spell', 'item', 'escape'] }, BASE)
    expect(ok.ok && ok.value.commands).toEqual(['attack', 'summon', 'spell', 'item', 'escape'])
    for (const bad of [['attack', 'attack'], ['attack', 'nope'], [1], 'attack', []]) {
      const r = parseConfig({ commands: bad }, BASE)
      expect(r.ok, JSON.stringify(bad)).toBe(false)
    }
  })

  it('buildBattleSetup が options.commands に渡す（複製）。未指定なら入れない', () => {
    const r = parseConfig({ commands: ['summon', 'attack'] }, BASE)
    if (!r.ok) throw new Error(r.error)
    const setup = buildBattleSetup(r.value, initialView(r.value))
    expect(setup.options.commands).toEqual(['summon', 'attack'])
    expect(setup.options.commands).not.toBe(r.value.commands)
    const none = parseConfig({}, BASE)
    if (!none.ok) throw new Error(none.error)
    expect(
      Object.keys(buildBattleSetup(none.value, initialView(none.value)).options)
    ).not.toContain('commands')
  })
})

describe('party[].magicites の反映', () => {
  const cfg = (party: unknown[], magicites: unknown[] = [STONE]) =>
    parseConfig({ magicites, party }, BASE)

  it('装備した味方の能力値・耐性・通常攻撃の属性・召喚の行が付く。魔石を書かない味方は従来と同じ', () => {
    const r = cfg([
      {
        id: 'a',
        name: 'A',
        hp: 50,
        atk: 10,
        magicites: ['sea'],
      },
      { id: 'b', name: 'B', hp: 50 },
    ])
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const [a, b] = r.value.party
    expect(a.attackElements).toEqual(['water'])
    expect(a.affinity).toEqual({ halve: ['water'] })
    expect(Object.keys(b)).not.toContain('attackElements')
    expect(Object.keys(b)).not.toContain('affinity')
    expect(Object.keys(r.value.summons)).toEqual(['a'])
    expect(r.value.summons.a[0]).toMatchObject({
      id: 'sea',
      name: 'うみ',
      target: '相手単体',
      mp: 0,
    })
  })

  it('装備時ボーナスは最大 HP/最大 MP を満タンで増やす。枠の既定は 1、magiciteSlots で増える', () => {
    const stones = [
      { id: 's1', name: '一', elements: ['water'], equipBonus: 'hp+20, mp+5, atk+3' },
      { id: 's2', name: '二', elements: ['water'], equipBonus: 'def+2' },
    ]
    const one = cfg([{ id: 'a', hp: 50, mp: 10, atk: 10, def: 1, magicites: ['s1', 's2'] }], stones)
    if (!one.ok) throw new Error(one.error)
    expect(one.value.party[0]).toMatchObject({
      maxHp: 70,
      hp: 70,
      maxMp: 15,
      mp: 15,
      atk: 13,
      def: 1,
    })
    expect(one.value.summons.a.map((e) => e.id)).toEqual(['s1'])
    const two = cfg(
      [{ id: 'a', hp: 50, mp: 10, atk: 10, def: 1, magicites: ['s1', 's2'], magiciteSlots: 2 }],
      stones
    )
    if (!two.ok) throw new Error(two.error)
    expect(two.value.party[0]).toMatchObject({ def: 3, affinity: { absorb: ['water'] } })
    expect(two.value.summons.a.map((e) => e.id)).toEqual(['s1', 's2'])
  })

  it('装備可に入らない味方・宣言の無い id・枠 0 は装備されない（読み込みは成功）', () => {
    const stones = [{ ...STONE, equippableBy: ['other'] }]
    const r = cfg([{ id: 'a', hp: 50, magicites: ['sea', 'nope'] }], stones)
    if (!r.ok) throw new Error(r.error)
    expect(r.value.summons).toEqual({})
    expect(r.value.party[0].attackElements).toBeUndefined()
    const zero = cfg([{ id: 'a', hp: 50, magicites: ['sea'], magiciteSlots: 0 }])
    if (!zero.ok) throw new Error(zero.error)
    expect(zero.value.summons).toEqual({})
  })

  it.each([
    ['magicites が配列でない', { id: 'a', magicites: 'sea' }, 'party[0].magicites'],
    ['magicites に非文字列', { id: 'a', magicites: [1] }, 'party[0].magicites'],
    ['枠が負', { id: 'a', magiciteSlots: -1 }, 'party[0].magiciteSlots'],
    ['枠が小数', { id: 'a', magiciteSlots: 1.5 }, 'party[0].magiciteSlots'],
    ['枠が文字列', { id: 'a', magiciteSlots: '2' }, 'party[0].magiciteSlots'],
  ])('不正: %s はエラーにする', (_n, member, msg) => {
    const r = cfg([member])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain(msg)
  })

  it('味方の affinity を直接書くのは従来どおり未対応（魔石で付ける）', () => {
    const r = cfg([{ id: 'a', affinity: { halve: ['water'] } }])
    expect(r.ok).toBe(false)
  })

  it('buildBattleSetup: 魔石を装備した味方だけ menu.summons を持つ（複製）。画面に出ない味方の分は渡さない', () => {
    const r = cfg([
      { id: 'a', hp: 50, magicites: ['sea'] },
      { id: 'b', hp: 50 },
    ])
    if (!r.ok) throw new Error(r.error)
    const view = { ...initialView(r.value), layout: 'side' as const, partyCount: 2 }
    const setup = buildBattleSetup(r.value, view)
    expect(Object.keys(setup.options.menu.summons ?? {})).toEqual(['a'])
    expect(setup.options.menu.summons?.a).not.toBe(r.value.summons.a)
    // 味方 1 人だけの画面（front は先頭 1 人）でも a の分は渡る。魔石の無い設定は summons キーを持たない
    const none = parseConfig({}, BASE)
    if (!none.ok) throw new Error(none.error)
    expect(
      Object.keys(buildBattleSetup(none.value, initialView(none.value)).options.menu)
    ).not.toContain('summons')
    const onlyB = buildBattleSetup(r.value, { ...view, partyCount: 1 })
    expect(Object.keys(onlyB.options.menu.summons ?? {})).toEqual(['a'])
  })
})

describe('同梱の例 public/battle-sample/magicite.json (#889)', () => {
  const load = () => {
    const r = parseConfigText(magiciteSample, 'https://example.com/battle-sample/magicite.json')
    if (!r.ok) throw new Error(r.error)
    return r.value
  }

  it('parseConfigText で読め、魔石 3 種・3 人の装備・summon を含むコマンド構成が入っている', () => {
    const c = load()
    expect(Object.keys(c.magicites)).toEqual(['sea', 'tiger', 'spring'])
    expect(c.commands).toEqual(['attack', 'summon', 'spell', 'escape'])
    expect(Object.keys(c.summons)).toEqual(['hero', 'ally', 'mage'])
    const [hero, ally, mage] = c.party
    expect(hero).toMatchObject({ maxHp: 150, affinity: { halve: ['water'] } })
    expect(ally).toMatchObject({
      maxHp: 130,
      atk: 24,
      affinity: { halve: ['water', 'fire'] },
      attackElements: ['water', 'fire'],
    })
    // 水の魔石 2 つ（うみ + わきみず）= 水が 2 層 → 吸収。わきみずは mage 専用
    expect(mage).toMatchObject({ def: 5, affinity: { absorb: ['water'] } })
    expect(c.summons.mage.map((e) => e.id)).toEqual(['sea', 'spring'])
  })

  it('例の通し: 水の通常攻撃はかわのぬし（水を吸収）に回復され、ひのとり（水が弱点）には倍。召喚は 1 人 1 回', () => {
    const c = load()
    const setup = buildBattleSetup(c, { ...initialView(c), layout: 'side', partyCount: 3 })
    const [kawanushi, hinotori] = setup.enemies
    // 敵は動かさない（検証を単純にする）
    kawanushi.actions = undefined
    hinotori.actions = undefined
    kawanushi.atk = 0
    hinotori.atk = 0
    kawanushi.hp = 300
    const engine = new BattleEngine(setup.party, setup.enemies, { rng: () => 0 })
    engine.selectAttack(kawanushi.id)
    // ATK 22・敵の DEF 2 → 通常攻撃は 21。かわのぬしは水を吸収して回復する（最大 HP 500 で止まる）
    expect(kawanushi.hp).toBe(321)
    engine.selectAttack(hinotori.id)
    expect(hinotori.hp).toBe(400 - 42) // 水が弱点で倍
    // 召喚: うみの召喚獣（水ダメージ 60・相手全体）。かわのぬしは吸収して回復、ひのとりは弱点で 120
    const sea = setup.options.menu.summons!.hero[0]
    const before = [kawanushi.hp, hinotori.hp]
    expect(engine.selectSummon(sea)).toBe(true)
    expect(kawanushi.hp).toBe(Math.min(500, before[0] + 60))
    expect(hinotori.hp).toBe(before[1] - 120)
    expect(engine.selectSummon(sea)).toBe(false)
  })
})
