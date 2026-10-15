import { describe, it, expect } from 'vitest'
import { clampEnemyWindowOverlap, computeEnemyGridLayout } from './enemyGrid'
import {
  computeAcrylicBoxSize,
  computeEnemyPlateRect,
  computeSideBattleLayout,
} from './battleLayout'
import { DEFAULT_ACRYLIC_PARAMS, computeAcrylicGeometry } from './spriteStyle'

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
  const frames = [
    { w: 160, h: 80 },
    { w: 80, h: 160 },
    { w: 60, h: 60 },
    { w: 240, h: 120 },
  ]
  it('板・台座・影が占有領域の内側に収まる', () => {
    for (const frame of frames) {
      for (const aspect of [0.5, 1, 2]) {
        const size = computeAcrylicBoxSize(frame, aspect, DEFAULT_ACRYLIC_PARAMS)
        expect(size).toBeLessThanOrEqual(Math.max(frame.w, frame.h) + 1e-9)
        const plate = computeEnemyPlateRect(
          { x: (frame.w - size) / 2, y: frame.h - size, size, width: size },
          aspect,
          DEFAULT_ACRYLIC_PARAMS
        )
        expect(plate.x).toBeGreaterThanOrEqual(-1e-6)
        expect(plate.x + plate.w).toBeLessThanOrEqual(frame.w + 1e-6)
        expect(plate.y).toBeGreaterThanOrEqual(-1e-6)
        const g = computeAcrylicGeometry(aspect, 1, size, DEFAULT_ACRYLIC_PARAMS)
        for (const e of [g.base, g.shadow])
          if (e) expect(2 * e.rx).toBeLessThanOrEqual(frame.w + 1e-6)
      }
    }
  })
  it('正方形の占有は従来どおり一辺いっぱい以下、横長・縦長の占有は短辺を超えて大きく描ける', () => {
    const one = computeAcrylicBoxSize({ w: 80, h: 80 }, 1, DEFAULT_ACRYLIC_PARAMS)
    expect(one).toBeLessThanOrEqual(80 + 1e-9)
    // 2x1: 同じ cell の 1x1 より箱が大きい（短辺 80 を超える）
    const wide = computeAcrylicBoxSize({ w: 160, h: 80 }, 1, DEFAULT_ACRYLIC_PARAMS)
    expect(wide).toBeGreaterThan(80)
    expect(wide).toBeGreaterThan(one)
    // 1x2: 縦長の占有。横は 80 に収まるので箱は 1x1 と同じ幅の制約（絵が縦に伸びる分は aspect で決まる）
    const tall = computeAcrylicBoxSize({ w: 80, h: 160 }, 0.5, DEFAULT_ACRYLIC_PARAMS)
    const tall1 = computeAcrylicBoxSize({ w: 80, h: 80 }, 0.5, DEFAULT_ACRYLIC_PARAMS)
    expect(tall).toBeGreaterThanOrEqual(tall1 - 1e-6)
    // 画像なし（色四角）は短辺
    expect(computeAcrylicBoxSize({ w: 160, h: 80 }, undefined, DEFAULT_ACRYLIC_PARAMS)).toBe(80)
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
