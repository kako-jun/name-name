/** 検証ハーネスの敵のレベルの族 (#898): 生成の決定性・形、実エンジンで壊れが出ないこと、規則の違反を `enemy-level-invariant` が検出すること */
import { describe, expect, it } from 'vitest'
import { isBroken } from './detect'
import { enemyLevelScenarios } from './generate'
import { buildSweep } from './sweep'
import { runScenario } from './run'
import { clone, realEngineFactory, type EngineFactory } from './scenario'

const NO_RANDOM = { randomSeed: 1, randomCount: 0, randomStatusCount: 0, randomScriptCount: 0 }

describe('enemyLevelScenarios', () => {
  const all = enemyLevelScenarios()

  it('決定的で、id は一意・`enemy-level/` で始まり、JSON にそのまま書き出せる。件数は 2×8×4×7', () => {
    expect(all.length).toBe(448)
    expect(enemyLevelScenarios().map((s) => s.id)).toEqual(all.map((s) => s.id))
    expect(new Set(all.map((s) => s.id)).size).toBe(all.length)
    expect(all.every((s) => s.id.startsWith('enemy-level/'))).toBe(true)
    for (const s of all) expect(clone(s)).toEqual(s)
  })

  it('総当たりの末尾（enemy-row の後）に足され、skip で外せる（他の族の並びは変わらない）', () => {
    const withIt = buildSweep({ ...NO_RANDOM, skip: ['script-grant', 'job-conversion'] })
    const without = buildSweep({
      ...NO_RANDOM,
      skip: ['enemy-level', 'script-grant', 'job-conversion'],
    })
    expect(withIt.length - without.length).toBe(448)
    expect(withIt.slice(0, without.length).map((s) => s.id)).toEqual(without.map((s) => s.id))
    expect(withIt.slice(without.length).map((s) => s.id)).toEqual(all.map((s) => s.id))
  })

  it('実エンジンでは 1 件も壊れない（倍数・倍数でない・レベル無し・クランプ）', () => {
    for (const s of all) {
      expect(
        runScenario(s).violations.filter((v) => isBroken(v)),
        s.id
      ).toEqual([])
    }
  })

  it('検査が素通りしていない: レベル 25 に 5 の倍数のデスは倒れ、レベル 24 は効かない', () => {
    const run = (level: number) => {
      const s = all.find((x) => x.id === `enemy-level/turn/lv${level}/x5/level+1`)
      if (!s) throw new Error('no scenario ' + level)
      const eng = realEngineFactory(s, () => 0)
      eng.selectSpell(s.spells[0], 's0')
      return eng.getState().enemies[0].hp
    }
    expect(run(25)).toBe(0)
    expect(run(4)).toBe(500)
  })
})

describe('runScenario: 規則の違反の検出', () => {
  const pick = (id: string) => enemyLevelScenarios().find((s) => s.id === id)!
  /** selectSpell の呪文の効果を書き換えるエンジン */
  const rewriting =
    (f: (effect: string) => string): EngineFactory =>
    (sc, rng) => {
      const e = realEngineFactory(sc, rng)
      const orig = e.selectSpell.bind(e)
      e.selectSpell = (spell, targetId, scope) =>
        orig({ ...spell, effect: f(spell.effect ?? '') }, targetId, scope)
      return e
    }

  it('倍数でなくても通してしまうエンジン（条件を捨てる）は検出される', () => {
    const r = runScenario(pick('enemy-level/turn/lv4/x5/level+1'), {
      engineFactory: rewriting((e) => e.replace(/ レベル倍数=\d+/, '')),
      driveLimit: 0,
    })
    expect(r.violations.some((v) => v.kind === 'enemy-level-invariant')).toBe(true)
  })

  it('レベル調整を無視するエンジン（調整を +0 にすり替え）は検出される', () => {
    const r = runScenario(pick('enemy-level/turn/lv4/x5/level+1'), {
      engineFactory: rewriting((e) => (e.startsWith('level') ? 'level +0' : e)),
      driveLimit: 0,
    })
    expect(r.violations.some((v) => v.kind === 'enemy-level-invariant')).toBe(true)
  })

  it('倍数のときに通さないエンジン（即死を無効にすり替え）も検出される', () => {
    const r = runScenario(pick('enemy-level/turn/lv10/x5/level+1'), {
      engineFactory: rewriting((e) => (e.startsWith('damage_full') ? 'level +0' : e)),
      driveLimit: 0,
    })
    expect(r.violations.some((v) => v.kind === 'enemy-level-invariant')).toBe(true)
  })

  it('enemy-level-invariant は壊れとして数える', () => {
    expect(isBroken({ kind: 'enemy-level-invariant', detail: '', opIndex: 0 })).toBe(true)
  })
})
