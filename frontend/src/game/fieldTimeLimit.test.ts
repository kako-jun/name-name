/** 制限時間の表示計算 (#880 / fieldTimeLimit.ts) のテスト */
import { describe, expect, it } from 'vitest'
import {
  TIME_LIMIT_AREA,
  TIME_LIMIT_MIN_FONT_PX,
  advanceTimeLimit,
  formatClock,
  formatTimeLimit,
  timeLimitFontPx,
  timeLimitRect,
  timeLimitText,
} from './fieldTimeLimit'

describe('formatClock', () => {
  it.each([
    [0, '00:00'],
    [999, '00:00'],
    [1000, '00:01'],
    [59_999, '00:59'],
    [60_000, '01:00'],
    [3_599_999, '59:59'],
    [3_600_000, '1:00:00'],
    [3_725_000, '1:02:05'],
    [36_000_000, '10:00:00'],
  ])('%d ms → %s', (ms, s) => {
    expect(formatClock(ms)).toBe(s)
  })
  it.each([[-1], [NaN], [Infinity], [-Infinity]])('不正（%s）は 00:00', (ms) => {
    expect(formatClock(ms)).toBe('00:00')
  })
})

describe('予約領域', () => {
  it('左上隅・幅 14%W・上端 2%H〜8%H', () => {
    expect(TIME_LIMIT_AREA).toEqual({ x: 0, y: 0.02, w: 0.14, h: 0.06 })
    const r = timeLimitRect(1000, 500)
    expect(r).toEqual({ x: 0, y: 10, w: 140, h: 30 })
  })
})

describe('timeLimitText / formatTimeLimit', () => {
  it('null は何も出さない', () => {
    expect(timeLimitText({ remainingMs: null, paused: false })).toBeNull()
    expect(formatTimeLimit({ remainingMs: null, paused: true })).toBeNull()
  })
  it('残りを「残り mm:ss」、停止中は「停止中」を添える（本文の文字は変わらない）', () => {
    expect(timeLimitText({ remainingMs: 65_000, paused: true })).toBe('残り 01:05')
    expect(formatTimeLimit({ remainingMs: 65_000, paused: false })).toBe('残り 01:05')
    expect(formatTimeLimit({ remainingMs: 65_000, paused: true })).toBe('残り 01:05 停止中')
  })
  it('0 は 00:00 を出す（null と区別）', () => {
    expect(timeLimitText({ remainingMs: 0, paused: false })).toBe('残り 00:00')
  })
})

describe('advanceTimeLimit', () => {
  it('dt ぶん減る', () => {
    expect(advanceTimeLimit(10_000, 16, false)).toBe(9_984)
  })
  it('停止中（メニュー中）は減らない', () => {
    expect(advanceTimeLimit(10_000, 16, true)).toBe(10_000)
  })
  it('null（制限なし）は null のまま', () => {
    expect(advanceTimeLimit(null, 16, false)).toBeNull()
  })
  it('0 で止まる（負にならない）。ちょうど 0 も', () => {
    expect(advanceTimeLimit(10, 50, false)).toBe(0)
    expect(advanceTimeLimit(50, 50, false)).toBe(0)
    expect(advanceTimeLimit(0, 50, false)).toBe(0)
  })
  it.each([[0], [-5], [NaN], [Infinity]])('dt=%s は変えない', (dt) => {
    expect(advanceTimeLimit(10_000, dt, false)).toBe(10_000)
  })
})

describe('timeLimitFontPx', () => {
  it('広い面では高さの 4% 以下・領域の幅に収まる。16px 以上の整数', () => {
    const px = timeLimitFontPx(1920, 1080)
    expect(Number.isInteger(px)).toBe(true)
    expect(px).toBeGreaterThanOrEqual(TIME_LIMIT_MIN_FONT_PX)
    // 5.2 字ぶんが領域幅に収まる
    expect((px * 5.2) / 0.62).toBeLessThanOrEqual(timeLimitRect(1920, 1080).w + 1)
  })
  it('狭い面では最小 16px', () => {
    expect(timeLimitFontPx(200, 100)).toBe(TIME_LIMIT_MIN_FONT_PX)
    expect(timeLimitFontPx(0, 0)).toBe(TIME_LIMIT_MIN_FONT_PX)
  })
  it('面が大きくなるほど減らない', () => {
    expect(timeLimitFontPx(3840, 2160)).toBeGreaterThanOrEqual(timeLimitFontPx(1920, 1080))
  })
})

describe('timeLimitFontPx の css px 下限', () => {
  it('canvas が縮小表示（cssScale<1）でも表示上 16 css px 以上になる', () => {
    expect(timeLimitFontPx(200, 100, 0.5) * 0.5).toBeGreaterThanOrEqual(TIME_LIMIT_MIN_FONT_PX)
    expect(timeLimitFontPx(200, 100, 0.5)).toBe(2 * TIME_LIMIT_MIN_FONT_PX)
  })
  it('cssScale の不正値は 1 とみなす。十分広い面では面基準の値のまま', () => {
    expect(timeLimitFontPx(200, 100, 0)).toBe(timeLimitFontPx(200, 100, 1))
    expect(timeLimitFontPx(200, 100, NaN)).toBe(timeLimitFontPx(200, 100))
    expect(timeLimitFontPx(1920, 1080, 1)).toBeGreaterThan(TIME_LIMIT_MIN_FONT_PX)
  })
})
