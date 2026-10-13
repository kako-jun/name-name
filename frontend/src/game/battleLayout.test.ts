import { describe, it, expect } from 'vitest'
import {
  SIDE_COMMAND_CELL_HEIGHT,
  SIDE_GAP,
  SIDE_LABEL_FONT_SIZE,
  SIDE_LABEL_GAP,
  SIDE_LABEL_MAX_WIDTH_RATIO,
  SIDE_LABEL_MIN_WIDTH,
  SIDE_LABEL_STROKE_WIDTH,
  SIDE_LABEL_HEIGHT,
  SIDE_LABEL_LINES,
  SIDE_LABEL_LINE_HEIGHT,
  SIDE_LOG_MIN_LINES,
  SIDE_READABLE_SPRITE_SIZE,
  SIDE_MIN_STAGE_HEIGHT,
  SIDE_COMMAND_TEXT_PADDING,
  SIDE_MAX_SPRITE_SIZE,
  SIDE_PADDING,
  SIDE_STAGGER_RATIO,
  SIDE_STATUS_COMPACT_WIDTH,
  SIDE_STATUS_ROW_HEIGHT,
  computeContainFit,
  computeFallbackRect,
  computeFormation,
  computeSideBattleLayout,
  computeSideLogHeight,
  desiredSideLogLines,
  fitCommandFontSize,
  fitHpLabel,
  isLabelWidthReadable,
  estimateTextWidth,
  fitLabel,
  fitNameWithSuffix,
  normalizeBattleLayout,
  type Rect,
  type SideBattleLayout,
  type SpriteSlot,
} from './battleLayout'

const EPS = 1e-9

function inside(inner: Rect, outer: Rect): boolean {
  return (
    inner.x >= outer.x - EPS &&
    inner.y >= outer.y - EPS &&
    inner.x + inner.w <= outer.x + outer.w + EPS &&
    inner.y + inner.h <= outer.y + outer.h + EPS
  )
}
function slotRect(s: SpriteSlot): Rect {
  return { x: s.x, y: s.y, w: s.size, h: s.size }
}
function overlaps(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.w - EPS && b.x < a.x + a.w - EPS && a.y < b.y + b.h - EPS && b.y < a.y + a.h - EPS
  )
}
function allRects(L: SideBattleLayout): Rect[] {
  return [
    L.log,
    L.stage,
    L.command,
    L.status,
    ...L.commandCells,
    ...L.statusRows,
    ...L.enemies.map(slotRect),
    ...L.party.map(slotRect),
  ]
}

describe('normalizeBattleLayout', () => {
  it('"side" → side', () => expect(normalizeBattleLayout('side')).toBe('side'))
  it('前後空白・大文字混じりでも side', () => expect(normalizeBattleLayout(' SIDE ')).toBe('side'))
  it('"front" → front', () => expect(normalizeBattleLayout('front')).toBe('front'))
  it('未知値は front', () => expect(normalizeBattleLayout('foo')).toBe('front'))
  it('null / undefined / 空文字は front', () => {
    expect(normalizeBattleLayout(null)).toBe('front')
    expect(normalizeBattleLayout(undefined)).toBe('front')
    expect(normalizeBattleLayout('')).toBe('front')
  })
})

describe('computeContainFit', () => {
  it('正方形テクスチャは枠いっぱい (x=y=0)', () => {
    expect(computeContainFit(64, 64, 100)).toEqual({ x: 0, y: 0, width: 100, height: 100 })
  })

  it('縦長は高さ=box・幅<box・水平中央寄せ', () => {
    const f = computeContainFit(50, 100, 120)
    expect(f.height).toBeCloseTo(120)
    expect(f.width).toBeLessThan(120)
    expect(f.x).toBeCloseTo((120 - f.width) / 2)
    expect(f.y).toBeCloseTo(0)
  })

  it('横長は幅=box・高さ<box・垂直中央寄せ', () => {
    const f = computeContainFit(200, 100, 120)
    expect(f.width).toBeCloseTo(120)
    expect(f.height).toBeLessThan(120)
    expect(f.y).toBeCloseTo((120 - f.height) / 2)
    expect(f.x).toBeCloseTo(0)
  })

  it.each([
    [10, 300, 80],
    [300, 10, 80],
    [123, 457, 99],
    [640, 480, 33],
  ])('縦横比維持・枠からはみ出さない (%d x %d, box %d)', (tw, th, box) => {
    const f = computeContainFit(tw, th, box)
    expect(f.width / f.height).toBeCloseTo(tw / th)
    expect(f.x).toBeGreaterThanOrEqual(-EPS)
    expect(f.y).toBeGreaterThanOrEqual(-EPS)
    expect(f.x + f.width).toBeLessThanOrEqual(box + EPS)
    expect(f.y + f.height).toBeLessThanOrEqual(box + EPS)
  })

  it('テクスチャ幅 0 / 高さ負 / NaN 寸法 は枠いっぱい', () => {
    const full = { x: 0, y: 0, width: 50, height: 50 }
    expect(computeContainFit(0, 10, 50)).toEqual(full)
    expect(computeContainFit(10, -5, 50)).toEqual(full)
    expect(computeContainFit(NaN, 10, 50)).toEqual(full)
    expect(computeContainFit(10, NaN, 50)).toEqual(full)
  })

  it('box=0 は全て 0、box 負は 0 にクランプ', () => {
    expect(computeContainFit(10, 20, 0)).toEqual({ x: 0, y: 0, width: 0, height: 0 })
    expect(computeContainFit(10, 20, -30)).toEqual({ x: 0, y: 0, width: 0, height: 0 })
  })
})

describe('computeFormation', () => {
  const region: Rect = { x: 20, y: 30, w: 300, h: 240 }

  it('count 0 / 負 は空配列', () => {
    expect(computeFormation(region, 0, 'enemy')).toEqual([])
    expect(computeFormation(region, -2, 'party')).toEqual([])
  })

  it('1 体は 1 枠・領域内・size ≤ SIDE_MAX_SPRITE_SIZE・千鳥なし', () => {
    const [s] = computeFormation(region, 1, 'enemy')
    expect(s.size).toBeLessThanOrEqual(SIDE_MAX_SPRITE_SIZE)
    expect(inside(slotRect(s), region)).toBe(true)
    // 領域内で水平・垂直とも中央
    expect(s.x + s.size / 2).toBeCloseTo(region.x + region.w / 2)
    expect(s.y + s.size / 2).toBeCloseTo(region.y + region.h / 2)
  })

  it('3 体までは 1 列（x が列内で共通になる行がある）', () => {
    const slots = computeFormation(region, 3, 'enemy')
    expect(slots).toHaveLength(3)
    // 1 列: 行ごとに y が単調増加
    expect(slots[0].y).toBeLessThan(slots[1].y)
    expect(slots[1].y).toBeLessThan(slots[2].y)
    // 千鳥のずれ分を除けば x は 1 種類（偶数行同士で一致）
    expect(slots[0].x).toBeCloseTo(slots[2].x)
  })

  it('4 体は 2 列（列優先: 先頭 rows 体が左列）', () => {
    const slots = computeFormation(region, 4, 'party')
    // rows=2 → i=0,1 が列 0、i=2,3 が列 1
    const col0 = [slots[0], slots[1]]
    const col1 = [slots[2], slots[3]]
    const minCol1X = Math.min(...col1.map((s) => s.x))
    const maxCol0X = Math.max(...col0.map((s) => s.x))
    expect(minCol1X).toBeGreaterThan(maxCol0X - EPS)
    // 列 1 は列 0 の右隣り（size 離れ ± ずらし）
    expect(slots[2].y).toBeCloseTo(slots[0].y)
    expect(slots[3].y).toBeCloseTo(slots[1].y)
  })

  it('5 体は rows=3 で、i → col=floor(i/3), row=i%3 の位置関係になる', () => {
    const slots = computeFormation(region, 5, 'enemy')
    const size = slots[0].size
    const rows = 3
    for (let i = 0; i < 5; i++) {
      const row = i % rows
      const col = Math.floor(i / rows)
      // 同じ row の y は共通、同じ列・同じ行パリティの x は col*size 刻み
      expect(slots[i].y).toBeCloseTo(slots[row].y)
      if (col === 1) expect(slots[i].x - slots[row].x).toBeCloseTo(size)
    }
  })

  it.each([
    { w: 300, h: 240 },
    { w: 800, h: 100 },
    { w: 60, h: 600 },
    { w: 1000, h: 1000 },
    { w: 7, h: 9 },
  ])('count 0〜6 すべてで全枠が領域内・size ≤ MAX・size ≥ 0 (領域 $w x $h)', ({ w, h }) => {
    const r: Rect = { x: 11, y: 17, w, h }
    for (const side of ['enemy', 'party'] as const) {
      for (let n = 0; n <= 6; n++) {
        const slots = computeFormation(r, n, side)
        expect(slots).toHaveLength(n)
        for (const s of slots) {
          expect(s.size).toBeGreaterThanOrEqual(0)
          expect(s.size).toBeLessThanOrEqual(SIDE_MAX_SPRITE_SIZE)
          expect(inside(slotRect(s), r)).toBe(true)
        }
      }
    }
  })

  it('同じ側の枠どうしは重ならない (1〜6 体)', () => {
    for (const side of ['enemy', 'party'] as const) {
      for (let n = 1; n <= 6; n++) {
        const rects = computeFormation(region, n, side).map(slotRect)
        for (let i = 0; i < rects.length; i++) {
          for (let j = i + 1; j < rects.length; j++) {
            expect(overlaps(rects[i], rects[j])).toBe(false)
          }
        }
      }
    }
  })

  it('領域幅 0 は size=0', () => {
    for (const s of computeFormation({ x: 0, y: 0, w: 0, h: 200 }, 3, 'enemy')) {
      expect(s.size).toBe(0)
    }
  })

  it('領域高さ 0・負でも size ≥ 0 で例外なし', () => {
    for (const h of [0, -50]) {
      for (const s of computeFormation({ x: 0, y: 0, w: 200, h }, 4, 'party')) {
        expect(s.size).toBeGreaterThanOrEqual(0)
        expect(Number.isFinite(s.x) && Number.isFinite(s.y)).toBe(true)
      }
    }
  })

  it('敵は奇数行が size×SIDE_STAGGER_RATIO だけ右にずれる', () => {
    const slots = computeFormation(region, 3, 'enemy')
    const size = slots[0].size
    expect(slots[1].x - slots[0].x).toBeCloseTo(size * SIDE_STAGGER_RATIO)
    expect(slots[2].x).toBeCloseTo(slots[0].x)
  })

  it('味方は偶数行が右にずれ、敵と向きが逆になる', () => {
    const party = computeFormation(region, 3, 'party')
    const enemy = computeFormation(region, 3, 'enemy')
    const size = party[0].size
    expect(party[0].x - party[1].x).toBeCloseTo(size * SIDE_STAGGER_RATIO)
    expect(party[2].x).toBeCloseTo(party[0].x)
    // 向きが逆: 敵は row1 が右、味方は row1 が左
    expect(Math.sign(enemy[1].x - enemy[0].x)).toBe(1)
    expect(Math.sign(party[1].x - party[0].x)).toBe(-1)
  })

  it('count=1 は千鳥なし（敵・味方で x が同じ）', () => {
    const e = computeFormation(region, 1, 'enemy')[0]
    const p = computeFormation(region, 1, 'party')[0]
    expect(e.x).toBeCloseTo(p.x)
  })
})

describe('computeSideBattleLayout', () => {
  const base = { width: 800, height: 450, partyCount: 1, enemyCount: 1 }

  it('800x450・味方1・敵1 は statusCompact=false', () => {
    expect(computeSideBattleLayout(base).statusCompact).toBe(false)
  })

  it.each([
    [360, 640],
    [320, 568],
  ])('%d x %d は statusCompact=true', (width, height) => {
    expect(computeSideBattleLayout({ ...base, width, height }).statusCompact).toBe(true)
  })

  it('幅スイープ: statusCompact === (status.w < SIDE_STATUS_COMPACT_WIDTH)（小数幅で境界を両側から挟む）', () => {
    let sawTrue = false
    let sawFalse = false
    for (let w = 200; w <= 1200; w += 0.5) {
      const L = computeSideBattleLayout({ ...base, width: w })
      expect(L.statusCompact).toBe(L.status.w < SIDE_STATUS_COMPACT_WIDTH)
      if (L.statusCompact) sawTrue = true
      else sawFalse = true
    }
    expect(sawTrue && sawFalse).toBe(true)
  })

  it('幅が広がるほど compact から非 compact へ一度だけ切り替わる（単調）', () => {
    let prev = true
    let flips = 0
    for (let w = 200; w <= 1200; w += 1) {
      const c = computeSideBattleLayout({ ...base, width: w }).statusCompact
      if (c !== prev) flips++
      prev = c
    }
    expect(flips).toBe(1)
  })

  it('commandCells は既定 4 個（2x2）で command 内に収まり互いに重ならない', () => {
    const L = computeSideBattleLayout(base)
    expect(L.commandCells).toHaveLength(4)
    const xs = new Set(L.commandCells.map((c) => c.x.toFixed(6)))
    const ys = new Set(L.commandCells.map((c) => c.y.toFixed(6)))
    expect(xs.size).toBe(2)
    expect(ys.size).toBe(2)
    for (const c of L.commandCells) expect(inside(c, L.command)).toBe(true)
    for (let i = 0; i < 4; i++) {
      for (let j = i + 1; j < 4; j++) {
        expect(overlaps(L.commandCells[i], L.commandCells[j])).toBe(false)
      }
    }
  })

  it('commandCount=5 は 3 行、0 は空配列', () => {
    const L5 = computeSideBattleLayout({ ...base, commandCount: 5 })
    expect(L5.commandCells).toHaveLength(5)
    expect(new Set(L5.commandCells.map((c) => c.y.toFixed(6))).size).toBe(3)
    for (const c of L5.commandCells) expect(inside(c, L5.command)).toBe(true)
    expect(computeSideBattleLayout({ ...base, commandCount: 0 }).commandCells).toEqual([])
  })

  it('味方 0・敵 0 は空配列で例外なし', () => {
    const L = computeSideBattleLayout({ ...base, partyCount: 0, enemyCount: 0 })
    expect(L.enemies).toEqual([])
    expect(L.party).toEqual([])
    expect(L.statusRows).toEqual([])
  })

  it('味方 1→6 で bottom が伸びる（単調非減少）・stage.h は単調非増加', () => {
    let prevBottomH = -1
    let prevStageH = Infinity
    for (let n = 1; n <= 6; n++) {
      const L = computeSideBattleLayout({ ...base, partyCount: n })
      expect(L.status.h).toBeGreaterThanOrEqual(prevBottomH - EPS)
      expect(L.stage.h).toBeLessThanOrEqual(prevStageH + EPS)
      prevBottomH = L.status.h
      prevStageH = L.stage.h
    }
  })

  it('味方が十分多いと bottom が status 側の必要高さに切り替わり、command と status は同じ高さ', () => {
    const rows = Math.ceil(4 / 2)
    const commandNeeded = rows * SIDE_COMMAND_CELL_HEIGHT
    const small = computeSideBattleLayout({ ...base, partyCount: 1 })
    expect(small.command.h).toBeCloseTo(commandNeeded)
    const big = computeSideBattleLayout({ ...base, partyCount: 6 })
    expect(big.command.h).toBeGreaterThan(commandNeeded)
    expect(big.command.h).toBeCloseTo(big.status.h)
  })

  it('bottomH は max(commandNeeded, statusNeeded) へ切り替わる点で連続（人数1ずつ増やしても欠落しない）', () => {
    const heights = [1, 2, 3, 4, 5, 6].map(
      (n) => computeSideBattleLayout({ ...base, partyCount: n }).command.h
    )
    for (let i = 1; i < heights.length; i++)
      expect(heights[i]).toBeGreaterThanOrEqual(heights[i - 1])
    // 切り替わり後は 1 人増えるごとに SIDE_STATUS_ROW_HEIGHT ずつ伸びる
    const last = heights.length - 1
    expect(heights[last] - heights[last - 1]).toBeCloseTo(SIDE_STATUS_ROW_HEIGHT)
  })

  it.each([
    [800, 120],
    [360, 100],
    [320, 60],
    [100, 30],
    [800, 0],
  ])('極端に低い画面 %d x %d でも stage.h ≥ 0・全 size ≥ 0・寸法が有限', (width, height) => {
    const L = computeSideBattleLayout({ width, height, partyCount: 4, enemyCount: 5 })
    expect(L.stage.h).toBeGreaterThanOrEqual(0)
    for (const s of [...L.enemies, ...L.party]) expect(s.size).toBeGreaterThanOrEqual(0)
    for (const r of allRects(L)) {
      expect(Number.isFinite(r.x + r.y + r.w + r.h)).toBe(true)
    }
  })

  it('幅が極小でも負の寸法が出ない', () => {
    for (const width of [0, 1, 10, 31, 32, 33, 100]) {
      const L = computeSideBattleLayout({ width, height: 450, partyCount: 2, enemyCount: 2 })
      for (const r of allRects(L)) {
        expect(r.w).toBeGreaterThanOrEqual(0)
        expect(r.h).toBeGreaterThanOrEqual(0)
      }
    }
  })

  it('360x640・味方 4 人で全矩形が画面内', () => {
    const screen: Rect = { x: 0, y: 0, w: 360, h: 640 }
    const L = computeSideBattleLayout({
      width: 360,
      height: 640,
      partyCount: 4,
      enemyCount: 3,
    })
    for (const r of allRects(L)) expect(inside(r, screen)).toBe(true)
  })

  it('上から log → stage → 下パネルの順で、log と stage と下パネルは重ならない', () => {
    for (const [width, height] of [
      [800, 450],
      [360, 640],
      [320, 568],
    ]) {
      const L = computeSideBattleLayout({ width, height, partyCount: 3, enemyCount: 3 })
      expect(L.log.y + L.log.h).toBeLessThanOrEqual(L.stage.y + EPS)
      expect(L.stage.y + L.stage.h).toBeLessThanOrEqual(L.command.y + EPS)
      expect(L.log.h).toBeCloseTo(computeSideLogHeight(L.logLines))
      expect(L.log.x).toBe(SIDE_PADDING)
    }
  })

  it('command と status は水平に重ならず、間に SIDE_GAP が空く', () => {
    const L = computeSideBattleLayout({ ...base, partyCount: 3 })
    expect(overlaps(L.command, L.status)).toBe(false)
    expect(L.status.x - (L.command.x + L.command.w)).toBeCloseTo(SIDE_GAP)
  })

  it('statusRows は味方数ぶんあり status 内に収まり、行高 ≤ SIDE_STATUS_ROW_HEIGHT', () => {
    for (let n = 1; n <= 6; n++) {
      const L = computeSideBattleLayout({ ...base, partyCount: n })
      expect(L.statusRows).toHaveLength(n)
      for (const r of L.statusRows) {
        expect(inside(r, L.status)).toBe(true)
        expect(r.h).toBeLessThanOrEqual(SIDE_STATUS_ROW_HEIGHT + EPS)
      }
      for (let i = 1; i < n; i++) {
        expect(L.statusRows[i].y).toBeGreaterThanOrEqual(
          L.statusRows[i - 1].y + L.statusRows[i - 1].h - EPS
        )
      }
    }
  })

  it('敵は stage の左半分・味方は右半分に入る', () => {
    for (const [width, height] of [
      [800, 450],
      [360, 640],
    ]) {
      const L = computeSideBattleLayout({ width, height, partyCount: 4, enemyCount: 5 })
      const half = L.stage.x + L.stage.w / 2
      for (const s of L.enemies) expect(s.x + s.size).toBeLessThanOrEqual(half + EPS)
      for (const s of L.party) expect(s.x).toBeGreaterThanOrEqual(half - EPS)
    }
  })

  it('スプライト枠は stage 内に収まる', () => {
    const L = computeSideBattleLayout({ width: 800, height: 450, partyCount: 4, enemyCount: 5 })
    for (const s of [...L.enemies, ...L.party]) expect(inside(slotRect(s), L.stage)).toBe(true)
  })

  it('枠数は enemyCount / partyCount に一致する', () => {
    const L = computeSideBattleLayout({ ...base, partyCount: 3, enemyCount: 5 })
    expect(L.enemies).toHaveLength(5)
    expect(L.party).toHaveLength(3)
  })

  it('小数・負の count で落ちない（負は 0、小数は切り捨て）', () => {
    const L = computeSideBattleLayout({ ...base, partyCount: -1, enemyCount: -3 })
    expect(L.party).toEqual([])
    expect(L.enemies).toEqual([])
    const F = computeSideBattleLayout({
      ...base,
      partyCount: 2.7,
      enemyCount: 1.2,
      commandCount: 3.9,
    })
    expect(F.party).toHaveLength(2)
    expect(F.enemies).toHaveLength(1)
    expect(F.commandCells).toHaveLength(3)
    const N = computeSideBattleLayout({ ...base, commandCount: -4 })
    expect(N.commandCells).toEqual([])
  })
})

// ---- #736 レビュー指摘対応: ラベル予約・ログ行数・省略 ----

const SWEEP_SIZES: Array<[number, number]> = [
  [360, 640],
  [320, 568],
  [800, 450],
  [1280, 720],
  [640, 360],
  [568, 320],
  [320, 240],
]

describe('computeFormation: 敵ラベル予約', () => {
  const region: Rect = { x: 0, y: 0, w: 300, h: 300 }

  it('withLabel なしは label を返さない（味方側）', () => {
    for (const s of computeFormation(region, 3, 'party')) expect(s.label).toBeUndefined()
  })

  it('withLabel ありは枠の直下に名前+HP 2 行ぶんのラベル矩形を返す', () => {
    const [s] = computeFormation(region, 1, 'enemy', true)
    // 1 列は横に何も並ばないので、領域幅（上限 size*倍率）まで広がり、領域内に収まる
    expect(s.label).toEqual({
      x: region.x,
      y: s.y + s.size + SIDE_LABEL_GAP,
      w: Math.min(region.w, s.size * SIDE_LABEL_MAX_WIDTH_RATIO),
      h: SIDE_LABEL_HEIGHT,
    })
    expect(SIDE_LABEL_HEIGHT).toBe(SIDE_LABEL_LINE_HEIGHT * SIDE_LABEL_LINES)
  })

  it('スプライト+ラベルは領域内・互いに重ならない', () => {
    for (let n = 1; n <= 6; n++) {
      const slots = computeFormation(region, n, 'enemy', true)
      const rects: Rect[] = []
      for (const s of slots) {
        expect(inside(slotRect(s), region)).toBe(true)
        expect(inside(s.label!, region)).toBe(true)
        rects.push(slotRect(s), s.label!)
      }
      for (let i = 0; i < rects.length; i++)
        for (let j = i + 1; j < rects.length; j++) {
          // 同一スロットの枠とラベルは接するだけ（重ならない）
          expect(overlaps(rects[i], rects[j])).toBe(false)
        }
    }
  })

  it('縦が足りないときは列を増やして行数を減らす（6 体・低い領域）', () => {
    const low: Rect = { x: 0, y: 0, w: 400, h: 120 }
    const slots = computeFormation(low, 6, 'enemy', true)
    expect(new Set(slots.map((s) => Math.round(s.y))).size).toBeLessThan(3)
    expect(slots[0].size).toBeGreaterThan(0)
  })

  it('領域高さが 0 ならサイズ 0・ラベルなし（はみ出させない）', () => {
    const slots = computeFormation({ x: 0, y: 0, w: 200, h: 0 }, 2, 'enemy', true)
    for (const s of slots) {
      expect(s.size).toBe(0)
      expect(s.label).toBeUndefined()
    }
  })
})

describe('computeFallbackRect', () => {
  it('枠比率 (0.15/0.1/0.7/0.8) の相対矩形', () => {
    expect(computeFallbackRect(100)).toEqual({ x: 15, y: 10, w: 70, h: 80 })
    expect(computeFallbackRect(0)).toEqual({ x: 0, y: 0, w: 0, h: 0 })
  })
})

describe('ログ行数', () => {
  it('desiredSideLogLines: 敵 1=2 / 2=3 / 3 以上=4、0 や負は下限', () => {
    expect(desiredSideLogLines(1)).toBe(2)
    expect(desiredSideLogLines(2)).toBe(3)
    expect(desiredSideLogLines(3)).toBe(4)
    expect(desiredSideLogLines(6)).toBe(4)
    expect(desiredSideLogLines(0)).toBe(SIDE_LOG_MIN_LINES)
    expect(desiredSideLogLines(-3)).toBe(SIDE_LOG_MIN_LINES)
  })

  it('十分高い画面では敵数に応じた行数・ログ帯高さが行数と一致', () => {
    for (const [n, lines] of [
      [1, 2],
      [2, 3],
      [3, 4],
      [6, 4],
    ] as const) {
      const L = computeSideBattleLayout({ width: 1280, height: 720, partyCount: 1, enemyCount: n })
      expect(L.logLines).toBe(lines)
      expect(L.log.h).toBeCloseTo(computeSideLogHeight(lines))
    }
  })

  it('低い画面ではステージ最小高さを優先して行数を下限まで減らす', () => {
    const L = computeSideBattleLayout({ width: 568, height: 320, partyCount: 4, enemyCount: 6 })
    expect(L.logLines).toBe(SIDE_LOG_MIN_LINES)
    expect(L.stage.h).toBeGreaterThanOrEqual(0)
  })

  it('余裕があるときステージは SIDE_MIN_STAGE_HEIGHT 以上を保つ', () => {
    for (const [w, h] of SWEEP_SIZES) {
      const L = computeSideBattleLayout({ width: w, height: h, partyCount: 1, enemyCount: 6 })
      if (L.logLines > SIDE_LOG_MIN_LINES) {
        expect(L.stage.h).toBeGreaterThanOrEqual(SIDE_MIN_STAGE_HEIGHT)
      }
    }
  })
})

describe('スイープ不変条件 (7 サイズ x party1-4 x enemy1-6)', () => {
  const cases: Array<[number, number, number, number]> = []
  for (const [w, h] of SWEEP_SIZES)
    for (let p = 1; p <= 4; p++) for (let e = 1; e <= 6; e++) cases.push([w, h, p, e])

  it('件数', () => expect(cases).toHaveLength(168))

  it.each(cases)('%dx%d party%d enemy%d', (w, h, p, e) => {
    const L = computeSideBattleLayout({ width: w, height: h, partyCount: p, enemyCount: e })
    expect(L.stage.h).toBeGreaterThanOrEqual(0)
    const screen: Rect = { x: 0, y: 0, w, h }
    const bottoms = [L.command, L.status]
    const items: Rect[] = []
    for (const s of L.enemies) {
      expect(s.size).toBeGreaterThanOrEqual(0)
      items.push(slotRect(s))
      if (s.label) items.push(s.label)
    }
    for (const s of L.party) items.push(slotRect(s))
    for (const r of items) {
      expect(r.x).toBeGreaterThanOrEqual(-EPS)
      expect(r.y).toBeGreaterThanOrEqual(-EPS)
      expect(inside(r, screen)).toBe(true)
      expect(inside(r, L.stage)).toBe(true)
      for (const b of [...bottoms, L.log]) expect(overlaps(r, b)).toBe(false)
    }
    // スプライト・ラベル同士（ゼロ面積は除く）が重ならない
    const nonEmpty = items.filter((r) => r.w > EPS && r.h > EPS)
    for (let i = 0; i < nonEmpty.length; i++)
      for (let j = i + 1; j < nonEmpty.length; j++)
        expect(overlaps(nonEmpty[i], nonEmpty[j])).toBe(false)
    // ステージが十分あればラベルは全員ぶん存在する（低すぎるときはラベルだけ省かれ、スプライトは残る）
    for (const s of L.enemies) {
      expect(s.size).toBeGreaterThan(0)
      // 期待ラベル幅: 1 列なら min(領域幅, 一辺×倍率)、多列なら一辺（列ピッチ）。読める幅ならラベルがある
      const oneColumn = rowsOf(L.enemies) === L.enemies.length
      const expectedW = oneColumn
        ? Math.min(L.stage.w / 2, s.size * SIDE_LABEL_MAX_WIDTH_RATIO)
        : s.size
      if (L.stage.h >= 60 && isLabelWidthReadable(expectedW)) expect(s.label).toBeDefined()
    }
  })
})

describe('fitLabel / fitNameWithSuffix', () => {
  it('収まるならそのまま', () => {
    expect(fitLabel('スライム', 100, 12)).toBe('スライム')
    expect(fitLabel('HP 5/5', 100, 12)).toBe('HP 5/5')
  })
  it('全角=fontPx・半角=0.6*fontPx で概算し、収まらなければ末尾を … にする', () => {
    expect(estimateTextWidth('あA', 10)).toBeCloseTo(16)
    const r = fitLabel('とても長い名前のモンスター', 60, 12)
    expect(r.endsWith('…')).toBe(true)
    expect(estimateTextWidth(r, 12)).toBeLessThanOrEqual(60)
  })
  it('… すら入らない幅は空文字', () => {
    expect(fitLabel('abc', 3, 12)).toBe('')
    expect(fitLabel('abc', 0, 12)).toBe('')
  })
  it('fitNameWithSuffix: 名前側だけ省略して suffix は残す', () => {
    const r = fitNameWithSuffix('ながいなまえのゆうしゃ', '  HP 120/120', 150, 14)
    expect(r.endsWith('  HP 120/120')).toBe(true)
    expect(r).toContain('…')
    expect(estimateTextWidth(r, 14)).toBeLessThanOrEqual(150)
  })
  it('fitNameWithSuffix: 収まるなら無加工 / suffix が入らないときは全体を切る', () => {
    expect(fitNameWithSuffix('あ', ' HP 1/1', 200, 14)).toBe('あ HP 1/1')
    const r = fitNameWithSuffix('あ', ' HP 1000/1000', 40, 14)
    expect(estimateTextWidth(r, 14)).toBeLessThanOrEqual(40)
  })
})

// ---- #736 2 巡目レビュー対応: 列数選択・ラベル省略・コマンドフォント ----

function rowsOf(slots: SpriteSlot[]): number {
  return new Set(slots.map((s) => Math.round(s.y * 1000))).size
}

describe('computeFormation: 列数は SIDE_READABLE_SPRITE_SIZE に届く最小の列数', () => {
  it('SIDE_READABLE_SPRITE_SIZE は定数の直書きでなく HP 行の概算幅 + 縁取り両側から導出される', () => {
    expect(SIDE_READABLE_SPRITE_SIZE).toBe(
      Math.ceil(estimateTextWidth('HP 12/12', SIDE_LABEL_FONT_SIZE) + SIDE_LABEL_STROKE_WIDTH * 2)
    )
    expect(SIDE_READABLE_SPRITE_SIZE).toBe(64)
  })

  it('800x450・敵 3 体は 2 列 2 行・千鳥あり・読める大きさ', () => {
    const L = computeSideBattleLayout({ width: 800, height: 450, partyCount: 1, enemyCount: 3 })
    expect(rowsOf(L.enemies)).toBe(2)
    expect(L.enemies[0].size).toBeGreaterThanOrEqual(SIDE_READABLE_SPRITE_SIZE)
    // 同じ列の 1 行目と 2 行目で x がずれている（千鳥）
    expect(L.enemies[1].x - L.enemies[0].x).not.toBe(0)
  })

  it('640x360・敵 3〜4 体は 1 行（千鳥なし）でも HP 行が省略されない', () => {
    for (let e = 3; e <= 4; e++) {
      const L = computeSideBattleLayout({ width: 640, height: 360, partyCount: 1, enemyCount: e })
      expect(rowsOf(L.enemies)).toBe(1)
      for (const s of L.enemies) {
        const room = s.label!.w - SIDE_LABEL_STROKE_WIDTH * 2
        expect(fitHpLabel(12, 12, room, SIDE_LABEL_FONT_SIZE)).toBe('HP 12/12')
      }
    }
  })

  it('640x360・敵 5〜6 体は「HP 」を落として数値 12/12 は必ず読める', () => {
    for (let e = 5; e <= 6; e++) {
      const L = computeSideBattleLayout({ width: 640, height: 360, partyCount: 1, enemyCount: e })
      for (const s of L.enemies) {
        const room = s.label!.w - SIDE_LABEL_STROKE_WIDTH * 2
        expect(fitHpLabel(12, 12, room, SIDE_LABEL_FONT_SIZE)).toMatch(/12\/12$/)
      }
    }
  })

  it('敵 N 体 → N+1 体でスプライトが読める大きさ未満へ縮むのは、届かない画面だけ（逆転の洗い出し）', () => {
    // 読める大きさに届く間は「最小の列数」を選ぶ仕様上、N+1 体のほうが大きくなる逆転は起こりうる
    // （例: 1280x720 で 3 体=3 行 135px → 4 体=2 列 160px）。それでも N 体が読める大きさなら N+1 体の
    // 選択も読める大きさ以上、または最大サイズへのフォールバックになる。
    for (const [w, h] of SWEEP_SIZES)
      for (let p = 1; p <= 4; p++)
        for (let e = 1; e < 6; e++) {
          const a = computeSideBattleLayout({ width: w, height: h, partyCount: p, enemyCount: e })
          const b = computeSideBattleLayout({
            width: w,
            height: h,
            partyCount: p,
            enemyCount: e + 1,
          })
          if (a.enemies[0].size < SIDE_READABLE_SPRITE_SIZE) {
            // 届いていない側は最大サイズ選択なので、体数が増えて大きくなることは無い
            expect(b.enemies[0].size).toBeLessThanOrEqual(a.enemies[0].size + EPS)
          }
        }
  })

  it('届く列数が複数あるとき最小の列数が選ばれる（4 体・広い領域 → 2 列 2 行）', () => {
    const slots = computeFormation({ x: 0, y: 0, w: 600, h: 400 }, 4, 'enemy', true)
    expect(rowsOf(slots)).toBe(2)
    expect(slots[0].size).toBeGreaterThanOrEqual(SIDE_READABLE_SPRITE_SIZE)
  })

  it('どの列数でも届かないときは最大サイズになる列数（6 体・低い領域 → 1 行）', () => {
    const slots = computeFormation({ x: 0, y: 0, w: 300, h: 60 }, 6, 'enemy', true)
    expect(rowsOf(slots)).toBe(1)
    expect(slots[0].size).toBeLessThan(SIDE_READABLE_SPRITE_SIZE)
    expect(slots[0].size).toBeCloseTo(60 - SIDE_LABEL_GAP - SIDE_LABEL_HEIGHT)
  })
})

describe('最小画面 320x240: ラベルだけを省いてスプライトは残す', () => {
  it.each([1, 2, 3, 4, 5, 6])('party4・enemy%d', (e) => {
    const L = computeSideBattleLayout({ width: 320, height: 240, partyCount: 4, enemyCount: e })
    expect(L.enemies).toHaveLength(e)
    for (const s of L.enemies) {
      expect(s.size).toBeGreaterThan(0)
      expect(inside(slotRect(s), L.stage)).toBe(true)
    }
    // ステージが低くラベルを置けない枠は label なし
    expect(L.enemies.some((s) => s.label === undefined)).toBe(true)
  })

  it('ラベルが置ける画面では全員にラベルがある（回帰）', () => {
    const L = computeSideBattleLayout({ width: 800, height: 450, partyCount: 1, enemyCount: 6 })
    for (const s of L.enemies) expect(s.label).toBeDefined()
  })
})

describe('fitCommandFontSize', () => {
  const labels = ['たたかう', 'じゅもん', 'どうぐ', 'にげる']

  it('広いセルでは上限のまま', () => {
    expect(fitCommandFontSize(200, labels, 18, 8)).toBe(18)
  })

  it('72px セルでは文字幅 + 2*padding がセル幅に収まる', () => {
    const f = fitCommandFontSize(72, labels, 18, SIDE_COMMAND_TEXT_PADDING)
    expect(f).toBeLessThan(18)
    for (const t of labels)
      expect(estimateTextWidth(t, f) + SIDE_COMMAND_TEXT_PADDING * 2).toBeLessThanOrEqual(72)
  })

  it('極端に狭くても 1 以上', () => {
    expect(fitCommandFontSize(0, labels, 18, 8)).toBe(1)
  })

  it('不変条件: 6 サイズ x party1-4 の全 commandCells で収まる', () => {
    for (const [w, h] of [...SWEEP_SIZES, [320, 240] as [number, number]])
      for (let p = 1; p <= 4; p++) {
        const L = computeSideBattleLayout({ width: w, height: h, partyCount: p, enemyCount: 1 })
        const minW = Math.min(...L.commandCells.map((c) => c.w))
        const f = fitCommandFontSize(minW, labels, 18, SIDE_COMMAND_TEXT_PADDING)
        for (const c of L.commandCells)
          for (const t of labels)
            expect(estimateTextWidth(t, f) + SIDE_COMMAND_TEXT_PADDING * 2).toBeLessThanOrEqual(
              c.w + EPS
            )
      }
  })
})

describe('敵ラベル幅: 1 列は領域幅まで・多列は列ピッチまで (#736)', () => {
  it('800x450・敵 3 体（2 列）はラベル幅=列ピッチ(size)で隣と重ならない', () => {
    const L = computeSideBattleLayout({ width: 800, height: 450, partyCount: 1, enemyCount: 3 })
    for (const s of L.enemies) expect(s.label!.w).toBeCloseTo(s.size)
  })

  it('1 列の敵はラベルがスプライトより広く、領域内に収まる（中央寄せ・端でクランプ）', () => {
    const region: Rect = { x: 10, y: 0, w: 400, h: 500 }
    for (const n of [1, 2, 3]) {
      const slots = computeFormation(region, n, 'enemy', true)
      for (const s of slots) {
        expect(s.label!.w).toBeGreaterThan(s.size)
        expect(s.label!.w).toBeLessThanOrEqual(region.w + EPS)
        expect(s.label!.w).toBeLessThanOrEqual(s.size * SIDE_LABEL_MAX_WIDTH_RATIO + EPS)
        expect(inside(s.label!, region)).toBe(true)
      }
    }
  })

  it('スイープ: 全ラベルが他のラベル・スプライトに重ならず stage 内（1 列/多列とも）', () => {
    for (const [w, h] of SWEEP_SIZES)
      for (let e = 1; e <= 6; e++) {
        const L = computeSideBattleLayout({ width: w, height: h, partyCount: 2, enemyCount: e })
        const rects: Rect[] = []
        for (const s of L.enemies) {
          if (s.size > 0) rects.push(slotRect(s))
          if (s.label) {
            expect(inside(s.label, L.stage)).toBe(true)
            rects.push(s.label)
          }
        }
        for (let i = 0; i < rects.length; i++)
          for (let j = i + 1; j < rects.length; j++)
            expect(overlaps(rects[i], rects[j])).toBe(false)
      }
  })
})

describe('fitHpLabel', () => {
  it('収まるなら「HP a/b」', () => {
    expect(fitHpLabel(12, 12, 100, 12)).toBe('HP 12/12')
  })
  it('収まらなければ「HP 」を落として数値だけ残す', () => {
    const w = estimateTextWidth('12/12', 12) + 1
    expect(fitHpLabel(12, 12, w, 12)).toBe('12/12')
  })
  it('数値も入らないときだけ … で省略', () => {
    const r = fitHpLabel(120, 120, 30, 12)
    expect(r.endsWith('…')).toBe(true)
    expect(estimateTextWidth(r, 12)).toBeLessThanOrEqual(30)
  })
  it('… すら入らなければ空文字', () => {
    expect(fitHpLabel(1, 1, 2, 12)).toBe('')
  })
})

describe('読めない幅のラベルは省く (#736)', () => {
  it('SIDE_LABEL_MIN_WIDTH は「12/12」の概算幅 + 縁取り両側から導出される', () => {
    expect(SIDE_LABEL_MIN_WIDTH).toBe(
      Math.ceil(estimateTextWidth('12/12', SIDE_LABEL_FONT_SIZE) + SIDE_LABEL_STROKE_WIDTH * 2)
    )
    expect(isLabelWidthReadable(SIDE_LABEL_MIN_WIDTH)).toBe(true)
    expect(isLabelWidthReadable(SIDE_LABEL_MIN_WIDTH - 1)).toBe(false)
  })

  it.each([1, 2, 3])(
    '320x240 party%d・敵 1〜6 体: ラベルが出るなら HP 数値が読め、出ないなら省かれスプライトは残る',
    (p) => {
      for (let e = 1; e <= 6; e++) {
        const L = computeSideBattleLayout({ width: 320, height: 240, partyCount: p, enemyCount: e })
        for (const s of L.enemies) {
          expect(s.size).toBeGreaterThan(0)
          if (s.label) {
            const room = s.label.w - SIDE_LABEL_STROKE_WIDTH * 2
            expect(fitHpLabel(12, 12, room, SIDE_LABEL_FONT_SIZE)).toMatch(/12\/12$/)
            expect(fitLabel('てき', room, SIDE_LABEL_FONT_SIZE)).not.toBe('…')
          }
        }
      }
    }
  )

  it('320x240 party1・敵 2 体（28px の 2 列）はラベルが省かれる', () => {
    const L = computeSideBattleLayout({ width: 320, height: 240, partyCount: 1, enemyCount: 2 })
    // 前提: 2 列（同じ行に並ぶ）で、一辺が読める最小ラベル幅に届かない
    expect(rowsOf(L.enemies)).toBe(1)
    expect(L.enemies).toHaveLength(2)
    for (const s of L.enemies) {
      expect(s.size).toBeGreaterThan(0)
      expect(s.size).toBeLessThan(SIDE_LABEL_MIN_WIDTH)
      expect(s.label).toBeUndefined()
    }
  })

  it('320x240 party1・敵 1 体（1 列・スプライトは小さい）でもラベル幅が広がるのでラベルが残る', () => {
    const L = computeSideBattleLayout({ width: 320, height: 240, partyCount: 1, enemyCount: 1 })
    const [s] = L.enemies
    const expectedW = Math.min(L.stage.w / 2, s.size * SIDE_LABEL_MAX_WIDTH_RATIO)
    expect(s.size).toBeGreaterThan(0)
    expect(s.size).toBeLessThan(SIDE_LABEL_MIN_WIDTH)
    expect(isLabelWidthReadable(expectedW)).toBe(true)
    expect(s.label).toBeDefined()
    expect(s.label!.w).toBeCloseTo(expectedW)
  })

  it('全スイープ: ラベルがあれば必ず読める幅（isLabelWidthReadable）', () => {
    for (const [w, h] of SWEEP_SIZES)
      for (let p = 1; p <= 4; p++)
        for (let e = 1; e <= 6; e++) {
          const L = computeSideBattleLayout({ width: w, height: h, partyCount: p, enemyCount: e })
          for (const s of L.enemies) if (s.label) expect(isLabelWidthReadable(s.label.w)).toBe(true)
        }
  })
})
