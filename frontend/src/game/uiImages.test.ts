import { afterEach, describe, expect, it, vi } from 'vitest'
import { Assets, Texture, TextureSource } from 'pixi.js'
import {
  DEFAULT_MARK_SCALE,
  MAX_MARK_SCALE,
  computeHandImageRect,
  computeSelectMarkImageRect,
  loadUiTexture,
  parseMarkScale,
} from './uiImages'
import { computeSelectMarkTriangle } from './battleLayout'
import { HAND_HEIGHT, HAND_WIDTH } from './battleMenuLayout'
import { createHandCursor } from './HandCursor'
import { Graphics, Sprite } from 'pixi.js'

const tex = (w: number, h: number): Texture =>
  new Texture({ source: new TextureSource({ width: w, height: h }) })

afterEach(() => vi.restoreAllMocks())

describe('parseMarkScale (#1087)', () => {
  it('未指定は既定 2.0。正常値はそのまま', () => {
    const w: string[] = []
    expect(parseMarkScale(undefined, w)).toBe(DEFAULT_MARK_SCALE)
    expect(DEFAULT_MARK_SCALE).toBe(2)
    expect(parseMarkScale(1.5, w)).toBe(1.5)
    expect(parseMarkScale(MAX_MARK_SCALE, w)).toBe(MAX_MARK_SCALE)
    expect(w).toEqual([])
  })
  it('0・負・非数・上限超・文字列は警告して既定へ', () => {
    for (const v of [0, -1, NaN, Infinity, MAX_MARK_SCALE + 0.1, '2', null, {}]) {
      const w: string[] = []
      expect(parseMarkScale(v, w), String(v)).toBe(DEFAULT_MARK_SCALE)
      expect(w.length).toBe(1)
      expect(w[0]).toContain('markScale')
    }
  })
})

describe('computeHandImageRect (#1067)', () => {
  const box = { x: 10, y: 20, w: HAND_WIDTH, h: HAND_HEIGHT }
  it('高さは枠の高さ・縦横比を保つ。右向きは右端、左向きは左端を枠に揃える', () => {
    const r = computeHandImageRect(box, 'right', 512, 285)!
    expect(r.h).toBe(HAND_HEIGHT)
    expect(r.w).toBeCloseTo((HAND_HEIGHT * 512) / 285)
    expect(r.y).toBe(20)
    expect(r.x + r.w).toBeCloseTo(box.x + box.w)
    expect(r.flipX).toBe(false)
    const l = computeHandImageRect(box, 'left', 512, 285)!
    expect(l.x).toBe(box.x)
    expect(l.flipX).toBe(true)
    expect(l.w).toBeCloseTo(r.w)
  })
  it('枠の高さに比例して拡大する（フィールドメニューの行の高さ）', () => {
    const big = computeHandImageRect({ x: 0, y: 0, w: 56, h: 32 }, 'right', 512, 285)!
    expect(big.h).toBe(32)
    expect(big.w).toBeCloseTo((32 * 512) / 285)
  })
  it('画像・枠の寸法が不正なら null（ドット手へ）', () => {
    expect(computeHandImageRect(box, 'right', 0, 285)).toBeNull()
    expect(computeHandImageRect(box, 'right', 512, NaN)).toBeNull()
    expect(computeHandImageRect({ ...box, h: 0 }, 'right', 512, 285)).toBeNull()
  })
})

describe('computeSelectMarkImageRect (#1087)', () => {
  it('頂点（下端中央）は三角の先端と同じ位置（頭から離れる間隔は拡大率に依らない）', () => {
    const tri = computeSelectMarkTriangle(50, 100, 200)
    for (const s of [1, 1.5, 2, 3]) {
      const r = computeSelectMarkImageRect(50, 100, 200, 256, 335, s)!
      expect(r.y + r.h).toBeCloseTo(tri[5])
      expect(r.x + r.w / 2).toBeCloseTo(50)
    }
  })
  it('三角の枠（幅・高さ）に縦横比を保って収め、拡大率ぶん大きくなる', () => {
    const tri = computeSelectMarkTriangle(50, 100, 200)
    const triH = tri[5] - tri[1]
    const r1 = computeSelectMarkImageRect(50, 100, 200, 256, 335, 1)!
    expect(r1.h).toBeCloseTo(triH) // 縦長の絵は高さが制約
    expect(r1.w / r1.h).toBeCloseTo(256 / 335)
    const r2 = computeSelectMarkImageRect(50, 100, 200, 256, 335, 2)!
    expect(r2.h).toBeCloseTo(triH * 2)
    expect(r2.w / r2.h).toBeCloseTo(256 / 335)
    const r3 = computeSelectMarkImageRect(50, 100, 200, 256, 335, 3)!
    expect(r3.h).toBeCloseTo(triH * 3)
  })
  it('横長の絵は幅が制約になる', () => {
    const tri = computeSelectMarkTriangle(50, 100, 200)
    const r = computeSelectMarkImageRect(50, 100, 200, 400, 100, 1)!
    expect(r.w).toBeCloseTo(tri[2] - tri[0])
  })
  it('unit が小さくても最小の枠を下回らない', () => {
    const r = computeSelectMarkImageRect(50, 100, 20, 100, 100, 1)!
    expect(r.w).toBeCloseTo(8) // 最小高 8 が制約（正方形）
    expect(100 - (r.y + r.h)).toBeCloseTo(4) // 最小の間隔
  })
  it('上端の下限（ログ窓の下端）より上に出ず、大きさは保つ。拡大するほど下げる', () => {
    const free = computeSelectMarkImageRect(50, 20, 100, 256, 335, 3)!
    const clamped = computeSelectMarkImageRect(50, 20, 100, 256, 335, 3, 30)!
    expect(clamped.y).toBeCloseTo(30)
    expect(clamped.h).toBeCloseTo(free.h)
    expect(clamped.w).toBeCloseTo(free.w)
    expect(computeSelectMarkImageRect(50, 20, 100, 256, 335, 3, -100)).toEqual(free)
  })
  it('画像・拡大率が不正なら null（三角へ）', () => {
    expect(computeSelectMarkImageRect(50, 100, 200, 0, 335, 2)).toBeNull()
    expect(computeSelectMarkImageRect(50, 100, 200, 256, 335, 0)).toBeNull()
    expect(computeSelectMarkImageRect(50, 100, 200, 256, 335, NaN)).toBeNull()
  })
})

describe('createHandCursor (#1067)', () => {
  it('画像なしは従来のドット手（Graphics）', () => {
    expect(createHandCursor(0, 0, HAND_HEIGHT, 'right', null)).toBeInstanceOf(Graphics)
  })
  it('画像ありは Sprite。高さは枠の高さ・縦横比を保ち、タップを受けない', () => {
    const s = createHandCursor(10, 20, HAND_HEIGHT, 'right', tex(512, 285)) as Sprite
    expect(s).toBeInstanceOf(Sprite)
    expect(s.height).toBeCloseTo(HAND_HEIGHT)
    expect(s.width).toBeCloseTo((HAND_HEIGHT * 512) / 285)
    expect(s.eventMode).toBe('none')
    expect(s.y).toBe(20)
  })
  it('左向きは左右反転し、枠の左端から右へ広がる', () => {
    const s = createHandCursor(10, 20, HAND_HEIGHT, 'left', tex(512, 285)) as Sprite
    const b = s.getBounds()
    expect(b.x).toBeCloseTo(10)
    expect(b.width).toBeCloseTo((HAND_HEIGHT * 512) / 285)
    expect(s.scale.x).toBeLessThan(0)
  })
})

describe('loadUiTexture (#1067・#1087)', () => {
  it('URL なしは null（警告なし）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await loadUiTexture(undefined, 'x')).toBeNull()
    expect(warn).not.toHaveBeenCalled()
  })
  it('読めたらその texture。失敗は警告して null', async () => {
    const t = tex(10, 10)
    vi.spyOn(Assets, 'load').mockResolvedValueOnce(t as never)
    expect(await loadUiTexture('http://x/a.webp', '手')).toBe(t)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(Assets, 'load').mockRejectedValueOnce(new Error('404'))
    expect(await loadUiTexture('http://x/b.webp', '手')).toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)
  })
})
