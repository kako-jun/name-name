import { describe, it, expect } from 'vitest'
import {
  EXPLODE_PRESET,
  TYPEWRITER_PRESET,
  TEXT_EFFECT_DEFAULTS,
  RESTING_GLYPH_TRANSFORM,
  resolveTransformEffect,
  glyphLinearProgress,
  computeGlyphTransform,
  textEffectTotalDurationMs,
  resolveTypewriterMsPerChar,
  isRevealEffect,
  layoutGlyphCenters,
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

  it('ms_per_char=0 は 0 として透過する（reveal 即時完了は typewriter.ts の責務）', () => {
    // resolver は値を素通しするだけ。msPerChar<=0 の即時完了挙動は tickTypewriter 側で守られる。
    expect(resolveTypewriterMsPerChar({ effect: 'Typewriter', ms_per_char: 0 })).toBe(0)
  })
})

// ===== フェーズ1ギャップ: resolveTransformEffect の値解決デシジョンテーブル =====
// 優先順: 個別override > プリセット既定 > グローバル既定。
// 既存テストは stagger/dy/scale の一部しか踏んでいないため、各パラメータについて
// (プリセット有無 × override 有無) を網羅する。期待値は定数を import して直書きを避ける。
describe('textEffect: resolveTransformEffect 値解決の優先順位（デシジョンテーブル）', () => {
  it('プリセットなし・override なしは各プリミティブがグローバル既定に倒れる', () => {
    const r = resolveTransformEffect({})
    // dx/dy/rotation 未指定 → resolveDelta(undefined, 0) = 0
    expect(r.offsetX).toBe(0)
    expect(r.offsetY).toBe(0)
    expect(r.offsetRotationRad).toBe(0)
    // scale/alpha 未指定 → 整列値 1
    expect(r.startScale).toBe(1)
    expect(r.startAlpha).toBe(1)
    expect(r.staggerMs).toBe(TEXT_EFFECT_DEFAULTS.stagger_ms)
    expect(r.durationMs).toBe(TEXT_EFFECT_DEFAULTS.duration_ms)
    expect(r.easing).toBe(TEXT_EFFECT_DEFAULTS.easing)
  })

  it('爆発プリセットの全プリミティブがプリセット定数に一致する（override なし）', () => {
    const r = resolveTransformEffect({ effect: 'Explode' })
    expect(r.offsetY).toBe(40) // EXPLODE_PRESET.dy '+40' を resolveDelta(_, 0) した値
    expect(r.startScale).toBe(EXPLODE_PRESET.scale)
    expect(r.startAlpha).toBe(EXPLODE_PRESET.alpha)
    expect(r.staggerMs).toBe(EXPLODE_PRESET.stagger_ms)
    expect(r.durationMs).toBe(EXPLODE_PRESET.duration_ms)
    expect(r.easing).toBe(EXPLODE_PRESET.easing)
    // 爆発はオフセット X / 回転を持たない（プリセットに定義なし → 既定 0）
    expect(r.offsetX).toBe(0)
    expect(r.offsetRotationRad).toBe(0)
  })

  it('override は爆発プリセットの全プリミティブを個別に上書きできる', () => {
    const r = resolveTransformEffect({
      effect: 'Explode',
      dx: '+10',
      dy: '+99',
      rotation: '90',
      scale: 0.7,
      alpha: 0.2,
      stagger_ms: 33,
      duration_ms: 222,
      easing: 'EaseInOut',
    })
    expect(r.offsetX).toBe(10)
    expect(r.offsetY).toBe(99) // プリセットの +40 を上書き
    expect(r.offsetRotationRad).toBeCloseTo((90 * Math.PI) / 180, 6)
    expect(r.startScale).toBe(0.7) // プリセットの 0.3 を上書き
    expect(r.startAlpha).toBe(0.2) // プリセットの 0 を上書き
    expect(r.staggerMs).toBe(33) // プリセットの 80 を上書き
    expect(r.durationMs).toBe(222) // プリセットの 500 を上書き
    expect(r.easing).toBe('EaseInOut') // プリセットの EaseOutBack を上書き
  })

  it('dx 絶対値 "40" は offsetX=40、相対 "-20" は -20 に解決する', () => {
    // 整列位置を 0 とするので、absolute も relative も current=0 起点で同値挙動になる。
    expect(resolveTransformEffect({ dx: '40' }).offsetX).toBe(40)
    expect(resolveTransformEffect({ dx: '-20' }).offsetX).toBe(-20)
  })

  it('rotation の deg→rad 変換は負値・90度でも成立する', () => {
    expect(resolveTransformEffect({ rotation: '-90' }).offsetRotationRad).toBeCloseTo(
      (-90 * Math.PI) / 180,
      6
    )
    expect(resolveTransformEffect({ rotation: '360' }).offsetRotationRad).toBeCloseTo(
      2 * Math.PI,
      6
    )
  })
})

describe('textEffect: resolveTransformEffect の境界クランプ', () => {
  it('負の duration / stagger は 0 にクランプされる', () => {
    const r = resolveTransformEffect({ duration_ms: -100, stagger_ms: -5 })
    expect(r.durationMs).toBe(0)
    expect(r.staggerMs).toBe(0)
  })

  it('duration=0 / stagger=0 はそのまま 0 を通す（境界そのもの）', () => {
    const r = resolveTransformEffect({ duration_ms: 0, stagger_ms: 0 })
    expect(r.durationMs).toBe(0)
    expect(r.staggerMs).toBe(0)
  })
})

// ===== フェーズ1ギャップ: glyphLinearProgress のグリフ開始時刻 境界±1 =====
describe('textEffect: glyphLinearProgress のグリフ開始時刻 境界値（境界-1/境界/境界+1）', () => {
  it('glyph i の開始は i*stagger。開始直前 0 / 開始ちょうど 0 / 開始直後は >0', () => {
    // glyph 3, stagger 80 → 開始 240ms。境界の 3 点を直接踏む。
    const start = 3 * 80
    expect(glyphLinearProgress(start - 1, 3, 80, 500)).toBe(0) // 境界-1
    expect(glyphLinearProgress(start, 3, 80, 500)).toBe(0) // 境界（local=0 → 0）
    expect(glyphLinearProgress(start + 1, 3, 80, 500)).toBeGreaterThan(0) // 境界+1
  })

  it('duration 完了の境界（end-1 < 1 / end ちょうど 1 / end+1 も 1）', () => {
    // glyph 0, stagger 任意, duration 500 → end=500ms。
    expect(glyphLinearProgress(499, 0, 80, 500)).toBeLessThan(1) // 境界-1
    expect(glyphLinearProgress(500, 0, 80, 500)).toBe(1) // 境界ちょうど
    expect(glyphLinearProgress(501, 0, 80, 500)).toBe(1) // 境界+1（飽和）
  })

  it('stagger=0 なら全グリフが同一進行（同時開始）', () => {
    const p0 = glyphLinearProgress(250, 0, 0, 500)
    const p5 = glyphLinearProgress(250, 5, 0, 500)
    const p99 = glyphLinearProgress(250, 99, 0, 500)
    expect(p0).toBeCloseTo(0.5, 6)
    expect(p5).toBe(p0)
    expect(p99).toBe(p0)
  })
})

// ===== フェーズ1ギャップ: textEffectTotalDurationMs の stagger=0 と glyphCount =====
describe('textEffect: textEffectTotalDurationMs の追加境界', () => {
  it('stagger=0 のとき総時間は glyphCount に依らず durationMs に一致する', () => {
    const r = resolveTransformEffect({ duration_ms: 400, stagger_ms: 0 })
    expect(textEffectTotalDurationMs(r, 1)).toBe(400)
    expect(textEffectTotalDurationMs(r, 10)).toBe(400)
  })

  it('負の glyphCount も 0（防御。マイナスでアンダーフローしない）', () => {
    const r = resolveTransformEffect({ effect: 'Explode' })
    expect(textEffectTotalDurationMs(r, -3)).toBe(0)
  })
})

// ===== フェーズ1ギャップ: computeGlyphTransform の glyph index ごとの開始ずれ =====
describe('textEffect: computeGlyphTransform の stagger 反映', () => {
  it('同一 elapsed でも後続グリフほど進行が遅れる（開始オフセットに近い）', () => {
    const r = resolveTransformEffect({ effect: 'Explode', easing: 'Linear' })
    // elapsed=stagger*1+α だと glyph0 は進み、glyph2 はまだ開始前で開始オフセットのまま。
    const elapsed = r.staggerMs + 100
    const g0 = computeGlyphTransform(r, elapsed, 0)
    const g2 = computeGlyphTransform(r, elapsed, 2)
    // glyph2 は開始遅延 (2*stagger=160) > elapsed(180? )... stagger=80 なので 2*80=160 < 180 → 少し進む
    // よって g0 の方が g2 より整列に近い（offsetY が 0 寄り = 小さい絶対値）。
    expect(Math.abs(g0.offsetY)).toBeLessThan(Math.abs(g2.offsetY))
  })

  it('開始前グリフ（i*stagger > elapsed）は厳密に開始オフセットを返す', () => {
    const r = resolveTransformEffect({ effect: 'Explode' }) // stagger 80
    // glyph 5 の開始は 400ms。elapsed=10 では未開始なので開始値そのまま。
    const g = computeGlyphTransform(r, 10, 5)
    expect(g.offsetY).toBeCloseTo(40, 6)
    expect(g.scale).toBeCloseTo(EXPLODE_PRESET.scale, 6)
    expect(g.alpha).toBeCloseTo(EXPLODE_PRESET.alpha, 6)
  })
})

// ===== should2: layoutGlyphCenters（中央寄せレイアウトの純関数化）=====
// 期待値は定数直書きせず、関数の不変条件（合計幅・中心間隔・対称性）で検証する。
describe('textEffect: layoutGlyphCenters の境界・不変条件', () => {
  // 中心配列に対し「各グリフを半幅ぶん広げた区間」の左端・右端を返すユーティリティ。
  function spanEnds(widths: number[], centers: number[]): { left: number; right: number } {
    const left = centers[0] - widths[0] / 2
    const right = centers[centers.length - 1] + widths[widths.length - 1] / 2
    return { left, right }
  }

  it('空配列は []（グリフ 0 個）', () => {
    expect(layoutGlyphCenters([])).toEqual([])
  })

  it('1 グリフは原点中央（中心 0）。幅に依らず単独なら中央に来る', () => {
    expect(layoutGlyphCenters([10])).toEqual([0])
    expect(layoutGlyphCenters([0])).toEqual([0])
    expect(layoutGlyphCenters([123.4])).toEqual([0])
  })

  it('複数グリフ: 行全体が原点中央（左端=-totalWidth/2, 右端=+totalWidth/2）', () => {
    const widths = [10, 20, 30] // totalWidth=60
    const centers = layoutGlyphCenters(widths)
    const total = widths.reduce((a, b) => a + b, 0)
    const { left, right } = spanEnds(widths, centers)
    expect(left).toBeCloseTo(-total / 2, 9)
    expect(right).toBeCloseTo(total / 2, 9)
    // 行全体は原点対称（左端と右端の符号が反転し絶対値が一致）
    expect(left).toBeCloseTo(-right, 9)
  })

  it('隣接中心の間隔は両グリフの半幅和に等しい（隙間も重なりもない詰め配置）', () => {
    const widths = [12, 8, 40, 4]
    const centers = layoutGlyphCenters(widths)
    for (let i = 1; i < widths.length; i++) {
      const gap = centers[i] - centers[i - 1]
      expect(gap).toBeCloseTo(widths[i - 1] / 2 + widths[i] / 2, 9)
    }
    expect(centers.length).toBe(widths.length)
  })

  it('幅 0 が混在しても破綻しない（0 幅グリフは前後と同一点に潰れるだけ）', () => {
    const widths = [10, 0, 10] // totalWidth=20
    const centers = layoutGlyphCenters(widths)
    const total = widths.reduce((a, b) => a + b, 0)
    const { left, right } = spanEnds(widths, centers)
    expect(left).toBeCloseTo(-total / 2, 9)
    expect(right).toBeCloseTo(total / 2, 9)
    // 中央の 0 幅グリフは前グリフの右端 = 次グリフの左端に一致（その点に潰れる）
    expect(centers[1]).toBeCloseTo(centers[0] + widths[0] / 2, 9)
    expect(centers[1]).toBeCloseTo(centers[2] - widths[2] / 2, 9)
  })

  it('左右対称な幅列なら中心配列も原点対称になる', () => {
    const widths = [10, 30, 10]
    const centers = layoutGlyphCenters(widths)
    expect(centers[0]).toBeCloseTo(-centers[2], 9)
    expect(centers[1]).toBeCloseTo(0, 9) // 中央グリフは原点
  })
})
