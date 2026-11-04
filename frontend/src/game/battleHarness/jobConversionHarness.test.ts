/** 検証ハーネスのジョブの変換の族 (#876): 生成の決定性・形、実エンジンで壊れが出ないこと、ログの規則の違反を `job-conversion-invariant` が検出すること */
import { describe, expect, it } from 'vitest'
import { isBroken } from './detect'
import { jobConversionScenarios } from './generate'
import { buildSweep } from './sweep'
import { runScenario } from './run'
import { clone, realEngineFactory, type EngineFactory } from './scenario'

const NO_RANDOM = { randomSeed: 1, randomCount: 0, randomStatusCount: 0, randomScriptCount: 0 }

describe('jobConversionScenarios', () => {
  const all = jobConversionScenarios()

  it('決定的で、id は一意・`job-conversion/` で始まり、JSON にそのまま書き出せる。件数は 2×6×4×8', () => {
    expect(all.length).toBe(384)
    expect(jobConversionScenarios().map((s) => s.id)).toEqual(all.map((s) => s.id))
    expect(new Set(all.map((s) => s.id)).size).toBe(all.length)
    expect(all.every((s) => s.id.startsWith('job-conversion/'))).toBe(true)
    for (const s of all) expect(clone(s)).toEqual(s)
  })

  it('総当たりの末尾に足され、skip で外せる（他の族の並びは変わらない）', () => {
    const withIt = buildSweep(NO_RANDOM)
    const without = buildSweep({ ...NO_RANDOM, skip: ['job-conversion'] })
    expect(withIt.length - without.length).toBe(384)
    expect(withIt.slice(0, without.length).map((s) => s.id)).toEqual(without.map((s) => s.id))
    expect(withIt.slice(without.length).map((s) => s.id)).toEqual(all.map((s) => s.id))
  })

  it('変換が効くシナリオと効かないシナリオの両方がある', () => {
    expect(all.some((s) => s.abilities?.[0].convertedBy)).toBe(true)
    expect(all.some((s) => !s.abilities?.[0].convertedBy)).toBe(true)
  })

  it('実エンジンでは 1 件も壊れない（変換あり・なし・壊れた変換・効果なし）', () => {
    for (const s of all) {
      expect(
        runScenario(s).violations.filter((v) => isBroken(v)),
        s.id
      ).toEqual([])
    }
  })
})

describe('runScenario: ログの規則の違反の検出', () => {
  const converted = jobConversionScenarios().find(
    (s) => s.id === 'job-conversion/turn/steal/t1/steal2'
  )!
  const plain = jobConversionScenarios().find(
    (s) => s.id === 'job-conversion/turn/steal/t2/steal2'
  )!

  it('変換したのにログへ印を出さないエンジン（convertedBy を落とす）は検出される', () => {
    const factory: EngineFactory = (sc, rng) => {
      const e = realEngineFactory(sc, rng)
      const orig = e.selectSkill!.bind(e)
      e.selectSkill = (skill, targetId) => {
        const { convertedBy: _drop, ...rest } = skill
        void _drop
        return orig(rest, targetId)
      }
      return e
    }
    expect(converted.abilities?.[0].convertedBy).toBe('steal2ジョブ名')
    const r = runScenario(converted, { engineFactory: factory, driveLimit: 0 })
    expect(r.violations.some((v) => v.kind === 'job-conversion-invariant')).toBe(true)
  })

  it('変換していないのに印を出すエンジンも検出される', () => {
    expect(plain.abilities?.[0].convertedBy).toBeUndefined()
    const factory: EngineFactory = (sc, rng) => {
      const e = realEngineFactory(sc, rng)
      const orig = e.selectSkill!.bind(e)
      e.selectSkill = (skill, targetId) => orig({ ...skill, convertedBy: 'うそ' }, targetId)
      return e
    }
    const r = runScenario(plain, { engineFactory: factory, driveLimit: 0 })
    expect(r.violations.some((v) => v.kind === 'job-conversion-invariant')).toBe(true)
  })

  it('job-conversion-invariant は壊れとして数える', () => {
    expect(isBroken({ kind: 'job-conversion-invariant', detail: '', opIndex: 0 })).toBe(true)
  })
})
