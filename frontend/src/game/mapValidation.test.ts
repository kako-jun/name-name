import { describe, expect, it } from 'vitest'
import type { MapData } from '../types/rpg'
import { formatHeightError, validateMapHeights } from './mapValidation'

/** width x height のタイル配列を作る（全て 0） */
function makeTiles(width: number, height: number): number[][] {
  return Array.from({ length: height }, () => Array.from({ length: width }, () => 0))
}

/** 寸法正常なベース MapData（tiles のみ、高さグリッドは未指定） */
function makeBaseMap(width: number, height: number): MapData {
  return {
    width,
    height,
    tileSize: 32,
    tiles: makeTiles(width, height),
  }
}

describe('validateMapHeights', () => {
  it('高さグリッドが全て未指定なら ok:true, errors:[]', () => {
    const map = makeBaseMap(3, 2)
    const result = validateMapHeights(map)
    expect(result.ok).toBe(true)
    expect(result.errors).toEqual([])
  })

  it('全 field が正しい次元なら ok:true', () => {
    const map: MapData = {
      ...makeBaseMap(3, 2),
      wallHeights: makeTiles(3, 2),
      floorHeights: makeTiles(3, 2),
      ceilingHeights: makeTiles(3, 2),
    }
    const result = validateMapHeights(map)
    expect(result.ok).toBe(true)
    expect(result.errors).toEqual([])
  })

  it('wallHeights の行数ミスマッチを検出する', () => {
    const map: MapData = {
      ...makeBaseMap(3, 2),
      wallHeights: makeTiles(3, 3), // 行数 3 ≠ height 2
    }
    const result = validateMapHeights(map)
    expect(result.ok).toBe(false)
    expect(result.errors).toEqual([
      { field: 'wallHeights', kind: 'row-count-mismatch', expected: 2, actual: 3 },
    ])
  })

  it('floorHeights の列数ミスマッチが 1 行だけ', () => {
    const grid = makeTiles(3, 2)
    grid[1] = [0, 0] // 1 行だけ列数 2（≠ width 3）
    const map: MapData = {
      ...makeBaseMap(3, 2),
      floorHeights: grid,
    }
    const result = validateMapHeights(map)
    expect(result.ok).toBe(false)
    expect(result.errors).toEqual([
      { field: 'floorHeights', kind: 'col-count-mismatch', expected: 3, actual: 2, rowIndex: 1 },
    ])
  })

  it('ceilingHeights の複数行で列数ミスマッチなら行ごとにエラーを出す', () => {
    const grid = makeTiles(3, 3)
    grid[0] = [0, 0] // col 2
    grid[2] = [0, 0, 0, 0] // col 4
    const map: MapData = {
      ...makeBaseMap(3, 3),
      ceilingHeights: grid,
    }
    const result = validateMapHeights(map)
    expect(result.ok).toBe(false)
    expect(result.errors).toEqual([
      { field: 'ceilingHeights', kind: 'col-count-mismatch', expected: 3, actual: 2, rowIndex: 0 },
      { field: 'ceilingHeights', kind: 'col-count-mismatch', expected: 3, actual: 4, rowIndex: 2 },
    ])
  })

  it('複数 field の同時ミスマッチを全て収集する', () => {
    const floor = makeTiles(3, 2)
    floor[0] = [0, 0] // col 2
    const map: MapData = {
      ...makeBaseMap(3, 2),
      wallHeights: makeTiles(3, 5), // row 5 ≠ 2
      floorHeights: floor,
    }
    const result = validateMapHeights(map)
    expect(result.ok).toBe(false)
    expect(result.errors).toEqual([
      { field: 'wallHeights', kind: 'row-count-mismatch', expected: 2, actual: 5 },
      { field: 'floorHeights', kind: 'col-count-mismatch', expected: 3, actual: 2, rowIndex: 0 },
    ])
  })

  it('行数ミスマッチの field は列数検証を打ち切る（ノイズ削減）', () => {
    // 行数が 5（≠ 2）、中身の列数もバラバラだが col-count-mismatch は出ない
    const grid: number[][] = [
      [0, 0], // 列数 2（width 3 と不一致だが）
      [0], // 列数 1
      [0, 0, 0, 0],
      [0],
      [0, 0],
    ]
    const map: MapData = {
      ...makeBaseMap(3, 2),
      wallHeights: grid,
    }
    const result = validateMapHeights(map)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toEqual({
      field: 'wallHeights',
      kind: 'row-count-mismatch',
      expected: 2,
      actual: 5,
    })
  })

  it('空グリッド（length=0）は height>0 なら row-count-mismatch', () => {
    const map: MapData = {
      ...makeBaseMap(3, 2),
      floorHeights: [],
    }
    const result = validateMapHeights(map)
    expect(result.errors).toEqual([
      { field: 'floorHeights', kind: 'row-count-mismatch', expected: 2, actual: 0 },
    ])
  })
})

describe('formatHeightError', () => {
  it('row-count-mismatch を整形する', () => {
    const msg = formatHeightError({
      field: 'wallHeights',
      kind: 'row-count-mismatch',
      expected: 2,
      actual: 3,
    })
    expect(msg).toBe('wallHeights: row count mismatch (expected 2, got 3)')
  })

  it('col-count-mismatch を整形する', () => {
    const msg = formatHeightError({
      field: 'ceilingHeights',
      kind: 'col-count-mismatch',
      expected: 3,
      actual: 4,
      rowIndex: 1,
    })
    expect(msg).toBe('ceilingHeights: col count mismatch at row 1 (expected 3, got 4)')
  })
})
