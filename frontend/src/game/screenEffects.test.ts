import { describe, it, expect } from 'vitest'
import {
  effectProgress,
  computeShakeOffset,
  computeFlashAlpha,
  computeFadeAlpha,
} from './screenEffects'

describe('effectProgress', () => {
  it('途中は elapsed/duration', () => {
    expect(effectProgress(0, 1000)).toBe(0)
    expect(effectProgress(250, 1000)).toBe(0.25)
    expect(effectProgress(500, 1000)).toBe(0.5)
    expect(effectProgress(1000, 1000)).toBe(1)
  })

  it('duration を超えても 1 にクランプ', () => {
    expect(effectProgress(1500, 1000)).toBe(1)
    expect(effectProgress(Number.MAX_VALUE, 1000)).toBe(1)
  })

  it('負の elapsed は 0 にクランプ', () => {
    expect(effectProgress(-100, 1000)).toBe(0)
  })

  it('duration <= 0 / 非有限は即完了 (1)', () => {
    expect(effectProgress(0, 0)).toBe(1)
    expect(effectProgress(0, -5)).toBe(1)
    expect(effectProgress(0, NaN)).toBe(1)
    expect(effectProgress(0, Infinity)).toBe(1)
  })

  it('elapsed が非有限なら完了 (1) にする', () => {
    expect(effectProgress(NaN, 1000)).toBe(1)
    expect(effectProgress(Infinity, 1000)).toBe(1)
  })
})

describe('computeShakeOffset', () => {
  // 抽出前に NovelRenderer.startShake の tick 内で直書きされていた式。
  // リファレンス等価性: 抽出後の computeShakeOffset と一致することを確認する。
  function referenceShake(elapsed: number, intensityPx: number, durationMs: number) {
    const progress = Math.min(elapsed / durationMs, 1)
    const decay = 1 - progress
    const offsetX = Math.sin(elapsed * 0.05) * intensityPx * decay
    const offsetY = Math.cos(elapsed * 0.037) * intensityPx * decay * 0.6
    return { offsetX, offsetY, done: progress >= 1 }
  }

  it('リファレンス等価性: 抽出前の inline 式と一致 (代表時刻)', () => {
    const intensity = 12
    const duration = 600
    for (const elapsed of [0, 50, 100, 200, 333, 450, 599]) {
      const ref = referenceShake(elapsed, intensity, duration)
      const got = computeShakeOffset(elapsed, intensity, duration)
      expect(got.offsetX).toBeCloseTo(ref.offsetX, 12)
      expect(got.offsetY).toBeCloseTo(ref.offsetY, 12)
      expect(got.done).toBe(ref.done)
    }
  })

  it('progress=0 で振幅最大、Y は X の係数違い（cos 起点なので Y は最大、X は 0）', () => {
    // elapsed=0: sin(0)=0 → offsetX=0、cos(0)=1 → offsetY = intensity*1*0.6
    const r = computeShakeOffset(0, 10, 500)
    expect(r.offsetX).toBeCloseTo(0, 12)
    expect(r.offsetY).toBeCloseTo(10 * 0.6, 12)
    expect(r.done).toBe(false)
  })

  it('duration 到達で done=true・減衰により振幅 0', () => {
    const r = computeShakeOffset(500, 10, 500)
    expect(r.done).toBe(true)
    // decay = 1 - 1 = 0 なので両軸とも 0
    expect(r.offsetX).toBeCloseTo(0, 12)
    expect(r.offsetY).toBeCloseTo(0, 12)
  })

  it('duration 超過でも done=true・振幅 0', () => {
    const r = computeShakeOffset(9999, 10, 500)
    expect(r.done).toBe(true)
    // 0 / -0 はどちらも振幅ゼロ（PixiJS の position 設定では同一）なので絶対値で比較
    expect(Math.abs(r.offsetX)).toBe(0)
    expect(Math.abs(r.offsetY)).toBe(0)
  })

  it('intensity が非有限なら揺れなし', () => {
    const r = computeShakeOffset(100, NaN, 500)
    expect(Math.abs(r.offsetX)).toBe(0)
    expect(Math.abs(r.offsetY)).toBe(0)
  })

  it('減衰: 同じ位相でも progress が進むほど振幅が小さい', () => {
    // 位相が同じになる時刻を選ぶ代わりに、振幅の上限 |offset| <= intensity*decay を確認
    const intensity = 20
    const duration = 1000
    const early = computeShakeOffset(100, intensity, duration)
    const late = computeShakeOffset(900, intensity, duration)
    const earlyDecay = 1 - 0.1
    const lateDecay = 1 - 0.9
    expect(Math.abs(early.offsetX)).toBeLessThanOrEqual(intensity * earlyDecay + 1e-9)
    expect(Math.abs(late.offsetX)).toBeLessThanOrEqual(intensity * lateDecay + 1e-9)
  })
})

describe('computeFlashAlpha', () => {
  // 抽出前 NovelRenderer.startFlash の inline 式
  function referenceFlash(elapsed: number, peakAlpha: number, durationMs: number) {
    const progress = Math.min(elapsed / durationMs, 1)
    return { alpha: peakAlpha * (1 - progress), done: progress >= 1 }
  }

  it('リファレンス等価性: 抽出前の inline 式と一致', () => {
    const peak = 0.8
    const duration = 400
    for (const elapsed of [0, 50, 100, 200, 399, 400]) {
      const ref = referenceFlash(elapsed, peak, duration)
      const got = computeFlashAlpha(elapsed, peak, duration)
      expect(got.alpha).toBeCloseTo(ref.alpha, 12)
      expect(got.done).toBe(ref.done)
    }
  })

  it('開始時は peak、完了時は 0', () => {
    expect(computeFlashAlpha(0, 0.8, 400).alpha).toBeCloseTo(0.8, 12)
    const end = computeFlashAlpha(400, 0.8, 400)
    expect(end.alpha).toBeCloseTo(0, 12)
    expect(end.done).toBe(true)
  })

  it('中点は peak の半分', () => {
    expect(computeFlashAlpha(200, 0.8, 400).alpha).toBeCloseTo(0.4, 12)
  })

  it('peak が非有限なら alpha=0', () => {
    expect(computeFlashAlpha(0, NaN, 400).alpha).toBe(0)
  })
})

describe('computeFadeAlpha', () => {
  // 抽出前 NovelRenderer.startFade の inline 式（progress>=1 で toAlpha を当て直す挙動込み）
  function referenceFade(elapsed: number, fromAlpha: number, toAlpha: number, durationMs: number) {
    const progress = Math.min(elapsed / durationMs, 1)
    let alpha = fromAlpha + (toAlpha - fromAlpha) * progress
    if (progress >= 1) alpha = toAlpha
    return { alpha, done: progress >= 1 }
  }

  it('リファレンス等価性: 抽出前の inline 式と一致（fade-in / fade-out 両方）', () => {
    const duration = 500
    for (const [from, to] of [
      [0, 1],
      [1, 0],
      [0.2, 0.9],
    ]) {
      for (const elapsed of [0, 100, 250, 400, 500, 600]) {
        const ref = referenceFade(elapsed, from, to, duration)
        const got = computeFadeAlpha(elapsed, from, to, duration)
        expect(got.alpha).toBeCloseTo(ref.alpha, 12)
        expect(got.done).toBe(ref.done)
      }
    }
  })

  it('開始は from、完了は to ちょうど', () => {
    expect(computeFadeAlpha(0, 0.2, 0.9, 500).alpha).toBeCloseTo(0.2, 12)
    const end = computeFadeAlpha(500, 0.2, 0.9, 500)
    expect(end.alpha).toBe(0.9)
    expect(end.done).toBe(true)
  })

  it('fade-out: from=1 to=0 の中点は 0.5', () => {
    expect(computeFadeAlpha(250, 1, 0, 500).alpha).toBeCloseTo(0.5, 12)
  })

  it('完了時は補間誤差を残さず to を返す', () => {
    // duration 超過でも done かつ alpha=to
    const r = computeFadeAlpha(9999, 0.3, 0.7, 500)
    expect(r.alpha).toBe(0.7)
    expect(r.done).toBe(true)
  })

  it('from / to が非有限なら 0 扱い', () => {
    expect(computeFadeAlpha(100, NaN, 0.5, 500).alpha).toBeGreaterThanOrEqual(0)
    expect(computeFadeAlpha(500, 0.5, NaN, 500).alpha).toBe(0)
  })
})
