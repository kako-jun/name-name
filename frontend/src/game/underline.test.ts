import { describe, it, expect } from 'vitest'
import {
  UNDERLINE_DEFAULTS,
  parseColorToNumber,
  resolveUnderline,
  underlineScaleX,
  layoutUnderline,
  type ResolvedUnderline,
} from './underline'
import { applyEasing, easeOutBack } from './easing'

// 解決済みパラメータを作るヘルパー（テスト用）。期待値は定数 import で陳腐化を防ぐ。
function makeResolved(over: Partial<ResolvedUnderline> = {}): ResolvedUnderline {
  return {
    colorNum: parseColorToNumber(UNDERLINE_DEFAULTS.color, 0x000000),
    thickness: UNDERLINE_DEFAULTS.thickness,
    durationMs: UNDERLINE_DEFAULTS.durationMs,
    offset: undefined,
    easing: UNDERLINE_DEFAULTS.easing,
    ...over,
  }
}

// ===== #270: parseColorToNumber（CSS カラー文字列 → Pixi 数値カラー）=====
describe('underline: parseColorToNumber', () => {
  it('# 付き 6 桁 hex を数値化する', () => {
    expect(parseColorToNumber('#1a4a7a', 0x000000)).toBe(0x1a4a7a)
    expect(parseColorToNumber('#ffffff', 0x000000)).toBe(0xffffff)
    expect(parseColorToNumber('#000000', 0xffffff)).toBe(0x000000)
  })

  it('# なし 6 桁 hex も数値化する', () => {
    expect(parseColorToNumber('1a4a7a', 0x000000)).toBe(0x1a4a7a)
  })

  it('3 桁短縮形 #rgb は #rrggbb に展開する', () => {
    expect(parseColorToNumber('#222', 0x000000)).toBe(0x222222)
    expect(parseColorToNumber('#abc', 0x000000)).toBe(0xaabbcc)
    // # なしの 3 桁も同様
    expect(parseColorToNumber('f0a', 0x000000)).toBe(0xff00aa)
  })

  it('前後の空白はトリムされる', () => {
    expect(parseColorToNumber('  #1a4a7a  ', 0x000000)).toBe(0x1a4a7a)
  })

  it('undefined は fallback を返す', () => {
    expect(parseColorToNumber(undefined, 0x123456)).toBe(0x123456)
  })

  it('長さが 6 でも 3 でもない文字列は fallback', () => {
    expect(parseColorToNumber('#12345', 0x123456)).toBe(0x123456) // 5 桁
    expect(parseColorToNumber('#1234567', 0x123456)).toBe(0x123456) // 7 桁
    expect(parseColorToNumber('#ab', 0x123456)).toBe(0x123456) // 2 桁
    expect(parseColorToNumber('', 0x123456)).toBe(0x123456) // 空
  })

  it('hex として解釈できない文字を含むと NaN になり fallback に倒れる', () => {
    // "zz" を含む 6 桁 → parseInt は途中まで読むが先頭が非 hex なら NaN
    expect(parseColorToNumber('#zzzzzz', 0x123456)).toBe(0x123456)
    expect(parseColorToNumber('#gggggg', 0x123456)).toBe(0x123456)
  })

  it('符号付き 6 文字 hex は純 hex でないので fallback に倒れる（parseInt の符号解釈を弾く）', () => {
    // Number.parseInt('+1a4a7', 16) は符号を解釈して 0x1a4a7 を返してしまう。
    // 純 hex 判定（/^[0-9a-fA-F]+$/）で先に弾くため fallback に倒れる。
    expect(parseColorToNumber('#+1a4a7', 0x123456)).toBe(0x123456)
    expect(parseColorToNumber('#-1a4a7', 0x123456)).toBe(0x123456)
    expect(parseColorToNumber('#+12345', 0x123456)).toBe(0x123456)
    expect(parseColorToNumber('#-12345', 0x123456)).toBe(0x123456)
    // '#' を付けない形でも同様（'+' を含めて 6 文字）。
    expect(parseColorToNumber('+1a4a7', 0x123456)).toBe(0x123456)
  })
})

// ===== #270: resolveUnderline（既定値 + 個別指定のデシジョンテーブル）=====
describe('underline: resolveUnderline 値解決（個別指定 > プリセット既定）', () => {
  it('指定なしはすべて UNDERLINE_DEFAULTS に倒れる', () => {
    const r = resolveUnderline({})
    expect(r.colorNum).toBe(parseColorToNumber(UNDERLINE_DEFAULTS.color, 0x000000))
    expect(r.thickness).toBe(UNDERLINE_DEFAULTS.thickness)
    expect(r.durationMs).toBe(UNDERLINE_DEFAULTS.durationMs)
    expect(r.easing).toBe(UNDERLINE_DEFAULTS.easing)
    // offset は未指定なら undefined のまま（autoOffset は呼び出し側が供給する）
    expect(r.offset).toBeUndefined()
  })

  it('個別指定は既定を上書きする', () => {
    const r = resolveUnderline({
      color: '#abcabc',
      thickness: 5,
      duration_ms: 1200,
      offset: 12,
      easing: 'EaseOutBack',
    })
    expect(r.colorNum).toBe(0xabcabc)
    expect(r.thickness).toBe(5)
    expect(r.durationMs).toBe(1200)
    expect(r.offset).toBe(12)
    expect(r.easing).toBe('EaseOutBack')
  })

  it('負の thickness / duration は 0 にクランプする', () => {
    const r = resolveUnderline({ thickness: -3, duration_ms: -500 })
    expect(r.thickness).toBe(0)
    expect(r.durationMs).toBe(0)
  })

  it('thickness=0 / duration_ms=0 は境界そのものとして 0 を通す', () => {
    const r = resolveUnderline({ thickness: 0, duration_ms: 0 })
    expect(r.thickness).toBe(0)
    expect(r.durationMs).toBe(0)
  })

  it('offset=0 は明示指定として 0 を保持する（undefined に倒さない）', () => {
    const r = resolveUnderline({ offset: 0 })
    expect(r.offset).toBe(0)
  })

  it('解釈不能な color は UNDERLINE_DEFAULTS.color を fallback として使う', () => {
    const fallback = parseColorToNumber(UNDERLINE_DEFAULTS.color, 0x000000)
    expect(resolveUnderline({ color: '#zzz' }).colorNum).toBe(fallback)
  })
})

// ===== #270: underlineScaleX（経過 ms → scale.x [0,1]、easing 適用）=====
describe('underline: underlineScaleX の境界値', () => {
  it('elapsed<=0 は 0（まだ伸びていない）', () => {
    const r = makeResolved({ durationMs: 700, easing: 'Linear' })
    expect(underlineScaleX(0, r)).toBe(0)
    expect(underlineScaleX(-100, r)).toBe(0)
  })

  it('elapsed>=duration は 1（伸び切り）', () => {
    const r = makeResolved({ durationMs: 700, easing: 'Linear' })
    expect(underlineScaleX(700, r)).toBe(1)
    expect(underlineScaleX(99999, r)).toBe(1)
  })

  it('durationMs<=0 は即時完了で常に 1（0 除算回避）', () => {
    expect(underlineScaleX(0, makeResolved({ durationMs: 0 }))).toBe(1)
    expect(underlineScaleX(-50, makeResolved({ durationMs: 0 }))).toBe(1)
    expect(underlineScaleX(50, makeResolved({ durationMs: -100 }))).toBe(1)
  })

  it('中間は easing を適用する（Linear なら t そのもの）', () => {
    const r = makeResolved({ durationMs: 700, easing: 'Linear' })
    expect(underlineScaleX(350, r)).toBeCloseTo(0.5, 9)
    expect(underlineScaleX(175, r)).toBeCloseTo(0.25, 9)
  })

  it('EaseIn は序盤ゆっくり（線形より小さい）', () => {
    const r = makeResolved({ durationMs: 700, easing: 'EaseIn' })
    // applyEasing と同値を返すことを守る（dispatcher を素通しせず正しく繋いでいる）。
    expect(underlineScaleX(175, r)).toBe(applyEasing('EaseIn', 0.25))
    expect(underlineScaleX(175, r)).toBeLessThan(0.25)
  })

  it('EaseOutBack は途中で 1 を一瞬超える（オーバーシュート、意図的に clamp しない）', () => {
    const r = makeResolved({ durationMs: 700, easing: 'EaseOutBack' })
    let sawOvershoot = false
    for (let t = 0; t < r.durationMs; t += 10) {
      if (underlineScaleX(t, r) > 1) {
        sawOvershoot = true
        break
      }
    }
    expect(sawOvershoot).toBe(true)
    // 参考: easeOutBack 自体が 0..1 の途中で 1 を超える
    expect(Math.max(...[0.6, 0.7, 0.8].map(easeOutBack))).toBeGreaterThan(1)
  })

  it('EaseOutBack でも t>=1（duration 経過後）はちょうど 1 に着地する', () => {
    const r = makeResolved({ durationMs: 700, easing: 'EaseOutBack' })
    // duration 経過後は easing を通さず 1 を返す（着地保証）。
    expect(underlineScaleX(700, r)).toBe(1)
    expect(underlineScaleX(800, r)).toBe(1)
  })
})

// ===== #270: layoutUnderline（実 measure 値 → 矩形ジオメトリ）=====
describe('underline: layoutUnderline のジオメトリ', () => {
  it('左端 x = -width/2、y = textBottomY + offset（offset 明示時は autoOffset を無視）', () => {
    const r = makeResolved({ offset: 10 })
    const geom = layoutUnderline(200, 32, r, 99)
    expect(geom.x).toBe(-100) // -width/2
    expect(geom.y).toBe(32 + 10) // textBottomY + resolved.offset
    expect(geom.width).toBe(200)
    expect(geom.thickness).toBe(r.thickness)
  })

  it('offset 未指定なら autoOffset を使う', () => {
    const r = makeResolved({ offset: undefined })
    const geom = layoutUnderline(120, 40, r, 7)
    expect(geom.y).toBe(40 + 7) // textBottomY + autoOffset
    expect(geom.x).toBe(-60)
    expect(geom.width).toBe(120)
  })

  it('offset=0（明示）は autoOffset を上書きして 0 を使う', () => {
    const r = makeResolved({ offset: 0 })
    const geom = layoutUnderline(100, 30, r, 50)
    expect(geom.y).toBe(30) // textBottomY + 0
  })

  it('textWidth<=0 のとき width=0、x=0（-width/2 は ±0、絶対値 0）', () => {
    const r = makeResolved({ offset: 5 })
    const zero = layoutUnderline(0, 20, r, 3)
    expect(zero.width).toBe(0)
    // width=0 のとき -0/2 = -0 になり得るので絶対値で 0 を確認する。
    expect(Math.abs(zero.x)).toBe(0)
    const neg = layoutUnderline(-50, 20, r, 3)
    expect(neg.width).toBe(0)
    expect(Math.abs(neg.x)).toBe(0)
  })

  it('thickness は resolved の値をそのまま透過する', () => {
    const r = makeResolved({ thickness: 8 })
    expect(layoutUnderline(100, 10, r, 0).thickness).toBe(8)
  })
})
