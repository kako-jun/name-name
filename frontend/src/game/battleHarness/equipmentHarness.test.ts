/** 検証ハーネスの装備の族 (#207): 生成の決定性・形、わざの操作（ability）、実エンジンで壊れが出ないこと */
import { describe, expect, it } from 'vitest'
import type { SkillExecution } from '../battleEngine'
import { isBroken } from './detect'
import { EQUIPMENT_ABILITIES, EQUIPMENT_SET, equipmentScenarios } from './generate'
import { runScenario } from './run'
import { applyOp, clone, type HarnessEngine } from './scenario'
import { baseState, fakeFactory, scenarioOf } from './testing'
import { buildSweep } from './sweep'

describe('equipmentScenarios: 生成', () => {
  const all = equipmentScenarios()

  it('決定的で、id は一意・`equipment/` で始まり、JSON にそのまま書き出せる', () => {
    expect(all.length).toBeGreaterThan(300)
    expect(equipmentScenarios().map((s) => s.id)).toEqual(all.map((s) => s.id))
    expect(new Set(all.map((s) => s.id)).size).toBe(all.length)
    expect(all.every((s) => s.id.startsWith('equipment/'))).toBe(true)
    for (const s of all.filter((_, i) => i % 53 === 0)) expect(clone(s)).toEqual(s)
  })

  it('装備の組み合わせの境界（装備なし・枠超過・種別違い・装備可違反・宣言なし・重複・枠なし・層の超過・極端なボーナス）を含む', () => {
    const names = new Set(all.map((s) => s.id.split('/')[2]))
    for (const n of [
      'none',
      'full',
      'two-weapons-one-slot',
      'armor-absorb',
      'armor-layers-over',
      'stone-twin+armor',
      'cursed',
      'broken',
      'not-equippable',
      'restricted',
      'unknown',
      'duplicate',
      'no-weapon-slot',
      'no-slots',
    ]) {
      expect(names.has(n), n).toBe(true)
    }
    const pick = (name: string) => all.find((s) => s.id.split('/')[2] === name)!
    // 武器のボーナスとわざ
    expect(pick('sword').party[0].atk).toBe(18)
    expect(pick('sword').abilities?.map((a) => a.name)).toEqual(['きりさく'])
    // 同じ属性の防具 2 枠で吸収。層は合計 2 まで（3 枚目の防具は捨てる）
    expect(pick('armor-absorb').party[0].affinity).toEqual({ absorb: ['water'] })
    expect(pick('armor-layers-over').party[0].affinity).toEqual({ halve: ['fire', 'water'] })
    // 防具の属性は通常攻撃の属性にならない。魔石の属性は先に層を埋める
    expect(pick('armor-absorb').party[0].attackElements).toBeUndefined()
    expect(pick('stone-twin+armor').party[0].attackElements).toEqual(['fire', 'ice'])
    expect(pick('stone-twin+armor').party[0].affinity).toEqual({ halve: ['fire', 'ice'] })
    // 装備できないものは何も起きない
    for (const n of ['none', 'not-equippable', 'restricted', 'unknown', 'no-slots']) {
      expect(pick(n).party[0].atk, n).toBe(10)
      expect(pick(n).abilities ?? [], n).toEqual([])
    }
    expect(pick('no-weapon-slot').abilities ?? []).toEqual([])
    expect(pick('duplicate').abilities).toHaveLength(1)
    // 極端なボーナスでも最大 HP は 1 以上・能力値は 0 以上
    const cursed = pick('cursed').party[0]
    expect(cursed.maxHp).toBeGreaterThanOrEqual(1)
    expect(cursed.atk).toBeGreaterThanOrEqual(0)
    expect(cursed.def).toBeGreaterThanOrEqual(0)
    // 不正なボーナスの書式は読めた分だけ、宣言の無いわざは出ない
    expect(pick('broken').party[0]).toMatchObject({ atk: 10, def: 2 })
    expect(pick('broken').abilities?.map((a) => a.name)).toEqual(['こわれた技'])
  })

  it('わざの使い方（連打・攻撃のあと）・ターン制/ATB を総当たりしている', () => {
    expect(all.some((s) => s.ops.filter((o) => o.t === 'ability').length >= 2)).toBe(true)
    expect(all.some((s) => s.atb)).toBe(true)
    expect(all.some((s) => !s.atb)).toBe(true)
    expect(Object.keys(EQUIPMENT_SET).length).toBeGreaterThanOrEqual(10)
    expect(Object.keys(EQUIPMENT_ABILITIES).length).toBeGreaterThanOrEqual(5)
  })

  it('SweepFamily `equipment` は buildSweep の `job` の前に足され、skip で除ける。直前の族のシナリオは変わらない', () => {
    // 重い族は skip で省いて、末尾に足されることだけを確かめる（既存族のバイト一致は npm run test:battle-harness の出力比較で見る）
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
      'summon',
    ] as const
    const cfg = { randomSeed: 1, randomCount: 0, randomStatusCount: 0 }
    const withIt = buildSweep({ ...cfg, skip: [...heavy, 'job'] })
    const without = buildSweep({ ...cfg, skip: [...heavy, 'job', 'equipment'] })
    expect(withIt.length - without.length).toBe(all.length)
    expect(withIt.slice(0, without.length)).toEqual(without)
    expect(without.every((s) => s.id.startsWith('loot/'))).toBe(true)
    expect(withIt.slice(without.length).map((s) => s.id)).toEqual(all.map((s) => s.id))
  })
})

describe('applyOp: ability', () => {
  const slash: SkillExecution = { name: 'きる', target: '相手単体' }
  const spy = () => {
    const used: string[] = []
    const engine = {
      ...fakeFactory(() => {})(scenarioOf(), () => 0),
      selectSkill: (s: SkillExecution) => {
        used.push(s.name)
        return true
      },
    } as HarnessEngine
    return { engine, used }
  }

  it('abilities の k 番目を selectSkill へ渡す（複製して渡す）', () => {
    const { engine, used } = spy()
    const sc = scenarioOf({ abilities: [slash] })
    applyOp(engine, sc, { t: 'ability', k: 0 })
    expect(used).toEqual(['きる'])
  })

  it('範囲外の添字・abilities なし・selectSkill を持たないエンジンは何もしない', () => {
    const { engine, used } = spy()
    applyOp(engine, scenarioOf({ abilities: [slash] }), { t: 'ability', k: 3 })
    applyOp(engine, scenarioOf(), { t: 'ability', k: 0 })
    expect(used).toEqual([])
    const bare = fakeFactory(() => {})(scenarioOf({ abilities: [slash] }), () => 0)
    expect(() =>
      applyOp(bare, scenarioOf({ abilities: [slash] }), { t: 'ability', k: 0 })
    ).not.toThrow()
    expect(baseState([], []).phase).toBe('party-input')
  })
})

describe('実エンジンで走らせる（間引いた件数。全件は npm run test:battle-harness）', () => {
  it('間引いたシナリオに壊れが無い', () => {
    const picked = equipmentScenarios().filter((_, i) => i % 7 === 0)
    expect(picked.length).toBeGreaterThan(50)
    for (const s of picked) {
      const r = runScenario(s)
      expect(
        r.violations.filter((v) => isBroken(v)),
        s.id
      ).toEqual([])
    }
  })

  it('わざを使うシナリオでは、わざが実際に敵へ効く（ability op が空振りしていない）', () => {
    const s = equipmentScenarios().find((x) =>
      x.id.includes('/turn/sword/plain/hp900/ability-spam')
    )!
    const factoryRun = runScenario(s)
    expect(factoryRun.metrics.maxEventDamage).toBeGreaterThan(0)
    expect(s.abilities?.[0]).toMatchObject({ name: 'きりさく' })
  })
})
