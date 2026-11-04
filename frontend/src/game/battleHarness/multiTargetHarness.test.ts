/** 検証ハーネスの魔法の全体化の族 (#895): 生成の決定性・形、実エンジンで壊れが出ないこと、割り算の規則の違反を `multi-target-invariant` が検出すること */
import { describe, expect, it } from 'vitest'
import { isBroken } from './detect'
import { multiTargetScenarios } from './generate'
import { buildSweep } from './sweep'
import { runScenario } from './run'
import { clone, realEngineFactory, type EngineFactory } from './scenario'

describe('multiTargetScenarios', () => {
  const all = multiTargetScenarios()

  it('決定的で、id は一意・`multi-target/` で始まり、JSON にそのまま書き出せる。件数は 2×4×7×2×4', () => {
    expect(all.length).toBe(448)
    expect(multiTargetScenarios().map((s) => s.id)).toEqual(all.map((s) => s.id))
    expect(new Set(all.map((s) => s.id)).size).toBe(all.length)
    expect(all.every((s) => s.id.startsWith('multi-target/'))).toBe(true)
    for (const s of all.filter((_, i) => i % 11 === 0)) expect(clone(s)).toEqual(s)
  })

  it('総当たりの末尾に足され、skip で外せる（他の族の並びは変わらない）', () => {
    const withIt = buildSweep({
      randomSeed: 1,
      randomCount: 0,
      randomStatusCount: 0,
      randomScriptCount: 0,
      skip: ['enemy-row', 'enemy-level', 'script-grant'],
    })
    const without = buildSweep({
      randomSeed: 1,
      randomCount: 0,
      randomStatusCount: 0,
      randomScriptCount: 0,
      skip: ['multi-target', 'enemy-row', 'enemy-level', 'script-grant'],
    })
    expect(withIt.length - without.length).toBe(448)
    expect(withIt.slice(0, without.length).map((s) => s.id)).toEqual(without.map((s) => s.id))
  })

  it('実エンジンでは 1 件も壊れない（割り算の規則・倒れた敵・単体のまま・敵全体）', () => {
    for (const s of all) {
      const r = runScenario(s)
      expect(
        r.violations.filter((v) => isBroken(v)),
        s.id
      ).toEqual([])
    }
  })
})

describe('runScenario: 全体化の規則の違反の検出', () => {
  const pick = (id: string) => multiTargetScenarios().find((s) => s.id === id)!
  const target = 'multi-target/turn/single-opt-in/e0/all/three'

  it('全体化を無視して単体で当てるエンジン（scope を捨てる）は検出される', () => {
    const factory: EngineFactory = (sc, rng) => {
      const e = realEngineFactory(sc, rng)
      const orig = e.selectSpell.bind(e)
      e.selectSpell = (spell, targetId) => orig(spell, targetId)
      return e
    }
    const r = runScenario(pick(target), { engineFactory: factory, driveLimit: 0 })
    expect(r.violations.some((v) => v.kind === 'multi-target-invariant')).toBe(true)
  })

  it('割らずに全体へ当てるエンジン（opt-in を外した呪文を単体に割り込ませる）も検出される', () => {
    // multiTarget を落として全体化を封じる + 範囲だけ全体で撃つ代わりに、割り算なしの全体ダメージを模す: 敵全体の呪文にすり替える
    const factory: EngineFactory = (sc, rng) => {
      const e = realEngineFactory(sc, rng)
      const orig = e.selectSpell.bind(e)
      e.selectSpell = (spell, targetId) => orig({ ...spell, target: '敵全体' }, targetId)
      return e
    }
    const r = runScenario(pick(target), { engineFactory: factory, driveLimit: 0 })
    expect(r.violations.some((v) => v.kind === 'multi-target-invariant')).toBe(true)
  })

  it('multi-target-invariant は壊れとして数える', () => {
    expect(isBroken({ kind: 'multi-target-invariant', detail: '', opIndex: 0 })).toBe(true)
  })
})
