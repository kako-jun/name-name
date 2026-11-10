import { describe, expect, it, vi } from 'vitest'
import { once } from './once'

describe('once (#1073)', () => {
  it('最初の 1 回だけ実行し、2 回目以降は何もしない', () => {
    const fn = vi.fn()
    const f = once(fn)
    f()
    f()
    f()
    expect(fn).toHaveBeenCalledTimes(1)
  })
  it('最初の呼び出しの引数がそのまま渡る（2 回目の引数は無視）', () => {
    const fn = vi.fn()
    const f = once((a: number, b: string) => fn(a, b))
    f(1, 'x')
    f(2, 'y')
    expect(fn).toHaveBeenCalledWith(1, 'x')
    expect(fn).toHaveBeenCalledTimes(1)
  })
  it('戻り値は undefined', () => {
    const f = once(() => {})
    expect(f()).toBeUndefined()
    expect(f()).toBeUndefined()
  })
  it('fn が例外を投げても、2 回目は呼ばない', () => {
    const fn = vi.fn(() => {
      throw new Error('x')
    })
    const f = once(fn)
    expect(() => f()).toThrow('x')
    expect(() => f()).not.toThrow()
    expect(fn).toHaveBeenCalledTimes(1)
  })
  it('once ごとに独立している', () => {
    const fn = vi.fn()
    once(fn)()
    once(fn)()
    expect(fn).toHaveBeenCalledTimes(2)
  })
})
