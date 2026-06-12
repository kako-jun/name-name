import { describe, it, expect } from 'vitest'
import {
  EXPLODE_PRESET,
  TYPEWRITER_PRESET,
  TEXT_EFFECT_DEFAULTS,
  RESTING_GLYPH_TRANSFORM,
  CURSOR_DEFAULTS,
  resolveTransformEffect,
  glyphLinearProgress,
  computeGlyphTransform,
  textEffectTotalDurationMs,
  resolveTypewriterMsPerChar,
  isRevealEffect,
  layoutGlyphCenters,
  glyphAnchorOffset,
  resolveCursor,
  cursorVisible,
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

// ===== #275: glyphAnchorOffset（揃えに応じたグリフ群の平行移動オフセット）=====
// layoutGlyphCenters は行全体を原点中央に置くので、anchor.x に応じて行をずらす。
// offset = totalWidth * (0.5 - anchorX)。左=0/中央=0.5/右=1 の 3 点と境界を検証する。
describe('textEffect: glyphAnchorOffset の揃え別オフセット (#275)', () => {
  it('中央 (anchorX=0.5) はオフセット 0（従来挙動 = 現状維持）', () => {
    expect(glyphAnchorOffset(60, 0.5)).toBe(0)
    expect(glyphAnchorOffset(0, 0.5)).toBe(0)
    expect(glyphAnchorOffset(123.4, 0.5)).toBe(0)
  })

  it('左揃え (anchorX=0) は +totalWidth/2（行の左端を原点へ寄せる）', () => {
    expect(glyphAnchorOffset(60, 0)).toBeCloseTo(30, 9)
    expect(glyphAnchorOffset(40, 0)).toBeCloseTo(20, 9)
  })

  it('右揃え (anchorX=1) は -totalWidth/2（行の右端を原点へ寄せる）', () => {
    expect(glyphAnchorOffset(60, 1)).toBeCloseTo(-30, 9)
    expect(glyphAnchorOffset(40, 1)).toBeCloseTo(-20, 9)
  })

  it('左揃えオフセット後、行の左端 (-totalWidth/2 + offset) がちょうど原点 0 に来る', () => {
    const total = 60
    const left = -total / 2 + glyphAnchorOffset(total, 0)
    expect(left).toBeCloseTo(0, 9)
  })

  it('右揃えオフセット後、行の右端 (+totalWidth/2 + offset) がちょうど原点 0 に来る', () => {
    const total = 60
    const right = total / 2 + glyphAnchorOffset(total, 1)
    expect(right).toBeCloseTo(0, 9)
  })

  it('幅 0 はどの揃えでもオフセット 0（空ラベルで破綻しない）', () => {
    // 0 * (0.5 - anchorX) は -0 を生むことがあるが座標上は 0 と等価。toBeCloseTo で符号差を吸収。
    expect(glyphAnchorOffset(0, 0)).toBeCloseTo(0, 9)
    expect(glyphAnchorOffset(0, 1)).toBeCloseTo(0, 9)
    expect(glyphAnchorOffset(0, 0.5)).toBeCloseTo(0, 9)
  })

  it('中間 anchor (0.25) は絶対値で 20（0.5-0.25=0.25 → 80*0.25）', () => {
    // 線形を割り戻すだけの自己整合（中央と左の中間）ではなく、独立計算した絶対値で縛る。
    const total = 80
    expect(glyphAnchorOffset(total, 0.25)).toBeCloseTo(20, 9)
  })

  // 観測点を「左揃え時、グリフ群左端 = container 原点」式に置く（線形の自己整合ではない）。
  // layoutGlyphCenters の左端 = -totalWidth/2。これに glyphAnchorOffset(_, 0) を足した
  // container ローカル左端が原点 0 に来ることを、独立に組み立てた幅列で確認する。
  it('左揃え時、layoutGlyphCenters の左端にオフセットを足すと container 原点 0 に乗る', () => {
    const widths = [12, 34, 6, 50] // totalWidth=102。任意の非対称幅列。
    const total = widths.reduce((a, b) => a + b, 0)
    const centers = layoutGlyphCenters(widths)
    const leftEdge = centers[0] - widths[0] / 2 // = -total/2
    // 左揃えオフセットを足すと先頭グリフの左端がちょうど原点へ寄る（左から右へ並ぶ起点）。
    expect(leftEdge + glyphAnchorOffset(total, 0)).toBeCloseTo(0, 9)
    // 右端は +total（行全体が原点右側に展開する）。
    const rightEdge = centers[centers.length - 1] + widths[widths.length - 1] / 2 // = +total/2
    expect(rightEdge + glyphAnchorOffset(total, 0)).toBeCloseTo(total, 9)
  })

  it('右揃え時、グリフ群右端が container 原点 0、左端が -total に来る', () => {
    const widths = [12, 34, 6, 50]
    const total = widths.reduce((a, b) => a + b, 0)
    const centers = layoutGlyphCenters(widths)
    const leftEdge = centers[0] - widths[0] / 2
    const rightEdge = centers[centers.length - 1] + widths[widths.length - 1] / 2
    expect(rightEdge + glyphAnchorOffset(total, 1)).toBeCloseTo(0, 9)
    expect(leftEdge + glyphAnchorOffset(total, 1)).toBeCloseTo(-total, 9)
  })
})

// ===== #271: resolveCursor（点滅カーソルの設定解決。reveal 専用）=====
// enabled は「reveal 効果 かつ cursor===true」のときだけ true。期待値は CURSOR_DEFAULTS を import。
describe('textEffect: resolveCursor 値解決（reveal 専用 + デフォルト）', () => {
  it('効果=タイプ かつ カーソル=on のときだけ enabled=true', () => {
    expect(resolveCursor({ effect: 'Typewriter', cursor: true }).enabled).toBe(true)
  })

  it('reveal でも cursor が false / 未指定なら enabled=false', () => {
    expect(resolveCursor({ effect: 'Typewriter', cursor: false }).enabled).toBe(false)
    expect(resolveCursor({ effect: 'Typewriter' }).enabled).toBe(false)
  })

  it('reveal でない効果は cursor=true でも enabled=false（カーソルは reveal 専用）', () => {
    expect(resolveCursor({ effect: 'Explode', cursor: true }).enabled).toBe(false)
    expect(resolveCursor({ cursor: true }).enabled).toBe(false)
  })

  it('blink_ms 未指定は既定 CURSOR_DEFAULTS.blinkMs を使う', () => {
    expect(resolveCursor({ effect: 'Typewriter', cursor: true }).blinkMs).toBe(
      CURSOR_DEFAULTS.blinkMs
    )
  })

  it('正の blink_ms はそれを優先する', () => {
    expect(resolveCursor({ effect: 'Typewriter', cursor: true, blink_ms: 400 }).blinkMs).toBe(400)
  })

  it('0 / 負の blink_ms は既定に倒す（点滅停止＝0 除算回避は cursorVisible 側でも担保）', () => {
    expect(resolveCursor({ effect: 'Typewriter', cursor: true, blink_ms: 0 }).blinkMs).toBe(
      CURSOR_DEFAULTS.blinkMs
    )
    expect(resolveCursor({ effect: 'Typewriter', cursor: true, blink_ms: -100 }).blinkMs).toBe(
      CURSOR_DEFAULTS.blinkMs
    )
  })

  it('cursor_color はパススルー（未指定なら undefined = 文字色流用）', () => {
    expect(
      resolveCursor({ effect: 'Typewriter', cursor: true, cursor_color: '#2b6cb0' }).color
    ).toBe('#2b6cb0')
    expect(resolveCursor({ effect: 'Typewriter', cursor: true }).color).toBeUndefined()
  })
})

// ===== #271: cursorVisible（点滅 step 関数。floor(t/半周期)%2===0）=====
describe('textEffect: cursorVisible の点滅境界', () => {
  it('t=0 は表示（true）', () => {
    expect(cursorVisible(0, 600)).toBe(true)
  })

  it('負 elapsed は 0 にクランプして表示（true）', () => {
    expect(cursorVisible(-100, 600)).toBe(true)
  })

  it('半周期ごとに表示/非表示が反転する（前半表示・後半非表示）', () => {
    const blink = 600 // 半周期 300
    expect(cursorVisible(0, blink)).toBe(true) // [0,300) 表示
    expect(cursorVisible(150, blink)).toBe(true)
    expect(cursorVisible(450, blink)).toBe(false) // [300,600) 非表示
    expect(cursorVisible(750, blink)).toBe(true) // [600,900) 再び表示
    expect(cursorVisible(1050, blink)).toBe(false) // [900,1200) 非表示
  })

  it('半周期ちょうどの境界は floor で次区間（非表示）に入る', () => {
    const blink = 600 // 半周期 300
    // t = 半周期ちょうど → floor(300/300)=1 → odd → false
    expect(cursorVisible(300, blink)).toBe(false)
    // t = 周期ちょうど → floor(600/300)=2 → even → true
    expect(cursorVisible(600, blink)).toBe(true)
    // 境界の直前は前区間に残る
    expect(cursorVisible(299, blink)).toBe(true)
    expect(cursorVisible(599, blink)).toBe(false)
  })

  it('blinkMs<=0 は常に表示（0 除算回避・点滅停止の安全側）', () => {
    expect(cursorVisible(0, 0)).toBe(true)
    expect(cursorVisible(500, 0)).toBe(true)
    expect(cursorVisible(500, -100)).toBe(true)
  })
})
