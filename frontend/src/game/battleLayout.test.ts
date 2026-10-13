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
  SIDE_PARTY_MAX_HEIGHT,
  SIDE_PADDING,
  SIDE_STAGGER_RATIO,
  SIDE_STATUS_COMPACT_WIDTH,
  SIDE_STATUS_ROW_HEIGHT,
  computeContainFitRect,
  computeFallbackRect,
  computeFormation,
  computePartyDiagonal,
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
  return { x: s.x, y: s.y, w: s.width, h: s.size }
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

describe('computeContainFitRect（正方形の枠は旧 computeContainFit と同じ結果）', () => {
  it('正方形テクスチャは枠いっぱい (x=y=0)', () => {
    expect(computeContainFitRect(64, 64, 100, 100)).toEqual({ x: 0, y: 0, width: 100, height: 100 })
  })

  it('縦長は高さ=box・幅<box・水平中央寄せ', () => {
    const f = computeContainFitRect(50, 100, 120, 120)
    expect(f.height).toBeCloseTo(120)
    expect(f.width).toBeLessThan(120)
    expect(f.x).toBeCloseTo((120 - f.width) / 2)
    expect(f.y).toBeCloseTo(0)
  })

  it('横長は幅=box・高さ<box・垂直中央寄せ', () => {
    const f = computeContainFitRect(200, 100, 120, 120)
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
    const f = computeContainFitRect(tw, th, box, box)
    expect(f.width / f.height).toBeCloseTo(tw / th)
    expect(f.x).toBeGreaterThanOrEqual(-EPS)
    expect(f.y).toBeGreaterThanOrEqual(-EPS)
    expect(f.x + f.width).toBeLessThanOrEqual(box + EPS)
    expect(f.y + f.height).toBeLessThanOrEqual(box + EPS)
  })

  it('テクスチャ幅 0 / 高さ負 / NaN 寸法 は枠いっぱい', () => {
    const full = { x: 0, y: 0, width: 50, height: 50 }
    expect(computeContainFitRect(0, 10, 50, 50)).toEqual(full)
    expect(computeContainFitRect(10, -5, 50, 50)).toEqual(full)
    expect(computeContainFitRect(NaN, 10, 50, 50)).toEqual(full)
    expect(computeContainFitRect(10, NaN, 50, 50)).toEqual(full)
  })

  it('box=0 は全て 0、box 負は 0 にクランプ', () => {
    expect(computeContainFitRect(10, 20, 0, 0)).toEqual({ x: 0, y: 0, width: 0, height: 0 })
    expect(computeContainFitRect(10, 20, -30, -30)).toEqual({ x: 0, y: 0, width: 0, height: 0 })
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
    const slots = computeFormation(region, 4, 'enemy')
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
          expect(s.size).toBeLessThanOrEqual(
            side === 'party' ? SIDE_PARTY_MAX_HEIGHT : SIDE_MAX_SPRITE_SIZE
          )
          expect(inside(slotRect(s), r)).toBe(true)
        }
      }
    }
  })

  it('敵どうしの枠は重ならない (1〜6 体)', () => {
    for (let n = 1; n <= 6; n++) {
      const rects = computeFormation(region, n, 'enemy').map(slotRect)
      for (let i = 0; i < rects.length; i++) {
        for (let j = i + 1; j < rects.length; j++) {
          expect(overlaps(rects[i], rects[j])).toBe(false)
        }
      }
    }
  })

  // #760: 味方どうしは上下に重ねてよい（仕様変更）。代わりに上の人の顔（上 30%）が下の人に隠れないことを守る
  it('味方どうしは重なってよいが、上の人の顔（上 30%）は下の人に隠れない (1〜6 体)', () => {
    for (let n = 1; n <= 6; n++) {
      const slots = computeFormation(region, n, 'party')
      for (let i = 0; i + 1 < slots.length; i++) {
        expect(slots[i + 1].y).toBeGreaterThanOrEqual(slots[i].y + slots[i].size * 0.3 - EPS)
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

  it('味方は左上から右下への斜め一列（x,y とも単調増加）、敵は千鳥のまま (#760)', () => {
    const party = computeFormation(region, 3, 'party')
    const enemy = computeFormation(region, 3, 'enemy')
    for (let i = 1; i < party.length; i++) {
      expect(party[i].x).toBeGreaterThan(party[i - 1].x)
      expect(party[i].y).toBeGreaterThan(party[i - 1].y)
    }
    // 敵は従来どおり千鳥: row1 が右、row2 は row0 と同じ x
    expect(Math.sign(enemy[1].x - enemy[0].x)).toBe(1)
    expect(enemy[2].x).toBeCloseTo(enemy[0].x)
  })

  it('count=1 は千鳥なし（敵・味方で x が同じ）', () => {
    const e = computeFormation(region, 1, 'enemy')[0]
    const p = computeFormation(region, 1, 'party')[0]
    // 味方は縦長の枠なので、左端でなく水平中心が揃う
    expect(e.x + e.width / 2).toBeCloseTo(p.x + p.width / 2)
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

  it('敵は味方の左・味方は stage の右半分に入る (#760)', () => {
    for (const [width, height] of [
      [800, 450],
      [360, 640],
    ]) {
      const L = computeSideBattleLayout({ width, height, partyCount: 4, enemyCount: 5 })
      const half = L.stage.x + L.stage.w / 2
      // #760: 敵は味方の斜め一列の左（味方に必要な幅以外すべて）・味方は右半分に入る
      const partyLeft = Math.min(...L.party.map((s) => s.x))
      for (const s of L.enemies) expect(s.x + s.width).toBeLessThanOrEqual(partyLeft + EPS)
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
    // #760: 味方どうしは上下に重ねてよいので、味方は敵・ラベルとの非重複だけを見る（下の sweep 比較に含めない）
    const partyRects = L.party.map(slotRect)
    for (let i = 0; i + 1 < L.party.length; i++) {
      expect(L.party[i + 1].y).toBeGreaterThanOrEqual(L.party[i].y + L.party[i].size * 0.3 - EPS)
    }
    for (const r of [...items, ...partyRects]) {
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
    for (const pr of partyRects.filter((r) => r.w > EPS && r.h > EPS))
      for (const o of nonEmpty) expect(overlaps(pr, o)).toBe(false)
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

  it('旧 800x450 の敵領域（左半分）・敵 3 体は 2 列 2 行・千鳥あり・読める大きさ（既定の配置規則は不変）', () => {
    // #760: computeSideBattleLayout は敵領域を広げ味方の高さ以上を目標に列数を選ぶので、既定規則の確認は領域を直接渡す
    const slots = computeFormation({ x: 16, y: 118, w: 384, h: 194 }, 3, 'enemy', true)
    expect(rowsOf(slots)).toBe(2)
    expect(slots[0].size).toBeGreaterThanOrEqual(SIDE_READABLE_SPRITE_SIZE)
    expect(slots[1].x - slots[0].x).not.toBe(0)
  })

  it('800x450・味方 4 人・敵 3 体: 敵は味方の高さ以上になる最小の列数（1 行）で、各敵が味方の立ち絵以上 (#760)', () => {
    const L = computeSideBattleLayout({ width: 800, height: 450, partyCount: 4, enemyCount: 3 })
    expect(rowsOf(L.enemies)).toBe(1)
    for (const e of L.enemies) expect(e.size).toBeGreaterThanOrEqual(L.party[0].size - EPS)
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

describe('spec の例: ラベル幅の上限は一辺の 3 倍 (#736・#760 で敵領域を拡大)', () => {
  // docs/spec/markdown-v0.1.md の「1280x720・敵 1 体で 480px」をそのまま固定する回帰テスト。
  // 倍率定数を変えると spec とずれるため、この 1 テストに限り数値をリテラルで書く。
  // #760: 敵の領域を味方の斜め一列に必要な幅以外すべてにし、敵 1 体は領域いっぱい近く（上限 480）まで大きくなる。
  // 一辺 160px・ラベル 480px だった旧仕様の数値を、新仕様の値（味方人数ごとの敵領域の幅で頭打ち）に更新
  it.each([
    [1, 480, 1088],
    [2, 480, 928],
    [3, 480, 768],
    [4, 472, 717.4737],
  ])('1280x720・party%d・敵 1 体: 一辺 %dpx・ラベル幅 %dpx (spec の例)', (p, size, labelW) => {
    const L = computeSideBattleLayout({ width: 1280, height: 720, partyCount: p, enemyCount: 1 })
    expect(L.enemies[0].size).toBeCloseTo(size, 3)
    expect(L.enemies[0].label!.w).toBeCloseTo(labelW, 3)
  })
})

describe('敵の大きさと縦横比 (#760)', () => {
  // 仕様値（リテラル）: 800x450・味方 4 人。敵の領域 = stage の幅 − 味方の斜め一列に必要な幅
  it('800x450・味方 4 人・敵 1 体（正方形）: 領域の高さいっぱい（ラベル 32px を残して 202px）で味方の高さ 123.2 を超える', () => {
    const L = computeSideBattleLayout({
      width: 800,
      height: 450,
      partyCount: 4,
      enemyCount: 1,
      enemyAspects: [1],
    })
    expect(L.enemies[0].size).toBeCloseTo(202, 3)
    expect(L.enemies[0].width).toBeCloseTo(202, 3)
    expect(L.enemies[0].size).toBeGreaterThan(L.party[0].size)
  })
  it('横長の敵（縦横比 1.6・ドラゴン）は枠の幅が高さの 1.6 倍で、味方と重ならず stage 内', () => {
    const L = computeSideBattleLayout({
      width: 800,
      height: 450,
      partyCount: 4,
      enemyCount: 1,
      enemyAspects: [1.6],
    })
    const e = L.enemies[0]
    expect(e.size).toBeCloseTo(202, 3)
    expect(e.width).toBeCloseTo(323.2, 3)
    const partyLeft = Math.min(...L.party.map((s) => s.x))
    expect(e.x + e.width).toBeLessThanOrEqual(partyLeft + EPS)
    expect(e.x).toBeGreaterThanOrEqual(L.stage.x - EPS)
  })
  it('1280x720・味方 4 人・敵 1 体: 上限 480 に届かない 472 まで大きくなる', () => {
    const L = computeSideBattleLayout({ width: 1280, height: 720, partyCount: 4, enemyCount: 1 })
    expect(L.enemies[0].size).toBeCloseTo(472, 3)
  })
  it('味方の大きさは敵の領域拡大で変わらない（800x450・4 人・敵 1〜4 体で同じ）', () => {
    const base = { width: 800, height: 450, partyCount: 4 }
    const sizes = [1, 2, 3, 4].map(
      (e) => computeSideBattleLayout({ ...base, enemyCount: e }).party[0].size
    )
    // 敵の数でログ行数 → stage の高さが変わるので高さが同じ敵数同士で比べる
    expect(sizes[2]).toBeCloseTo(sizes[3], 9)
  })
  it('敵の縦横比は 0.2〜3 に丸められ、不正値は正方形', () => {
    const slots = computeFormation({ x: 0, y: 0, w: 2000, h: 400 }, 3, 'enemy', true, undefined, [
      100,
      NaN,
      0.01,
    ])
    expect(slots[0].width / slots[0].size).toBeCloseTo(3)
    expect(slots[1].width / slots[1].size).toBeCloseTo(1)
    expect(slots[2].width / slots[2].size).toBeCloseTo(0.2)
  })
  it('敵の枠はどれも画面内・非負・敵どうし非重複・ラベルは枠の直下（縦横比が混在でも）', () => {
    for (const [w, h] of [
      [800, 450],
      [360, 640],
      [1280, 720],
    ]) {
      for (const e of [1, 2, 3, 4]) {
        const L = computeSideBattleLayout({
          width: w,
          height: h,
          partyCount: 4,
          enemyCount: e,
          enemyAspects: [1.6, 0.6, 1, 2.2].slice(0, e),
        })
        const screen: Rect = { x: 0, y: 0, w, h }
        const rects = L.enemies.map(slotRect)
        for (const r of rects) {
          expect(r.x).toBeGreaterThanOrEqual(-EPS)
          expect(r.y).toBeGreaterThanOrEqual(-EPS)
          expect(inside(r, screen)).toBe(true)
        }
        for (let i = 0; i < rects.length; i++)
          for (let j = i + 1; j < rects.length; j++)
            expect(overlaps(rects[i], rects[j])).toBe(false)
        for (const s of L.enemies)
          if (s.label) expect(s.label.y).toBeGreaterThanOrEqual(s.y + s.size - EPS)
        for (const s of L.enemies)
          for (const p of L.party) expect(overlaps(slotRect(s), slotRect(p))).toBe(false)
      }
    }
  })
})

describe('縦長の stage は敵を下寄せにする (#760)', () => {
  it.each([1, 4])('360x640・味方 4 人・敵 %d 体: 敵は味方 1 人目の足元より下から始まる', (e) => {
    const L = computeSideBattleLayout({
      width: 360,
      height: 640,
      partyCount: 4,
      enemyCount: e,
      enemyAspects: Array(e).fill(1.6),
    })
    for (const s of L.enemies) expect(s.y).toBeGreaterThanOrEqual(L.party[0].floor - EPS)
    for (const s of L.enemies) expect(inside(slotRect(s), L.stage)).toBe(true)
  })
  it('360x640 の仕様値（リテラル）: 敵 1 体（縦横比 1.6）は (16, 281.3) から幅 164・高さ 102.5', () => {
    const L = computeSideBattleLayout({
      width: 360,
      height: 640,
      partyCount: 4,
      enemyCount: 1,
      enemyAspects: [1.6],
    })
    expect(L.enemies[0].x).toBeCloseTo(16, 3)
    expect(L.enemies[0].y).toBeCloseTo(281.3, 1)
    expect(L.enemies[0].width).toBeCloseTo(164, 3)
    expect(L.enemies[0].size).toBeCloseTo(102.5, 1)
  })
  it('横長（800x450・1280x720）は従来の位置のまま（敵 1 体は stage の上端から）', () => {
    for (const [w, h] of [
      [800, 450],
      [1280, 720],
    ]) {
      const L = computeSideBattleLayout({
        width: w,
        height: h,
        partyCount: 4,
        enemyCount: 1,
        enemyAspects: [1],
      })
      expect(L.enemies[0].y).toBeCloseTo(L.stage.y, 3)
    }
  })
})

// ---------------------------------------------------------------------------
// #760 テスト観点の追加（独立テスト担当）。仕様値はリテラルで固定する。
// ---------------------------------------------------------------------------

describe('computePartyDiagonal: 仕様値 (#760)', () => {
  it('領域 (100,50,400,300)・3 人・縦横比 0.5: 高さ 187.5・幅 93.75・斜めの送り (140.625, 56.25)・中央寄せ（リテラル）', () => {
    const s = computePartyDiagonal({ x: 100, y: 50, w: 400, h: 300 }, 3, undefined, [0.5, 0.5, 0.5])
    const expected = [
      [112.5, 50],
      [253.125, 106.25],
      [393.75, 162.5],
    ]
    expect(s).toHaveLength(3)
    s.forEach((slot, i) => {
      expect(slot.x).toBeCloseTo(expected[i][0], 9)
      expect(slot.y).toBeCloseTo(expected[i][1], 9)
      expect(slot.size).toBeCloseTo(187.5, 9)
      expect(slot.width).toBeCloseTo(93.75, 9)
      expect(slot.floor).toBeCloseTo(expected[i][1] + 187.5, 9)
      expect(slot.scale).toBe(1)
    })
  })

  it('count 0・負は空配列', () => {
    expect(computePartyDiagonal({ x: 0, y: 0, w: 400, h: 300 }, 0)).toEqual([])
    expect(computePartyDiagonal({ x: 0, y: 0, w: 400, h: 300 }, -2)).toEqual([])
  })

  it('1 人は領域の水平・垂直の中央（高さ 300 上限 320 に届かない）', () => {
    const [s] = computePartyDiagonal({ x: 10, y: 20, w: 400, h: 300 }, 1, undefined, [0.5])
    expect(s.size).toBeCloseTo(300, 9)
    expect(s.width).toBeCloseTo(150, 9)
    expect(s.x).toBeCloseTo(10 + (400 - 150) / 2, 9)
    expect(s.y).toBeCloseTo(20, 9)
  })

  it('高さの上限 320（SIDE_PARTY_MAX_HEIGHT）: 領域が広くても 320 を超えない', () => {
    for (const n of [1, 2, 3, 4]) {
      const s = computePartyDiagonal({ x: 0, y: 0, w: 4000, h: 4000 }, n)
      for (const slot of s) expect(slot.size).toBeCloseTo(320, 9)
    }
  })

  // 行間隔 pitch = min((領域高さ - h) / (人数-1), 0.6h)。h = min(320, 領域高さ / (1 + 0.3 (人数-1)))
  it.each([
    [415, 415 / 1.3, 0.3], // 高さ律速: pitch はちょうど 0.3h（下限）
    [416, 320, 0.3], // 境界: h=320 に届く点で pitch=0.3h=96
    [417, 320, 97 / 320], // 境界+1: 余った 1px が pitch に回る
  ])('pitch 下限側の境界: 2 人・領域高さ %d → 高さ %f・pitch/高さ %f', (regionH, size, ratio) => {
    const [a, b] = computePartyDiagonal({ x: 0, y: 0, w: 4000, h: regionH }, 2)
    expect(a.size).toBeCloseTo(size, 6)
    expect((b.y - a.y) / a.size).toBeCloseTo(ratio, 9)
  })

  it.each([
    [511, 191], // 境界-1: 領域の余りがそのまま pitch
    [512, 192], // 境界: pitch = 0.6 × 320 = 192
    [513, 192], // 境界+1: 上限 0.6h で頭打ち（余りは上下の余白）
    [2000, 192],
  ])('pitch 上限側の境界: 2 人・領域高さ %d → pitch %d（上限 0.6h）', (regionH, pitch) => {
    const [a, b] = computePartyDiagonal({ x: 0, y: 0, w: 4000, h: regionH }, 2)
    expect(a.size).toBeCloseTo(320, 9)
    expect(b.y - a.y).toBeCloseTo(pitch, 9)
  })

  it('領域 1000x600・2 人: 上限どおり 320 / pitch 192 で縦中央寄せ（y=44, 236）', () => {
    const s = computePartyDiagonal({ x: 0, y: 0, w: 1000, h: 600 }, 2, undefined, [0.5, 0.5])
    expect(s[0].y).toBeCloseTo(44, 9)
    expect(s[1].y).toBeCloseTo(236, 9)
    expect(s[0].x).toBeCloseTo(300, 9)
    expect(s[1].x).toBeCloseTo(540, 9)
  })

  it('斜めのずらし dx は 0.3h〜0.75h: 幅が余れば 0.75h・ぎりぎりなら 0.3h', () => {
    const wide = computePartyDiagonal({ x: 0, y: 0, w: 4000, h: 300 }, 2, undefined, [0.5, 0.5])
    expect((wide[1].x - wide[0].x) / wide[0].size).toBeCloseTo(0.75, 9)
    // 幅律速（領域幅 = 0.5h*1 + 0.3h*(2-1)... 高さは余る）→ ずらしは下限 0.3h
    const narrow = computePartyDiagonal({ x: 0, y: 0, w: 80, h: 1000 }, 2, undefined, [0.5, 0.5])
    expect(narrow[0].size).toBeCloseTo(100, 9)
    expect((narrow[1].x - narrow[0].x) / narrow[0].size).toBeCloseTo(0.3, 9)
  })

  // aspect = clamp(a, 0.2, 1.5)。不正（非有限・0 以下・未指定）は 0.5
  it.each([
    [0.19, 0.2],
    [0.2, 0.2],
    [0.21, 0.21],
    [0.5, 0.5],
    [1.49, 1.49],
    [1.5, 1.5],
    [1.51, 1.5],
    [2, 1.5],
    [100, 1.5],
    [0.01, 0.2],
    [NaN, 0.5],
    [0, 0.5],
    [-1, 0.5],
    [Infinity, 0.5],
    [undefined, 0.5],
  ])('味方の縦横比 %s → 枠の幅/高さ %s', (input, expected) => {
    const [s] = computePartyDiagonal({ x: 0, y: 0, w: 4000, h: 4000 }, 1, undefined, [input])
    expect(s.width / s.size).toBeCloseTo(expected, 9)
  })

  it('aspects が人数より短い分は 0.5・長い分は無視', () => {
    const s = computePartyDiagonal({ x: 0, y: 0, w: 4000, h: 4000 }, 2, undefined, [1])
    expect(s[0].width / s[0].size).toBeCloseTo(1, 9)
    expect(s[1].width / s[1].size).toBeCloseTo(0.5, 9)
    const t = computePartyDiagonal({ x: 0, y: 0, w: 4000, h: 4000 }, 1, undefined, [0.4, 9])
    expect(t).toHaveLength(1)
    expect(t[0].width / t[0].size).toBeCloseTo(0.4, 9)
  })

  it('幅律速: 最大の縦横比で高さが決まる（[0.2, 1.5]・領域幅 150 → 高さ 150/(1.5+0.3)）', () => {
    const s = computePartyDiagonal({ x: 0, y: 0, w: 150, h: 1000 }, 2, undefined, [0.2, 1.5])
    expect(s[0].size).toBeCloseTo(150 / 1.8, 9)
    expect(s[0].width).toBeCloseTo((150 / 1.8) * 0.2, 9)
    expect(s[1].width).toBeCloseTo((150 / 1.8) * 1.5, 9)
  })

  it('後衛の右半歩は「その人自身の幅」の 0.5 倍（前衛との差 = 0.5×幅 − 右余白予約で全体が左へ寄る 0.25×最大幅）', () => {
    const region = { x: 0, y: 0, w: 1000, h: 300 }
    const aspects = [0.4, 0.8]
    const front = computePartyDiagonal(region, 2, ['front', 'front'], aspects)
    for (const [rows, i] of [
      [['front', 'back'], 1],
      [['back', 'front'], 0],
    ] as const) {
      const back = computePartyDiagonal(region, 2, rows, aspects)
      // 高さは同じ（高さ律速）・ずらしは同じ（幅に余裕）
      expect(back[0].size).toBeCloseTo(front[0].size, 9)
      const maxW = front[1].width
      for (let k = 0; k < 2; k++) {
        const shift = k === i ? 0.5 * front[k].width : 0
        expect(back[k].x - front[k].x).toBeCloseTo(shift - 0.25 * maxW, 9)
        expect(back[k].y).toBeCloseTo(front[k].y, 9)
      }
    }
  })

  it('後衛指定 [front, back]・縦横比 [0.4, 0.8]・領域 1000x300 の座標（リテラル）', () => {
    const s = computePartyDiagonal(
      { x: 0, y: 0, w: 1000, h: 300 },
      2,
      ['front', 'back'],
      [0.4, 0.8]
    )
    expect(s[0].x).toBeCloseTo(275, 6)
    expect(s[1].x).toBeCloseTo(540.384615, 5)
    expect(s[0].size).toBeCloseTo(230.769231, 5)
    expect(s[1].width).toBeCloseTo(184.615385, 5)
  })

  it('rows が undefined の要素・短い配列は前衛扱い', () => {
    const region = { x: 0, y: 0, w: 600, h: 300 }
    expect(computePartyDiagonal(region, 3, [undefined, undefined])).toEqual(
      computePartyDiagonal(region, 3)
    )
  })

  it('領域の幅 0・負でも size 0・座標は有限（例外なし）', () => {
    for (const w of [0, -10]) {
      const s = computePartyDiagonal({ x: 5, y: 5, w, h: 200 }, 4)
      expect(s).toHaveLength(4)
      for (const slot of s) {
        expect(slot.size).toBe(0)
        expect(slot.width).toBe(0)
        expect(Number.isFinite(slot.x) && Number.isFinite(slot.y)).toBe(true)
      }
    }
  })

  it('スイープ不変条件: 領域 × 人数 1〜6 × 縦横比 × 隊列で、領域内・y 単調増加・pitch 0.3h〜0.6h・高さ ≤ 320', () => {
    const regions: Rect[] = [
      { x: 0, y: 0, w: 400, h: 300 },
      { x: 10, y: 20, w: 164, h: 424 },
      { x: 0, y: 0, w: 2000, h: 2000 },
      { x: 0, y: 0, w: 100, h: 100 },
      { x: 0, y: 0, w: 1000, h: 50 },
      { x: 3, y: 4, w: 37, h: 600 },
    ]
    const aspectSets: Array<readonly (number | undefined)[] | undefined> = [
      undefined,
      [0.2, 0.2, 0.2, 0.2, 0.2, 0.2],
      [1.5, 1.5, 1.5, 1.5, 1.5, 1.5],
      [0.2, 1.5, 0.5, 1.2, 0.3, 1],
    ]
    const rowSets: Array<readonly ('front' | 'back' | undefined)[] | undefined> = [
      undefined,
      ['back', 'back', 'back', 'back', 'back', 'back'],
      ['front', 'back', undefined, 'back', 'front', 'back'],
    ]
    let checked = 0
    for (const region of regions)
      for (let n = 1; n <= 6; n++)
        for (const aspects of aspectSets)
          for (const rows of rowSets) {
            const s = computePartyDiagonal(region, n, rows, aspects)
            expect(s).toHaveLength(n)
            for (const slot of s) {
              expect(slot.size).toBeGreaterThanOrEqual(0)
              expect(slot.size).toBeLessThanOrEqual(320 + EPS)
              expect(inside(slotRect(slot), region)).toBe(true)
              expect(slot.floor).toBeCloseTo(slot.y + slot.size, 9)
            }
            for (let i = 0; i + 1 < n; i++) {
              const dy = s[i + 1].y - s[i].y
              expect(dy).toBeGreaterThanOrEqual(0.3 * s[i].size - EPS)
              expect(dy).toBeLessThanOrEqual(0.6 * s[i].size + EPS)
              if (s[i].size > 0) expect(dy).toBeGreaterThan(0)
              checked++
            }
          }
    expect(checked).toBeGreaterThan(500)
  })

  it('全員前衛なら x のずらしは 0.3h〜0.75h・x も単調増加', () => {
    for (const w of [60, 100, 200, 400, 4000])
      for (let n = 2; n <= 6; n++) {
        const s = computePartyDiagonal({ x: 0, y: 0, w, h: 400 }, n, undefined, [0.5])
        for (let i = 0; i + 1 < n; i++) {
          const dx = s[i + 1].x - s[i].x
          expect(dx).toBeGreaterThanOrEqual(0.3 * s[i].size - EPS)
          expect(dx).toBeLessThanOrEqual(0.75 * s[i].size + EPS)
        }
      }
  })
})

describe('敵の縦横比の丸め境界 (#760)', () => {
  it.each([
    [0.19, 0.2],
    [0.2, 0.2],
    [0.21, 0.21],
    [1, 1],
    [2.99, 2.99],
    [3, 3],
    [3.01, 3],
    [10, 3],
    [0, 1],
    [-1, 1],
    [Infinity, 1],
    [NaN, 1],
    [undefined, 1],
  ])('敵の縦横比 %s → 枠の幅/高さ %s', (input, expected) => {
    const [e] = computeFormation(
      { x: 0, y: 0, w: 5000, h: 400 },
      1,
      'enemy',
      true,
      undefined,
      [input],
      { maxSize: 480 }
    )
    expect(e.size).toBeCloseTo(368, 9)
    expect(e.width / e.size).toBeCloseTo(expected, 9)
  })
})

describe('SIDE_ENEMY_MAX_SIZE = 480 の境界 (#760)', () => {
  // 敵 1・味方 1 のとき stage.h = H - 180（ログ 2 行 56・下パネル 80）、敵の高さ = stage.h - ラベル 32
  it.each([
    [691, 479],
    [692, 480],
    [693, 480],
    [3000, 480],
  ])('4000x%d・味方 1・敵 1: 敵の高さ %d（上限 480）', (h, size) => {
    const L = computeSideBattleLayout({ width: 4000, height: h, partyCount: 1, enemyCount: 1 })
    expect(L.stage.h).toBe(h - 180)
    expect(L.enemies[0].size).toBeCloseTo(size, 9)
    expect(L.enemies[0].width).toBeCloseTo(size, 9)
  })
  it('1280x720・味方 4 は 472 のまま（上限に届かない）・2560x1440 は 480', () => {
    expect(
      computeSideBattleLayout({ width: 1280, height: 720, partyCount: 4, enemyCount: 1 }).enemies[0]
        .size
    ).toBeCloseTo(472, 9)
    expect(
      computeSideBattleLayout({ width: 2560, height: 1440, partyCount: 1, enemyCount: 1 })
        .enemies[0].size
    ).toBe(480)
  })
  it('味方の高さの上限 320 は敵の上限 480 と独立（同じ巨大画面で味方 ≤ 320 < 敵 480）', () => {
    const L = computeSideBattleLayout({ width: 4000, height: 3000, partyCount: 2, enemyCount: 1 })
    expect(L.party[0].size).toBe(320)
    expect(L.enemies[0].size).toBe(480)
  })
})

describe('縦長判定の境界と下げ幅の上限 (#760)', () => {
  // stage.h === stage.w になる (W,H) = (360,544), (400,584), (500,684)（味方 4・敵 1）
  it.each([
    [360, 544, 144],
    [400, 584, 154],
    [500, 684, 179],
  ])('%dx%d: stage の高さ = 幅（正方形）は横長扱い → 敵は下寄せにならない（y=%d）', (w, h, y) => {
    const L = computeSideBattleLayout({ width: w, height: h, partyCount: 4, enemyCount: 1 })
    expect(L.stage.h).toBe(L.stage.w)
    expect(L.enemies[0].y).toBeCloseTo(y, 6)
  })
  it.each([
    [360, 543, 143.5],
    [400, 583, 153.5],
  ])('%dx%d: 高さ-1 の横長も同じ規則（y=%d・下寄せなし）', (w, h, y) => {
    const L = computeSideBattleLayout({ width: w, height: h, partyCount: 4, enemyCount: 1 })
    expect(L.stage.h).toBe(L.stage.w - 1)
    expect(L.enemies[0].y).toBeCloseTo(y, 6)
  })
  it.each([
    [360, 545, 203.0714286],
    [400, 585, 220.2142857],
    [500, 685, 263.0714286],
  ])('%dx%d: 高さ+1（縦長）から敵は下寄せ（y=%f）', (w, h, y) => {
    const L = computeSideBattleLayout({ width: w, height: h, partyCount: 4, enemyCount: 1 })
    expect(L.stage.h).toBe(L.stage.w + 1)
    expect(L.enemies[0].y).toBeCloseTo(y, 5)
  })

  // 下げ幅の上限: 領域の上端は stage.y + stage.h × 0.4 まで。仕様値（リテラル）
  it.each([
    [360, 640, 1, 300],
    [360, 640, 2, 302],
    [360, 640, 3, 295],
    [320, 568, 1, 261.6],
    [400, 900, 1, 462],
  ])('%dx%d・味方 %d・敵 1: 上限が効く下寄せで y=%f', (w, h, p, y) => {
    const L = computeSideBattleLayout({ width: w, height: h, partyCount: p, enemyCount: 1 })
    expect(L.enemies[0].y).toBeCloseTo(y, 6)
    // 敵の領域の上端 = stage.y + 0.4 stage.h を超えて下げない（敵の枠は領域の中央寄せなので上端以上）
    expect(L.enemies[0].y).toBeGreaterThanOrEqual(L.stage.y + L.stage.h * 0.4 - EPS)
  })

  it('縦長でも味方 0 人なら下寄せせず、領域（stage 全体）の縦中央', () => {
    const L = computeSideBattleLayout({ width: 360, height: 640, partyCount: 0, enemyCount: 1 })
    const e = L.enemies[0]
    expect(e.y).toBeCloseTo(L.stage.y + (L.stage.h - (e.size + 32)) / 2, 6)
  })

  it('縦長でも敵 0 体は空配列で例外なし', () => {
    const L = computeSideBattleLayout({ width: 360, height: 640, partyCount: 4, enemyCount: 0 })
    expect(L.enemies).toEqual([])
    expect(L.party).toHaveLength(4)
  })

  it('縦長の下寄せ: 領域の下端は固定（敵の枠・ラベルは stage の下端を超えない）', () => {
    for (const [w, h] of [
      [360, 640],
      [320, 568],
      [400, 900],
    ]) {
      for (let p = 1; p <= 4; p++)
        for (let e = 1; e <= 4; e++) {
          const L = computeSideBattleLayout({ width: w, height: h, partyCount: p, enemyCount: e })
          for (const s of L.enemies) {
            expect(s.y + s.size + (s.label ? 2 + 30 : 0)).toBeLessThanOrEqual(
              L.stage.y + L.stage.h + EPS
            )
          }
        }
    }
  })
})

describe('組み合わせスイープ: 縦長/横長 × 味方 1〜4 × 敵 1〜4 × 縦横比 × 隊列 × 奥行き (#760)', () => {
  const partyAspectSets: Array<readonly number[] | undefined> = [
    undefined,
    [0.2, 1.5, 0.2, 1.5],
    [0.4, 0.5, 0.6, 0.45],
  ]
  const enemyAspectSets: Array<readonly number[] | undefined> = [
    undefined,
    [3, 0.2, 3, 0.2],
    [1.6, 0.6, 1, 2.2],
  ]
  const rowSets: Array<readonly ('front' | 'back')[] | undefined> = [
    undefined,
    ['back', 'back', 'back', 'back'],
    ['front', 'back', 'front', 'back'],
  ]
  const depths = [null, { horizon: 0.3, perspective: 0.8 }, { horizon: 0, perspective: 1 }]
  const SIZES: Array<[number, number]> = [
    [360, 640],
    [320, 568],
    [800, 450],
    [1280, 720],
    [568, 320],
  ]
  it.each(SIZES)('%dx%d: 全矩形が画面内・stage 内・非負で、敵と味方が重ならない', (w, h) => {
    const screen: Rect = { x: 0, y: 0, w, h }
    let cases = 0
    for (let p = 1; p <= 4; p++)
      for (let e = 1; e <= 4; e++)
        for (const partyAspects of partyAspectSets)
          for (const enemyAspects of enemyAspectSets)
            for (const partyRows of rowSets)
              for (const depth of depths) {
                const L = computeSideBattleLayout({
                  width: w,
                  height: h,
                  partyCount: p,
                  enemyCount: e,
                  partyAspects,
                  enemyAspects,
                  partyRows,
                  depth,
                })
                const tag = `${w}x${h} p${p} e${e} depth=${depth ? 1 : 0}`
                const enemyRects = L.enemies.map(slotRect)
                const labels = L.enemies.flatMap((s) => (s.label ? [s.label] : []))
                const partyRects = L.party.map(slotRect)
                for (const r of [...enemyRects, ...labels, ...partyRects]) {
                  expect(Number.isFinite(r.x + r.y + r.w + r.h), tag).toBe(true)
                  expect(r.x, tag).toBeGreaterThanOrEqual(-EPS)
                  expect(r.y, tag).toBeGreaterThanOrEqual(-EPS)
                  expect(r.w, tag).toBeGreaterThanOrEqual(0)
                  expect(r.h, tag).toBeGreaterThanOrEqual(0)
                  expect(inside(r, screen), tag).toBe(true)
                  expect(inside(r, L.stage), tag).toBe(true)
                  for (const panel of [L.log, L.command, L.status])
                    expect(overlaps(r, panel), tag).toBe(false)
                }
                const nonEmpty = [...enemyRects, ...labels].filter((r) => r.w > EPS && r.h > EPS)
                for (let i = 0; i < nonEmpty.length; i++)
                  for (let j = i + 1; j < nonEmpty.length; j++)
                    expect(overlaps(nonEmpty[i], nonEmpty[j]), tag).toBe(false)
                for (const pr of partyRects.filter((r) => r.w > EPS && r.h > EPS))
                  for (const o of nonEmpty) expect(overlaps(pr, o), tag).toBe(false)
                for (const s of L.enemies) expect(s.size, tag).toBeLessThanOrEqual(480 + EPS)
                for (const s of L.party) expect(s.size, tag).toBeLessThanOrEqual(320 + EPS)
                for (let i = 0; i + 1 < L.party.length; i++) {
                  expect(L.party[i + 1].y, tag).toBeGreaterThan(L.party[i].y)
                  expect(L.party[i + 1].floor, tag).toBeGreaterThan(L.party[i].floor)
                  // 上の人の顔（上 30%）が隠れない（縮尺後の size でも y は縮まないので成り立つ）
                  expect(L.party[i + 1].y, tag).toBeGreaterThanOrEqual(
                    L.party[i].y + L.party[i].size * 0.3 - EPS
                  )
                }
                cases++
              }
    expect(cases).toBe(4 * 4 * 3 * 3 * 3 * 3)
  })
})

describe('味方の大きさは敵領域の拡大で縮まない (#760・縦横比混在・先頭後衛)', () => {
  const sizes: [number, number][] = [
    [800, 450],
    [360, 640],
    [1280, 720],
    [640, 360],
  ]
  const aspectSets: (number[] | undefined)[] = [
    undefined,
    [1.0, 0.5, 0.5, 0.5],
    [1.2, 0.4, 0.4, 0.4],
    [0.3, 1.0, 0.6, 0.45],
  ]
  const rowSets: (('front' | 'back')[] | undefined)[] = [
    undefined,
    ['back', 'front', 'front', 'front'],
    ['front', 'back', 'front', 'back'],
    ['back', 'back', 'back', 'back'],
  ]
  it('L.party の高さ = 右半分だけで求めた配置の高さ（全組み合わせ）', () => {
    for (const [w, h] of sizes)
      for (const n of [1, 2, 3, 4])
        for (const aspects of aspectSets)
          for (const rows of rowSets) {
            const L = computeSideBattleLayout({
              width: w,
              height: h,
              partyCount: n,
              enemyCount: 2,
              partyAspects: aspects?.slice(0, n),
              partyRows: rows?.slice(0, n),
            })
            const half: Rect = {
              x: L.stage.x + L.stage.w / 2,
              y: L.stage.y,
              w: L.stage.w / 2,
              h: L.stage.h,
            }
            const ref = computeFormation(
              half,
              n,
              'party',
              false,
              rows?.slice(0, n),
              aspects?.slice(0, n)
            )
            for (const s of L.party) expect(s.size).toBeCloseTo(ref[0].size, 9)
            for (const s of L.party) expect(inside(slotRect(s), L.stage)).toBe(true)
          }
  })
  it('実測の退行例: 360x640・先頭後衛 / 縦横比 [1,0.5,0.5,0.5] / 800x450 [1.2,0.4,0.4,0.4] で縮まない（リテラル）', () => {
    const a = computeSideBattleLayout({
      width: 360,
      height: 640,
      partyCount: 4,
      enemyCount: 1,
      partyRows: ['back', 'front', 'front', 'front'],
    })
    expect(a.party[0].size).toBeCloseTo(99.4, 1)
    const b = computeSideBattleLayout({
      width: 360,
      height: 640,
      partyCount: 4,
      enemyCount: 1,
      partyAspects: [1, 0.5, 0.5, 0.5],
    })
    expect(b.party[0].size).toBeCloseTo(86.3, 1)
    const c = computeSideBattleLayout({
      width: 800,
      height: 450,
      partyCount: 4,
      enemyCount: 1,
      partyAspects: [1.2, 0.4, 0.4, 0.4],
    })
    expect(c.party[0].size).toBeCloseTo(123.2, 1)
  })
})
