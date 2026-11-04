/** 検証ハーネスの敵の前列・後列の族 (#896): 生成の決定性・形、実エンジンで壊れが出ないこと、列の規則の違反を `enemy-row-invariant` が検出すること */
import { describe, expect, it } from 'vitest'
import { isBroken } from './detect'
import { enemyRowScenarios } from './generate'
import { buildSweep } from './sweep'
import { runScenario } from './run'
import { clone, realEngineFactory, type EngineFactory } from './scenario'

const NO_RANDOM = { randomSeed: 1, randomCount: 0, randomStatusCount: 0, randomScriptCount: 0 }

describe('enemyRowScenarios', () => {
  const all = enemyRowScenarios()

  it('決定的で、id は一意・`enemy-row/` で始まり、JSON にそのまま書き出せる。件数は 2×8×3×2', () => {
    expect(all.length).toBe(96)
    expect(enemyRowScenarios().map((s) => s.id)).toEqual(all.map((s) => s.id))
    expect(new Set(all.map((s) => s.id)).size).toBe(all.length)
    expect(all.every((s) => s.id.startsWith('enemy-row/'))).toBe(true)
    for (const s of all) expect(clone(s)).toEqual(s)
  })

  it('総当たりの末尾に足され、skip で外せる（他の族の並びは変わらない）', () => {
    const withIt = buildSweep({ ...NO_RANDOM, skip: ['enemy-level', 'script-grant'] })
    const without = buildSweep({ ...NO_RANDOM, skip: ['enemy-row', 'enemy-level', 'script-grant'] })
    expect(withIt.length - without.length).toBe(96)
    expect(withIt.slice(0, without.length).map((s) => s.id)).toEqual(without.map((s) => s.id))
    expect(withIt.slice(without.length).map((s) => s.id)).toEqual(all.map((s) => s.id))
  })

  it('実エンジンでは 1 件も壊れない（宣言・グリッド・繰り上がり・サイズ・端数）', () => {
    for (const s of all) {
      expect(
        runScenario(s).violations.filter((v) => isBroken(v)),
        s.id
      ).toEqual([])
    }
  })

  it('有効なシナリオでは実際に後列の半分ダメージが起きている（検査が素通りしていない）', () => {
    const s = all.find((x) => x.id === 'enemy-row/turn/three-cols/def0/on')!
    const hp: number[] = []
    const eng = realEngineFactory(s, () => 0)
    for (let i = 0; i < 3; i++) eng.selectAttack(`s${i}`)
    for (const e of eng.getState().enemies) hp.push(500 - e.hp)
    // atk 40・def 0・rng 0 → 前列 40 / 後列 20
    expect(hp).toEqual([40, 20, 20])
  })
})

describe('runScenario: 列の規則の違反の検出', () => {
  const pick = (id: string) => enemyRowScenarios().find((s) => s.id === id)!
  const id = 'enemy-row/turn/three-cols/def0/on'

  it('後列の軽減をしないエンジン（enemyRow を捨てる）は検出される', () => {
    const factory: EngineFactory = (sc, rng) => {
      const { enemyRow: _drop, ...rest } = sc
      void _drop
      return realEngineFactory(rest, rng)
    }
    const r = runScenario(pick(id), { engineFactory: factory, driveLimit: 0 })
    expect(r.violations.some((v) => v.kind === 'enemy-row-invariant')).toBe(true)
  })

  it('全員を後列にするエンジン（前列にも軽減）も検出される', () => {
    const factory: EngineFactory = (sc, rng) =>
      realEngineFactory(
        { ...sc, enemies: sc.enemies.map((e) => ({ ...e, formationRow: 'back' as const })) },
        rng
      )
    const r = runScenario(pick(id), { engineFactory: factory, driveLimit: 0 })
    expect(r.violations.some((v) => v.kind === 'enemy-row-invariant')).toBe(true)
  })

  it('繰り上がりを忘れるエンジン（グリッドの列を戦闘開始時の最前列に固定）は検出される', () => {
    // 前列が倒れたあとも、倒れた前列の列を「最前列」と思い込む = 繰り上がり前の旧列で軽減し続ける
    const factory: EngineFactory = (sc, rng) =>
      realEngineFactory(
        {
          ...sc,
          // 倒れた後も残るよう、s0 を倒せない代わりに s1 / s2 を後列と宣言し続けるすり替え
          enemies: sc.enemies.map((e, i) =>
            i === 0 ? e : { ...e, formationRow: 'back' as const }
          ),
        },
        rng
      )
    const r = runScenario(pick('enemy-row/turn/front-fragile/def0/on'), {
      engineFactory: factory,
      driveLimit: 0,
    })
    expect(r.violations.some((v) => v.kind === 'enemy-row-invariant')).toBe(true)
  })

  it('enemy-row-invariant は壊れとして数える', () => {
    expect(isBroken({ kind: 'enemy-row-invariant', detail: '', opIndex: 0 })).toBe(true)
  })
})
