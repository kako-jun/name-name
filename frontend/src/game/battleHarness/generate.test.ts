/**
 * 生成・集計 (#877 段階 3) のテスト。生成が決定論的・JSON 化できること、集計の分類、通常実行を重くしない範囲の小さな総当たり。
 */
import { describe, expect, it } from 'vitest'
import {
  effectMatrix,
  enemySkillMatrix,
  EFFECTS,
  randomScenarios,
  reactionChains,
  stackOrders,
  STACK_EFFECTS,
} from './generate'
import { candidates, formatReport, summarize } from './report'
import { runAll } from './sweep'
import { runScenario } from './run'

describe('生成', () => {
  it('総当たりの件数が直積どおり', () => {
    expect(effectMatrix()).toHaveLength(EFFECTS.length * 5 * 10 * 5)
    expect(enemySkillMatrix()).toHaveLength(EFFECTS.length * 5 * 10 * 3)
    expect(stackOrders(3)).toHaveLength(STACK_EFFECTS.length ** 3 * 2)
    expect(reactionChains()).toHaveLength(8 * 8 * 8 * 2)
  })

  it('id は全体で一意', () => {
    const all = [
      ...effectMatrix(),
      ...enemySkillMatrix(),
      ...stackOrders(2),
      ...reactionChains(),
      ...randomScenarios(1, 200),
    ]
    expect(new Set(all.map((s) => s.id)).size).toBe(all.length)
  })

  it('ランダム合成は seed と件数が同じなら完全に同じ（JSON 化しても同じ）', () => {
    const a = randomScenarios(5, 50)
    expect(randomScenarios(5, 50)).toEqual(a)
    expect(JSON.parse(JSON.stringify(a))).toEqual(a)
    expect(randomScenarios(6, 50)).not.toEqual(a)
  })
})

describe('小さな総当たりを実エンジンで走らせる（通常実行を重くしない件数）', () => {
  it('同じ入力なら同じ結果・集計が件数と整合する', () => {
    const scenarios = [
      ...randomScenarios(1, 15),
      ...stackOrders(2).slice(0, 20),
      ...reactionChains().slice(0, 20),
    ]
    const r1 = runAll(scenarios)
    const r2 = runAll(scenarios)
    expect(r2).toEqual(r1)
    const sum = summarize(r1)
    expect(sum.total).toBe(scenarios.length)
    expect(sum.broken + sum.needsJudgement + sum.normal).toBe(sum.total)
    const text = formatReport(sum, candidates(r1), r1)
    expect(text).toContain('壊れ（止めるべき）')
    expect(text).toContain('凄い組み合わせの候補')
  })
})

describe('集計', () => {
  it('壊れ・要判断・正常を分け、壊れたシナリオは候補に混ぜない', () => {
    const base = {
      opsRun: 1,
      driveSteps: 0,
      ended: true,
      finalPhase: 'victory',
      maxEventDamage: 50,
      maxHealAmount: 0,
      maxHitsPerEvent: 1,
      maxAbsBuff: 0,
      maxEventsPerOp: 1,
      maxHpDrop: 50,
    }
    const results = [
      { id: 'f/ok', violations: [], metrics: base },
      { id: 'f/big', violations: [], metrics: { ...base, maxEventDamage: 9000 } },
      {
        id: 'f/bad',
        violations: [{ kind: 'negative-hp' as const, detail: 'x', opIndex: 0 }],
        metrics: { ...base, maxEventDamage: 99999 },
      },
      {
        id: 'f/stale',
        violations: [{ kind: 'stalemate' as const, detail: 'y', opIndex: 0 }],
        metrics: { ...base, ended: false },
      },
    ]
    const s = summarize(results)
    expect([s.total, s.broken, s.needsJudgement, s.normal]).toEqual([4, 1, 1, 2])
    expect(s.byFamily.f).toEqual({ total: 4, broken: 1 })
    const dmg = candidates(results).find((c) => c.metric === 'maxEventDamage')!
    expect(dmg.rows.map((r) => r.value)).toEqual([9000, 50])
    expect(dmg.rows[1].ties).toBe(0)
  })

  it('同値の候補は 1 行にまとめ、他の件数を ties に出す', () => {
    const m = {
      opsRun: 1,
      driveSteps: 0,
      ended: true,
      finalPhase: 'v',
      maxEventDamage: 7,
      maxHealAmount: 0,
      maxHitsPerEvent: 0,
      maxAbsBuff: 0,
      maxEventsPerOp: 0,
      maxHpDrop: 0,
    }
    const rows = candidates([
      { id: 'a', violations: [], metrics: m },
      { id: 'b', violations: [], metrics: m },
    ]).find((c) => c.metric === 'maxEventDamage')!.rows
    expect(rows).toEqual([{ id: 'a', value: 7, ties: 1 }])
  })
})

describe('実エンジンの既知の状態', () => {
  it('族の id から 1 件を取り出して走らせると、同じ id の結果が再現する', () => {
    const s = effectMatrix().find((x) => x.id.startsWith('effect-matrix/e0/'))!
    const r = runScenario(s)
    expect(r.id).toBe(s.id)
    expect(runScenario(JSON.parse(JSON.stringify(s)))).toEqual(r)
  })
})
