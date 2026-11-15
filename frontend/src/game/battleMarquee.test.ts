/** 入り切らない文字の横スクロール (#1183) の純粋関数・時計のテスト。時刻は注入するので再現できる */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MARQUEE_END_PAD,
  MarqueeClock,
  effectiveTextOverflow,
  marqueeCycleMs,
  marqueeOverflowPx,
  marqueeTimingOf,
  normalizeBattleTextOverflow,
  sampleMarquee,
} from './battleMarquee'
import { DEFAULT_MOTION_TIMING, SNAPPY_MOTION_TIMING, motionTimingFor } from './battleMotion'

afterEach(() => vi.restoreAllMocks())

const T = { speed: 50, holdMs: 500 }

describe('normalizeBattleTextOverflow', () => {
  it('scroll / ellipsis はそのまま（大小・前後の空白は無視）', () => {
    expect(normalizeBattleTextOverflow('scroll')).toBe('scroll')
    expect(normalizeBattleTextOverflow(' Scroll ')).toBe('scroll')
    expect(normalizeBattleTextOverflow('ellipsis')).toBe('ellipsis')
  })
  it('未指定・空は既定の ellipsis（警告なし）', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    for (const v of [undefined, null, '', '  '])
      expect(normalizeBattleTextOverflow(v)).toBe('ellipsis')
    expect(spy).not.toHaveBeenCalled()
  })
  it('不正値は警告して ellipsis（warn=false なら警告なし）', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(normalizeBattleTextOverflow('marquee')).toBe('ellipsis')
    expect(spy).toHaveBeenCalledTimes(1)
    expect(normalizeBattleTextOverflow('marquee', false)).toBe('ellipsis')
    expect(spy).toHaveBeenCalledTimes(1)
  })
})

describe('effectiveTextOverflow', () => {
  it('scroll は reduced-motion のときだけ ellipsis に倒れる。ellipsis はそのまま', () => {
    expect(effectiveTextOverflow('scroll', false)).toBe('scroll')
    expect(effectiveTextOverflow('scroll', true)).toBe('ellipsis')
    expect(effectiveTextOverflow('ellipsis', false)).toBe('ellipsis')
    expect(effectiveTextOverflow('ellipsis', true)).toBe('ellipsis')
  })
})

describe('marqueeOverflowPx', () => {
  it('入るなら 0、越えるなら越えた量 + 末尾の余白', () => {
    expect(marqueeOverflowPx(100, 100)).toBe(0)
    expect(marqueeOverflowPx(80, 100)).toBe(0)
    expect(marqueeOverflowPx(130, 100)).toBe(30 + MARQUEE_END_PAD)
  })
  it('非有限は 0（動かさない）', () => {
    expect(marqueeOverflowPx(NaN, 100)).toBe(0)
    expect(marqueeOverflowPx(100, Infinity)).toBe(0)
  })
})

describe('sampleMarquee: 先頭で止まる → 流れる → 末尾で止まる → 戻る', () => {
  const overflow = 100 // 100px / 50px/秒 = 2000ms
  it('周期は 停止 + 往路 + 停止 + 復路', () => {
    expect(marqueeCycleMs(overflow, T)).toBe(500 + 2000 + 500 + 2000)
  })
  it('先頭の停止の間は 0、流れ出すと直線的に増える', () => {
    expect(sampleMarquee(0, overflow, T)).toBe(0)
    expect(sampleMarquee(499, overflow, T)).toBe(0)
    expect(sampleMarquee(500 + 1000, overflow, T)).toBeCloseTo(50, 6)
  })
  it('末尾で止まり（overflow のまま）、同じ速さで戻る', () => {
    expect(sampleMarquee(500 + 2000, overflow, T)).toBeCloseTo(100, 6)
    expect(sampleMarquee(500 + 2000 + 499, overflow, T)).toBeCloseTo(100, 6)
    expect(sampleMarquee(500 + 2000 + 500 + 1000, overflow, T)).toBeCloseTo(50, 6)
    expect(sampleMarquee(500 + 2000 + 500 + 2000, overflow, T)).toBe(0) // 1 周して先頭
  })
  it('周期で繰り返す', () => {
    const c = marqueeCycleMs(overflow, T)
    for (const t of [123, 1500, 3200, 4900])
      expect(sampleMarquee(t + c * 3, overflow, T)).toBeCloseTo(sampleMarquee(t, overflow, T), 6)
  })
  it('常に 0..overflow の範囲で、速さは速度（px/秒）を越えない', () => {
    let prev = sampleMarquee(0, overflow, T)
    for (let t = 1; t < 20000; t += 7) {
      const v = sampleMarquee(t, overflow, T)
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThanOrEqual(overflow + 1e-9)
      expect(Math.abs(v - prev)).toBeLessThanOrEqual((T.speed * 7) / 1000 + 1e-9)
      prev = v
    }
  })
  it('動かさない条件（overflow 0・速度 0 以下・非有限・負の経過）は 0', () => {
    expect(sampleMarquee(1000, 0, T)).toBe(0)
    expect(sampleMarquee(1000, overflow, { speed: 0, holdMs: 500 })).toBe(0)
    expect(sampleMarquee(1000, overflow, { speed: NaN, holdMs: 500 })).toBe(0)
    expect(sampleMarquee(-5, overflow, T)).toBe(0)
    expect(sampleMarquee(NaN, overflow, T)).toBe(0)
    expect(marqueeCycleMs(0, T)).toBe(0)
  })
})

describe('motion preset の表', () => {
  it('default はゆっくり長め・snappy は少し速く短め。表から取り出せる', () => {
    expect(marqueeTimingOf(DEFAULT_MOTION_TIMING)).toEqual({ speed: 30, holdMs: 1000 })
    expect(marqueeTimingOf(SNAPPY_MOTION_TIMING)).toEqual({ speed: 48, holdMs: 600 })
    expect(marqueeTimingOf(motionTimingFor('snappy')).speed).toBeGreaterThan(
      marqueeTimingOf(motionTimingFor('default')).speed
    )
  })
})

describe('MarqueeClock', () => {
  it('キーが初めて見えた時刻から数える。同じキーは再描画しても先頭へ戻らない', () => {
    const c = new MarqueeClock()
    c.advance(1000)
    expect(c.elapsedOf('a')).toBe(0)
    c.advance(300)
    expect(c.elapsedOf('a')).toBe(300)
    c.advance(200)
    expect(c.elapsedOf('b')).toBe(0)
    expect(c.elapsedOf('a')).toBe(500)
  })
  it('retain に無いキーは忘れ、次に出たときは先頭から', () => {
    const c = new MarqueeClock()
    c.elapsedOf('a')
    c.advance(400)
    c.retain(new Set())
    expect(c.elapsedOf('a')).toBe(0)
  })
  it('負・非有限の経過は無視する', () => {
    const c = new MarqueeClock()
    c.advance(-5)
    c.advance(NaN)
    expect(c.now).toBe(0)
  })
})
