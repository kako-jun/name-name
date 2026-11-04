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

  it('決定的で、id は一意・`learning/` で始まり、JSON にそのまま書き出せる。件数は 2×5×3×4×2', () => {
    expect(all.length).toBe(240)
    expect(learningScenarios().map((s) => s.id)).toEqual(all.map((s) => s.id))
    expect(new Set(all.map((s) => s.id)).size).toBe(all.length)
    expect(all.every((s) => s.id.startsWith('learning/'))).toBe(true)
    for (const s of all) expect(clone(s)).toEqual(s)
  })

  it('総当たりの末尾に足され、skip で外せる（他の族の並びは変わらない）', () => {
    const withIt = buildSweep(NO_RANDOM)
    const without = buildSweep({ ...NO_RANDOM, skip: ['learning'] })
    expect(withIt.length - without.length).toBe(240)
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

  it('覚えるシナリオは実際に覚えている（検査が素通りしていない）', () => {
    const s = all.find((x) => x.id === 'learning/turn/opp-single/l1/empty/p1')!
    const eng = realEngineFactory(s, () => 0)
    for (let i = 0; i < 300 && !eng.isOver(); i++) eng.selectAttack()
    expect(eng.getResult?.()?.learnedSpells).toEqual(['flame'])
  })
})

describe('runScenario: 規則の違反の検出', () => {
  const pick = (id: string) => learningScenarios().find((s) => s.id === id)!

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
    // 検査は元のシナリオの向き（仲間単体）で見るので、向きを偽るエンジンは覚えるはずのない呪文を入れる
    const r = runScenario(pick('learning/turn/ally-single/l1/empty/p1'), {
      engineFactory: factory,
      driveLimit: 400,
    })
    expect(r.violations.some((v) => v.kind === 'learning-invariant')).toBe(true)
  })

  it('初期の習得済みを落とすエンジンは検出される', () => {
    const factory: EngineFactory = (sc, rng) =>
      realEngineFactory({ ...sc, learning: { initial: [] } }, rng)
    const r = runScenario(pick('learning/turn/opp-single/l1/ice+flame/p1'), {
      engineFactory: factory,
      driveLimit: 400,
    })
    expect(r.violations.some((v) => v.kind === 'learning-invariant')).toBe(true)
  })

  it('learning-invariant は壊れとして数える', () => {
    expect(isBroken({ kind: 'learning-invariant', detail: '', opIndex: 0 })).toBe(true)
  })
})
