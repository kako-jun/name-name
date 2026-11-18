import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  attachTouchInput,
  classifySwipe,
  resetTouchTapSuppressionForTest,
  suppressNextTouchTap,
} from './touchInput'

describe('tap 抑止のモジュール状態 (#1203)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    resetTouchTapSuppressionForTest()
  })

  const tapOnce = (el: HTMLElement): void => {
    const ev = (type: string) =>
      Object.assign(new Event(type), { isPrimary: true, clientX: 5, clientY: 5 })
    el.dispatchEvent(ev('pointerdown'))
    el.dispatchEvent(ev('pointerup'))
  }

  it('先に実時計で入れた抑止の期限は、リセットすると偽時計の tap を握りつぶさない', () => {
    // 稼働が長い worker（実時計が 60 秒）で、抑止を入れた状況
    vi.spyOn(performance, 'now').mockReturnValue(60_000)
    suppressNextTouchTap(400)
    // 偽時計に切り替えた後のテスト
    vi.spyOn(performance, 'now').mockReturnValue(10_000)
    const el = document.createElement('div')
    const onTap = vi.fn()
    const detach = attachTouchInput(el, { onTap })
    tapOnce(el)
    expect(onTap).not.toHaveBeenCalled() // リセット前は残った期限で弾かれる（落ちていた状態の再現）
    resetTouchTapSuppressionForTest()
    tapOnce(el)
    expect(onTap).toHaveBeenCalledTimes(1)
    detach()
  })
})

describe('classifySwipe', () => {
  it('水平方向が支配的なら left/right を返す', () => {
    expect(classifySwipe(50, 10)).toBe('right')
    expect(classifySwipe(-50, 10)).toBe('left')
    expect(classifySwipe(50, -10)).toBe('right')
    expect(classifySwipe(-50, -10)).toBe('left')
  })

  it('垂直方向が支配的なら up/down を返す', () => {
    expect(classifySwipe(10, 50)).toBe('down')
    expect(classifySwipe(10, -50)).toBe('up')
    expect(classifySwipe(-10, 50)).toBe('down')
    expect(classifySwipe(-10, -50)).toBe('up')
  })

  it('絶対値が同じときは水平を優先する（4 象限すべて確認）', () => {
    expect(classifySwipe(40, 40)).toBe('right')
    expect(classifySwipe(40, -40)).toBe('right')
    expect(classifySwipe(-40, 40)).toBe('left')
    expect(classifySwipe(-40, -40)).toBe('left')
  })

  it('スクリーン座標の Y 軸（下向き正）に従い up/down を分ける', () => {
    expect(classifySwipe(0, -100)).toBe('up')
    expect(classifySwipe(0, 100)).toBe('down')
  })
})
