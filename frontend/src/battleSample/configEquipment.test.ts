/** 戦闘画面サンプルの設定 JSON の装備 (#207): `gear` / `party[].equipment` / `party[].equipmentSlots` / `party[].abilities` */
import { describe, it, expect } from 'vitest'
import equipmentSample from '../../public/battle-sample/equipment.json?raw'
import {
  buildBattleSetup,
  defaultConfig,
  initialView,
  parseConfig,
  parseConfigText,
} from './config'
import { BattleEngine } from '../game/battleEngine'

const BASE = 'https://example.com/dir/x.json'

const SWORD = {
  id: 'sword',
  name: 'かたな',
  kind: '武器',
  equipBonus: 'atk+8',
  abilities: ['slash'],
}
const SLASH = { id: 'slash', name: 'きりさく', target: '相手単体', effect: 'damage 30..30' }

const cfg = (party: unknown[], gear: unknown[] = [SWORD], extra: Record<string, unknown> = {}) =>
  parseConfig({ gear, skills: [SLASH], party, ...extra }, BASE)

describe('gear の読み込み', () => {
  it('省略は空。既定の設定にも空で入る', () => {
    const r = parseConfig({}, BASE)
    expect(r.ok && r.value.gear).toEqual({})
    expect(r.ok && r.value.abilities).toEqual({})
    const d = defaultConfig()
    expect([d.gear, d.abilities]).toEqual([{}, {}])
  })

  it('id をキーにした ItemDef になる（kind の既定は武器、属性は正規化・重複排除、空文字は未指定）', () => {
    const r = parseConfig(
      {
        gear: [
          {
            id: ' armor ',
            name: ' よろい ',
            kind: '防具',
            elements: ['ＷＡＴＥＲ', 'water', 'ice'],
            equipBonus: 'def+4',
            equippableBy: ['hero', ' '],
            abilities: [],
          },
          { id: 'plain', name: 'ただ', kind: '', equipBonus: '' },
        ],
      },
      BASE
    )
    if (!r.ok) throw new Error(r.error)
    expect(r.value.gear).toEqual({
      armor: {
        id: 'armor',
        name: 'よろい',
        kind: '防具',
        equipBonus: 'def+4',
        equippableBy: ['hero'],
        elements: ['water', 'ice'],
      },
      plain: { id: 'plain', name: 'ただ', kind: '武器' },
    })
  })

  it.each([
    ['gear が配列でない', { gear: {} }, 'gear は配列'],
    ['要素がオブジェクトでない', { gear: [1] }, 'gear[0]'],
    ['id が無い', { gear: [{ name: 'x' }] }, 'gear[0].id'],
    ['name が空', { gear: [{ id: 'a', name: ' ' }] }, 'gear[0].name'],
    ['kind が文字列でない', { gear: [{ id: 'a', name: 'x', kind: 1 }] }, 'gear[0].kind'],
    [
      'equipBonus が文字列でない',
      { gear: [{ id: 'a', name: 'x', equipBonus: 3 }] },
      'gear[0].equipBonus',
    ],
    ['属性が 3 つ', { gear: [{ id: 'a', name: 'x', elements: ['a', 'b', 'c'] }] }, '最大 2 つ'],
    [
      'abilities が配列でない',
      { gear: [{ id: 'a', name: 'x', abilities: 'slash' }] },
      'gear[0].abilities',
    ],
    [
      'equippableBy に非文字列',
      { gear: [{ id: 'a', name: 'x', equippableBy: [1] }] },
      'gear[0].equippableBy',
    ],
  ])('不正: %s はエラーにする', (_n, raw, msg) => {
    const r = parseConfig(raw, BASE)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain(msg)
  })
})

describe('party[] の装備の反映', () => {
  it('武器のボーナスが能力値に付き、武器のわざが candidate（menu.skills）になる', () => {
    const r = cfg([{ id: 'a', hp: 50, atk: 10, equipment: ['sword'] }])
    if (!r.ok) throw new Error(r.error)
    expect(r.value.party[0]).toMatchObject({ atk: 18 })
    expect(r.value.abilities.a).toEqual([
      { id: 'slash', name: 'きりさく', target: '相手単体', effect: 'damage 30..30' },
    ])
  })

  it('固定のわざ（party[].abilities）の後ろに武器のわざを足す。skills に無い id は出ない', () => {
    const r = cfg(
      [{ id: 'a', hp: 50, abilities: ['guard', 'nope'], equipment: ['sword'] }],
      [SWORD],
      { skills: [SLASH, { id: 'guard', name: 'みがまえ', target: '自分' }] }
    )
    if (!r.ok) throw new Error(r.error)
    expect(r.value.abilities.a.map((e) => e.id)).toEqual(['guard', 'slash'])
  })

  it('equipment に魔石の id も書ける（同じ入口）。equipmentSlots と magiciteSlots が効く', () => {
    const r = cfg(
      [
        {
          id: 'a',
          hp: 50,
          atk: 10,
          equipment: ['sword', 'axe', 'sea'],
          equipmentSlots: ['武器', '武器'],
        },
      ],
      [SWORD, { id: 'axe', name: 'おの', equipBonus: 'atk+3' }],
      { magicites: [{ id: 'sea', name: 'うみ', elements: ['water'] }] }
    )
    if (!r.ok) throw new Error(r.error)
    expect(r.value.party[0]).toMatchObject({ atk: 21, affinity: { halve: ['water'] } })
    expect(r.value.summons.a.map((e) => e.id)).toEqual(['sea'])
  })

  it('装備可に入らない味方・種別違い・宣言なし・枠なしは装備されない（読み込みは成功）', () => {
    const r = cfg(
      [
        {
          id: 'a',
          hp: 50,
          atk: 10,
          equipment: ['sword', 'potion', 'nope'],
          equipmentSlots: ['防具'],
        },
      ],
      [
        { ...SWORD, equippableBy: ['other'] },
        { id: 'potion', name: 'くすり', kind: '回復' },
      ]
    )
    if (!r.ok) throw new Error(r.error)
    expect(r.value.party[0]).toMatchObject({ atk: 10 })
    expect(r.value.abilities).toEqual({})
  })

  it.each([
    ['equipment が配列でない', { id: 'a', equipment: 'sword' }, 'party[0].equipment'],
    ['equipment に非文字列', { id: 'a', equipment: [1] }, 'party[0].equipment'],
    ['equipmentSlots が配列でない', { id: 'a', equipmentSlots: '武器' }, 'party[0].equipmentSlots'],
    ['abilities が配列でない', { id: 'a', abilities: 'slash' }, 'party[0].abilities'],
  ])('不正: %s はエラーにする', (_n, member, msg) => {
    const r = cfg([member])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain(msg)
  })

  it('装備の項目が無い設定は従来どおり（味方は変わらず、menu に skills キーが出ない）', () => {
    const r = parseConfig({}, BASE)
    if (!r.ok) throw new Error(r.error)
    const setup = buildBattleSetup(r.value, initialView(r.value))
    expect(Object.keys(setup.options.menu)).not.toContain('skills')
    expect(r.value.party).toEqual(defaultConfig().party)
  })

  it('buildBattleSetup: わざのある味方だけ menu.skills を持つ（複製）', () => {
    const r = cfg([
      { id: 'a', hp: 50, equipment: ['sword'] },
      { id: 'b', hp: 50 },
    ])
    if (!r.ok) throw new Error(r.error)
    const view = { ...initialView(r.value), layout: 'side' as const, partyCount: 2 }
    const setup = buildBattleSetup(r.value, view)
    expect(Object.keys(setup.options.menu.skills ?? {})).toEqual(['a'])
    expect(setup.options.menu.skills?.a).not.toBe(r.value.abilities.a)
  })
})

describe('同梱の例 public/battle-sample/equipment.json (#207)', () => {
  const load = () => {
    const r = parseConfigText(equipmentSample, 'https://example.com/battle-sample/equipment.json')
    if (!r.ok) throw new Error(r.error)
    return r.value
  }

  it('parseConfigText で読め、装備品 4 種・3 人の装備・skill/summon を含むコマンド構成が入っている', () => {
    const c = load()
    expect(Object.keys(c.gear)).toEqual(['katana-a', 'katana-b', 'armor-water', 'armor-fire'])
    expect(c.commands).toEqual(['skill', 'summon', 'item', 'escape'])
    const [hero, ally, mage] = c.party
    expect(hero).toMatchObject({ atk: 28, def: 8, maxHp: 150, affinity: { halve: ['water'] } })
    // ally: 防具の水 + 魔石の水 = 2 層 → 吸収。通常攻撃の属性は魔石由来だけ
    expect(ally).toMatchObject({
      atk: 19,
      agi: 7,
      def: 7,
      maxHp: 130,
      affinity: { absorb: ['water'] },
      attackElements: ['water'],
    })
    // mage: katana-b は ally 専用なので装備できない。防具（火）だけ効く
    expect(mage).toMatchObject({ atk: 12, def: 6, affinity: { halve: ['fire'] } })
    expect(Object.keys(c.abilities)).toEqual(['hero', 'ally'])
    expect(c.abilities.hero.map((e) => e.id)).toEqual(['slash'])
    expect(c.abilities.ally.map((e) => e.id)).toEqual(['sweep'])
    expect(Object.keys(c.summons)).toEqual(['ally'])
  })

  it('例の通し: 武器のわざで攻撃でき、MP は減らない', () => {
    const c = load()
    const setup = buildBattleSetup(c, { ...initialView(c), layout: 'side', partyCount: 3 })
    const [hero] = setup.party
    const [kawanushi] = setup.enemies
    kawanushi.actions = undefined
    kawanushi.atk = 0
    const engine = new BattleEngine(setup.party, setup.enemies, { rng: () => 0 })
    const slash = setup.options.menu.skills!.hero[0]
    const mp = hero.mp
    expect(engine.selectSkill(slash, kawanushi.id)).toBe(true)
    expect(kawanushi.hp).toBe(500 - 45)
    expect(hero.mp).toBe(mp)
  })

  it('例の通し: 水の特技（40）は、防具の水耐性で hero は半減（20）、防具＋魔石の水 2 層で ally は吸収（回復）', () => {
    const c = load()
    const setup = buildBattleSetup(c, { ...initialView(c), layout: 'side', partyCount: 3 })
    const [hero, ally] = setup.party
    const [kawanushi, hinotori] = setup.enemies
    kawanushi.actions = ['候補=wave']
    hinotori.actions = undefined
    hinotori.atk = 0
    ally.hp = 50
    const engine = new BattleEngine(setup.party, setup.enemies, {
      rng: () => 0,
      skills: setup.skills,
    })
    engine.selectAttack(kawanushi.id)
    // hero: 水 40 の半減 20 + ひのとりの通常攻撃 1
    expect(hero.hp).toBe(150 - 20 - 1)
    expect(ally.hp).toBe(90)
  })
})
