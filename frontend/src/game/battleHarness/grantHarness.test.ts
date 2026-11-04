/** 検証ハーネスの一時付与の族 (#875): 生成の決定性・形、実エンジンで壊れが出ないこと（付与の行はエンジンの挙動を変えない） */
import { describe, expect, it } from 'vitest'
import { isBroken } from './detect'
import { grantMatrix } from './scriptFamily'
import { buildSweep } from './sweep'
import { runScenario } from './run'
import { clone } from './scenario'
import { parseBattleScript } from '../battleScript'

const NO_RANDOM = { randomSeed: 1, randomCount: 0, randomStatusCount: 0, randomScriptCount: 0 }

describe('grantMatrix', () => {
  const all = grantMatrix()

  it('決定的で、id は一意・`script-grant/` で始まり、JSON にそのまま書き出せる。件数は 6×3×3', () => {
    expect(all.length).toBe(54)
    expect(grantMatrix().map((s) => s.id)).toEqual(all.map((s) => s.id))
    expect(new Set(all.map((s) => s.id)).size).toBe(all.length)
    expect(all.every((s) => s.id.startsWith('script-grant/'))).toBe(true)
    for (const s of all) expect(clone(s)).toEqual(s)
  })

  it('総当たりの末尾に足され、skip で外せる（他の族の並びは変わらない）', () => {
    const withIt = buildSweep({ ...NO_RANDOM, skip: ['job-conversion'] })
    const without = buildSweep({ ...NO_RANDOM, skip: ['script-grant', 'job-conversion'] })
    expect(withIt.length - without.length).toBe(54)
    expect(withIt.slice(0, without.length).map((s) => s.id)).toEqual(without.map((s) => s.id))
    expect(withIt.slice(without.length).map((s) => s.id)).toEqual(all.map((s) => s.id))
  })

  it('付与の行はルールに数えられない（付与の行を除いたルールと同じ数・同じ内容）', () => {
    for (const s of all) {
      const rules = s.script?.rules ?? []
      const plain = rules.filter((r) => !r.startsWith('付与'))
      expect(parseBattleScript(rules).rules, s.id).toEqual(parseBattleScript(plain).rules)
    }
  })

  it('実エンジンでは 1 件も壊れない（固定した結果で上限ターン内に終わる）', () => {
    for (const s of all) {
      expect(
        runScenario(s).violations.filter((v) => isBroken(v)),
        s.id
      ).toEqual([])
    }
  })
})
