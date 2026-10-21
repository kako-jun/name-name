/** 検証ハーネスのジョブの族 (#740): 生成の決定性・形、実エンジンで壊れが出ないこと */
import { describe, expect, it } from 'vitest'
import { isBroken } from './detect'
import { JOB_SET, jobScenarios } from './generate'
import { runScenario } from './run'
import { clone } from './scenario'
import { buildSweep } from './sweep'

describe('jobScenarios: 生成', () => {
  const all = jobScenarios()

  it('決定的で、id は一意・`job/` で始まり、JSON にそのまま書き出せる。コマンド（わざ）は持たない', () => {
    expect(all.length).toBeGreaterThan(150)
    expect(jobScenarios().map((s) => s.id)).toEqual(all.map((s) => s.id))
    expect(new Set(all.map((s) => s.id)).size).toBe(all.length)
    expect(all.every((s) => s.id.startsWith('job/'))).toBe(true)
    expect(all.every((s) => s.abilities === undefined)).toBe(true)
    for (const s of all.filter((_, i) => i % 29 === 0)) expect(clone(s)).toEqual(s)
  })

  it('ジョブの組み合わせの境界（無し・既定・転職・ジョブ無し・宣言なし・就けない・極端・不正・層の超過）を含み、結果が期待どおり', () => {
    const names = new Set(all.map((s) => s.id.split('/')[2]))
    for (const n of [
      'none',
      'first',
      'changed',
      'no-job',
      'unknown',
      'not-candidate',
      'no-candidates',
      'cursed',
      'broken',
      'job+armor-absorb',
      'job+armor-over',
      'job+stone-over',
    ]) {
      expect(names.has(n), n).toBe(true)
    }
    const pick = (name: string) => all.find((s) => s.id.split('/')[2] === name)!
    // 先頭のジョブ（看護師）: DEF+3, HP+20
    expect(pick('first').party[0]).toMatchObject({ def: 3, maxHp: 320 })
    // 転職（海女）: AGI+2 と水の半減
    expect(pick('changed').party[0]).toMatchObject({ agi: 7, affinity: { halve: ['water'] } })
    // ジョブ無し・宣言なし・就けない・候補なしは何も起きない
    for (const n of ['none', 'no-job', 'unknown', 'not-candidate', 'no-candidates']) {
      expect(pick(n).party[0], n).toMatchObject({ atk: 10, def: 0, maxHp: 300 })
      expect(Object.keys(pick(n).party[0]), n).not.toContain('affinity')
    }
    // ジョブの属性は攻撃の属性にならない
    expect(pick('twin').party[0].attackElements).toBeUndefined()
    // 装備の防具と同属性で吸収、層は合計 2 まで（ジョブの層が先に捨てられる）
    expect(pick('job+armor-absorb').party[0].affinity).toEqual({ absorb: ['water'] })
    expect(pick('job+armor-over').party[0].affinity).toEqual({ absorb: ['fire'] })
    expect(pick('job+stone-over').party[0].affinity).toEqual({ halve: ['fire', 'ice'] })
    // 極端なボーナスでも最大 HP は 1 以上・能力値は 0 以上
    const cursed = pick('cursed').party[0]
    expect(cursed.maxHp).toBeGreaterThanOrEqual(1)
    expect(cursed.atk).toBeGreaterThanOrEqual(0)
    expect(cursed.def).toBeGreaterThanOrEqual(0)
    // 不正なボーナスの書式は読めた分だけ
    expect(pick('broken').party[0]).toMatchObject({ atk: 10, def: 2 })
    expect(Object.keys(JOB_SET).length).toBeGreaterThanOrEqual(6)
  })

  it('ターン制/ATB・敵の相性・操作の並びを総当たりしている', () => {
    expect(all.some((s) => s.atb)).toBe(true)
    expect(all.some((s) => !s.atb)).toBe(true)
    expect(all.some((s) => s.ops.some((o) => o.t === 'escape'))).toBe(true)
  })

  it('SweepFamily `job` は buildSweep の最後に足され、skip で除ける。直前の族のシナリオは変わらない', () => {
    const heavy = [
      'effect-matrix',
      'enemy-skill',
      'stack-order',
      'reaction-chain',
      'random',
      'status-matrix',
      'random-status',
      'damage-condition',
      'magicite',
      'script',
      'random-script',
      'equipment',
    ] as const
    const cfg = { randomSeed: 1, randomCount: 0, randomStatusCount: 0 }
    const withIt = buildSweep({ ...cfg, skip: [...heavy] })
    const without = buildSweep({ ...cfg, skip: [...heavy, 'job'] })
    expect(withIt.length - without.length).toBe(all.length)
    expect(withIt.slice(0, without.length)).toEqual(without)
    expect(without.every((s) => s.id.startsWith('loot/'))).toBe(true)
    expect(withIt.slice(without.length).map((s) => s.id)).toEqual(all.map((s) => s.id))
  })
})

describe('実エンジンで走らせる（間引いた件数。全件は npm run test:battle-harness）', () => {
  it('間引いたシナリオに壊れが無い', () => {
    const picked = jobScenarios().filter((_, i) => i % 5 === 0)
    expect(picked.length).toBeGreaterThan(40)
    for (const s of picked) {
      const r = runScenario(s)
      expect(
        r.violations.filter((v) => isBroken(v)),
        s.id
      ).toEqual([])
    }
  })
})
