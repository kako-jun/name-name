/**
 * spriteStyle (#737) の純粋関数テスト。
 *
 * 「仕様値」と書いたテストは、定数を参照せずリテラルで固定している（定数の値だけが変わる変異を捕まえるため）。
 * 定数参照は導出式のテストにだけ使う。PixiJS の実描画・GLSL コンパイルは対象外（jsdom に WebGL が無い）。
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_ACRYLIC_PARAMS,
  EDGE_INNER_SPACING_PX,
  EDGE_MAX_INNER_TAPS,
  EDGE_MAX_LINE_PX,
  EDGE_MAX_MARGIN_PX,
  EDGE_MAX_OUTER_TAPS,
  EDGE_MAX_TAPS,
  EDGE_OUTER_SPACING_PX,
  computeAcrylicGeometry,
  computeEdgeOffsets,
  normalizeSpriteStyle,
  resolveAcrylicParams,
  type AcrylicParams,
} from './spriteStyle'

describe('normalizeSpriteStyle', () => {
  it.each([
    ['acrylic', 'acrylic'],
    ['ACRYLIC', 'acrylic'],
    [' Acrylic ', 'acrylic'],
    ['none', 'none'],
    ['', 'none'],
    ['  ', 'none'],
    [null, 'none'],
    [undefined, 'none'],
    ['acrylics', 'none'],
    ['acryl', 'none'],
    ['"acrylic"', 'none'],
  ])('%j → %s（完全一致のみ acrylic。前後空白・大文字小文字は許容）', (raw, expected) => {
    expect(normalizeSpriteStyle(raw)).toBe(expected)
  })
})

describe('DEFAULT_ACRYLIC_PARAMS / resolveAcrylicParams', () => {
  it('仕様値: 既定パラメータはリテラルで固定（定数参照にしない）', () => {
    expect(DEFAULT_ACRYLIC_PARAMS).toEqual({
      marginRatio: 0.03,
      minMarginPx: 2,
      lineWidthRatio: 0.02,
      minLinePx: 1.5,
      maxMarginPx: 6,
      maxLinePx: 4,
      lineColor: 0xe6f3ff,
      lineAlpha: 0.85,
      hasBase: true,
      baseWidthRatio: 0.7,
      baseHeightRatio: 0.28,
      highlightAlpha: 0.3,
      shadowAlpha: 0.4,
      shadowScale: 1.2,
    })
  })

  it.each([[undefined], [{}]])('引数 %j は既定値と一致する（仕様値）', (arg) => {
    expect(resolveAcrylicParams(arg as Partial<AcrylicParams> | undefined)).toEqual({
      marginRatio: 0.03,
      minMarginPx: 2,
      lineWidthRatio: 0.02,
      minLinePx: 1.5,
      maxMarginPx: 6,
      maxLinePx: 4,
      lineColor: 0xe6f3ff,
      lineAlpha: 0.85,
      hasBase: true,
      baseWidthRatio: 0.7,
      baseHeightRatio: 0.28,
      highlightAlpha: 0.3,
      shadowAlpha: 0.4,
      shadowScale: 1.2,
    })
  })

  it('1 項目だけの上書きは他の項目を既定のまま残す', () => {
    const r = resolveAcrylicParams({ lineAlpha: 0.5 })
    expect(r.lineAlpha).toBe(0.5)
    expect(r).toEqual({ ...DEFAULT_ACRYLIC_PARAMS, lineAlpha: 0.5 })
  })

  it('冪等: resolve(resolve(x)) は resolve(x) と等しい', () => {
    const x: Partial<AcrylicParams> = { marginRatio: 9, lineColor: 1.9, baseWidthRatio: -3 }
    expect(resolveAcrylicParams(resolveAcrylicParams(x))).toEqual(resolveAcrylicParams(x))
  })

  it.each([[NaN], [Infinity], [-Infinity]])(
    '数値項目に %s を渡すと既定値になる（仕様値）',
    (bad) => {
      const r = resolveAcrylicParams({
        marginRatio: bad,
        minMarginPx: bad,
        lineWidthRatio: bad,
        minLinePx: bad,
        maxMarginPx: bad,
        maxLinePx: bad,
        lineColor: bad,
        lineAlpha: bad,
        baseWidthRatio: bad,
        baseHeightRatio: bad,
        highlightAlpha: bad,
        shadowAlpha: bad,
        shadowScale: bad,
      })
      expect(r).toEqual({
        marginRatio: 0.03,
        minMarginPx: 2,
        lineWidthRatio: 0.02,
        minLinePx: 1.5,
        maxMarginPx: 6,
        maxLinePx: 4,
        lineColor: 0xe6f3ff,
        lineAlpha: 0.85,
        hasBase: true,
        baseWidthRatio: 0.7,
        baseHeightRatio: 0.28,
        highlightAlpha: 0.3,
        shadowAlpha: 0.4,
        shadowScale: 1.2,
      })
    }
  )

  it('hasBase: false 指定は false、boolean 以外は既定 true', () => {
    expect(resolveAcrylicParams({ hasBase: false }).hasBase).toBe(false)
    expect(resolveAcrylicParams({ hasBase: true }).hasBase).toBe(true)
    expect(resolveAcrylicParams({ hasBase: 0 as never }).hasBase).toBe(true)
    expect(resolveAcrylicParams({ hasBase: 'false' as never }).hasBase).toBe(true)
    expect(resolveAcrylicParams({ hasBase: null as never }).hasBase).toBe(true)
  })

  // [項目, 下限, 上限] — 仕様値の clamp 範囲。下限の手前・境界・上限の先をリテラルで固定する。
  it.each<[keyof AcrylicParams, number, number]>([
    ['marginRatio', 0, 0.15],
    ['minMarginPx', 0, 32],
    ['lineWidthRatio', 0, 0.1],
    ['minLinePx', 0, 16],
    ['maxMarginPx', 0, 6],
    ['maxLinePx', 0, 4],
    ['lineColor', 0, 0xffffff],
    ['lineAlpha', 0, 1],
    ['highlightAlpha', 0, 1],
    ['shadowAlpha', 0, 1],
    ['baseWidthRatio', 0.1, 1],
    ['baseHeightRatio', 0.05, 1],
    ['shadowScale', 1, 2],
  ])('仕様値: %s の clamp は下限 %s・上限 %s', (key, min, max) => {
    const at = (v: number): number => resolveAcrylicParams({ [key]: v })[key] as number
    expect(at(min - 1)).toBe(min)
    expect(at(min)).toBe(min)
    expect(at(max)).toBe(max)
    expect(at(max + 1)).toBe(max)
    expect(at(max * 100)).toBe(max)
  })

  it('仕様値: clamp 境界の直外（0.15→0.16 など）は境界へ倒す', () => {
    expect(resolveAcrylicParams({ marginRatio: 0.16 }).marginRatio).toBe(0.15)
    expect(resolveAcrylicParams({ minMarginPx: 33 }).minMarginPx).toBe(32)
    expect(resolveAcrylicParams({ lineWidthRatio: 0.11 }).lineWidthRatio).toBe(0.1)
    expect(resolveAcrylicParams({ minLinePx: 17 }).minLinePx).toBe(16)
    expect(resolveAcrylicParams({ maxMarginPx: 6.1 }).maxMarginPx).toBe(6)
    expect(resolveAcrylicParams({ maxLinePx: 4.1 }).maxLinePx).toBe(4)
    expect(resolveAcrylicParams({ baseWidthRatio: 0.09 }).baseWidthRatio).toBe(0.1)
    expect(resolveAcrylicParams({ baseHeightRatio: 0.04 }).baseHeightRatio).toBe(0.05)
    expect(resolveAcrylicParams({ shadowScale: 0.99 }).shadowScale).toBe(1)
    expect(resolveAcrylicParams({ shadowScale: 2.01 }).shadowScale).toBe(2)
  })

  it('範囲内の値はそのまま通す（clamp が値を潰さない）', () => {
    const r = resolveAcrylicParams({ marginRatio: 0.1, baseWidthRatio: 0.5, shadowScale: 1.5 })
    expect(r.marginRatio).toBe(0.1)
    expect(r.baseWidthRatio).toBe(0.5)
    expect(r.shadowScale).toBe(1.5)
  })

  it('lineColor の小数は切り捨てる', () => {
    expect(resolveAcrylicParams({ lineColor: 0x123456 + 0.9 }).lineColor).toBe(0x123456)
  })
})

describe('computeAcrylicGeometry', () => {
  const empty = {
    sprite: { x: 0, y: 0, width: 0, height: 0 },
    marginPx: 0,
    linePx: 0,
    base: null,
    highlight: null,
    shadow: null,
  }

  it.each([[0], [-1], [-100], [NaN], [Infinity], [-Infinity]])(
    'size=%s は空の幾何（大きさ 0・台座・影・フチなし）',
    (size) => {
      expect(computeAcrylicGeometry(100, 100, size)).toEqual(empty)
    }
  )

  it('size=1 は通常の計算（NaN なし・空幾何ではない）', () => {
    const g = computeAcrylicGeometry(100, 100, 1)
    expect(g.base).not.toBeNull()
    expect(g.marginPx).toBe(2)
    expect(g.linePx).toBe(1.5)
    for (const v of [g.sprite.x, g.sprite.y, g.sprite.width, g.sprite.height]) {
      expect(Number.isNaN(v)).toBe(false)
    }
  })

  it('hasBase=false で base / highlight / shadow が null', () => {
    const g = computeAcrylicGeometry(100, 100, 200, resolveAcrylicParams({ hasBase: false }))
    expect(g.base).toBeNull()
    expect(g.highlight).toBeNull()
    expect(g.shadow).toBeNull()
    expect(g.sprite.width).toBeGreaterThan(0)
  })

  it('hasBase=false のスプライトは枠の下端から余白+線ぶん上に足元が来る（足元は台座中心ではない）', () => {
    const g = computeAcrylicGeometry(100, 100, 200, resolveAcrylicParams({ hasBase: false }))
    // size=200: margin=6, line=4 → 領域は [10, 190]²。足元 190
    expect(g.sprite).toEqual({ x: 10, y: 10, width: 180, height: 180 })
  })

  it('仕様値: 正準寸法（size=200, texture 100x100）のスナップショット', () => {
    const g = computeAcrylicGeometry(100, 100, 200)
    expect(g.marginPx).toBeCloseTo(6, 9)
    expect(g.linePx).toBeCloseTo(4, 9)
    expect(g.base!.cx).toBeCloseTo(100, 9)
    expect(g.base!.rx).toBeCloseTo(70, 9)
    expect(g.base!.ry).toBeCloseTo(19.6, 9)
    expect(g.shadow!.cx).toBeCloseTo(100, 9)
    expect(g.shadow!.rx).toBeCloseTo(84, 9)
    expect(g.shadow!.ry).toBeCloseTo(23.52, 9)
    expect(g.shadow!.cy).toBeCloseTo(176.48, 9)
    expect(g.shadow!.cy + g.shadow!.ry).toBeCloseTo(200, 9)
    expect(g.base!.cy).toBeCloseTo(176.48, 9)
    // 領域は x:[10,190] × y:[10,176.48] → 高さ 166.48 の正方形が中央に乗る
    expect(g.sprite.width).toBeCloseTo(166.48, 9)
    expect(g.sprite.height).toBeCloseTo(166.48, 9)
    expect(g.sprite.x).toBeCloseTo(16.76, 9)
    expect(g.sprite.y).toBeCloseTo(10, 9)
  })

  it('仕様値: ハイライトの係数（rx = base.rx*0.7, ry = base.ry*0.35, cy = base.cy - base.ry*0.35）', () => {
    const g = computeAcrylicGeometry(100, 100, 200)
    expect(g.highlight!.cx).toBeCloseTo(100, 9)
    expect(g.highlight!.rx).toBeCloseTo(49, 9) // 70 * 0.7
    expect(g.highlight!.ry).toBeCloseTo(6.86, 9) // 19.6 * 0.35
    expect(g.highlight!.cy).toBeCloseTo(169.62, 9) // 176.48 - 6.86
  })

  it('縦長 400x100 は幅いっぱい・縦横比 4:1 を保つ（size と width の取り違えを検知）', () => {
    const g = computeAcrylicGeometry(400, 100, 200)
    expect(g.sprite.width).toBeCloseTo(180, 9)
    expect(g.sprite.height).toBeCloseTo(45, 9)
    expect(g.sprite.x).toBeCloseTo(10, 9)
    expect(g.sprite.y + g.sprite.height).toBeCloseTo(g.base!.cy, 9)
  })

  it('横長 100x400 は高さいっぱい・縦横比 1:4 を保つ', () => {
    const g = computeAcrylicGeometry(100, 400, 200)
    expect(g.sprite.height).toBeCloseTo(166.48, 9)
    expect(g.sprite.width).toBeCloseTo(41.62, 9)
    expect(g.sprite.x).toBeCloseTo((200 - 41.62) / 2, 9)
    expect(g.sprite.y).toBeCloseTo(10, 9)
  })

  it.each([
    [0, 100],
    [100, 0],
    [-5, 100],
    [100, -5],
    [0, 0],
  ])('テクスチャ寸法 %s x %s は領域いっぱいに置く', (w, h) => {
    const g = computeAcrylicGeometry(w, h, 200)
    expect(g.sprite.x).toBeCloseTo(10, 9)
    expect(g.sprite.y).toBeCloseTo(10, 9)
    expect(g.sprite.width).toBeCloseTo(180, 9)
    expect(g.sprite.height).toBeCloseTo(166.48, 9)
  })

  // minMarginPx(2) と marginRatio*size = 0.03*size の切替: size=66.67 で等しい。minLinePx(1.5) と 0.02*size は size=75 で等しい。
  it.each([
    [50, 2, 1.5], // 比率 1.5 / 1.0 → 両方とも最小値が勝つ
    [66, 2, 1.5],
    [75, 2.25, 1.5], // 線は 0.02*75=1.5 ちょうど（最小値と同値）
    [100, 3, 2], // 比率が勝つ
  ])(
    '仕様値: size=%s の余白は %s px・線は %s px（最小値と比率の切替境界）',
    (size, margin, line) => {
      const g = computeAcrylicGeometry(100, 100, size)
      expect(g.marginPx).toBeCloseTo(margin, 9)
      expect(g.linePx).toBeCloseTo(line, 9)
    }
  )

  it('size=66 は余白が最小値 2（0.03*66=1.98）、size=67 は比率 2.01 が勝つ', () => {
    expect(computeAcrylicGeometry(100, 100, 66).marginPx).toBeCloseTo(2, 9)
    expect(computeAcrylicGeometry(100, 100, 67).marginPx).toBeCloseTo(2.01, 9)
  })

  it('size=75 の線は 1.5、size=76 は比率 1.52 が勝つ', () => {
    expect(computeAcrylicGeometry(100, 100, 75).linePx).toBeCloseTo(1.5, 9)
    expect(computeAcrylicGeometry(100, 100, 76).linePx).toBeCloseTo(1.52, 9)
  })

  it('余白と線を取り違えない（余白>線の既定で marginPx と linePx が別の値）', () => {
    const g = computeAcrylicGeometry(100, 100, 200)
    expect(g.marginPx).not.toBe(g.linePx)
    // スプライトの内側余白は marginPx+linePx の合計: 上端 y = 6 + 4
    expect(g.sprite.y).toBeCloseTo(g.marginPx + g.linePx, 9)
  })

  it('台座は影の内側（同一中心・base ⊂ shadow）で、影の下端は枠の下端', () => {
    const g = computeAcrylicGeometry(100, 100, 200)
    expect(g.base!.cx).toBe(g.shadow!.cx)
    expect(g.base!.cy).toBe(g.shadow!.cy)
    expect(g.base!.rx).toBeLessThan(g.shadow!.rx)
    expect(g.base!.ry).toBeLessThan(g.shadow!.ry)
    expect(g.shadow!.cy + g.shadow!.ry).toBeCloseTo(200, 9)
  })

  it('ハイライトは台座の内側（highlight ⊂ base）', () => {
    const g = computeAcrylicGeometry(100, 100, 200)
    const b = g.base!
    const h = g.highlight!
    expect(h.rx).toBeLessThan(b.rx)
    expect(h.cy - h.ry).toBeGreaterThanOrEqual(b.cy - b.ry)
    expect(h.cy + h.ry).toBeLessThanOrEqual(b.cy + b.ry)
  })

  // 影の枠幅頭打ち: baseW × shadowScale が size-1 / size / size+1 の3点
  it.each([
    [199, false],
    [200, false],
    [201, true],
  ])(
    '影の幅 baseW×scale=%s（size=200）: 頭打ち=%s でも base ⊂ shadow・影は枠内',
    (shadowRaw, clipped) => {
      // baseWidthRatio=1 → baseW=200。scale = shadowRaw/200 を 1〜2 の範囲で作る…が scale<1 は丸められるため
      // baseWidthRatio を使って baseW×scale を作る: scale=1.5 固定で baseW = shadowRaw/1.5
      const p = resolveAcrylicParams({ baseWidthRatio: shadowRaw / 1.5 / 200, shadowScale: 1.5 })
      const g = computeAcrylicGeometry(100, 100, 200, p)
      const s = g.shadow!
      const b = g.base!
      expect(s.rx * 2).toBeLessThanOrEqual(200 + 1e-9)
      expect(s.cx - s.rx).toBeGreaterThanOrEqual(-1e-9)
      expect(s.cx + s.rx).toBeLessThanOrEqual(200 + 1e-9)
      expect(b.rx).toBeLessThan(s.rx)
      expect(s.cy + s.ry).toBeCloseTo(200, 9)
      if (clipped) expect(s.rx * 2).toBeCloseTo(200, 9)
      else expect(s.rx * 2).toBeCloseTo(shadowRaw, 9)
    }
  )

  it('baseWidthRatio=1・shadowScale=2 でも影は枠幅に切り詰められ、台座は同比率で縮んで影の内側に残る', () => {
    const g = computeAcrylicGeometry(
      100,
      100,
      200,
      resolveAcrylicParams({ baseWidthRatio: 1, shadowScale: 2 })
    )
    expect(g.shadow!.rx).toBeCloseTo(100, 9)
    expect(g.base!.rx).toBeCloseTo(50, 9) // 台座は影の 1/scale
    expect(g.base!.rx * 2).toBeCloseTo(g.shadow!.rx, 9)
  })

  it.each([[4], [8]])('極小 size=%s: 領域が 0 に丸まっても幅・高さが負にならない', (size) => {
    for (const hasBase of [true, false]) {
      const g = computeAcrylicGeometry(100, 100, size, resolveAcrylicParams({ hasBase }))
      expect(g.sprite.width).toBeGreaterThanOrEqual(0)
      expect(g.sprite.height).toBeGreaterThanOrEqual(0)
      expect(Number.isFinite(g.sprite.x)).toBe(true)
      expect(Number.isFinite(g.sprite.y)).toBe(true)
    }
  })

  it('size=4 は余白+線(3.5)が両側で枠を超えるので幅 0（領域が潰れる）', () => {
    expect(computeAcrylicGeometry(100, 100, 4).sprite.width).toBe(0)
  })
})

describe('computeAcrylicGeometry: スイープ不変条件', () => {
  const EPS = 1e-9
  const sizes = [1, 8, 24, 48, 64, 100, 200, 500]
  const texes: Array<[number, number]> = [
    [1, 1],
    [100, 100],
    [400, 100],
    [100, 400],
    [1, 1000],
    [1000, 1],
    [0, 0],
  ]

  it('全組合せで有限・非負・枠内・接地・縦横比維持が成り立つ', () => {
    let cases = 0
    for (const size of sizes)
      for (const [tw, th] of texes)
        for (const hasBase of [true, false])
          for (const marginRatio of [0, 0.15])
            for (const lineWidthRatio of [0, 0.1]) {
              cases++
              const tag = `size=${size} tex=${tw}x${th} base=${hasBase} m=${marginRatio} l=${lineWidthRatio}`
              const p = resolveAcrylicParams({ hasBase, marginRatio, lineWidthRatio })
              const g = computeAcrylicGeometry(tw, th, size, p)
              const s = g.sprite
              const m = g.marginPx + g.linePx
              const nums = [s.x, s.y, s.width, s.height, g.marginPx, g.linePx]
              for (const e of [g.base, g.highlight, g.shadow])
                if (e) nums.push(e.cx, e.cy, e.rx, e.ry)
              for (const v of nums) expect(Number.isFinite(v), tag).toBe(true)
              expect(s.width, tag).toBeGreaterThanOrEqual(0)
              expect(s.height, tag).toBeGreaterThanOrEqual(0)
              if (s.height > 0) expect(s.y, tag).toBeGreaterThanOrEqual(-EPS)
              expect(s.x, tag).toBeGreaterThanOrEqual(-EPS)

              const hasArea = s.width > 0 && s.height > 0
              if (hasArea) {
                // 余白+線を外へ広げても枠に収まる。下端は台座の中心に足が乗る都合で、台座があるときは対象外
                expect(s.x - m, tag).toBeGreaterThanOrEqual(-EPS)
                expect(s.y - m, tag).toBeGreaterThanOrEqual(-EPS)
                expect(s.x + s.width + m, tag).toBeLessThanOrEqual(size + EPS)
                if (!hasBase) expect(s.y + s.height + m, tag).toBeLessThanOrEqual(size + EPS)
              }
              if (hasArea && tw > 0 && th > 0) {
                expect(s.width / s.height, tag).toBeCloseTo(tw / th, 6)
              }
              if (hasBase) {
                const { base, shadow, highlight } = g
                expect(shadow!.cy + shadow!.ry, tag).toBeCloseTo(size, 9)
                expect(shadow!.cx - shadow!.rx, tag).toBeGreaterThanOrEqual(-EPS)
                expect(shadow!.cx + shadow!.rx, tag).toBeLessThanOrEqual(size + EPS)
                expect(base!.cy - base!.ry, tag).toBeGreaterThanOrEqual(-EPS)
                expect(base!.rx, tag).toBeLessThanOrEqual(shadow!.rx + EPS)
                expect(highlight!.rx, tag).toBeLessThan(base!.rx)
                // 足元は台座の中心（領域が潰れていないとき）
                if (base!.cy - m > 0) expect(s.y + s.height, tag).toBeCloseTo(base!.cy, 9)
              } else {
                expect(g.base, tag).toBeNull()
                expect(g.shadow, tag).toBeNull()
                expect(g.highlight, tag).toBeNull()
              }
            }
    expect(cases).toBe(8 * 7 * 2 * 2 * 2)
  })
})

describe('computeAcrylicGeometry: 余白・線の上限', () => {
  it('仕様値: 大きな枠でも余白は 6px・線は 4px で頭打ち（比率×size が上限を超えても）', () => {
    const g = computeAcrylicGeometry(100, 100, 1000)
    expect(g.marginPx).toBe(6) // 0.03*1000 = 30 → 6
    expect(g.linePx).toBe(4) // 0.02*1000 = 20 → 4
  })

  it('上限の手前は比率のまま（上限 clamp が小さな値を潰さない）', () => {
    const g = computeAcrylicGeometry(100, 100, 100)
    expect(g.marginPx).toBe(3) // 0.03*100
    expect(g.linePx).toBe(2) // 0.02*100
  })

  it('maxMarginPx / maxLinePx を下げて上書きできる', () => {
    const g = computeAcrylicGeometry(
      100,
      100,
      1000,
      resolveAcrylicParams({ maxMarginPx: 3, maxLinePx: 1 })
    )
    expect(g.marginPx).toBe(3)
    expect(g.linePx).toBe(1)
  })

  it('maxMarginPx にハード上限（6）を超える値を渡しても 6', () => {
    const g = computeAcrylicGeometry(100, 100, 1000, {
      ...DEFAULT_ACRYLIC_PARAMS,
      maxMarginPx: 99,
      maxLinePx: 99,
    })
    expect(g.marginPx).toBe(6)
    expect(g.linePx).toBe(4)
  })
})

describe('computeEdgeOffsets', () => {
  const radius = (o: readonly [number, number]): number => Math.hypot(o[0], o[1])
  const approxEq = (a: number, b: number): boolean => Math.abs(a - b) < 1e-6

  it('仕様値: 上限・間隔・タップ予算の定数', () => {
    expect(EDGE_MAX_MARGIN_PX).toBe(6)
    expect(EDGE_MAX_LINE_PX).toBe(4)
    expect(EDGE_INNER_SPACING_PX).toBe(2)
    expect(EDGE_OUTER_SPACING_PX).toBe(3)
    expect(EDGE_MAX_TAPS).toBe(64)
    expect(EDGE_MAX_INNER_TAPS).toBe(40)
    expect(EDGE_MAX_OUTER_TAPS).toBe(24)
  })

  it('余白 0 なら内側は空・線 0 なら外側は空', () => {
    expect(computeEdgeOffsets(0, 3).inner).toEqual([])
    expect(computeEdgeOffsets(3, 0).outer).toEqual([])
    expect(computeEdgeOffsets(0, 0)).toEqual({ inner: [], outer: [] })
  })

  it.each([[NaN], [-1], [Infinity], [-Infinity]])(
    '余白・線に %s を渡すと 0 と同じ（空）',
    (bad) => {
      expect(computeEdgeOffsets(bad, bad)).toEqual({ inner: [], outer: [] })
      expect(computeEdgeOffsets(bad, 3).inner).toEqual([])
      expect(computeEdgeOffsets(3, bad).outer).toEqual([])
    }
  )

  it('外側は半径 余白+線 の円上だけ（内側とは別の半径）', () => {
    const { outer } = computeEdgeOffsets(3, 2)
    expect(outer.length).toBeGreaterThan(0)
    for (const o of outer) expect(approxEq(radius(o), 5)).toBe(true)
  })

  it('内側は最外の円が半径=余白で、全サンプルが余白以内', () => {
    for (const m of [0.5, 1, 2, 3, 4.5, 6]) {
      const { inner } = computeEdgeOffsets(m, 1)
      const rs = inner.map(radius)
      expect(Math.max(...rs)).toBeCloseTo(m, 6)
      for (const r of rs) expect(r).toBeLessThanOrEqual(m + 1e-6)
    }
  })

  it('内側の円の半径間隔が EDGE_INNER_SPACING_PX 以下（細い部分の取りこぼし防止）', () => {
    for (let m = 0.25; m <= 6; m += 0.25) {
      const radii = [
        ...new Set(computeEdgeOffsets(m, 1).inner.map((o) => Math.round(radius(o) * 1e6) / 1e6)),
      ].sort((a, b) => a - b)
      let prev = 0
      for (const r of radii) {
        expect(r - prev, `m=${m}`).toBeLessThanOrEqual(2 + 1e-5)
        prev = r
      }
    }
  })

  it('円周上の隣接サンプル間隔が内側 2px 以下・外側 3px 以下', () => {
    const gap = (pts: readonly (readonly [number, number])[], r: number): number => {
      const angles = pts.map((p) => Math.atan2(p[1], p[0])).sort((a, b) => a - b)
      let max = angles[0] + 2 * Math.PI - angles[angles.length - 1]
      for (let i = 1; i < angles.length; i++) max = Math.max(max, angles[i] - angles[i - 1])
      return max * r
    }
    for (const m of [2, 4, 6]) {
      const { inner, outer } = computeEdgeOffsets(m, 4)
      const rings = new Map<number, [number, number][]>()
      for (const o of inner) {
        const k = Math.round(radius(o) * 1e4)
        rings.set(k, [...(rings.get(k) ?? []), [o[0], o[1]]])
      }
      for (const [k, pts] of rings)
        expect(gap(pts, k / 1e4), `m=${m}`).toBeLessThanOrEqual(2 + 1e-6)
      expect(gap(outer, m + 4), `m=${m}`).toBeLessThanOrEqual(3 + 1e-6)
    }
  })

  it('円ごとに角度の位相がずれる（隣り合う円の同じ方向に並ばない）', () => {
    const { inner } = computeEdgeOffsets(6, 1) // 半径 2,4,6 の 3 円
    const angleSet = new Set(inner.map((o) => Math.round(Math.atan2(o[1], o[0]) * 1e4)))
    expect(angleSet.size).toBe(inner.length) // どの 2 点も同じ角度を共有しない（放射状の星形にならない）
  })

  it('スイープ: 総タップ ≤ 64・内側 ≤ 40・外側 ≤ 24', () => {
    let maxTotal = 0
    for (let m = 0; m <= 8; m += 0.1)
      for (let l = 0; l <= 6; l += 0.1) {
        const { inner, outer } = computeEdgeOffsets(m, l, 1)
        expect(inner.length).toBeLessThanOrEqual(40)
        expect(outer.length).toBeLessThanOrEqual(24)
        expect(inner.length + outer.length).toBeLessThanOrEqual(64)
        maxTotal = Math.max(maxTotal, inner.length + outer.length)
      }
    // 最悪（余白 6・線 4）は 39 + 21 = 60。64 の予算に余裕がある
    expect(maxTotal).toBe(60)
  })

  it('余白・線は上限（6 / 4 論理 px）に切り詰められる', () => {
    const big = computeEdgeOffsets(100, 100)
    const cap = computeEdgeOffsets(6, 4)
    expect(big).toEqual(cap)
    expect(Math.max(...big.outer.map(radius))).toBeCloseTo(10, 6)
  })

  it('変位は実 px = 論理配置 × resolution（個数・配置は resolution に依存しない）', () => {
    const base = computeEdgeOffsets(5, 3, 1)
    for (const res of [1.5, 2, 3]) {
      const hi = computeEdgeOffsets(5, 3, res)
      expect(hi.inner.length).toBe(base.inner.length)
      expect(hi.outer.length).toBe(base.outer.length)
      hi.inner.forEach((o, i) => {
        expect(o[0] / res).toBeCloseTo(base.inner[i][0], 6)
        expect(o[1] / res).toBeCloseTo(base.inner[i][1], 6)
      })
      hi.outer.forEach((o, i) => {
        expect(o[0] / res).toBeCloseTo(base.outer[i][0], 6)
        expect(o[1] / res).toBeCloseTo(base.outer[i][1], 6)
      })
    }
  })

  it.each([[0], [-2], [NaN]])('resolution %s は 1 として扱う', (bad) => {
    expect(computeEdgeOffsets(4, 2, bad)).toEqual(computeEdgeOffsets(4, 2, 1))
  })

  it('仕様値: 余白 2 → 内側 1 円（半径 2・7 方向）、線 1.5 → 外側 半径 3.5・8 方向', () => {
    const { inner, outer } = computeEdgeOffsets(2, 1.5)
    expect(inner.length).toBe(7) // ceil(2π·2/2)=7
    expect(outer.length).toBe(8) // ceil(2π·3.5/3)=8（下限 6 を上回る）
  })

  it('方向数の下限は 6（小さな円でも）', () => {
    expect(computeEdgeOffsets(0.2, 0).inner.length).toBe(6)
  })
})
