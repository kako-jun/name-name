import { describe, it, expect } from 'vitest'
import {
  EXPLODE_PRESET,
  TYPEWRITER_PRESET,
  RESTING_GLYPH_TRANSFORM,
  resolveTransformEffect,
  glyphLinearProgress,
  computeGlyphTransform,
  textEffectTotalDurationMs,
  resolveTypewriterMsPerChar,
  isRevealEffect,
} from './textEffect'
import { easeOutBack } from './easing'

describe('textEffect: プリセット解決', () => {
  it('効果=爆発 はプリセット既定値を引く（個別指定なし）', () => {
    const r = resolveTransformEffect({ effect: 'Explode' })
    expect(r.offsetY).toBe(40) // EXPLODE_PRESET.dy '+40'
    expect(r.startScale).toBe(EXPLODE_PRESET.scale)
    expect(r.startAlpha).toBe(EXPLODE_PRESET.alpha)
    expect(r.staggerMs).toBe(EXPLODE_PRESET.stagger_ms)
    expect(r.durationMs).toBe(EXPLODE_PRESET.duration_ms)
    expect(r.easing).toBe(EXPLODE_PRESET.easing)
  })

  it('個別指定はプリセット既定値より優先する', () => {
    const r = resolveTransformEffect({ effect: 'Explode', stagger_ms: 50, dy: '+60' })
    expect(r.staggerMs).toBe(50)
    expect(r.offsetY).toBe(60)
    // 未指定の scale はプリセット値のまま
    expect(r.startScale).toBe(EXPLODE_PRESET.scale)
  })

  it('プリセットなしの素プリミティブはグローバル既定にフォールバック', () => {
    const r = resolveTransformEffect({ dy: '+60', scale: 0.5, easing: 'EaseOutBack' })
    expect(r.offsetY).toBe(60)
    expect(r.startScale).toBe(0.5)
    expect(r.startAlpha).toBe(1) // alpha 未指定 → 整列値 1
    expect(r.staggerMs).toBe(0)
    expect(r.easing).toBe('EaseOutBack')
  })

  it('rotation は degrees → rad 変換される', () => {
    const r = resolveTransformEffect({ rotation: '180' })
    expect(r.offsetRotationRad).toBeCloseTo(Math.PI, 6)
  })
})

describe('textEffect: glyphLinearProgress', () => {
  it('開始遅延前は 0、duration 経過後は 1', () => {
    // glyph index 2, stagger 80 → 開始は 160ms
    expect(glyphLinearProgress(100, 2, 80, 500)).toBe(0)
    expect(glyphLinearProgress(160, 2, 80, 500)).toBe(0)
    expect(glyphLinearProgress(160 + 250, 2, 80, 500)).toBeCloseTo(0.5, 6)
    expect(glyphLinearProgress(160 + 500, 2, 80, 500)).toBe(1)
    expect(glyphLinearProgress(99999, 2, 80, 500)).toBe(1)
  })

  it('duration<=0 は即完了、負 elapsed は 0 クランプ', () => {
    expect(glyphLinearProgress(10, 0, 0, 0)).toBe(1)
    expect(glyphLinearProgress(-100, 0, 0, 500)).toBe(0)
  })
})

describe('textEffect: computeGlyphTransform', () => {
  it('p=0 は開始オフセット、p=1 は整列状態', () => {
    const r = resolveTransformEffect({ effect: 'Explode' })
    // glyph 0, elapsed 0 → 開始オフセット
    const start = computeGlyphTransform(r, 0, 0)
    // easeOutBack(0) = 0 なので開始値そのまま
    expect(start.offsetY).toBeCloseTo(40, 6)
    expect(start.scale).toBeCloseTo(EXPLODE_PRESET.scale, 6)
    expect(start.alpha).toBeCloseTo(EXPLODE_PRESET.alpha, 6)

    // 完了後 → 整列状態
    const end = computeGlyphTransform(r, 999999, 0)
    expect(end.offsetY).toBe(RESTING_GLYPH_TRANSFORM.offsetY)
    expect(end.scale).toBe(RESTING_GLYPH_TRANSFORM.scale)
    expect(end.alpha).toBe(RESTING_GLYPH_TRANSFORM.alpha)
  })

  it('EaseOutBack のオーバーシュートで offsetY が一度符号反転（行き過ぎ）する', () => {
    const r = resolveTransformEffect({ effect: 'Explode', stagger_ms: 0 })
    // easeOutBack が 1.0 を超える区間 → (1-eased) が負 → offsetY が +40 の逆へ行き過ぎる
    let sawOvershoot = false
    for (let t = 0; t <= r.durationMs; t += 10) {
      const gt = computeGlyphTransform(r, t, 0)
      if (gt.offsetY < 0) sawOvershoot = true
    }
    expect(sawOvershoot).toBe(true)
    // 参考: easeOutBack は途中で 1 を超える
    expect(Math.max(...[0.6, 0.7, 0.8].map(easeOutBack))).toBeGreaterThan(1)
  })
})

describe('textEffect: total duration', () => {
  it('最後のグリフが整列し終わる時刻', () => {
    const r = resolveTransformEffect({ effect: 'Explode' }) // stagger 80, duration 500
    expect(textEffectTotalDurationMs(r, 1)).toBe(500)
    expect(textEffectTotalDurationMs(r, 5)).toBe(4 * 80 + 500)
    expect(textEffectTotalDurationMs(r, 0)).toBe(0)
  })
})

describe('textEffect: typewriter / reveal 分岐', () => {
  it('speed 未指定はプリセット既定 70、指定はそれを使う', () => {
    expect(resolveTypewriterMsPerChar({ effect: 'Typewriter' })).toBe(TYPEWRITER_PRESET.ms_per_char)
    expect(resolveTypewriterMsPerChar({ effect: 'Typewriter', ms_per_char: 30 })).toBe(30)
  })

  it('isRevealEffect は Typewriter だけ true', () => {
    expect(isRevealEffect({ effect: 'Typewriter' })).toBe(true)
    expect(isRevealEffect({ effect: 'Explode' })).toBe(false)
    expect(isRevealEffect({})).toBe(false)
  })
})
