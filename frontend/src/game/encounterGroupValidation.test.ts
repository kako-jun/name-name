import { describe, it, expect } from 'vitest'
import {
  formatEncounterGroupErrors,
  validateEncounterGroups,
  type EncounterGroupInput,
} from './encounterGroupValidation'
import { rollEncounter } from './encounter'
import type { MonsterDef } from '../types'

const GRID = { cols: 6, rows: 2 }

function mon(id: string, size?: { w: number; h: number }): MonsterDef {
  return { id, name: id, hp: 5, atk: 1, def: 1, agi: 1, exp: 0, gold: 0, ...(size ? { size } : {}) }
}

const masters: Record<string, MonsterDef> = {
  bit: mon('bit'),
  boss: mon('boss', { w: 2, h: 2 }),
  wide: mon('wide', { w: 3, h: 3 }),
  tall: mon('tall', { w: 1, h: 3 }),
  zero: mon('zero', { w: 0, h: 1 }),
}

function run(...specs: string[]) {
  const groups: EncounterGroupInput[] = specs.map((spec) => ({ mapId: 'm1', spec }))
  return validateEncounterGroups({ grid: GRID, masters, groups })
}

describe('validateEncounterGroups (#839 段5)', () => {
  it('収まる群はエラーなし', () => {
    const r = run('bit', 'bit+bit', 'boss@C1+bit@E1+bit@E2')
    expect(r.errors).toEqual([])
    expect(r.valid).toEqual([true, true, true])
  })

  it('範囲外の配置指定を検出し、mapId・群・モンスター id・理由が入る', () => {
    const r = run('bit@M1')
    expect(r.errors).toHaveLength(1)
    expect(r.errors[0]).toMatchObject({
      mapId: 'm1',
      group: 'bit@M1',
      monsterId: 'bit',
      nth: 1,
      kind: 'out-of-range',
    })
    expect(r.errors[0].reason).toContain('範囲外')
  })

  it('2x2 が右端にはみ出す配置も範囲外', () => {
    expect(run('boss@F1').errors[0].kind).toBe('out-of-range')
  })

  it('同じセルを 2 体に指定すると重なり（何体目かも出る）', () => {
    const r = run('bit@A1+bit@A1')
    expect(r.errors).toHaveLength(1)
    expect(r.errors[0]).toMatchObject({ kind: 'overlap', monsterId: 'bit', nth: 2 })
  })

  it('2x2 の上に @ で重ねると重なり', () => {
    const r = run('boss@A1+bit@B2')
    expect(r.errors).toHaveLength(1)
    expect(r.errors[0]).toMatchObject({ kind: 'overlap', monsterId: 'bit' })
  })

  it('1x1 を 13 体で満杯（6x2=12）', () => {
    const r = run('bit*13')
    expect(r.errors).toHaveLength(1)
    expect(r.errors[0]).toMatchObject({ kind: 'full', monsterId: 'bit', nth: 13 })
    expect(run('bit*12').errors).toEqual([])
  })

  it('サイズ超過（3x3・1x3 は 6x2 に入らない）', () => {
    expect(run('wide').errors[0]).toMatchObject({ kind: 'invalid-size', monsterId: 'wide' })
    expect(run('tall').errors[0].kind).toBe('invalid-size')
  })

  it('不正サイズ（w=0）', () => {
    expect(run('zero').errors[0]).toMatchObject({ kind: 'invalid-size', monsterId: 'zero' })
  })

  it('不正グリッドは全敵がエラー', () => {
    const r = validateEncounterGroups({
      grid: { cols: 0, rows: 2 },
      masters,
      groups: [{ mapId: 'm1', spec: 'bit+bit' }],
    })
    expect(r.errors.map((e) => e.kind)).toEqual(['invalid-grid', 'invalid-grid'])
  })

  it('配置指定は最初の 1 体だけに効く（bit*2@E1 は 2 体目が自動配置でエラーなし）', () => {
    expect(run('bit*2@E1').errors).toEqual([])
  })

  it('*m..n は最大数で検証する', () => {
    expect(run('bit*1..13').errors).toHaveLength(1)
    expect(run('bit*1..12').errors).toEqual([])
    // ランダムな群でも、最大が収まらなければ無効（最小では収まるのに）
    expect(run('bit*1..13').valid).toEqual([false])
  })

  it('未知のモンスター id は数えず、群のエラーにもしない', () => {
    expect(run('ghost+bit').errors).toEqual([])
    // 未知 id が 20 体いても枠を取らない
    expect(run('ghost*20').errors).toEqual([])
  })

  it('構文警告（不正な重み）は群のエラーにしない', () => {
    expect(run('bit:0').errors).toEqual([])
  })

  it('エラー群は除外され、残りは元の文字列・順序のまま', () => {
    const r = run('bit', 'wide', 'bit+bit', 'bit@M1', 'boss')
    expect(r.validGroups.map((g) => g.spec)).toEqual(['bit', 'bit+bit', 'boss'])
    expect(r.valid).toEqual([true, false, true, false, true])
  })

  it('除外後の残りの群は、除外前と同じ rng 列で（重みなし・修飾なしなら）同じ抽選結果', () => {
    // 無効群 'wide' を先頭・末尾に混ぜない（抽選母数が変わるのは仕様）。残った群だけで従来と同じ結果になることを確認
    const all = ['bit', 'bit+bit', 'bit+bit+bit']
    const r = run(...all)
    expect(r.validGroups.map((g) => g.spec)).toEqual(all)
    const seq = [0.0, 0.5, 0.99]
    for (const v of seq) {
      const roll = (groups: string[]) =>
        rollEncounter({
          rate: 1,
          groups,
          masters,
          rng: (() => {
            const q = [0.0, v]
            return () => q.shift() ?? 0
          })(),
        })
      expect(roll(r.validGroups.map((g) => g.spec))).toEqual(roll(all))
    }
  })

  it('全部無効なら validGroups が空で、rollEncounter は null（例外にしない）', () => {
    const r = run('wide', 'bit@M1')
    expect(r.validGroups).toEqual([])
    expect(
      rollEncounter({ rate: 1, groups: r.validGroups.map((g) => g.spec), masters, rng: () => 0 })
    ).toBeNull()
  })

  it('formatEncounterGroupErrors に件数と一覧が出る', () => {
    const text = formatEncounterGroupErrors(run('wide', 'bit@M1').errors)
    expect(text).toContain('2 件')
    expect(text).toContain("マップ 'm1'")
    expect(text).toContain('wide')
  })
})
