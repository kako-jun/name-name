import { describe, it, expect } from 'vitest'
import {
  computeEnemyGridLayout,
  enemyDrawOrder,
  parseCellRef,
  parseEnemyGrid,
  parseEnemySize,
  placeEnemies,
  type EnemyFootprint,
  type EnemyGridSize,
  type PlacementItem,
} from './enemyGrid'
import { SIDE_LABEL_GAP, SIDE_LABEL_HEIGHT, type Rect } from './battleLayout'

const EPS = 1e-6

describe('parseEnemySize', () => {
  it('2x1 / 1X2 / 全角 / × を解釈する', () => {
    expect(parseEnemySize('1x1')).toEqual({ w: 1, h: 1 })
    expect(parseEnemySize('2x1')).toEqual({ w: 2, h: 1 })
    expect(parseEnemySize(' 1X2 ')).toEqual({ w: 1, h: 2 })
    expect(parseEnemySize('２×２')).toEqual({ w: 2, h: 2 })
    expect(parseEnemySize('3×2')).toEqual({ w: 3, h: 2 })
    expect(parseEnemySize('10x10')).toEqual({ w: 10, h: 10 })
  })
  it('不正値は null', () => {
    for (const bad of [
      '',
      'x',
      '0x1',
      '1x0',
      '2',
      '2x',
      'x2',
      '-1x2',
      '1.5x2',
      '1x2x3',
      'axb',
      '1 2',
    ]) {
      expect(parseEnemySize(bad), bad).toBeNull()
    }
  })
})

describe('parseEnemyGrid', () => {
  it('列 1〜12・行 1〜4 に丸める', () => {
    expect(parseEnemyGrid('6x2')).toEqual({ cols: 6, rows: 2 })
    expect(parseEnemyGrid('6×2')).toEqual({ cols: 6, rows: 2 })
    expect(parseEnemyGrid('99x99')).toEqual({ cols: 12, rows: 4 })
    expect(parseEnemyGrid('1x1')).toEqual({ cols: 1, rows: 1 })
  })
  it('不正値・on は null（無効）', () => {
    for (const bad of ['', 'on', '0x2', '6x0', '6', '6x', 'x2'])
      expect(parseEnemyGrid(bad), bad).toBeNull()
  })
})

describe('parseCellRef', () => {
  it('C1 → col 2, row 0', () => {
    expect(parseCellRef('C1')).toEqual({ col: 2, row: 0 })
    expect(parseCellRef('a1')).toEqual({ col: 0, row: 0 })
    expect(parseCellRef(' F2 ')).toEqual({ col: 5, row: 1 })
  })
  it('不正は null', () => {
    for (const bad of ['', 'C', '1', 'C0', 'CC1', '1C', 'C-1'])
      expect(parseCellRef(bad), bad).toBeNull()
  })
})

describe('placeEnemies', () => {
  const grid: EnemyGridSize = { cols: 6, rows: 2 }
  const one: PlacementItem = { w: 1, h: 1 }

  it('1x1 は手前（右）の列の上段から、列内は上→下', () => {
    const r = placeEnemies(grid, [one, one, one, one])
    expect(r.errors).toEqual([])
    expect(r.cells).toEqual([
      { col: 5, row: 0 },
      { col: 5, row: 1 },
      { col: 4, row: 0 },
      { col: 4, row: 1 },
    ])
  })

  it('1 体目の位置は他の敵の有無で変わらない', () => {
    const solo = placeEnemies(grid, [one]).cells[0]
    for (let n = 2; n <= 12; n++) {
      expect(placeEnemies(grid, new Array(n).fill(one)).cells[0]).toEqual(solo)
    }
  })

  it('設計書 5.4: drill(2x1)+icicle(1x2)+slime+slime', () => {
    const r = placeEnemies(grid, [{ w: 2, h: 1 }, { w: 1, h: 2 }, one, one])
    expect(r.errors).toEqual([])
    expect(r.cells).toEqual([
      { col: 4, row: 0 }, // E1
      { col: 3, row: 0 }, // D1〜D2
      { col: 5, row: 1 }, // F2
      { col: 4, row: 1 }, // E2
    ])
  })

  it('1x2 / 2x2 は同じ列に別の敵を入れない', () => {
    const r = placeEnemies(grid, [{ w: 1, h: 2 }, one])
    expect(r.cells[0]).toEqual({ col: 5, row: 0 })
    expect(r.cells[1]).toEqual({ col: 4, row: 0 })
    const r2 = placeEnemies({ cols: 2, rows: 2 }, [{ w: 2, h: 2 }, one])
    expect(r2.cells[0]).toEqual({ col: 0, row: 0 })
    expect(r2.cells[1]).toBeNull()
    expect(r2.errors).toEqual([{ index: 1, kind: 'full' }])
  })

  it('配置指定を先に確定し、残りは指定を避けて自動配置（設計書 5.2）', () => {
    const r = placeEnemies(grid, [
      one, // 自動
      { w: 2, h: 2, at: { col: 2, row: 0 } }, // C1
      { ...one, at: { col: 4, row: 0 } }, // E1
      { ...one, at: { col: 4, row: 1 } }, // E2
    ])
    expect(r.errors).toEqual([])
    expect(r.cells[1]).toEqual({ col: 2, row: 0 })
    expect(r.cells[2]).toEqual({ col: 4, row: 0 })
    expect(r.cells[3]).toEqual({ col: 4, row: 1 })
    // 自動の 1 体は、指定が先に確定していても手前の F 列上段
    expect(r.cells[0]).toEqual({ col: 5, row: 0 })
  })

  it('自動の敵は配置指定に先に取られたセルを避ける', () => {
    const r = placeEnemies(grid, [one, { ...one, at: { col: 5, row: 0 } }])
    expect(r.cells[1]).toEqual({ col: 5, row: 0 })
    expect(r.cells[0]).toEqual({ col: 5, row: 1 })
  })

  it('範囲外の配置指定はエラー', () => {
    const cases: PlacementItem[] = [
      { ...one, at: { col: 6, row: 0 } },
      { ...one, at: { col: 0, row: 2 } },
      { ...one, at: { col: -1, row: 0 } },
      { w: 2, h: 1, at: { col: 5, row: 0 } },
      { w: 1, h: 2, at: { col: 0, row: 1 } },
    ]
    for (const c of cases) {
      const r = placeEnemies(grid, [c])
      expect(r.errors, JSON.stringify(c)).toEqual([{ index: 0, kind: 'out-of-range' }])
      expect(r.cells[0]).toBeNull()
    }
  })

  it('配置指定同士の重なりはエラー（後の指定が落ちる）', () => {
    const r = placeEnemies(grid, [
      { w: 2, h: 2, at: { col: 2, row: 0 } },
      { ...one, at: { col: 3, row: 1 } },
    ])
    expect(r.errors).toEqual([{ index: 1, kind: 'overlap' }])
    expect(r.cells[0]).toEqual({ col: 2, row: 0 })
    expect(r.cells[1]).toBeNull()
  })

  it('満杯はエラー: 1x1 を 13 体', () => {
    const r = placeEnemies(grid, new Array(13).fill(one))
    expect(r.errors).toEqual([{ index: 12, kind: 'full' }])
    expect(r.cells.slice(0, 12).every((c) => c !== null)).toBe(true)
  })

  it('グリッドより大きい／不正サイズはエラー', () => {
    const r = placeEnemies(grid, [
      { w: 7, h: 1 },
      { w: 1, h: 3 },
      { w: 0, h: 1 },
      { w: 1.5, h: 1 },
    ])
    expect(r.errors.map((e) => e.kind)).toEqual([
      'invalid-size',
      'invalid-size',
      'invalid-size',
      'invalid-size',
    ])
  })

  it('エラーの敵があっても他の敵は置かれ、errors は添字昇順', () => {
    const r = placeEnemies(grid, [{ w: 9, h: 1 }, one, { ...one, at: { col: 9, row: 0 } }])
    expect(r.cells[1]).toEqual({ col: 5, row: 0 })
    expect(r.errors.map((e) => e.index)).toEqual([0, 2])
  })

  it('空の群は空の結果', () => {
    expect(placeEnemies(grid, [])).toEqual({ cells: [], errors: [] })
  })

  it('1 列・1 行のグリッドでも動く', () => {
    expect(placeEnemies({ cols: 1, rows: 1 }, [one, one]).errors).toEqual([
      { index: 1, kind: 'full' },
    ])
  })
})

// ---------------------------------------------------------------------------
// computeEnemyGridLayout
// ---------------------------------------------------------------------------

const LABEL_BAND = SIDE_LABEL_GAP + SIDE_LABEL_HEIGHT

function overlapArea(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
  return w > EPS && h > EPS ? w * h : 0
}

function fpOf(
  cell: { col: number; row: number },
  it: PlacementItem,
  scale?: number
): EnemyFootprint {
  return { col: cell.col, row: cell.row, w: it.w, h: it.h, scale }
}

describe('computeEnemyGridLayout', () => {
  const grid: EnemyGridSize = { cols: 6, rows: 2 }
  const region: Rect = { x: 10, y: 100, w: 600, h: 300 }

  it('セルは体数・種類に依らない（空の群でも同じ）', () => {
    const a = computeEnemyGridLayout(region, grid, [], { withLabel: true })
    const b = computeEnemyGridLayout(region, grid, [{ col: 5, row: 0, w: 1, h: 1 }], {
      withLabel: true,
    })
    const c = computeEnemyGridLayout(region, grid, [{ col: 3, row: 0, w: 2, h: 2 }], {
      withLabel: true,
    })
    expect(b.cell).toBe(a.cell)
    expect(c.cell).toBe(a.cell)
    expect(b.grid).toEqual(a.grid)
  })

  it('セルの式: min(幅/列, (高さ-行*ラベル帯)/(行-重なり))', () => {
    const wide = computeEnemyGridLayout({ x: 0, y: 0, w: 1200, h: 300 }, grid, [], {
      withLabel: true,
      windowOverlap: 0,
    })
    expect(wide.cell).toBeCloseTo((300 - 2 * LABEL_BAND) / 2, 6)
    const narrow = computeEnemyGridLayout({ x: 0, y: 0, w: 300, h: 900 }, grid, [], {
      withLabel: true,
      windowOverlap: 0,
    })
    expect(narrow.cell).toBeCloseTo(50, 6)
    const noLabel = computeEnemyGridLayout({ x: 0, y: 0, w: 1200, h: 300 }, grid, [], {
      withLabel: false,
      windowOverlap: 0,
    })
    expect(noLabel.cell).toBeCloseTo(150, 6)
  })

  const wideRegion: Rect = { ...region, w: 1200 }

  it('グリッドは横中央・下端。最上行は overlap*cell だけ領域の上へ延びる', () => {
    const l = computeEnemyGridLayout(wideRegion, grid, [], {
      withLabel: true,
      windowOverlap: 0.25,
    })
    expect(l.grid.x + l.grid.w / 2).toBeCloseTo(wideRegion.x + wideRegion.w / 2, 6)
    expect(l.grid.y + l.grid.h).toBeCloseTo(region.y + region.h, 6)
    expect(region.y - l.grid.y).toBeCloseTo(0.25 * l.cell, 6)
    const z = computeEnemyGridLayout(region, grid, [], { withLabel: true, windowOverlap: 0 })
    expect(z.grid.y).toBeGreaterThanOrEqual(region.y - EPS)
  })

  it('占有矩形・floor・ラベル・box', () => {
    const l = computeEnemyGridLayout(
      region,
      grid,
      [
        { col: 5, row: 1, w: 1, h: 1 },
        { col: 3, row: 0, w: 2, h: 2, scale: 0.5 },
      ],
      { withLabel: true }
    )
    const [a, b] = l.slots
    expect(a.width).toBeCloseTo(l.cell, 6)
    expect(a.size).toBeCloseTo(l.cell, 6)
    expect(a.floor).toBeCloseTo(l.grid.y + l.grid.h - LABEL_BAND, 6)
    expect(a.label).toEqual({
      x: a.x,
      y: a.floor + SIDE_LABEL_GAP,
      w: a.width,
      h: SIDE_LABEL_HEIGHT,
    })
    // 2x2: 最下行の足元に揃う。ラベルは占有領域の最下行の下
    expect(b.floor).toBeCloseTo(a.floor, 6)
    expect(b.width).toBeCloseTo(2 * l.cell, 6)
    expect(b.size).toBeCloseTo(2 * l.cell, 6)
    expect(b.label?.y).toBeCloseTo(b.floor + SIDE_LABEL_GAP, 6)
    // 倍率 0.5: 足元中央基準で縮む
    expect(b.box.w).toBeCloseTo(b.width / 2, 6)
    expect(b.box.h).toBeCloseTo(b.size / 2, 6)
    expect(b.box.x + b.box.w / 2).toBeCloseTo(b.x + b.width / 2, 6)
    expect(b.box.y + b.box.h).toBeCloseTo(b.floor, 6)
    expect(b.scale).toBe(0.5)
    expect(a.box).toEqual(a.occupied)
  })

  it('倍率は 0.25〜1 に丸める（1 超は受け付けない）', () => {
    const l = computeEnemyGridLayout(
      region,
      grid,
      [
        { col: 5, row: 0, w: 1, h: 1, scale: 3 },
        { col: 4, row: 0, w: 1, h: 1, scale: 0.01 },
        { col: 3, row: 0, w: 1, h: 1, scale: NaN },
      ],
      { withLabel: false }
    )
    expect(l.slots.map((s) => s.scale)).toEqual([1, 0.25, 1])
  })

  it('withLabel=false ではラベルなし。幅が読めないセルのラベルも省く', () => {
    const noLabel = computeEnemyGridLayout(region, grid, [{ col: 5, row: 0, w: 1, h: 1 }], {
      withLabel: false,
    })
    expect(noLabel.slots[0].label).toBeUndefined()
    const tiny = computeEnemyGridLayout(
      { x: 0, y: 0, w: 60, h: 300 },
      grid,
      [{ col: 5, row: 0, w: 1, h: 1 }],
      {
        withLabel: true,
      }
    )
    expect(tiny.cell).toBeCloseTo(10, 6)
    expect(tiny.slots[0].label).toBeUndefined()
  })

  it('潰れた領域は cell 0（NaN・負にならない）', () => {
    for (const r of [
      { x: 0, y: 0, w: 0, h: 100 },
      { x: 0, y: 0, w: 100, h: 0 },
      { x: 0, y: 0, w: 100, h: 20 },
      { x: 0, y: 0, w: -5, h: -5 },
    ]) {
      const l = computeEnemyGridLayout(r, grid, [{ col: 5, row: 0, w: 1, h: 1 }], {
        withLabel: true,
      })
      expect(l.cell).toBe(0)
      expect(l.slots[0].size).toBe(0)
      expect(Number.isFinite(l.slots[0].x)).toBe(true)
      expect(l.slots[0].label).toBeUndefined()
    }
  })

  it('windowOverlap は丸められる（負・巨大・NaN）', () => {
    const base = computeEnemyGridLayout(region, grid, [], { withLabel: true, windowOverlap: 0.5 })
    expect(
      computeEnemyGridLayout(region, grid, [], { withLabel: true, windowOverlap: 9 }).cell
    ).toBeCloseTo(base.cell, 6)
    const zero = computeEnemyGridLayout(region, grid, [], { withLabel: true, windowOverlap: 0 })
    expect(
      computeEnemyGridLayout(region, grid, [], { withLabel: true, windowOverlap: -1 }).cell
    ).toBeCloseTo(zero.cell, 6)
    const def = computeEnemyGridLayout(region, grid, [], { withLabel: true })
    expect(
      computeEnemyGridLayout(region, grid, [], { withLabel: true, windowOverlap: NaN }).cell
    ).toBeCloseTo(def.cell, 6)
  })

  it('描画順は floor 昇順（奥→手前）、同じ floor は列昇順', () => {
    const l = computeEnemyGridLayout(
      region,
      grid,
      [
        { col: 5, row: 1, w: 1, h: 1 }, // 手前下
        { col: 4, row: 0, w: 1, h: 1 }, // 奥上
        { col: 2, row: 1, w: 1, h: 1 }, // 下段・左
        { col: 3, row: 0, w: 2, h: 2 }, // 2x2 は最下行 floor（下段と同じ）
      ],
      { withLabel: true }
    )
    expect(enemyDrawOrder(l.slots)).toEqual([1, 2, 3, 0])
  })
})

// ---------------------------------------------------------------------------
// 画面サイズ総当たり（設計書 §3.8）
// ---------------------------------------------------------------------------

describe('画面サイズ総当たり（敵グリッド）', () => {
  const widths = [240, 360, 480, 640, 1024, 1280, 1920]
  const heights = [200, 320, 568, 720, 1080]
  const grids: EnemyGridSize[] = [
    { cols: 6, rows: 2 },
    { cols: 4, rows: 2 },
    { cols: 1, rows: 1 },
    { cols: 12, rows: 4 },
    { cols: 3, rows: 3 },
  ]
  const overlaps = [0, 0.25]

  // 混成の群（サイズ・配置指定を含む）。グリッドに収まるものだけを検証に使う
  const groups = (g: EnemyGridSize): PlacementItem[][] => {
    const one: PlacementItem = { w: 1, h: 1 }
    const out: PlacementItem[][] = [
      [one],
      [one, one],
      [one, one, one, one, one],
      [{ w: 2, h: 1 }, { w: 1, h: 2 }, one, one],
      [{ w: 2, h: 2 }, one, one],
      [
        { w: 2, h: 2, at: { col: 0, row: 0 } },
        { ...one, at: { col: Math.max(0, g.cols - 1), row: 0 } },
      ],
      new Array(g.cols * g.rows).fill(one),
    ]
    return out
  }

  it('画面内・非重複・ラベル・窓重なり許容量・体数不変・2x2=2倍', () => {
    let checked = 0
    for (const g of grids) {
      for (const ov of overlaps) {
        for (const W of widths) {
          for (const H of heights) {
            // 領域: 画面の左側（味方の領域と窓の下端を引いたもの）を模す
            const region: Rect = {
              x: 16,
              y: 80,
              w: Math.max(0, W - 16 - 120),
              h: Math.max(0, H - 80 - 140),
            }
            for (const items of groups(g)) {
              const placed = placeEnemies(g, items)
              if (placed.errors.length > 0) continue
              const fps = placed.cells.map((c, i) => fpOf(c!, items[i]))
              const l = computeEnemyGridLayout(region, g, fps, {
                withLabel: true,
                windowOverlap: ov,
              })
              const tag = `${g.cols}x${g.rows} ov${ov} ${W}x${H} n${items.length}`
              checked++

              // グリッド: 領域内（横）。下端は領域の下端、上端は窓重なり許容ぶんだけ上へ
              expect(l.grid.x, tag).toBeGreaterThanOrEqual(region.x - EPS)
              expect(l.grid.x + l.grid.w, tag).toBeLessThanOrEqual(region.x + region.w + EPS)
              expect(l.grid.y + l.grid.h, tag).toBeLessThanOrEqual(region.y + region.h + EPS)
              expect(l.grid.y, tag).toBeGreaterThanOrEqual(region.y - ov * l.cell - EPS)

              l.slots.forEach((s, i) => {
                // 占有矩形はグリッド内
                expect(s.x, tag).toBeGreaterThanOrEqual(l.grid.x - EPS)
                expect(s.x + s.width, tag).toBeLessThanOrEqual(l.grid.x + l.grid.w + EPS)
                expect(s.y, tag).toBeGreaterThanOrEqual(l.grid.y - EPS)
                expect(s.floor, tag).toBeLessThanOrEqual(l.grid.y + l.grid.h + EPS)
                // 窓との重なり: 領域の上端より上へ出る量は、その敵の占有高さの overlap 以下
                const over = Math.max(0, region.y - s.y)
                expect(over, tag).toBeLessThanOrEqual(ov * s.size + EPS)
                // ラベルは領域の下端まで（stage 内）で、占有矩形の直下
                if (s.label) {
                  expect(s.label.y + s.label.h, tag).toBeLessThanOrEqual(region.y + region.h + EPS)
                  expect(s.label.x, tag).toBeGreaterThanOrEqual(region.x - EPS)
                  expect(s.label.x + s.label.w, tag).toBeLessThanOrEqual(region.x + region.w + EPS)
                }
                // 体数不変: 同じ位置の敵だけの配置と cell・x・y・width・size が一致
                const solo = computeEnemyGridLayout(region, g, [fps[i]], {
                  withLabel: true,
                  windowOverlap: ov,
                })
                expect(solo.cell, tag).toBe(l.cell)
                expect(solo.slots[0].x, tag).toBe(s.x)
                expect(solo.slots[0].y, tag).toBe(s.y)
                expect(solo.slots[0].width, tag).toBe(s.width)
                expect(solo.slots[0].size, tag).toBe(s.size)
              })

              // 非重複（占有矩形同士・ラベル同士・ラベルと他の占有矩形）
              for (let i = 0; i < l.slots.length; i++) {
                for (let j = i + 1; j < l.slots.length; j++) {
                  expect(
                    overlapArea(l.slots[i].occupied, l.slots[j].occupied),
                    `${tag} occ ${i},${j}`
                  ).toBe(0)
                  const li = l.slots[i].label
                  const lj = l.slots[j].label
                  if (li && lj) expect(overlapArea(li, lj), `${tag} label ${i},${j}`).toBe(0)
                }
                const li = l.slots[i].label
                if (li) {
                  for (let j = 0; j < l.slots.length; j++) {
                    expect(overlapArea(li, l.slots[j].occupied), `${tag} label-occ ${i},${j}`).toBe(
                      0
                    )
                  }
                }
              }

              // 2x2 と 1x1 は同一 cell から導出され、2x2 の占有は幅・高さとも 2 倍（面積 4 倍）
              if (l.cell > 0 && g.cols >= 2 && g.rows >= 2) {
                const big = computeEnemyGridLayout(region, g, [{ col: 0, row: 0, w: 2, h: 2 }], {
                  withLabel: true,
                  windowOverlap: ov,
                })
                const small = computeEnemyGridLayout(region, g, [{ col: 0, row: 0, w: 1, h: 1 }], {
                  withLabel: true,
                  windowOverlap: ov,
                })
                expect(big.cell, tag).toBe(small.cell)
                expect(big.slots[0].width, tag).toBeCloseTo(2 * small.slots[0].width, 6)
                expect(big.slots[0].size, tag).toBeCloseTo(2 * small.slots[0].size, 6)
              }
            }
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(1000)
  }, 120000)

  it('cell は領域・グリッド・ラベル帯・重なりだけで決まり、footprints に依存しない', () => {
    for (const W of widths) {
      for (const H of heights) {
        const region: Rect = { x: 0, y: 0, w: W, h: H }
        const base = computeEnemyGridLayout(region, { cols: 6, rows: 2 }, [], { withLabel: true })
        const many = computeEnemyGridLayout(
          region,
          { cols: 6, rows: 2 },
          [
            { col: 0, row: 0, w: 2, h: 2 },
            { col: 5, row: 0, w: 1, h: 1 },
            { col: 5, row: 1, w: 1, h: 1 },
          ],
          { withLabel: true }
        )
        expect(many.cell).toBe(base.cell)
        expect(many.grid).toEqual(base.grid)
      }
    }
  })
})
