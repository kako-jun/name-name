/** 検証ハーネスのラーニングの族 (#882): 生成の決定性・形、実エンジンで壊れが出ないこと、規則の違反を `learning-invariant` が検出すること */
import { describe, expect, it } from 'vitest'
import { isBroken } from './detect'
import { learningScenarios } from './generate'
import { buildSweep } from './sweep'
import { runScenario } from './run'
import { clone, realEngineFactory, type EngineFactory } from './scenario'

const NO_RANDOM = { randomSeed: 1, randomCount: 0, randomStatusCount: 0, randomScriptCount: 0 }

describe('learningScenarios', () => {
  const all = learningScenarios()

  it('決定的で、id は一意・`learning/` で始まり、JSON にそのまま書き出せる。件数は 2×5×3×3×3×3', () => {
    expect(all.length).toBe(810)
    expect(learningScenarios().map((s) => s.id)).toEqual(all.map((s) => s.id))
    expect(new Set(all.map((s) => s.id)).size).toBe(all.length)
    expect(all.every((s) => s.id.startsWith('learning/'))).toBe(true)
    for (const s of all) expect(clone(s)).toEqual(s)
  })

  it('総当たりの末尾に足され、skip で外せる（他の族の並びは変わらない）', () => {
    const withIt = buildSweep(NO_RANDOM)
    const without = buildSweep({ ...NO_RANDOM, skip: ['learning'] })
    expect(withIt.length - without.length).toBe(810)
    expect(withIt.slice(0, without.length).map((s) => s.id)).toEqual(without.map((s) => s.id))
    expect(withIt.slice(without.length).map((s) => s.id)).toEqual(all.map((s) => s.id))
  })

  it('実エンジンでは 1 件も壊れない（向き・重複・初期の習得済み・耐性）', () => {
    for (const s of all) {
      expect(
        runScenario(s).violations.filter((v) => isBroken(v)),
        s.id
      ).toEqual([])
    }
  })

  it('覚えるシナリオは実際に結果に載せている（検査が素通りしていない）。勝利・全滅・逃走のそれぞれ', () => {
    for (const end of ['victory', 'defeat']) {
      const s = all.find((x) => x.id === `learning/turn/opp-single/l1/empty/${end}/p1`)!
      const eng = realEngineFactory(s, () => 0)
      for (let i = 0; i < 400 && !eng.isOver(); i++) eng.selectAttack()
      expect(eng.getResult?.()?.learnedSpells, end).toEqual(['flame'])
    }
    const s = all.find((x) => x.id === 'learning/turn/opp-single/l1/empty/escape/p1')!
    const eng = realEngineFactory(s, () => 0)
    eng.selectAttack()
    for (let i = 0; i < 20 && !eng.isOver(); i++) eng.selectEscape()
    expect(eng.getResult?.()?.outcome).toBe('escaped')
    expect(eng.getResult?.()?.learnedSpells).toEqual(['flame'])
  })
})

describe('runScenario: 規則の違反の検出', () => {
  const pick = (id: string) => learningScenarios().find((s) => s.id === id)!
  /** 結果から習得済みを落とすエンジン */
  const dropAll: EngineFactory = (sc, rng) => {
    const e = realEngineFactory(sc, rng)
    const orig = e.getResult!.bind(e)
    e.getResult = () => {
      const r = orig()
      if (!r) return r
      const { learnedSpells: _drop, ...rest } = r
      void _drop
      return rest
    }
    return e
  }
  /** 全滅のときだけ結果に載せないエンジン */
  const dropOnDefeat: EngineFactory = (sc, rng) => {
    const e = realEngineFactory(sc, rng)
    const orig = e.getResult!.bind(e)
    e.getResult = () => {
      const r = orig()
      if (r && r.outcome === 'defeat') {
        const { learnedSpells: _drop, ...rest } = r
        void _drop
        return rest
      }
      return r
    }
    return e
  }

  it('食らったのに結果に載せないエンジンは検出される（勝利）', () => {
    const r = runScenario(pick('learning/turn/opp-single/l1/empty/victory/p1'), {
      engineFactory: dropAll,
    })
    expect(r.violations.some((v) => v.kind === 'learning-invariant')).toBe(true)
  })

  it('全滅のときだけ載せないエンジンは検出される（全滅・複数の味方・戦闘不能が混じる）', () => {
    for (const pt of ['p1', 'p2', 'p3down']) {
      const r = runScenario(pick(`learning/turn/opp-all/l1/empty/defeat/${pt}`), {
        engineFactory: dropOnDefeat,
      })
      expect(
        r.violations.some((v) => v.kind === 'learning-invariant'),
        pt
      ).toBe(true)
    }
  })

  it('初期の習得済みを落とすエンジンは検出される', () => {
    const factory: EngineFactory = (sc, rng) =>
      realEngineFactory({ ...sc, learning: { initial: [] } }, rng)
    const r = runScenario(pick('learning/turn/opp-single/l1/ice+flame/victory/p1'), {
      engineFactory: factory,
    })
    expect(r.violations.some((v) => v.kind === 'learning-invariant')).toBe(true)
  })

  it('仲間・自分に使う技でも覚えてしまうエンジン（向きを偽る）は検出される', () => {
    const factory: EngineFactory = (sc, rng) =>
      realEngineFactory(
        {
          ...sc,
          skills: Object.fromEntries(
            Object.entries(sc.skills ?? {}).map(([k, v]) => [k, { ...v, target: '相手単体' }])
          ),
        },
        rng
      )
    const r = runScenario(pick('learning/turn/ally-single/l1/empty/victory/p1'), {
      engineFactory: factory,
    })
    expect(r.violations.some((v) => v.kind === 'learning-invariant')).toBe(true)
  })

  it('learning-invariant は壊れとして数える', () => {
    expect(isBroken({ kind: 'learning-invariant', detail: '', opIndex: 0 })).toBe(true)
  })
})
