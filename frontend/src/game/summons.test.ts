/** 召喚獣 (#750) の参照解決 `resolveSummonRefs` と演出の元 `toSummonCue`: 継承の規則・境界・入力を壊さないこと */
import { describe, expect, it, vi } from 'vitest'
import type { MagiciteDef, SkillDef, SummonDef } from '../types'
import { resolveSummonRefs, toSummonCue, warnSummonOnce } from './summons'

const beast = (over: Partial<SummonDef> = {}): SummonDef => ({
  id: 'S1',
  name: 'うみ',
  elements: ['water'],
  target: '相手全体',
  effect: 'damage 30..30 type=water',
  message: '{user}は よんだ',
  ...over,
})
const stone = (over: Partial<MagiciteDef> = {}): MagiciteDef => ({
  id: 'm',
  name: '石',
  target: '相手単体',
  summonId: 'S1',
  ...over,
})
const skill = (over: Partial<SkillDef> = {}): SkillDef => ({
  id: 'k',
  name: '技',
  target: '相手単体',
  summonId: 'S1',
  ...over,
})

describe('toSummonCue', () => {
  it('id と名前だけ。空の画像・効果音は付けず、想像が偽・向きが右なら印も付けない', () => {
    expect(toSummonCue({ id: 'a', name: 'b' })).toEqual({ id: 'a', name: 'b' })
    expect(toSummonCue({ id: 'a', name: 'b', image: '', se: '', imaginary: false })).toEqual({
      id: 'a',
      name: 'b',
    })
    expect(toSummonCue({ id: 'a', name: 'b', facing: 'right' })).toEqual({ id: 'a', name: 'b' })
  })
  it('画像・効果音・想像・左向きを写す', () => {
    expect(
      toSummonCue({
        id: 'a',
        name: 'b',
        image: 'x.webp',
        se: 'y.ogg',
        imaginary: true,
        facing: 'left',
      })
    ).toEqual({ id: 'a', name: 'b', image: 'x.webp', se: 'y.ogg', imaginary: true, faces: 'left' })
  })
})

describe('resolveSummonRefs: 魔石', () => {
  it('効果も builtin も無い魔石は召喚獣の対象・効果・メッセージ・属性・表示名を使う', () => {
    const r = resolveSummonRefs({ magicites: { m: stone() }, summons: { S1: beast() } })
    expect(r.magicites?.m).toMatchObject({
      summon: 'うみ',
      elements: ['water'],
      target: '相手全体',
      effect: 'damage 30..30 type=water',
      message: '{user}は よんだ',
      cue: { id: 'S1', name: 'うみ' },
    })
    expect(r.warnings).toEqual([])
  })
  it('魔石が効果を持てば全体が魔石優先（召喚獣の対象・メッセージは混ぜない）', () => {
    const r = resolveSummonRefs({
      magicites: { m: stone({ effect: 'heal 5..5' }) },
      summons: { S1: beast() },
    })
    expect(r.magicites?.m.target).toBe('相手単体')
    expect(r.magicites?.m.effect).toBe('heal 5..5')
    expect(r.magicites?.m.message).toBeUndefined()
    expect(r.magicites?.m.cue?.id).toBe('S1')
  })
  it('builtin だけでも「自分の中身を持つ」とみなす', () => {
    const r = resolveSummonRefs({
      magicites: { m: stone({ builtin: 'zaorik' }) },
      summons: { S1: beast() },
    })
    expect(r.magicites?.m.effect).toBeUndefined()
    expect(r.magicites?.m.builtin).toBe('zaorik')
  })
  it('表示名・属性が石にあればそちらを使う', () => {
    const r = resolveSummonRefs({
      magicites: { m: stone({ summon: 'ひのとら', elements: ['fire'] }) },
      summons: { S1: beast() },
    })
    expect(r.magicites?.m).toMatchObject({ summon: 'ひのとら', elements: ['fire'] })
  })
  it('召喚獣が属性・中身を持たなければ何も足さず cue だけ付く', () => {
    const r = resolveSummonRefs({
      magicites: { m: stone() },
      summons: { S1: { id: 'S1', name: 'ただの' } },
    })
    expect(r.magicites?.m.elements).toBeUndefined()
    expect(r.magicites?.m.effect).toBeUndefined()
    expect(r.magicites?.m.summon).toBe('ただの')
    expect(r.magicites?.m.cue).toEqual({ id: 'S1', name: 'ただの' })
  })
  it('宣言の無い id は警告して無視（cue も継承も付かない）', () => {
    const r = resolveSummonRefs({ magicites: { m: stone({ summonId: 'zz' }) }, summons: {} })
    expect(r.magicites?.m.cue).toBeUndefined()
    expect(r.magicites?.m.effect).toBeUndefined()
    expect(r.warnings).toHaveLength(1)
    expect(r.warnings[0]).toContain('zz')
  })
  it('召喚獣の宣言そのものが無い（summons 未指定）でも落ちず警告', () => {
    const r = resolveSummonRefs({ magicites: { m: stone() } })
    expect(r.warnings).toHaveLength(1)
  })
  it('空の summonId・summonId を書かない魔石は同じオブジェクトのまま。何も参照しなければ入力のマップそのもの', () => {
    const magicites = { a: stone({ summonId: undefined }), b: stone({ summonId: '' }) }
    const r = resolveSummonRefs({ magicites, summons: { S1: beast() } })
    expect(r.magicites).toBe(magicites)
    expect(r.warnings).toEqual([])
  })
  it('参照する魔石だけ新しいオブジェクトになり、入力は壊さない・ほかは同じオブジェクト', () => {
    const a = stone()
    const b = stone({ id: 'b', summonId: undefined })
    const input = { a, b }
    const r = resolveSummonRefs({ magicites: input, summons: { S1: beast() } })
    expect(r.magicites).not.toBe(input)
    expect(r.magicites?.b).toBe(b)
    expect(r.magicites?.a).not.toBe(a)
    expect(a.cue).toBeUndefined()
    expect(a.effect).toBeUndefined()
    expect(Object.keys(input)).toEqual(['a', 'b'])
  })
  it('id が __proto__ でも own property として扱う', () => {
    const magicites = JSON.parse(
      '{"__proto__": {"id":"__proto__","name":"x","target":"相手単体","summonId":"S1"}}'
    )
    const r = resolveSummonRefs({ magicites, summons: { S1: beast() } })
    expect(Object.getPrototypeOf(r.magicites)).toBe(Object.prototype)
    expect(Object.prototype.hasOwnProperty.call(r.magicites, '__proto__')).toBe(true)
  })
})

describe('resolveSummonRefs: 特技', () => {
  it('効果も builtin も無い特技は召喚獣の中身を使い、cue が付く', () => {
    const r = resolveSummonRefs({ skills: { k: skill() }, summons: { S1: beast() } })
    expect(r.skills?.k).toMatchObject({
      target: '相手全体',
      effect: 'damage 30..30 type=water',
      message: '{user}は よんだ',
      cue: { id: 'S1', name: 'うみ' },
    })
    // 特技の名前は特技のまま（召喚獣の名前に置き換えない）
    expect(r.skills?.k.name).toBe('技')
  })
  it('特技が効果を持てば特技優先。cue は付く', () => {
    const r = resolveSummonRefs({
      skills: { k: skill({ effect: 'heal 1..1', target: '自分' }) },
      summons: { S1: beast() },
    })
    expect(r.skills?.k).toMatchObject({ target: '自分', effect: 'heal 1..1', cue: { id: 'S1' } })
  })
  it('宣言の無い id は警告して無視', () => {
    const r = resolveSummonRefs({ skills: { k: skill() }, summons: { X: beast({ id: 'X' }) } })
    expect(r.skills?.k.cue).toBeUndefined()
    expect(r.warnings[0]).toContain('特技')
  })
  it('skills / magicites が未指定でも落ちない', () => {
    expect(resolveSummonRefs({})).toEqual({ skills: undefined, magicites: undefined, warnings: [] })
  })
})

describe('warnSummonOnce', () => {
  it('同じ文面は 1 度だけ出す', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    warnSummonOnce(['dup-test-1', 'dup-test-1'])
    warnSummonOnce(['dup-test-1'])
    expect(spy).toHaveBeenCalledTimes(1)
    spy.mockRestore()
  })
})
