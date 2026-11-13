import { afterEach, describe, expect, it, vi } from 'vitest'
import { BattleEngine } from './battleEngine'
import { applyEffect, parseEffect, MAX_LEVEL, type BattleEntity } from './spellDsl'

/** 敵のレベルとレベル条件の即死・レベル調整 (#898) */

const hero = (over: Partial<BattleEntity> = {}): BattleEntity => ({
  id: 'hero',
  name: 'ゆうしゃ',
  hp: 999,
  maxHp: 999,
  mp: 99,
  maxMp: 99,
  atk: 10,
  def: 0,
  agi: 50,
  ...over,
})
const foe = (id: string, over: Partial<BattleEntity> = {}): BattleEntity => ({
  id,
  name: id,
  hp: 100,
  maxHp: 100,
  mp: 0,
  maxMp: 0,
  atk: 1,
  def: 0,
  agi: 1,
  exp: 1,
  gold: 1,
  ...over,
})

afterEach(() => vi.restoreAllMocks())

describe('parseEffect: レベル倍数 / level (#898)', () => {
  it('damage_full レベル倍数=N は levelMultiple を持つ（回数と併記可。回数は警告して無視）', () => {
    expect(parseEffect('damage_full レベル倍数=5')).toEqual({
      kind: 'damage_full',
      levelMultiple: 5,
    })
    expect(parseEffect('damage_full')).toEqual({ kind: 'damage_full' })
    const both = parseEffect('damage_full 回数=3 レベル倍数=2')
    expect(both?.levelMultiple).toBe(2)
  })
  it.each([
    'damage_full レベル倍数=0',
    'damage_full レベル倍数=-3',
    'damage_full レベル倍数=1.5',
    'damage_full レベル倍数=',
    'damage_full レベル倍数=abc',
  ])('不正値 %s は書式エラー（無条件の即死にしない）', (s) => expect(parseEffect(s)).toBeNull())
  it('damage_full 以外の レベル倍数= は警告して無視', () => {
    expect(parseEffect('damage 5..6 レベル倍数=5')?.warnings?.join()).toContain('damage_full 専用')
  })
  it.each([
    ['level +2', { mode: 'add', value: 2 }],
    ['level -3', { mode: 'add', value: -3 }],
    ['level =10', { mode: 'set', value: 10 }],
  ])('%s', (s, adj) => expect(parseEffect(s)).toEqual({ kind: 'level', levelAdjust: adj }))
  it.each(['level', 'level 5', 'level +', 'level +1 +2', 'level +1.5', 'level =', 'level x'])(
    '不正 %s は null',
    (s) => expect(parseEffect(s)).toBeNull()
  )
})

describe('applyEffect: レベル倍数の即死 (#898)', () => {
  const run = (effect: string, t: BattleEntity, rng = () => 0.5): string[] => {
    const e = parseEffect(effect)!
    return applyEffect(e, { caster: hero(), targets: [t], rng })
  }
  it('倍数なら倒れ、倍数でない・レベル無しは効かない（HP 不変）', () => {
    const a = foe('a', { level: 10 })
    expect(run('damage_full レベル倍数=5', a)).toContain('a は たおれた！')
    expect(a.hp).toBe(0)
    const b = foe('b', { level: 11 })
    expect(run('damage_full レベル倍数=5', b)).toEqual(['b には きかなかった！'])
    expect(b.hp).toBe(100)
    const c = foe('c')
    expect(run('damage_full レベル倍数=5', c)).toEqual(['c には きかなかった！'])
    expect(c.hp).toBe(100)
  })
  it('倍数 1 は全レベルに通る。レベル 99 は 9 の倍数・11 の倍数', () => {
    expect(
      foe('a', { level: 7 }) &&
        (() => {
          const t = foe('a', { level: 7 })
          run('damage_full レベル倍数=1', t)
          return t.hp
        })()
    ).toBe(0)
    const t = foe('t', { level: 99 })
    run('damage_full レベル倍数=9', t)
    expect(t.hp).toBe(0)
  })
  it('乱数を使わない（成功率 100%）', () => {
    const rng = vi.fn(() => 0.5)
    run('damage_full レベル倍数=5', foe('a', { level: 5 }), rng)
    run('damage_full レベル倍数=5', foe('a', { level: 6 }), rng)
    expect(rng).not.toHaveBeenCalled()
  })
  it('死の耐性（death 無効・吸収・半減）は従来どおり重なる', () => {
    const nul = foe('n', { level: 5, affinity: { nullify: ['death'] } })
    expect(run('damage_full レベル倍数=5', nul)).toEqual(['n には きかなかった！'])
    expect(nul.hp).toBe(100)
    const half = foe('h', { level: 5, affinity: { halve: ['death'] } })
    run('damage_full レベル倍数=5', half, () => 0.99) // 成功率 50% は rng 0.99 で外れる
    expect(half.hp).toBe(100)
    run('damage_full レベル倍数=5', half, () => 0.1)
    expect(half.hp).toBe(0)
  })
  it('レベル倍数を書かない damage_full は従来どおり（レベルが無くても倒れる）', () => {
    const t = foe('a')
    run('damage_full', t)
    expect(t.hp).toBe(0)
  })
})

describe('applyEffect: level 調整 (#898)', () => {
  const adjust = (effect: string, t: BattleEntity): string[] =>
    applyEffect(parseEffect(effect)!, { caster: hero(), targets: [t], rng: () => 0.5 })
  it('+N / -N / =N と 1〜99 へのクランプ・ログ', () => {
    const t = foe('a', { level: 10 })
    expect(adjust('level +1', t)).toEqual(['a の レベルが 11 に あがった！'])
    expect(adjust('level -4', t)).toEqual(['a の レベルが 7 に さがった！'])
    expect(adjust('level =25', t)).toEqual(['a の レベルが 25 に あがった！'])
    adjust('level +500', t)
    expect(t.level).toBe(MAX_LEVEL)
    expect(adjust('level +1', t)).toEqual([`a の レベルは ${MAX_LEVEL} のまま！`])
    adjust('level -500', t)
    expect(t.level).toBe(1)
    adjust('level =0', t)
    expect(t.level).toBe(1)
  })
  it('レベルを持たない者・倒れた者には効かない（レベルは付かない）', () => {
    const none = foe('n')
    expect(adjust('level +1', none)).toEqual(['n には きかなかった！'])
    expect('level' in none).toBe(false)
    const dead = foe('d', { level: 5, hp: 0 })
    adjust('level +1', dead)
    expect(dead.level).toBe(5)
  })
})

describe('BattleEngine: レベル調整で即死を通す (#898)', () => {
  const spell = (name: string, effect: string) => ({ name, mp: 1, target: '敵単体', effect })
  it('倍数でない敵に MISS → level 調整 → 同じ即死が通る（実エンジン・MISS 表示）', () => {
    const e = foe('boss', { level: 24 })
    const eng = new BattleEngine([hero()], [e, foe('other')], { rng: () => 0.5 })
    const death = spell('デス', 'damage_full レベル倍数=5')
    eng.selectSpell(death, 'boss')
    expect(e.hp).toBe(100)
    const ev1 = eng.getState().events.filter((x) => x.kind === 'spell' && x.label === 'デス')
    expect(ev1[0].hits[0].kind).toBe('miss')
    expect(eng.getState().log.some((l) => l.includes('boss には きかなかった'))).toBe(true)
    eng.selectSpell(spell('レベルアップ', 'level +1'), 'boss')
    expect(e.level).toBe(25)
    // レベル調整は HP が動かなくても MISS にならない
    const ev2 = eng.getState().events.filter((x) => x.label === 'レベルアップ')
    expect(ev2[0].hits.some((h) => h.kind === 'miss')).toBe(false)
    expect(eng.getState().log.some((l) => l.includes('boss の レベルが 25 に あがった'))).toBe(true)
    eng.selectSpell(death, 'boss')
    expect(e.hp).toBe(0)
    const ev3 = eng.getState().events.filter((x) => x.label === 'デス')
    expect(ev3[1].hits[0].kind).toBe('damage')
    expect(ev3[1].hits[0].instantDeath).toBe(true)
  })
  it('レベル無しの敵への level 調整は MISS（効かない）', () => {
    const e = foe('a')
    const eng = new BattleEngine([hero()], [e, foe('b')], { rng: () => 0.5 })
    eng.selectSpell(spell('レベルアップ', 'level +1'), 'a')
    const ev = eng.getState().events.find((x) => x.label === 'レベルアップ')!
    expect(ev.hits[0].kind).toBe('miss')
    expect('level' in e).toBe(false)
  })
  it('ATB でも同じ', () => {
    const e = foe('boss', { level: 24 })
    const eng = new BattleEngine([hero()], [e, foe('other')], { rng: () => 0.5, atb: {} })
    const ready = () => {
      for (let i = 0; i < 400 && eng.getState().phase !== 'party-input'; i++) eng.tick(100)
    }
    ready()
    eng.selectSpell(spell('デス', 'damage_full レベル倍数=5'), 'boss')
    expect(e.hp).toBe(100)
    ready()
    eng.selectSpell(spell('レベルアップ', 'level +1'), 'boss')
    ready()
    eng.selectSpell(spell('デス', 'damage_full レベル倍数=5'), 'boss')
    expect(e.hp).toBe(0)
  })
  it('レベルを持たない敵・倍数を書かない即死は従来どおり（既存挙動の不変）', () => {
    const e = foe('a')
    const eng = new BattleEngine([hero()], [e, foe('b')], { rng: () => 0.5 })
    eng.selectSpell(spell('デス', 'damage_full'), 'a')
    expect(e.hp).toBe(0)
  })
})

describe('味方には level 効果もレベル倍数の即死も効かない (#206)', () => {
  const ally = (over: Partial<BattleEntity> = {}) => hero({ level: 5, ...over })
  it('applyEffect: isAlly の者は level 調整が効かず、level も変わらない', () => {
    const a = ally()
    const log = applyEffect(parseEffect('level +3')!, {
      caster: hero(),
      targets: [a],
      rng: () => 0.5,
      isAlly: (e) => e === a,
    })
    expect(log).toEqual(['ゆうしゃ には きかなかった！'])
    expect(a.level).toBe(5)
  })
  it('applyEffect: isAlly の者は damage_full レベル倍数 が level の有無に関わらず効かない（HP 不変）', () => {
    const a = ally()
    const log = applyEffect(parseEffect('damage_full レベル倍数=5')!, {
      caster: foe('x'),
      targets: [a],
      rng: () => 0,
      isAlly: (e) => e === a,
    })
    expect(log).toEqual(['ゆうしゃ には きかなかった！'])
    expect(a.hp).toBe(999)
  })
  it('isAlly を渡さない・敵は従来どおり level を持てば効く', () => {
    const e = foe('a', { level: 10 })
    applyEffect(parseEffect('level +1')!, { caster: hero(), targets: [e], rng: () => 0.5 })
    expect(e.level).toBe(11)
    const t = foe('b', { level: 5 })
    applyEffect(parseEffect('damage_full レベル倍数=5')!, {
      caster: hero(),
      targets: [t],
      rng: () => 0,
      isAlly: () => false,
    })
    expect(t.hp).toBe(0)
  })
  it('実エンジン: 味方単体への level 調整は効かず、保存される level は変わらない', () => {
    const a = ally()
    const eng = new BattleEngine([a], [foe('e')], { rng: () => 0.5 })
    eng.selectSpell({ name: 'レベルアップ', mp: 1, target: '味方単体', effect: 'level +1' }, 'hero')
    expect(eng.getState().party[0].level).toBe(5)
    expect(eng.getState().log.some((l) => l.includes('ゆうしゃ には きかなかった'))).toBe(true)
  })
})
