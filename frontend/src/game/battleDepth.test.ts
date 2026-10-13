import { describe, it, expect } from 'vitest'
import {
  DEPTH_DEFAULT_HORIZON,
  DEPTH_MIN_SCALE,
  SIDE_BACK_ROW_SHIFT_RATIO,
  computeDepthScale,
  computeFormation,
  computeSideBattleLayout,
  normalizeBattleDepth,
  normalizeBattleRow,
  type Rect,
  type SpriteSlot,
} from './battleLayout'

const base = { width: 800, height: 450, partyCount: 4, enemyCount: 4 }
const depth = { horizon: 0.3, perspective: 0.8 }

function within(inner: Rect, outer: Rect): boolean {
  const e = 1e-6
  return (
    inner.x >= outer.x - e &&
    inner.y >= outer.y - e &&
    inner.x + inner.w <= outer.x + outer.w + e &&
    inner.y + inner.h <= outer.y + outer.h + e
  )
}
const box = (s: SpriteSlot): Rect => ({ x: s.x, y: s.y, w: s.size, h: s.size })
function overlap(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.w - 1e-6 &&
    b.x < a.x + a.w - 1e-6 &&
    a.y < b.y + b.h - 1e-6 &&
    b.y < a.y + a.h - 1e-6
  )
}

describe('奥行き (#747)', () => {
  it('未指定・perspective 0 は平面（座標が完全に同じ）', () => {
    const flat = computeSideBattleLayout(base)
    expect(computeSideBattleLayout({ ...base, depth: null })).toEqual(flat)
    expect(computeSideBattleLayout({ ...base, depth: { horizon: 0.3, perspective: 0 } })).toEqual(
      flat
    )
    expect(flat.depthActive).toBe(false)
    expect(flat.enemies.every((s) => s.scale === 1)).toBe(true)
  })

  it('縮尺: 手前ほど大きく 1 に、奥ほど小さい（リテラル）', () => {
    // 地平線 y=100, 最前列 floor=400: floor 250 は幾何 0.5, perspective 1 でそのまま 0.5
    expect(computeDepthScale(250, 400, 100, 1)).toBeCloseTo(0.5)
    expect(computeDepthScale(400, 400, 100, 1)).toBe(1)
    expect(computeDepthScale(250, 400, 100, 0.5)).toBeCloseTo(0.75)
    expect(computeDepthScale(250, 400, 100, 0)).toBe(1)
    // 地平線より上は下限
    expect(computeDepthScale(50, 400, 100, 1)).toBeCloseTo(0.3)
    // 地平線が最前列より下なら平面
    expect(computeDepthScale(250, 400, 500, 1)).toBe(1)
  })

  it('奥の行ほど小さく、最前列は縮まない', () => {
    const L = computeSideBattleLayout({ ...base, depth })
    expect(L.depthActive).toBe(true)
    const flat = computeSideBattleLayout(base)
    for (let i = 0; i < L.party.length; i++) {
      expect(L.party[i].size).toBeLessThanOrEqual(flat.party[i].size + 1e-9)
      expect(L.party[i].scale).toBeLessThanOrEqual(1)
    }
    const maxFloor = Math.max(...[...L.enemies, ...L.party].map((s) => s.floor))
    const front = [...L.enemies, ...L.party].filter((s) => s.floor === maxFloor)
    expect(front.every((s) => s.scale === 1)).toBe(true)
    const sizes = new Set(L.party.map((s) => s.scale))
    expect(sizes.size).toBeGreaterThan(1)
  })

  it('不変条件: 縮んだ枠・ラベルは元の予約領域内で、画面内・非重複・非負', () => {
    for (const [w, h] of [
      [800, 450],
      [360, 640],
      [1280, 720],
      [640, 360],
    ]) {
      for (const n of [1, 2, 3, 4]) {
        const input = { width: w, height: h, partyCount: n, enemyCount: n }
        const flat = computeSideBattleLayout(input)
        const L = computeSideBattleLayout({ ...input, depth })
        const all = [...L.enemies, ...L.party]
        for (const s of all) {
          expect(s.size).toBeGreaterThanOrEqual(0)
          expect(within(box(s), { x: 0, y: 0, w, h })).toBe(true)
        }
        for (let i = 0; i < all.length; i++) {
          for (let j = i + 1; j < all.length; j++) {
            expect(overlap(box(all[i]), box(all[j]))).toBe(false)
          }
        }
        L.enemies.forEach((s, i) => {
          const f = flat.enemies[i]
          expect(within(box(s), box(f))).toBe(true)
          if (s.label) {
            expect(f.label).toBeDefined()
            expect(s.label.y).toBeGreaterThanOrEqual(s.y + s.size)
            // 元の予約領域（スプライト枠とラベル矩形をまとめた外接矩形）の内側
            const fl = f.label as Rect
            const x0 = Math.min(f.x, fl.x)
            const y0 = Math.min(f.y, fl.y)
            const reserve = {
              x: x0,
              y: y0,
              w: Math.max(f.x + f.size, fl.x + fl.w) - x0,
              h: Math.max(f.y + f.size, fl.y + fl.h) - y0,
            }
            expect(within(s.label, reserve)).toBe(true)
            expect(overlap(s.label, box(s))).toBe(false)
          }
        })
      }
    }
  })
})

describe('隊列の座標 (#747)', () => {
  const region: Rect = { x: 400, y: 50, w: 384, h: 250 }

  it('後衛がいなければ従来と完全に同じ', () => {
    expect(computeFormation(region, 3, 'party', false, ['front', undefined, 'front'])).toEqual(
      computeFormation(region, 3, 'party')
    )
  })

  it('後衛は右（敵から遠い側）へ半歩下がり、領域内・非重複', () => {
    for (const n of [1, 2, 3, 4]) {
      const rows = Array.from({ length: n }, (_, i) =>
        i % 2 === 1 ? ('back' as const) : undefined
      )
      const slots = computeFormation(region, n, 'party', false, rows)
      const noBack = computeFormation(region, n, 'party', false, [])
      slots.forEach((s) => expect(within(box(s), region)).toBe(true))
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) expect(overlap(box(slots[i]), box(slots[j]))).toBe(false)
      }
      // 同じ人数で、後衛の右寄りは前衛に対して size * 半歩ぶん
      const s = slots[0].size
      expect(s).toBeLessThanOrEqual(noBack[0].size + 1e-9)
      if (n >= 2) {
        const backSlot = slots[1]
        const frontSlot = slots[0]
        // 同じ列・同じ偶奇でなくても、後衛の右ずれ分が含まれる
        expect(backSlot.x).toBeGreaterThan(frontSlot.x - 1e-9 - s * SIDE_BACK_ROW_SHIFT_RATIO)
      }
    }
  })

  it('1 人だけ後衛: 前衛より半歩（size * 0.5）右', () => {
    const front = computeFormation(region, 1, 'party', false, ['front'])[0]
    const back = computeFormation(region, 1, 'party', false, ['back'])[0]
    // 後衛分の予約で size が変わりうるので、同一スロット内の相対位置: 左端 = 領域中央寄せ + shift
    const totalW = back.size * (1 + SIDE_BACK_ROW_SHIFT_RATIO)
    expect(back.x).toBeCloseTo(
      region.x + (region.w - totalW) / 2 + back.size * SIDE_BACK_ROW_SHIFT_RATIO
    )
    expect(back.x + back.size).toBeLessThanOrEqual(region.x + region.w + 1e-9)
    expect(front.x).toBeLessThan(back.x)
  })
})

describe('正規化 (#747)', () => {
  it('normalizeBattleDepth', () => {
    expect(normalizeBattleDepth('0.4', '0.7')).toEqual({ horizon: 0.4, perspective: 0.7 })
    expect(normalizeBattleDepth(undefined, '1')).toEqual({ horizon: 0.3, perspective: 1 })
    expect(normalizeBattleDepth('0.4', undefined)).toBeNull()
    expect(normalizeBattleDepth('0.4', '0')).toBeNull()
    expect(normalizeBattleDepth('0.4', 'abc')).toBeNull()
    expect(normalizeBattleDepth('9', '5')).toEqual({ horizon: 1, perspective: 1 })
    expect(normalizeBattleDepth('x', '0.5')).toEqual({ horizon: 0.3, perspective: 0.5 })
  })
  it('normalizeBattleRow', () => {
    expect(normalizeBattleRow('back')).toBe('back')
    expect(normalizeBattleRow(' BACK ')).toBe('back')
    expect(normalizeBattleRow('後衛')).toBe('back')
    expect(normalizeBattleRow('front')).toBe('front')
    expect(normalizeBattleRow('foo')).toBe('front')
    expect(normalizeBattleRow(undefined)).toBe('front')
  })
})

describe('定数のリテラル固定 (#747)', () => {
  it('SIDE_BACK_ROW_SHIFT_RATIO は 0.5', () => {
    expect(SIDE_BACK_ROW_SHIFT_RATIO).toBe(0.5)
  })
  it('DEPTH_MIN_SCALE は 0.3', () => {
    expect(DEPTH_MIN_SCALE).toBe(0.3)
  })
  it('DEPTH_DEFAULT_HORIZON は 0.3', () => {
    expect(DEPTH_DEFAULT_HORIZON).toBe(0.3)
  })
})

describe('computeDepthScale 境界 (#747)', () => {
  // 地平線 y=100・最前列 floor=400 → span 300。floor = 100 + 幾何 * 300
  it('幾何 0.31 は下限に掛からず 0.31', () => {
    expect(computeDepthScale(193, 400, 100, 1)).toBeCloseTo(0.31, 10)
  })
  it('幾何 0.30 はちょうど 0.3', () => {
    expect(computeDepthScale(190, 400, 100, 1)).toBeCloseTo(0.3, 10)
  })
  it('幾何 0.29 は下限 0.3 に丸まる', () => {
    expect(computeDepthScale(187, 400, 100, 1)).toBeCloseTo(0.3, 10)
  })
  it('span = 0（地平線 = 最前列）は 1', () => {
    expect(computeDepthScale(250, 400, 400, 1)).toBe(1)
  })
  it('span < 0（地平線が最前列より下）は 1', () => {
    expect(computeDepthScale(250, 400, 401, 1)).toBe(1)
  })
  it('perspective 2 は 1 に丸められ幾何どおり（0.5）', () => {
    expect(computeDepthScale(250, 400, 100, 2)).toBeCloseTo(0.5, 10)
  })
  it('perspective 負は 0 扱いで平面（1）', () => {
    expect(computeDepthScale(250, 400, 100, -1)).toBe(1)
  })
  it('perspective NaN は 1', () => {
    expect(computeDepthScale(250, 400, 100, NaN)).toBe(1)
  })
  it('floor NaN は 1', () => {
    expect(computeDepthScale(NaN, 400, 100, 1)).toBe(1)
  })
  it('frontFloor NaN は 1', () => {
    expect(computeDepthScale(250, NaN, 100, 1)).toBe(1)
  })
  it('horizonY NaN は 1', () => {
    expect(computeDepthScale(250, 400, NaN, 1)).toBe(1)
  })
  it('Infinity の入力も 1', () => {
    expect(computeDepthScale(Infinity, 400, 100, 1)).toBe(1)
    expect(computeDepthScale(250, 400, -Infinity, 1)).toBe(1)
  })
})

describe('normalizeBattleDepth 境界 (#747)', () => {
  it("horizon '0' は 0 を保持（既定 0.3 にならない）", () => {
    expect(normalizeBattleDepth('0', '0.5')).toEqual({ horizon: 0, perspective: 0.5 })
  })
  it("horizon '-0.5' は 0 に丸める", () => {
    expect(normalizeBattleDepth('-0.5', '0.5')).toEqual({ horizon: 0, perspective: 0.5 })
  })
  it("horizon '1.0001' は 1 に丸める", () => {
    expect(normalizeBattleDepth('1.0001', '0.5')).toEqual({ horizon: 1, perspective: 0.5 })
  })
  it('horizon 空文字は既定 0.3', () => {
    expect(normalizeBattleDepth('', '0.5')).toEqual({ horizon: 0.3, perspective: 0.5 })
  })
  it("perspective '-0.1' は null", () => {
    expect(normalizeBattleDepth('0.4', '-0.1')).toBeNull()
  })
  it("perspective '0' は null", () => {
    expect(normalizeBattleDepth('0.4', '0')).toBeNull()
  })
  it("perspective '0.001' は有効", () => {
    expect(normalizeBattleDepth('0.4', '0.001')).toEqual({ horizon: 0.4, perspective: 0.001 })
  })
  it('perspective 空文字は null', () => {
    expect(normalizeBattleDepth('0.4', '')).toBeNull()
  })
  it('perspective 空白のみは null', () => {
    expect(normalizeBattleDepth('0.4', '   ')).toBeNull()
  })
  it("perspective 'Infinity' は null", () => {
    expect(normalizeBattleDepth('0.4', 'Infinity')).toBeNull()
  })
  it("perspective 'NaN' は null", () => {
    expect(normalizeBattleDepth('0.4', 'NaN')).toBeNull()
  })
  it("perspective '0.5abc' は null", () => {
    expect(normalizeBattleDepth('0.4', '0.5abc')).toBeNull()
  })
  it('perspective null は null', () => {
    expect(normalizeBattleDepth('0.4', null)).toBeNull()
  })
  it("horizon 'Infinity' は数値扱いされず既定 0.3", () => {
    expect(normalizeBattleDepth('Infinity', '0.5')).toEqual({ horizon: 0.3, perspective: 0.5 })
  })
})

describe('normalizeBattleRow 境界 (#747)', () => {
  it("'後列' は back", () => {
    expect(normalizeBattleRow('後列')).toBe('back')
  })
  it("'Back' は back", () => {
    expect(normalizeBattleRow('Back')).toBe('back')
  })
  it("'  後衛  ' は back", () => {
    expect(normalizeBattleRow('  後衛  ')).toBe('back')
  })
  it("'前衛' は front", () => {
    expect(normalizeBattleRow('前衛')).toBe('front')
  })
  it("'rear' は front（別名は認めない）", () => {
    expect(normalizeBattleRow('rear')).toBe('front')
  })
  it('空文字は front', () => {
    expect(normalizeBattleRow('')).toBe('front')
  })
  it('null は front', () => {
    expect(normalizeBattleRow(null)).toBe('front')
  })
})

describe('computeFormation 隊列の境界 (#747)', () => {
  const region: Rect = { x: 400, y: 50, w: 384, h: 250 }
  const party = (n: number, rows?: readonly ('front' | 'back' | undefined)[]) =>
    computeFormation(region, n, 'party', false, rows)

  it('rows が count より短い: 足りない分は前衛', () => {
    const slots = party(3, ['back'])
    const full = party(3, ['back', undefined, undefined])
    expect(slots).toEqual(full)
    // 斜め一列: index 0 だけ size/2 右へ下がる（基準の斜め位置との差）
    const front = party(3, ['front', 'front', 'front'])
    expect(slots[0].x - slots[2].x).toBeCloseTo(front[0].x - front[2].x + slots[0].size * 0.5, 9)
    expect(slots[1].x).toBeGreaterThan(slots[0].x - slots[0].size)
  })
  it('rows が count より長い: はみ出し分は無視（後衛を含まないなら従来と同じ）', () => {
    expect(party(1, ['front', 'back', 'back'])).toEqual(party(1))
  })
  it('rows が count より長い: 先頭 count 件だけ見て後衛がいれば size が縮む', () => {
    expect(party(1, ['back', 'front'])).toEqual(party(1, ['back']))
  })
  it('敵側に rows を渡しても無視（全員後衛指定でも従来と同じ）', () => {
    const back3 = ['back', 'back', 'back'] as const
    expect(computeFormation(region, 3, 'enemy', true, back3)).toEqual(
      computeFormation(region, 3, 'enemy', true)
    )
  })
  it('前衛と後衛の x 差は斜め位置の差 + ちょうど 0.5 × size (#760)', () => {
    const slots = party(3, ['front', 'front', 'back'])
    const front = party(
      3,
      ['front', 'front', 'back'].map(() => 'front')
    )
    const dx = front[2].x - front[0].x
    expect(slots[2].x - slots[0].x).toBeCloseTo(dx + slots[0].size * 0.5, 9)
  })
  it('1 人後衛で 4 人: 全員の size が後衛ぶんの右余白で縮む（前衛のみは 62.5=高さ律速）(#760)', () => {
    const mixed = party(4, ['front', 'front', 'front', 'back'])
    expect(party(4)[0].size).toBe(62.5)
    // 幅律速: 384 / (1 + 0.5 + 3 * 0.25) = 170.67 は高さ律速 62.5 より大きいので縮まない
    for (const s of mixed) expect(s.size).toBe(62.5)
  })
  it('全員後衛 4 人でも size は 1 人後衛と同じ (#760)', () => {
    const slots = party(4, ['back', 'back', 'back', 'back'])
    for (const s of slots) expect(s.size).toBe(62.5)
  })
  it('全員後衛 2 人: 高さ律速なので size は 125 のまま', () => {
    for (const s of party(2, ['back', 'back'])) expect(s.size).toBe(125)
  })
  it('全員後衛 1 人: size は最大の 160', () => {
    expect(party(1, ['back'])[0].size).toBe(160)
  })
  it('斜め一列＋後衛: 領域内で縦に重ならない (#760)', () => {
    for (const rows of [
      ['front', 'back', 'front', 'back'],
      ['back', 'back', 'back', 'back'],
    ] as const) {
      const slots = party(4, rows)
      slots.forEach((s) => expect(within(box(s), region)).toBe(true))
      for (let i = 1; i < slots.length; i++) {
        expect(slots[i].y).toBeGreaterThanOrEqual(slots[i - 1].y + slots[i - 1].size - 1e-9)
      }
    }
  })
})

describe('computeSideBattleLayout 奥行き＋隊列 (#747)', () => {
  const screens: [number, number][] = [
    [800, 450],
    [360, 640],
    [1280, 720],
    [640, 360],
  ]
  it('奥行き＋後衛同時: 画面内・非重複・非負（画面 4 種 × 人数 1〜4）', () => {
    for (const [w, h] of screens) {
      for (const n of [1, 2, 3, 4]) {
        const partyRows = Array.from({ length: n }, (_, i) =>
          i % 2 === 1 ? ('back' as const) : ('front' as const)
        )
        const L = computeSideBattleLayout({
          width: w,
          height: h,
          partyCount: n,
          enemyCount: n,
          partyRows,
          depth,
        })
        const all = [...L.enemies, ...L.party]
        for (const s of all) {
          expect(s.size).toBeGreaterThanOrEqual(0)
          expect(s.x).toBeGreaterThanOrEqual(0)
          expect(s.y).toBeGreaterThanOrEqual(0)
          expect(within(box(s), { x: 0, y: 0, w, h })).toBe(true)
        }
        for (let i = 0; i < all.length; i++) {
          for (let j = i + 1; j < all.length; j++) {
            expect(overlap(box(all[i]), box(all[j]))).toBe(false)
          }
        }
      }
    }
  })
  it('全員後衛でも不変条件を満たす', () => {
    for (const [w, h] of screens) {
      for (const n of [1, 2, 3, 4]) {
        const L = computeSideBattleLayout({
          width: w,
          height: h,
          partyCount: n,
          enemyCount: n,
          partyRows: Array(n).fill('back'),
          depth,
        })
        for (const s of L.party) expect(within(box(s), { x: 0, y: 0, w, h })).toBe(true)
        for (let i = 0; i < L.party.length; i++) {
          for (let j = i + 1; j < L.party.length; j++) {
            expect(overlap(box(L.party[i]), box(L.party[j]))).toBe(false)
          }
        }
      }
    }
  })
  it('味方 0 体でも例外なく、敵だけの配置になる', () => {
    const L = computeSideBattleLayout({ ...base, partyCount: 0, partyRows: [], depth })
    expect(L.party).toEqual([])
    expect(L.enemies.length).toBe(4)
    expect(L.depthActive).toBe(true)
  })
  it('敵 0 体でも例外なく、味方だけの配置になる', () => {
    const L = computeSideBattleLayout({ ...base, enemyCount: 0, partyRows: ['back'], depth })
    expect(L.enemies).toEqual([])
    expect(L.party.length).toBe(4)
  })
  it('両側 0 体でも例外なし', () => {
    const L = computeSideBattleLayout({ ...base, partyCount: 0, enemyCount: 0, depth })
    expect(L.party).toEqual([])
    expect(L.enemies).toEqual([])
  })
  it('800x450・4 対 4・{0.3, 0.8}: 奥の味方の scale は 0.44（リテラル・斜め一列 #760）', () => {
    const L = computeSideBattleLayout({ ...base, depth })
    expect(L.party[0].scale).toBeCloseTo(0.44, 5)
    expect(L.party[0].size).toBeCloseTo(21.34, 3)
  })
  it('800x450・4 対 4・{0.3, 0.8}: 最前列（4 人目）の味方は scale 1・size 48.5（斜め一列 #760）', () => {
    const L = computeSideBattleLayout({ ...base, depth })
    expect(L.party[3].scale).toBe(1)
    expect(L.party[3].size).toBe(48.5)
  })
  it('800x450・4 対 4・{0.3, 0.8}: 奥の敵の scale は 0.44（リテラル・幾何が下限 0.3 に張り付く）', () => {
    const L = computeSideBattleLayout({ ...base, depth })
    expect(L.enemies[0].scale).toBeCloseTo(0.44, 5)
    expect(L.enemies[0].size).toBeCloseTo(28.6, 3)
  })
  it('味方 1 敵 1: 足元が同じ高さか味方のほうが下なら、味方の縮尺は敵以上（基準は足元 y+size）', () => {
    const L = computeSideBattleLayout({
      ...base,
      partyCount: 1,
      enemyCount: 1,
      partyRows: [],
      depth: { horizon: 0.3, perspective: 0.8 },
    })
    const party = L.party[0]
    const enemy = L.enemies[0]
    expect(party.floor).toBeGreaterThanOrEqual(enemy.floor)
    expect(party.scale).toBeGreaterThanOrEqual(enemy.scale)
  })
  it('未指定: depthActive false・座標は従来どおり（800x450・4 対 4）', () => {
    const L = computeSideBattleLayout(base)
    expect(L.depthActive).toBe(false)
    expect([L.party[0].x, L.party[0].y, L.party[0].size]).toEqual([513.1875, 118, 48.5])
    expect(L.party[1].x).toBeCloseTo(549.5625, 3)
    expect(L.party[1].y).toBe(166.5)
    expect([L.enemies[0].x, L.enemies[0].y, L.enemies[0].size]).toEqual([134.875, 118, 65])
  })
  it('partyRows に front のみ・depth なしなら従来と完全に同じ', () => {
    expect(
      computeSideBattleLayout({ ...base, partyRows: ['front', undefined, 'front', 'front'] })
    ).toEqual(computeSideBattleLayout(base))
  })
})
