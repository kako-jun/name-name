/** 脚本制御の戦闘の一時付与 `付与:` (#875): 候補への足し方・無視する宣言・戦闘後に残らないこと・markdown の往復 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Container } from 'pixi.js'
import {
  FieldInputGate,
  applyScriptGrants,
  buildBattleMenuData,
  openFieldBattle,
  type FieldBattleRoster,
} from './fieldBattle'
import { DEFAULT_FIELD_BATTLE_SETTINGS } from './fieldBattle'
import { emitMarkdown, parseMarkdown } from '../wasm/parser'
import { collectMasterData } from './rpgProjectFromDoc'
import type { SkillDef, SpellDef } from '../types'

afterEach(() => vi.restoreAllMocks())

const member = (id: string, over = {}) => ({
  id,
  name: id,
  hp: 50,
  mp: 10,
  atk: 5,
  def: 1,
  agi: 3,
  ...over,
})
const skill = (id: string): SkillDef => ({
  id,
  name: `わざ${id}`,
  target: '相手単体',
  effect: 'damage 10..10',
})
const spell = (id: string): SpellDef => ({
  id,
  name: `まほう${id}`,
  mp: 2,
  target: '敵単体',
  effect: 'damage 10..10',
})
const roster = (): FieldBattleRoster => ({
  party: { hero: member('hero'), mage: member('mage', { abilities: ['own'] }) },
  order: ['hero', 'mage'],
  skills: { own: skill('own'), slash: skill('slash'), heal: skill('heal') },
  spells: { fire: spell('fire'), ice: spell('ice') },
})

describe('applyScriptGrants (#875)', () => {
  it('付与: が無ければ渡したロスターをそのまま返す', () => {
    const r = roster()
    expect(applyScriptGrants(r, ['台詞: 文=やあ'], 'b')).toBe(r)
  })

  it('対象のわざ・呪文の候補に足す。対象でない味方・渡したロスターは変わらない（戦闘後に残らない）', () => {
    const r = roster()
    const before = JSON.stringify(r)
    const g = applyScriptGrants(r, ['付与: 味方=hero わざ=slash,heal 魔法=fire'], 'b')
    expect(JSON.stringify(r)).toBe(before)
    const menu = buildBattleMenuData(g, [
      { id: 'hero', name: 'h', hp: 1, maxHp: 1, mp: 5, maxMp: 5, atk: 1, def: 1, agi: 1 },
      { id: 'mage', name: 'm', hp: 1, maxHp: 1, mp: 5, maxMp: 5, atk: 1, def: 1, agi: 1 },
    ])
    expect(menu?.skills?.hero.map((s) => s.id)).toEqual(['slash', 'heal'])
    expect(menu?.spells?.hero.map((s) => s.id)).toEqual(['fire'])
    expect(menu?.skills?.mage.map((s) => s.id)).toEqual(['own'])
    expect(menu?.spells?.mage).toBeUndefined()
    // 元のロスターでは付いていない
    const plain = buildBattleMenuData(r, [
      { id: 'hero', name: 'h', hp: 1, maxHp: 1, mp: 5, maxMp: 5, atk: 1, def: 1, agi: 1 },
    ])
    expect(plain).toBeUndefined()
  })

  it('既に持っているわざ・呪文は重ねない。レベル 1 で覚えている扱いなのでレベルに関係なく出る', () => {
    const r = roster()
    r.party.mage = { ...r.party.mage, level: 1, learns: [{ level: 1, spell: 'fire' }] } as never
    const g = applyScriptGrants(r, ['付与: 味方=mage わざ=own,slash 魔法=fire,ice'], 'b')
    expect(g.party.mage.abilities).toEqual(['own', 'slash'])
    expect(g.party.mage.learns?.map((l) => l.spell)).toEqual(['fire', 'ice'])
  })

  it('高いレベルで覚える宣言がある呪文も、付与ではレベル不足でも出る（元の宣言は変わらない）', () => {
    const r = roster()
    r.party.hero = { ...r.party.hero, level: 3, learns: [{ level: 10, spell: 'fire' }] } as never
    const before = JSON.stringify(r)
    const g = applyScriptGrants(r, ['付与: 味方=hero 魔法=fire'], 'b')
    expect(JSON.stringify(r)).toBe(before)
    const ent = { id: 'hero', name: 'h', hp: 1, maxHp: 1, mp: 5, maxMp: 5, atk: 1, def: 1, agi: 1 }
    expect(buildBattleMenuData(g, [ent])?.spells?.hero.map((s) => s.id)).toEqual(['fire'])
    // 付与しなければレベル不足で出ない
    expect(buildBattleMenuData(r, [ent])).toBeUndefined()
  })

  it('未知の味方・[特技] [呪文] に無い id は警告して無視する（ほかは生きる）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const g = applyScriptGrants(
      roster(),
      ['付与: 味方=nobody わざ=slash', '付与: 味方=hero わざ=slash,zzz 魔法=zzz,fire'],
      'b'
    )
    expect(g.party.hero.abilities).toEqual(['slash'])
    expect(g.party.hero.learns?.map((l) => l.spell)).toEqual(['fire'])
    const msgs = warn.mock.calls.map((c) => String(c[0]))
    expect(msgs.some((m) => m.includes("味方 'nobody'"))).toBe(true)
    expect(msgs.some((m) => m.includes("特技 'zzz'"))).toBe(true)
    expect(msgs.some((m) => m.includes("呪文 'zzz'"))).toBe(true)
  })

  it('特技・呪文のマスターが無いロスターでは、足せるものが無く警告して無視する', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const g = applyScriptGrants(
      { party: { hero: member('hero') }, order: ['hero'] },
      ['付与: 味方=hero わざ=slash 魔法=fire'],
      'b'
    )
    expect(g.party.hero.abilities).toEqual([])
  })
})

describe('openFieldBattle: 付与した候補が戦闘にだけ出る (#875)', () => {
  const open = (rules: string[] | null) => {
    const r = roster()
    const screen = openFieldBattle({
      stage: new Container(),
      width: 800,
      height: 600,
      settings: { ...DEFAULT_FIELD_BATTLE_SETTINGS, layout: 'side' },
      roster: r,
      enemies: [],
      scripted: rules
        ? {
            enemies: [
              {
                id: 'e',
                name: 'e',
                hp: 100,
                maxHp: 100,
                mp: 0,
                maxMp: 0,
                atk: 1,
                def: 0,
                agi: 1,
              },
            ],
            partyIds: ['hero'],
            script: { id: 'g', rules, joiners: {} },
          }
        : undefined,
      gate: new FieldInputGate(),
      onClosed: () => {},
    })
    const menu = (screen as unknown as { opts: { menu?: ReturnType<typeof buildBattleMenuData> } })
      .opts.menu
    return { menu, r }
  }

  it('付与: のある脚本の戦闘では候補窓に出て、付与の無い次の戦闘・ロスターには残らない', () => {
    const a = open(['付与: 味方=hero わざ=slash 魔法=fire'])
    expect(a.menu?.skills?.hero.map((s) => s.id)).toEqual(['slash'])
    expect(a.menu?.spells?.hero.map((s) => s.id)).toEqual(['fire'])
    expect(a.r.party.hero.abilities).toBeUndefined()
    const b = open(['台詞: 文=やあ'])
    expect(b.menu?.skills?.hero).toBeUndefined()
    expect(b.menu?.spells).toBeUndefined()
    const c = open(null)
    expect(c.menu?.skills?.hero).toBeUndefined()
    expect(c.menu?.spells).toBeUndefined()
  })
})

describe('markdown: 付与: が wasm を生き残る (#875)', () => {
  const MD = [
    '---',
    'engine: name-name',
    'chapter: 1',
    'title: t',
    '---',
    '',
    '## data: マスター',
    '',
    '[戦闘 g]',
    '敵: x',
    '付与: 味方=hero わざ=slash 魔法=fire',
    '付与: 味方=mage わざ=heal',
    '[/戦闘]',
    '',
  ].join('\n')
  it('rules に生の行として残り、emit → parse で保たれる', async () => {
    const doc = await parseMarkdown(MD)
    const def = collectMasterData(doc).battleScripts.g
    expect(def.rules).toEqual(['付与: 味方=hero わざ=slash 魔法=fire', '付与: 味方=mage わざ=heal'])
    const again = await parseMarkdown(await emitMarkdown(doc))
    expect(collectMasterData(again).battleScripts.g.rules).toEqual(def.rules)
  })
})
