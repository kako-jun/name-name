/**
 * 回転舞台 `[舞台回転]` (#704 第2弾) の純粋関数。
 * 回転軸は画面中央の鉛直線で、全板が同じ角度・同じ消失点・同じカメラ距離で回る。
 */
import { describe, expect, it } from 'vitest'
import {
  STAGE_TURN_MAX_MS,
  computeStageTurnAngles,
  computeStageTurnCorners,
  computeStageTurnView,
  resolveStageTurnDuration,
} from './stageTurn'
import { BOARD_FLIP_MAX_ANGLE_RAD } from './boardFlip'

const W = 1280
const H = 720
const view = computeStageTurnView(W, H)
const full = { x: W / 2, y: H / 2, width: W, height: H }

describe('computeStageTurnView', () => {
  it('軸は画面中央の鉛直線、消失点は縦の中央、距離は全板共通で画面幅の 2 倍以上', () => {
    expect(view.axisX).toBe(W / 2)
    expect(view.vanishY).toBe(H / 2)
    expect(view.distance).toBeGreaterThanOrEqual(W * 2)
    const tall = computeStageTurnView(400, 1200)
    expect(tall.distance).toBeGreaterThanOrEqual(1200 * 2.5)
  })
})

describe('computeStageTurnCorners', () => {
  it('角度 0 では板の元の矩形そのまま（左上・右上・右下・左下）', () => {
    const c = computeStageTurnCorners({ x: 300, y: 500, width: 200, height: 100 }, 0, view)
    expect(c.x0).toBeCloseTo(200)
    expect(c.y0).toBeCloseTo(450)
    expect(c.x1).toBeCloseTo(400)
    expect(c.y1).toBeCloseTo(450)
    expect(c.x2).toBeCloseTo(400)
    expect(c.y2).toBeCloseTo(550)
    expect(c.x3).toBeCloseTo(200)
    expect(c.y3).toBeCloseTo(550)
  })

  it('軸は個々の板の中心ではなく画面中央: 軸から離れた板の中心は回転で軸のほうへ寄る', () => {
    const left = { x: 200, y: H / 2, width: 100, height: 100 }
    const angle = 0.8
    const c = computeStageTurnCorners(left, angle, view)
    const centerX = (c.x0 + c.x1 + c.x2 + c.x3) / 4
    // 板自身の中心軸まわりなら中心は動かない（x=200）。画面中央軸まわりなら中心は動く。
    expect(Math.abs(centerX - 200)).toBeGreaterThan(30)
    // 軸の x に置いた板は、軸が板の中心を通るので左右の辺が軸をはさんだまま。
    const mid = computeStageTurnCorners(
      { x: W / 2, y: H / 2, width: 100, height: 100 },
      angle,
      view
    )
    expect(mid.x0).toBeLessThan(W / 2)
    expect(mid.x1).toBeGreaterThan(W / 2)
  })

  it('同じ角度なら、軸の左右にある板は軸について鏡像（x は軸対称）になり、縮み方（奥行き）は左右で逆', () => {
    const a = computeStageTurnCorners(
      { x: W / 2 - 300, y: H / 2, width: 100, height: 100 },
      0.6,
      view
    )
    const b = computeStageTurnCorners(
      { x: W / 2 + 300, y: H / 2, width: 100, height: 100 },
      0.6,
      view
    )
    // 正の角度では +x 側が奥へ行く: 右の板のほうが小さい（縦の幅が小さい）。
    const edgeA = (a.y3 - a.y0 + (a.y2 - a.y1)) / 2
    const edgeB = (b.y3 - b.y0 + (b.y2 - b.y1)) / 2
    expect(edgeB).toBeLessThan(edgeA)
    // 負の角度ではその逆（鏡像）。
    const a2 = computeStageTurnCorners(
      { x: W / 2 - 300, y: H / 2, width: 100, height: 100 },
      -0.6,
      view
    )
    expect((a2.y3 - a2.y0 + (a2.y2 - a2.y1)) / 2).toBeCloseTo(edgeB, 5)
  })

  it('剛体として回る: 同じ角度で、板の上下位置の違いは共通の消失点まわりに保たれる', () => {
    const top = { x: W / 2, y: H * 0.25, width: 200, height: 100 }
    const bottom = { x: W / 2, y: H * 0.75, width: 200, height: 100 }
    const t = computeStageTurnCorners(top, 1.0, view)
    const b = computeStageTurnCorners(bottom, 1.0, view)
    // 中心 y は消失点（H/2）をはさんで対称に離れる。
    const ty = (t.y0 + t.y3) / 2
    const by = (b.y0 + b.y3) / 2
    expect(ty).toBeLessThan(H / 2)
    expect(by).toBeGreaterThan(H / 2)
    expect(H / 2 - ty).toBeCloseTo(by - H / 2, 5)
  })

  it('複数の板の四隅が全て有限（0 / 0.5 / 1 の進行度、大きい板・軸から遠い板を含む）', () => {
    const faces = [
      full,
      { x: 100, y: 600, width: 300, height: 200 },
      { x: W - 50, y: 100, width: 400, height: 300 },
    ]
    for (const angle of [-BOARD_FLIP_MAX_ANGLE_RAD, -0.7, 0, 0.7, BOARD_FLIP_MAX_ANGLE_RAD, 99]) {
      for (const f of faces) {
        const c = computeStageTurnCorners(f, angle, view)
        for (const v of Object.values(c)) expect(Number.isFinite(v)).toBe(true)
      }
    }
    // 非有限の角度は 0 扱い。
    const c = computeStageTurnCorners(full, Number.NaN, view)
    expect(c.x0).toBeCloseTo(0)
  })

  it('最大角でも板が裏返らない（左右の順序が保たれる）', () => {
    const c = computeStageTurnCorners(full, BOARD_FLIP_MAX_ANGLE_RAD, view)
    expect(c.x1).toBeGreaterThanOrEqual(c.x0)
    expect(c.x2).toBeGreaterThanOrEqual(c.x3)
  })
})

describe('computeStageTurnAngles', () => {
  const total = 1000
  it('進行度 0: 旧面は角度 0 で可視、新面は不可視', () => {
    const a = computeStageTurnAngles(0, total)
    expect(a.old).toEqual({ visible: true, angleRad: 0 })
    expect(a.next.visible).toBe(false)
  })
  it('進行度 0.5: 旧面は消え、新面が -90° 側から現れる（どちらも不可視の空白フレームが無い）', () => {
    const a = computeStageTurnAngles(500, total)
    expect(a.old.visible).toBe(false)
    expect(a.next.visible).toBe(true)
    expect(a.next.angleRad).toBeCloseTo(-BOARD_FLIP_MAX_ANGLE_RAD)
  })
  it('進行度 1: 新面は角度 0 で可視、旧面は不可視', () => {
    const a = computeStageTurnAngles(1000, total)
    expect(a.old.visible).toBe(false)
    expect(a.next.visible).toBe(true)
    expect(a.next.angleRad).toBeCloseTo(0)
  })
  it('旧面は 0→+90°、新面は -90°→0 に向かって単調', () => {
    const olds = [0, 100, 200, 300, 400].map((t) => computeStageTurnAngles(t, total).old.angleRad)
    for (let i = 1; i < olds.length; i++) expect(olds[i]).toBeGreaterThan(olds[i - 1])
    const news = [500, 600, 700, 800, 1000].map(
      (t) => computeStageTurnAngles(t, total).next.angleRad
    )
    for (let i = 1; i < news.length; i++) expect(news[i]).toBeGreaterThan(news[i - 1])
  })
})

describe('resolveStageTurnDuration', () => {
  it('省略・null・非有限は既定（character_fade_ms）、既定自体も 0〜5000 に収まる', () => {
    expect(resolveStageTurnDuration(undefined, 700)).toBe(700)
    expect(resolveStageTurnDuration(null, 1200)).toBe(1200)
    expect(resolveStageTurnDuration(Number.NaN, 700)).toBe(700)
    expect(resolveStageTurnDuration(undefined, 99999)).toBe(STAGE_TURN_MAX_MS)
  })
  it('指定は 0〜5000 にクランプする（0 は 0 のまま = 即時の合図）', () => {
    expect(resolveStageTurnDuration(0, 700)).toBe(0)
    expect(resolveStageTurnDuration(900, 700)).toBe(900)
    expect(resolveStageTurnDuration(5000, 700)).toBe(5000)
    expect(resolveStageTurnDuration(5001, 700)).toBe(5000)
    expect(resolveStageTurnDuration(-5, 700)).toBe(0)
  })
})
