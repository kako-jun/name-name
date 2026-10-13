import { describe, it, expect } from 'vitest'
import {
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
