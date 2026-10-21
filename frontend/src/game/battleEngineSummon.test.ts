/**
 * 召喚獣の演出 (#750) の戦闘エンジン側: 演出の元（`cue`）を持つ召喚・わざ・敵の特技が、行動の記録（`BattleActionEvent.summon`）に載る。
 * 演出の元を持たない戦闘は、イベントの形も乱数の消費も従来どおり。
 */
import { describe, expect, it } from 'vitest'
import { BattleEngine, type SkillExecution, type SummonExecution } from './battleEngine'
import type { SummonCue } from '../types'
import type { BattleEntity } from './spellDsl'

function ent(id: string, over: Partial<BattleEntity> = {}): BattleEntity {
  return {
    id,
    name: id.toUpperCase(),
    hp: 100,
    maxHp: 100,
    mp: 10,
    maxMp: 10,
    atk: 10,
    def: 0,
    agi: 5,
    ...over,
  }
}
const foe = (id: string, over: Partial<BattleEntity> = {}): BattleEntity =>
  ent(id, { mp: 0, maxMp: 0, atk: 0, exp: 1, gold: 1, ...over })

const cue: SummonCue = {
  id: 'S001',
  name: '日本海の召喚獣',
  image: 'summons/S001.webp',
  se: 'se/wave.ogg',
  imaginary: true,
}
const wave: SummonExecution = {
  name: '日本海の召喚獣',
  target: '相手全体',
  mp: 0,
  effect: 'damage 30..30 type=water',
  cue,
}

describe('召喚: 行動の記録に summon が載る', () => {
  it('演出の元つきの召喚は skill イベントに summon（同じ内容）が付く', () => {
    const engine = new BattleEngine([ent('a')], [foe('s')], { rng: () => 0 })
    expect(engine.selectSummon(wave)).toBe(true)
    const ev = engine.getState().events.find((e) => e.kind === 'skill')
    expect(ev?.summon).toEqual(cue)
    expect(ev?.label).toBe('日本海の召喚獣')
    // 効果は従来どおり出る
    expect(ev?.hits.map((h) => h.amount)).toEqual([30])
  })
  it('演出の元の無い召喚には summon のキーが付かない（従来と同じ形）', () => {
    const engine = new BattleEngine([ent('a')], [foe('s')], { rng: () => 0 })
    engine.selectSummon({ ...wave, cue: undefined })
    const ev = engine.getState().events.find((e) => e.kind === 'skill')
    expect(ev).toBeDefined()
    expect('summon' in (ev as object)).toBe(false)
  })
  it('回数制限で呼べなかった 2 回目は知らせ（notice）だけで、summon の記録は増えない', () => {
    const party = [ent('a')]
    const engine = new BattleEngine(party, [foe('s', { hp: 999, maxHp: 999 })], { rng: () => 0 })
    expect(engine.selectSummon(wave)).toBe(true)
    // 敵ターンが終わって a の番に戻ったあと、もう一度呼ぼうとしても拒否される
    expect(engine.getState().phase).toBe('party-input')
    expect(engine.selectSummon(wave)).toBe(false)
    const evs = engine.getState().events
    const last = evs[evs.length - 1]
    expect(last).toMatchObject({ kind: 'notice' })
    expect(last?.summon).toBeUndefined()
    expect(engine.getState().events.filter((e) => e.summon).length).toBe(1)
  })
  it('複数ヒットの効果でも summon が付く', () => {
    const engine = new BattleEngine([ent('a')], [foe('s', { hp: 999, maxHp: 999 })], {
      rng: () => 0,
    })
    engine.selectSummon({ ...wave, effect: 'damage 5..5 type=water 回数=3' })
    const ev = engine.getState().events.find((e) => e.kind === 'skill')
    expect(ev?.hits).toHaveLength(3)
    expect(ev?.summon).toEqual(cue)
  })
  it('効果の無い（演出だけの）召喚獣でも summon が付く', () => {
    const engine = new BattleEngine([ent('a')], [foe('s')], { rng: () => 0 })
    engine.selectSummon({ name: cue.name, target: '自分', mp: 0, cue })
    const ev = engine.getState().events.find((e) => e.kind === 'skill')
    expect(ev?.summon).toEqual(cue)
    expect(ev?.hits).toEqual([])
  })
  it('MP 不足で呼べないときは notice だけで summon は付かない', () => {
    const engine = new BattleEngine([ent('a', { mp: 0 })], [foe('s')], { rng: () => 0 })
    expect(engine.selectSummon({ ...wave, mp: 5 })).toBe(false)
    expect(engine.getState().events.every((e) => e.summon === undefined)).toBe(true)
  })
})

describe('特技: 演出の元つきの特技（味方の「わざ」だけ。敵は呼ばない）', () => {
  const call: SkillExecution = {
    name: 'みなものよびごえ',
    target: '相手全体',
    effect: 'damage 12..12 type=water',
    cue,
  }
  it('敵が使っても enemy 側の skill イベントに summon は付かない（普通の特技として動く）', () => {
    const enemy = foe('boss', { hp: 999, maxHp: 999, actions: ['候補=call'], agi: 99 })
    const engine = new BattleEngine([ent('a')], [enemy], { rng: () => 0, skills: { call } })
    engine.selectAttack()
    const ev = engine.getState().events.find((e) => e.kind === 'skill')
    expect(ev?.actor.side).toBe('enemy')
    expect(ev?.summon).toBeUndefined()
    expect('summon' in (ev ?? {})).toBe(false)
    expect(ev?.label).toBe('みなものよびごえ')
    expect(ev?.hits.length).toBeGreaterThan(0)
  })
  it('味方の「わざ」でも付く', () => {
    const engine = new BattleEngine([ent('a')], [foe('s')], { rng: () => 0 })
    expect(engine.selectSkill(call)).toBe(true)
    const ev = engine.getState().events.find((e) => e.kind === 'skill')
    expect(ev?.summon).toEqual(cue)
  })
  it('演出の元の無い特技のイベントには summon のキーが付かない', () => {
    const enemy = foe('boss', { hp: 999, maxHp: 999, actions: ['候補=call'], agi: 99 })
    const engine = new BattleEngine([ent('a')], [enemy], {
      rng: () => 0,
      skills: { call: { ...call, cue: undefined } },
    })
    engine.selectAttack()
    for (const e of engine.getState().events) expect('summon' in e).toBe(false)
  })
})

describe('旧挙動不変: cue を付けても乱数の消費・ログ・HP は同じ', () => {
  const play = (withCue: boolean) => {
    const calls: number[] = []
    let n = 0
    const rng = () => {
      calls.push(n)
      n = (n * 7 + 3) % 11
      return n / 11
    }
    const party = [ent('a'), ent('b')]
    const enemies = [
      foe('s', { hp: 300, maxHp: 300, actions: ['候補=call'], agi: 9 }),
      foe('t', { hp: 300, maxHp: 300 }),
    ]
    const call: SkillExecution = {
      name: 'よびごえ',
      target: '相手全体',
      effect: 'damage 5..9 type=water',
      ...(withCue ? { cue } : {}),
    }
    const engine = new BattleEngine(party, enemies, { rng, skills: { call } })
    engine.selectSummon({
      ...wave,
      effect: 'damage 5..9 type=water',
      ...(withCue ? {} : { cue: undefined }),
    })
    engine.tick(3000)
    engine.selectAttack()
    engine.tick(3000)
    const s = engine.getState()
    return {
      calls: calls.length,
      log: s.log,
      hps: [...s.party, ...s.enemies].map((e) => e.hp),
      events: s.events.map((e) => ({ ...e, summon: undefined })),
    }
  }
  it('乱数の呼び出し回数・ログ・HP・（summon を除いた）イベントが一致する', () => {
    expect(play(true)).toEqual(play(false))
  })
})
