import { describe, it, expect } from 'vitest'
import { buildBattleEngineOptions } from './battleOptions'

/** BattleEngine に渡すオプションの組み立て (#1043: enemyRow) */
describe('buildBattleEngineOptions', () => {
  const atb = { mode: 'wait' as const }

  it('何も無ければ {}（従来どおり）', () => {
    expect(buildBattleEngineOptions({})).toEqual({})
  })
  it('atb 単独', () => {
    expect(buildBattleEngineOptions({ atb })).toEqual({ atb })
  })
  it('enemyRow 単独（layout 未指定は side 扱い）', () => {
    expect(buildBattleEngineOptions({ enemyRow: true })).toEqual({ enemyRow: {} })
    expect(buildBattleEngineOptions({ enemyRow: true, layout: 'side' })).toEqual({ enemyRow: {} })
  })
  it('atb と enemyRow の両方', () => {
    expect(buildBattleEngineOptions({ atb, enemyRow: true, layout: 'side' })).toEqual({
      atb,
      enemyRow: {},
    })
  })
  it('front レイアウトでは enemyRow を出さない（atb は出る）', () => {
    expect(buildBattleEngineOptions({ enemyRow: true, layout: 'front' })).toEqual({})
    expect(buildBattleEngineOptions({ atb, enemyRow: true, layout: 'front' })).toEqual({ atb })
  })
  it('enemyGrid があれば grid が入る。enemyRow が無ければ grid だけでは出ない', () => {
    const enemyGrid = { cols: 3, rows: 2 }
    expect(buildBattleEngineOptions({ enemyRow: true, enemyGrid })).toEqual({
      enemyRow: { grid: enemyGrid },
    })
    expect(buildBattleEngineOptions({ enemyGrid })).toEqual({})
  })
})
