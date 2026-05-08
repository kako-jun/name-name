import { describe, it, expect } from 'vitest'
import { classifySwipe } from './touchInput'

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

  it('絶対値が同じときは水平を優先する', () => {
    expect(classifySwipe(40, 40)).toBe('right')
    expect(classifySwipe(40, -40)).toBe('right')
    expect(classifySwipe(-40, 40)).toBe('left')
  })

  it('スクリーン座標の Y 軸（下向き正）に従い up/down を分ける', () => {
    expect(classifySwipe(0, -100)).toBe('up')
    expect(classifySwipe(0, 100)).toBe('down')
  })
})
