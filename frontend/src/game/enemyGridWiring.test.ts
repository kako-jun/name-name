import { describe, it, expect } from 'vitest'
import { clampEnemyWindowOverlap, computeEnemyGridLayout } from './enemyGrid'
import {
  computeAcrylicBoxSize,
  computeEnemyPlateRect,
  computeSideBattleLayout,
} from './battleLayout'
import { DEFAULT_ACRYLIC_PARAMS } from './spriteStyle'

describe('clampEnemyWindowOverlap (#839 段4)', () => {
  const grid = { cols: 6, rows: 2 }
  it('延長 overlap*cell が窓の高さ以下に収まり、収まる範囲では要求値のまま', () => {
    for (const rw of [200, 400, 800]) {
      for (const rh of [100, 200, 400]) {
        for (const L of [10, 40, 80, 200]) {
          for (const ov of [0, 0.1, 0.25, 0.5]) {
            const region = { x: 0, y: 0, w: rw, h: rh }
            const o = clampEnemyWindowOverlap(region, grid, true, ov, L)
            expect(o).toBeLessThanOrEqual(ov + 1e-9)
            const { cell } = computeEnemyGridLayout(region, grid, [], {
              withLabel: true,
              windowOverlap: o,
            })
            expect(o * cell).toBeLessThanOrEqual(L + 1e-6)
            if (o < ov - 1e-9 && cell > 0) expect(o * cell).toBeCloseTo(L, 6)
          }
        }
      }
    }
  })
})

describe('computeAcrylicBoxSize (#839 段4)', () => {
  it('2x1 のような横長の占有でも板が占有領域の内側に収まる', () => {
    for (const frame of [
      { w: 160, h: 80 },
      { w: 80, h: 160 },
      { w: 60, h: 60 },
    ]) {
      for (const aspect of [0.5, 1, 2]) {
        const size = computeAcrylicBoxSize(frame, aspect, DEFAULT_ACRYLIC_PARAMS)
        expect(size).toBeLessThanOrEqual(Math.min(frame.w, frame.h) + 1e-9)
        const plate = computeEnemyPlateRect(
          { x: (frame.w - size) / 2, y: frame.h - size, size, width: size },
          aspect,
          DEFAULT_ACRYLIC_PARAMS
        )
        expect(plate.x).toBeGreaterThanOrEqual(-1e-6)
        expect(plate.x + plate.w).toBeLessThanOrEqual(frame.w + 1e-6)
        expect(plate.y).toBeGreaterThanOrEqual(-1e-6)
      }
    }
  })
})

describe('computeSideBattleLayout 敵グリッド (#839 段4)', () => {
  const base = { width: 800, height: 450, partyCount: 4 }
  const fp = (col: number) => ({ col, row: 0, w: 1, h: 1 })
  it('グリッドなしの出力は enemyFootprints を渡しても変わらない', () => {
    const a = computeSideBattleLayout({ ...base, enemyCount: 3 })
    const b = computeSideBattleLayout({ ...base, enemyCount: 3, enemyFootprints: [fp(0)] })
    expect(b).toEqual(a)
  })
  // ログ帯の行数もグリッド容量で決まる（体数に依らない）ので、体数が違っても 1 体目の枠は不変
  it('置けない敵は大きさ 0、体数が変わっても 1 体目の枠と奥行きの縮尺は不変', () => {
    const depth = { horizon: 0.3, perspective: 1 }
    const grid = { cols: 6, rows: 2 }
    const one = computeSideBattleLayout({
      ...base,
      enemyCount: 3,
      enemyGrid: grid,
      enemyFootprints: [fp(5)],
      depth,
    })
    const three = computeSideBattleLayout({
      ...base,
      enemyCount: 5,
      enemyGrid: grid,
      enemyFootprints: [fp(5), fp(4), null, fp(3), fp(2)],
      depth,
    })
    expect(three.enemies[0]).toEqual(one.enemies[0])
    expect(three.enemies[2].size).toBe(0)
    expect(three.enemies[2].width).toBe(0)
  })
})
