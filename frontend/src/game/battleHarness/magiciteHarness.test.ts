/** 検証ハーネスの魔石の族 (#889): 生成の決定性・形、検出器 `magicite-invariant`、召喚の回数制限の検出、実エンジンで壊れが出ないこと */
import { describe, expect, it } from 'vitest'
import type { SummonExecution } from '../battleEngine'
import { checkState, isBroken, type ViolationKind } from './detect'
import { MAGICITE_SUMMONS, entity, magiciteScenarios } from './generate'
import { runScenario } from './run'
import { applyOp, clone, type HarnessEngine, type Scenario } from './scenario'
import { baseState, fakeFactory, scenarioOf } from './testing'

const OPTS = { maxDamage: 9999 }
const kinds = (s: ReturnType<typeof baseState>): ViolationKind[] =>
  checkState(s, s.events, 0, OPTS).map((v) => v.kind)

describe('magiciteScenarios: 生成', () => {
  const all = magiciteScenarios()

  it('決定的で、id は一意・`magicite/` で始まり、JSON にそのまま書き出せる', () => {
    expect(all.length).toBeGreaterThan(1000)
    expect(magiciteScenarios().map((s) => s.id)).toEqual(all.map((s) => s.id))
    expect(new Set(all.map((s) => s.id)).size).toBe(all.length)
    expect(all.every((s) => s.id.startsWith('magicite/'))).toBe(true)
    for (const s of all.filter((_, i) => i % 97 === 0)) expect(clone(s)).toEqual(s)
  })

  it('魔石の組み合わせの境界（装備なし・枠 0・枠超過・層の超過・負の極端なボーナス）を含む', () => {
    const names = new Set(all.map((s) => s.id.split('/')[2]))
    for (const n of [
      'none',
      'water+water',
      'three-over',
      'twin+extra',
      'over-slots',
      'zero-slot',
      'heavy',
      'broken',
    ]) {
      expect(names.has(n), n).toBe(true)
    }
    // 層は合計 2 まで・装備なし/枠 0 は属性なし
    for (const s of all) {
      const els = s.party[0].attackElements
      expect((els ?? []).length).toBeLessThanOrEqual(2)
      if (/\/(none|zero-slot)\//.test(s.id)) expect(els).toBeUndefined()
    }
    const absorb = all.find((s) => s.id.includes('/water+water/'))!
    expect(absorb.party[0].affinity).toEqual({ absorb: ['water'] })
    // 重い魔石でも最大 HP は 1 以上・能力値は 0 以上
    const heavy = all.find((s) => s.id.includes('/heavy/'))!
    expect(heavy.party[0].maxHp).toBeGreaterThanOrEqual(1)
    expect(heavy.party[0].atk).toBeGreaterThanOrEqual(0)
  })

  it('召喚の中身・操作（2 連打・攻撃のあと）・ターン制/ATB を総当たりしている', () => {
    expect(MAGICITE_SUMMONS.length).toBeGreaterThanOrEqual(10)
    expect(all.some((s) => s.ops.filter((o) => o.t === 'summon').length >= 2)).toBe(true)
    expect(all.some((s) => s.atb)).toBe(true)
    expect(all.some((s) => !s.atb)).toBe(true)
    expect(all.every((s) => (s.summons ?? []).length === 1)).toBe(true)
  })
})

describe('実エンジンで走らせる（間引いた件数。全件は npm run test:battle-harness）', () => {
  it('間引いたシナリオに壊れが無く、召喚は 1 人 1 回までしか通らない', () => {
    const picked = magiciteScenarios().filter((_, i) => i % 41 === 0)
    expect(picked.length).toBeGreaterThan(100)
    for (const s of picked) {
      const r = runScenario(s)
      expect(
        r.violations.filter((v) => isBroken(v)),
        s.id
      ).toEqual([])
    }
  })
})

describe('checkState: 魔石の不変条件 (magicite-invariant)', () => {
  it('通常攻撃の属性は空でない文字列が最大 2 個。召喚済みの印は真か未指定', () => {
    const ok = baseState(
      [entity('a', { attackElements: ['water', 'fire'], summoned: true })],
      [entity('s')]
    )
    expect(kinds(ok)).toEqual([])
    const three = baseState([entity('a', { attackElements: ['a', 'b', 'c'] })], [entity('s')])
    expect(kinds(three)).toContain('magicite-invariant')
    const empty = baseState([entity('a', { attackElements: [''] })], [entity('s')])
    expect(kinds(empty)).toContain('magicite-invariant')
    const notArray = baseState(
      [entity('a', { attackElements: 'fire' as unknown as string[] })],
      [entity('s')]
    )
    expect(kinds(notArray)).toContain('magicite-invariant')
    const falseFlag = baseState([entity('a', { summoned: false })], [entity('s')])
    expect(kinds(falseFlag)).toContain('magicite-invariant')
    // 敵側にも同じ検査
    const foeBad = baseState([entity('a')], [entity('s', { attackElements: ['a', 'b', 'c'] })])
    expect(kinds(foeBad)).toContain('magicite-invariant')
  })
  it('壊れとして数える（要判断扱いではない）', () => {
    expect(isBroken({ kind: 'magicite-invariant', detail: '', opIndex: 0 })).toBe(true)
  })
})

describe('runScenario: 召喚の回数制限の検出', () => {
  const summon: SummonExecution = { name: 'うみ', target: '相手全体', mp: 0 }
  const withSummon = (over: Partial<Scenario> = {}): Scenario =>
    scenarioOf({
      summons: [summon],
      ops: [
        { t: 'summon', m: 0 },
        { t: 'summon', m: 0 },
      ],
      ...over,
    })
  /** 召喚のたびに skill イベントを積む合成エンジン。`mark` が false なら召喚済みの印を立てない */
  const factory = (mark: boolean, actorIndex = 0) => {
    const base = fakeFactory(() => {})
    return (scenario: Scenario, rng: () => number): HarnessEngine => {
      const engine = base(scenario, rng)
      engine.selectSummon = (s) => {
        const st = engine.getState() as ReturnType<typeof baseState>
        st.events.push({
          seq: st.eventTotal,
          actor: { side: 'party', index: actorIndex },
          kind: 'skill',
          label: s.name,
          hits: [],
        })
        st.eventTotal++
        if (mark) st.party[actorIndex].summoned = true
        return true
      }
      return engine
    }
  }
  const kindsOf = (r: ReturnType<typeof runScenario>) => r.violations.map((v) => v.kind)

  it('同じ味方が 2 回召喚すると検出する（印は立っていても）', () => {
    const r = runScenario(withSummon(), { engineFactory: factory(true), driveLimit: 0 })
    expect(kindsOf(r)).toEqual(['magicite-invariant'])
    expect(r.violations[0].detail).toContain('2 回召喚')
    expect(r.violations[0].opIndex).toBe(1)
  })
  it('1 回だけなら違反なし。別の味方が 1 回ずつなら違反なし', () => {
    const one = runScenario(withSummon({ ops: [{ t: 'summon', m: 0 }] }), {
      engineFactory: factory(true),
      driveLimit: 0,
    })
    expect(kindsOf(one)).toEqual([])
    const sc = withSummon({ party: [entity('a'), entity('b')] })
    const base = factory(true)
    let who = 0
    const alternate = (s: Scenario, rng: () => number): HarnessEngine => {
      const e = base(s, rng)
      const orig = e.selectSummon!
      e.selectSummon = (x) => {
        const st = e.getState() as ReturnType<typeof baseState>
        const idx = who++
        st.events.push({
          seq: st.eventTotal++,
          actor: { side: 'party', index: idx },
          kind: 'skill',
          label: x.name,
          hits: [],
        })
        st.party[idx].summoned = true
        void orig
        return true
      }
      return e
    }
    expect(kindsOf(runScenario(sc, { engineFactory: alternate, driveLimit: 0 }))).toEqual([])
  })
  it('召喚したのに召喚済みの印が立っていなければ検出する', () => {
    const r = runScenario(withSummon({ ops: [{ t: 'summon', m: 0 }] }), {
      engineFactory: factory(false),
      driveLimit: 0,
    })
    expect(kindsOf(r)).toEqual(['magicite-invariant'])
    expect(r.violations[0].detail).toContain('summoned が立っていない')
  })
  it('召喚を使わないシナリオは検査しない（従来と同じ）', () => {
    const r = runScenario(scenarioOf(), { engineFactory: factory(false), driveLimit: 0 })
    expect(kindsOf(r)).toEqual([])
  })
  it('applyOp: 範囲外の添字・selectSummon を持たないエンジンでは何も起きない', () => {
    const calls: string[] = []
    const engine = {
      selectSummon: (s: SummonExecution) => {
        calls.push(s.name)
        return true
      },
    } as unknown as HarnessEngine
    applyOp(engine, withSummon(), { t: 'summon', m: 5 })
    expect(calls).toEqual([])
    applyOp(engine, withSummon(), { t: 'summon', m: 0 })
    expect(calls).toEqual(['うみ'])
    applyOp({} as HarnessEngine, withSummon(), { t: 'summon', m: 0 })
    applyOp(engine, scenarioOf(), { t: 'summon', m: 0 })
    expect(calls).toEqual(['うみ'])
  })
})
