/** 戦闘画面サンプルの設定 JSON の召喚獣 (#750): beasts の検証、魔石・特技の summonId の引き当て、素材の URL 解決 */
import { describe, expect, it, vi } from 'vitest'
import summonSample from '../../public/battle-sample/summon.json?raw'
import { buildBattleSetup, initialView, parseConfig, parseConfigText } from './config'
import { BattleEngine } from '../game/battleEngine'

const BASE = 'https://example.com/dir/x.json'
const HERO = { id: 'hero', name: 'H', hp: 100, atk: 10, def: 1, agi: 5 }
const BEAST = {
  id: 'S1',
  name: 'うみの主',
  elements: ['ＷＡＴＥＲ', 'water'],
  image: 'img/s1.svg',
  se: 'se/s1.ogg',
  imaginary: true,
  target: '相手全体',
  effect: 'damage 30..30 type=water',
  message: '{user}は よんだ',
}

describe('beasts: 検証', () => {
  it('未指定は空', () => {
    const r = parseConfig({}, BASE)
    expect(r.ok && r.value.magicites).toEqual({})
  })
  it('配列でなければエラー', () => {
    expect(parseConfig({ beasts: {} }, BASE)).toEqual({
      ok: false,
      error: 'beasts は配列である必要があります',
    })
  })
  it('id / name は必須、型違いはエラー', () => {
    for (const [b, msg] of [
      [{ name: 'x' }, 'beasts[0].id'],
      [{ id: 'a' }, 'beasts[0].name'],
      [{ id: 'a', name: 'x', imaginary: 'yes' }, 'beasts[0].imaginary'],
      [{ id: 'a', name: 'x', image: 3 }, 'beasts[0].image'],
      [{ id: 'a', name: 'x', elements: 'water' }, 'beasts[0].elements'],
      [{ id: 'a', name: 'x', elements: ['a', 'b', 'c'] }, 'beasts[0].elements'],
      [{ id: 'a', name: 'x', facing: 'up' }, 'beasts[0].facing'],
    ] as const) {
      const r = parseConfig({ beasts: [b] }, BASE)
      expect(r.ok, msg).toBe(false)
      if (!r.ok) expect(r.error).toContain(msg)
    }
    expect(parseConfig({ beasts: [3] }, BASE).ok).toBe(false)
  })
  it('素材は設定 JSON の位置からの絶対 URL になる', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r = parseConfig(
      {
        party: [HERO],
        magicites: [{ id: 'm', name: '石', summonId: 'S1' }],
        beasts: [BEAST],
      },
      BASE
    )
    warn.mockRestore()
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.magicites.m.cue).toEqual({
      id: 'S1',
      name: 'うみの主',
      image: 'https://example.com/dir/img/s1.svg',
      se: 'https://example.com/dir/se/s1.ogg',
      imaginary: true,
    })
  })
})

describe('summonId の引き当て', () => {
  it('魔石: 効果が無ければ召喚獣の中身・属性（正規化・重複排除）・表示名を使い、cue が付く。「しょうかん」の行にも載る', () => {
    const r = parseConfig(
      {
        party: [{ ...HERO, magicites: ['m'] }],
        magicites: [{ id: 'm', name: '石', summonId: 'S1' }],
        beasts: [BEAST],
      },
      BASE
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.magicites.m).toMatchObject({
      summon: 'うみの主',
      elements: ['water'],
      target: '相手全体',
      effect: 'damage 30..30 type=water',
      cue: { id: 'S1' },
    })
    expect(r.value.summons.hero[0]).toMatchObject({ name: 'うみの主', cue: { id: 'S1' } })
    expect(r.value.party[0].attackElements).toEqual(['water'])
  })
  it('特技: 効果が無ければ召喚獣の中身を使い cue が付く。特技の表示名は特技のまま。敵が使える', () => {
    const r = parseConfig(
      {
        party: [HERO],
        skills: [
          { id: 'call', name: 'よびごえ', summonId: 'S1' },
          { id: 'hit', name: 'たたく' },
        ],
        beasts: [BEAST],
      },
      BASE
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.skills.call).toMatchObject({
      name: 'よびごえ',
      target: '相手全体',
      effect: 'damage 30..30 type=water',
      cue: { id: 'S1' },
    })
    expect(r.value.skills.hit).not.toHaveProperty('cue')
    expect(r.value.skills.hit).not.toHaveProperty('summonId')
  })
  it('宣言の無い summonId は警告して無視（cue なし・継承なし）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r = parseConfig(
      { party: [HERO], skills: [{ id: 'call', name: 'x', summonId: 'nope-sample' }] },
      BASE
    )
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.skills.call).not.toHaveProperty('cue')
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
  it('beasts も summonId も書かない設定は、魔石・特技が従来と同じ（cue のキーが付かない）', () => {
    const r = parseConfig(
      {
        party: [{ ...HERO, magicites: ['m'] }],
        magicites: [{ id: 'm', name: '石', effect: 'damage 1..1' }],
        skills: [{ id: 'k', name: 'わざ', effect: 'damage 1..1' }],
      },
      BASE
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(Object.keys(r.value.magicites.m)).not.toContain('cue')
    expect(Object.keys(r.value.skills.k)).toEqual(['name', 'target', 'effect'])
    expect(Object.keys(r.value.summons.hero[0])).not.toContain('cue')
  })
})

describe('サンプル summon.json', () => {
  it('読み込めて、魔石・特技が召喚獣を引き当て、素材の URL は設定の位置から解決される', () => {
    const r = parseConfigText(summonSample, 'https://example.com/battle-sample/summon.json')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const c = r.value
    expect(Object.keys(c.magicites)).toEqual(['sea-stone', 'gate-stone', 'plain-stone'])
    expect(c.magicites['sea-stone'].cue).toMatchObject({
      id: 'sea',
      imaginary: true,
      image: 'https://example.com/battle-sample/summon-wave.svg',
    })
    expect(c.magicites['gate-stone'].cue?.imaginary).toBeUndefined()
    expect(c.magicites['plain-stone']).not.toHaveProperty('cue')
    expect(c.skills['call-flood'].cue?.id).toBe('flood')
    expect(c.skills.swing).not.toHaveProperty('cue')
  })

  it('実エンジンで召喚（味方）と、敵の初手の召喚獣が演出つきの記録になる', () => {
    const r = parseConfigText(summonSample, 'https://example.com/battle-sample/summon.json')
    if (!r.ok) throw new Error(r.error)
    const view = initialView(r.value)
    const setup = buildBattleSetup(r.value, view)
    const engine = new BattleEngine(setup.party, setup.enemies, {
      rng: () => 0.5,
      skills: setup.skills,
    })
    const hero = r.value.summons.hero[0]
    expect(engine.selectSummon(hero)).toBe(true)
    const evs = engine.getState().events
    const mine = evs.find((e) => e.actor.side === 'party' && e.kind === 'skill')
    expect(mine?.summon).toMatchObject({ id: 'sea', imaginary: true })
    // 敵の初手は召喚獣を呼ぶ特技（条件=初手）
    const theirs = evs.find((e) => e.actor.side === 'enemy' && e.kind === 'skill')
    expect(theirs?.summon).toMatchObject({ id: 'flood' })
    expect(theirs?.label).toBe('おおみずをよぶ')
  })
})
