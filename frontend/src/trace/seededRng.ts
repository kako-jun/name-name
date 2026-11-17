/**
 * 種付きの乱数 (#1197)。トレースが on の戦闘では、種を記録して同じ乱数列を再現できるよう、Math.random の代わりに使う。
 * mulberry32（32 ビット状態の軽量な乱数。0 以上 1 未満の一様乱数を返す）。
 */
export function seededRng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
