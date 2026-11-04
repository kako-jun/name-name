import { describe, expect, it } from 'vitest'
import { enemyRightEdges } from './enemyRow'
import type { BattleEntity } from './spellDsl'

const e = (id: string, over: Partial<BattleEntity> = {}): BattleEntity => ({
  id,
  name: id,
  hp: 10,
  maxHp: 10,
  mp: 0,
  maxMp: 0,
  atk: 1,
  def: 0,
  agi: 1,
  ...over,
})
const at = (col: number, row = 0) => ({ layout: { w: 1, h: 1, scale: 1, at: { col, row } } })

describe('enemyRightEdges (#896)', () => {
  it('グリッドが無ければ空', () => {
    expect(enemyRightEdges(undefined, [e('a')]).size).toBe(0)
  })
  it('敵ごとの占有セルの右端の列（置けなかった敵は含めない）', () => {
    const a = e('a', at(2))
    const b = e('b', at(1))
    const c = e('c', at(9))
    const edges = enemyRightEdges({ cols: 3, rows: 1 }, [a, b, c])
    expect(edges.get(a)).toBe(2)
    expect(edges.get(b)).toBe(1)
    expect(edges.has(c)).toBe(false)
  })
  it('サイズ 2x1 は右端の列（col + w - 1）で数える', () => {
    const w = e('w', { layout: { w: 2, h: 1, scale: 1, at: { col: 0, row: 0 } } })
    const edges = enemyRightEdges({ cols: 3, rows: 2 }, [w])
    expect(edges.get(w)).toBe(1)
  })
})
