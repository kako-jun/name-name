import { describe, expect, it } from 'vitest'
import {
  ensureHeightGrid,
  formatHeightLabel,
  heightToBackgroundColor,
  HEIGHT_FALLBACKS,
  paintHeightCell,
  resizeHeightGrid,
} from './heightUtils'

describe('ensureHeightGrid', () => {
  it('wallHeights は 1.0 で初期化される', () => {
    const grid = ensureHeightGrid('wallHeights', 3, 2)
    expect(grid).toEqual([
      [1, 1, 1],
      [1, 1, 1],
    ])
  })

  it('floorHeights は 0.0 で初期化される', () => {
    const grid = ensureHeightGrid('floorHeights', 2, 3)
    expect(grid).toEqual([
      [0, 0],
      [0, 0],
      [0, 0],
    ])
  })

  it('ceilingHeights は 1.0 で初期化される', () => {
    const grid = ensureHeightGrid('ceilingHeights', 2, 2)
    expect(grid).toEqual([
      [1, 1],
      [1, 1],
    ])
  })

  it('寸法が正しい（height 行 × width 列）', () => {
    const grid = ensureHeightGrid('wallHeights', 5, 3)
    expect(grid.length).toBe(3)
    expect(grid[0].length).toBe(5)
    expect(grid[2].length).toBe(5)
  })

  it('0x0 は空配列', () => {
    expect(ensureHeightGrid('wallHeights', 0, 0)).toEqual([])
  })

  it('HEIGHT_FALLBACKS 定数と一致する', () => {
    const g = ensureHeightGrid('floorHeights', 1, 1)
    expect(g[0][0]).toBe(HEIGHT_FALLBACKS.floorHeights)
  })
})

describe('resizeHeightGrid', () => {
  it('同サイズなら同一内容を返す', () => {
    const original = [
      [0.5, 1.0],
      [1.5, 2.0],
    ]
    const resized = resizeHeightGrid('wallHeights', original, 2, 2)
    expect(resized).toEqual(original)
  })

  it('拡大時は fallback で埋める（wallHeights → 1.0）', () => {
    const original = [[0.5]]
    const resized = resizeHeightGrid('wallHeights', original, 3, 2)
    expect(resized).toEqual([
      [0.5, 1, 1],
      [1, 1, 1],
    ])
  })

  it('拡大時は fallback で埋める（floorHeights → 0.0）', () => {
    const original = [[0.5]]
    const resized = resizeHeightGrid('floorHeights', original, 2, 2)
    expect(resized).toEqual([
      [0.5, 0],
      [0, 0],
    ])
  })

  it('縮小時は切り落とす', () => {
    const original = [
      [0.1, 0.2, 0.3],
      [0.4, 0.5, 0.6],
      [0.7, 0.8, 0.9],
    ]
    const resized = resizeHeightGrid('wallHeights', original, 2, 2)
    expect(resized).toEqual([
      [0.1, 0.2],
      [0.4, 0.5],
    ])
  })

  it('横だけ拡大・縦だけ縮小も成立する', () => {
    const original = [
      [0.5, 1.0],
      [1.5, 2.0],
      [2.5, 3.0],
    ]
    const resized = resizeHeightGrid('wallHeights', original, 3, 2)
    expect(resized).toEqual([
      [0.5, 1.0, 1],
      [1.5, 2.0, 1],
    ])
  })
})

describe('paintHeightCell', () => {
  it('undefined の grid でも初期化してから塗る', () => {
    const result = paintHeightCell('wallHeights', undefined, 3, 2, 1, 0, 2.0)
    expect(result).toEqual([
      [1, 2, 1],
      [1, 1, 1],
    ])
  })

  it('既存 grid の 1 セルだけ変更し、他は等しい', () => {
    const original = [
      [0.5, 0.5],
      [0.5, 0.5],
    ]
    const result = paintHeightCell('wallHeights', original, 2, 2, 0, 1, 2.0)
    expect(result).toEqual([
      [0.5, 0.5],
      [2.0, 0.5],
    ])
    // 元の grid は変更されない（immutable）
    expect(original).toEqual([
      [0.5, 0.5],
      [0.5, 0.5],
    ])
  })

  it('範囲外 (x >= width) はノーオペで元の grid を返す', () => {
    const original = [
      [0.5, 0.5],
      [0.5, 0.5],
    ]
    const result = paintHeightCell('wallHeights', original, 2, 2, 5, 0, 99)
    expect(result).toBe(original)
  })

  it('範囲外 (y >= height) はノーオペ', () => {
    const original = [
      [0.5, 0.5],
      [0.5, 0.5],
    ]
    const result = paintHeightCell('wallHeights', original, 2, 2, 0, 5, 99)
    expect(result).toBe(original)
  })

  it('範囲外 (負の座標) はノーオペ', () => {
    const original = [[0.5]]
    const result = paintHeightCell('wallHeights', original, 1, 1, -1, 0, 99)
    expect(result).toBe(original)
  })

  it('undefined grid で範囲外 → 初期化した grid を返す（throw しない）', () => {
    const result = paintHeightCell('floorHeights', undefined, 2, 2, 5, 5, 99)
    expect(result).toEqual([
      [0, 0],
      [0, 0],
    ])
  })
})

describe('heightToBackgroundColor', () => {
  it('value = 0 は薄グレー（field 共通）', () => {
    expect(heightToBackgroundColor('wallHeights', 0)).toBe('#e5e7eb')
    expect(heightToBackgroundColor('floorHeights', 0)).toBe('#e5e7eb')
    expect(heightToBackgroundColor('ceilingHeights', 0)).toBe('#e5e7eb')
  })

  it('壁: 値が大きいほど L が小さい（=暗い）', () => {
    const c1 = heightToBackgroundColor('wallHeights', 1.0)
    const c2 = heightToBackgroundColor('wallHeights', 2.0)
    const l1 = parseInt(c1.match(/(\d+)%\)$/)![1], 10)
    const l2 = parseInt(c2.match(/(\d+)%\)$/)![1], 10)
    expect(l2).toBeLessThan(l1)
  })

  it('L は 20 で下限クランプされる（非常に大きい値でも破綻しない）', () => {
    const c = heightToBackgroundColor('wallHeights', 100)
    const l = parseInt(c.match(/(\d+)%\)$/)![1], 10)
    expect(l).toBe(20)
  })

  it('各 field で色相が違う（1.0 同士を比較）', () => {
    const wall = heightToBackgroundColor('wallHeights', 1.0)
    const floor = heightToBackgroundColor('floorHeights', 1.0)
    const ceiling = heightToBackgroundColor('ceilingHeights', 1.0)
    const extractHue = (s: string) => parseInt(s.match(/^hsl\((\d+),/)![1], 10)
    expect(extractHue(wall)).toBe(200)
    expect(extractHue(floor)).toBe(30)
    expect(extractHue(ceiling)).toBe(280)
    expect(new Set([extractHue(wall), extractHue(floor), extractHue(ceiling)]).size).toBe(3)
  })
})

describe('formatHeightLabel', () => {
  it('1.0 → "1"', () => {
    expect(formatHeightLabel(1.0)).toBe('1')
  })

  it('0.25 → "0.25"', () => {
    expect(formatHeightLabel(0.25)).toBe('0.25')
  })

  it('1.5 → "1.5"', () => {
    expect(formatHeightLabel(1.5)).toBe('1.5')
  })

  it('0 → "0"', () => {
    expect(formatHeightLabel(0)).toBe('0')
  })

  it('2 → "2"（大きい整数も）', () => {
    expect(formatHeightLabel(2)).toBe('2')
  })

  it('0.75 → "0.75"', () => {
    expect(formatHeightLabel(0.75)).toBe('0.75')
  })
})
