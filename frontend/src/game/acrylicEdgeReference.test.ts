/**
 * 枠線フィルタ (#737) の JS 参照実装によるシミュレーションテスト。
 *
 * jsdom に WebGL が無く GLSL 本体は実行できないため、シェーダと同じ式
 * （`ring = clamp(outerMax − innerMax, 0, 1)`、本体の alpha は両方の max に含める、
 * `lineA = alpha * ring * (1 − src.a)`）を JS に移植し、`computeEdgeOffsets` が返す変位列を
 * 最近傍サンプリングで当てて、形状ごとに「余白の内側に線が漏れない」ことを検証する。
 * 変位列の配置（間隔・範囲）が崩れる変異はここで落ちる。
 */
import { describe, expect, it } from 'vitest'
import { computeEdgeOffsets } from './spriteStyle'

const N = 96

type Mask = Uint8Array // N*N, 1 = 本体

function blank(): Mask {
  return new Uint8Array(N * N)
}
function disc(m: Mask, cx: number, cy: number, r: number): void {
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) m[y * N + x] = 1
}
function rect(m: Mask, x0: number, y0: number, x1: number, y1: number): void {
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) m[y * N + x] = 1
}
/** 2px 幅の棒（ひげ）＋円盤 */
function barAndDisc(): Mask {
  const m = blank()
  disc(m, 30, 48, 14)
  rect(m, 44, 47, 80, 48) // 高さ 2px の水平な棒
  return m
}
/** 円盤 */
function plainDisc(): Mask {
  const m = blank()
  disc(m, 48, 48, 20)
  return m
}
/** 細い角（2px 幅の L 字の折れ曲がり）と先端 */
function thinCorner(): Mask {
  const m = blank()
  rect(m, 20, 20, 21, 70) // 縦棒（2px 幅）
  rect(m, 20, 69, 70, 70) // 横棒（2px 幅）。角は (20..21, 69..70)
  rect(m, 60, 40, 61, 69) // 先端が細く立つ棒
  return m
}

/** 本体までの最短距離（ピクセル中心間のユークリッド距離） */
function distanceField(m: Mask): Float32Array {
  const pts: number[] = []
  for (let i = 0; i < N * N; i++) if (m[i]) pts.push(i % N, Math.floor(i / N))
  const d = new Float32Array(N * N)
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      let best = Infinity
      for (let k = 0; k < pts.length; k += 2) {
        const dd = (pts[k] - x) ** 2 + (pts[k + 1] - y) ** 2
        if (dd < best) best = dd
      }
      d[y * N + x] = Math.sqrt(best)
    }
  return d
}

/** シェーダの main() の JS 版。本体 alpha(0/1) から各ピクセルの lineA（alpha=1 のとき ring*(1−src.a)）を返す */
export function simulate(m: Mask, margin: number, line: number): Float32Array {
  const { inner, outer } = computeEdgeOffsets(margin, line, 1)
  const at = (x: number, y: number): number => {
    const cx = Math.min(N - 1, Math.max(0, Math.round(x)))
    const cy = Math.min(N - 1, Math.max(0, Math.round(y)))
    return m[cy * N + cx]
  }
  const out = new Float32Array(N * N)
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const src = m[y * N + x]
      let innerMax = src
      let outerMax = src
      for (const [ox, oy] of inner) innerMax = Math.max(innerMax, at(x + ox, y + oy))
      for (const [ox, oy] of outer) outerMax = Math.max(outerMax, at(x + ox, y + oy))
      outerMax = Math.max(outerMax, innerMax)
      const ring = Math.min(1, Math.max(0, outerMax - innerMax))
      out[y * N + x] = ring * (1 - src)
    }
  return out
}

const SHAPES: [string, () => Mask][] = [
  ['円盤', plainDisc],
  ['2px 幅の棒＋円盤', barAndDisc],
  ['細い角', thinCorner],
]
const WIDTHS: [number, number][] = [
  [2, 1.5],
  [4, 3],
  [6, 4],
]
// 最近傍サンプリング（変位を整数ピクセルへ丸める）の誤差 √2/2 と、距離の離散化の分
const TOL = 1

describe('枠線フィルタの参照実装（形状 × 余白/線）', () => {
  for (const [name, make] of SHAPES) {
    for (const [margin, line] of WIDTHS) {
      it(`${name} margin=${margin} line=${line}: 余白の内側に線が漏れない・線は余白〜余白+線の範囲・本体を上書きしない`, () => {
        const m = make()
        const df = distanceField(m)
        const a = simulate(m, margin, line)
        let leak = 0
        let beyond = 0
        let onBody = 0
        let drawn = 0
        for (let i = 0; i < N * N; i++) {
          if (a[i] <= 0) continue
          drawn++
          if (m[i]) onBody++
          if (df[i] < margin - TOL) leak++
          if (df[i] > margin + line + TOL) beyond++
        }
        expect(drawn, '線が 1 ピクセルも描かれていない').toBeGreaterThan(0)
        expect(leak, '余白の内側の線').toBe(0)
        expect(beyond, '範囲外の線').toBe(0)
        expect(onBody, '本体の上書き').toBe(0)
      })
    }
  }

  it('円盤では線が輪郭をほぼ一周して描かれる（星形に欠けない）', () => {
    const m = plainDisc()
    const df = distanceField(m)
    const a = simulate(m, 6, 4)
    let expected = 0
    let covered = 0
    for (let i = 0; i < N * N; i++) {
      if (df[i] >= 6 + 1.5 && df[i] <= 6 + 4 - 1.5) {
        expected++
        if (a[i] > 0) covered++
      }
    }
    expect(expected).toBeGreaterThan(100)
    expect(covered / expected).toBeGreaterThan(0.95)
  })
})
