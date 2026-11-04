import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MENU_FONT_TIMEOUT_MS, loadMenuFont } from './menuFont'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('loadMenuFont (#881)', () => {
  it('読み込みが決着しなくても上限内に完了する（ensure が返らない）', async () => {
    const load = vi.fn(() => new Promise<unknown>(() => undefined))
    let done = false
    const p = loadMenuFont(
      { ensure: () => new Promise<void>(() => undefined), load },
      'F',
      'あ'
    ).then(() => (done = true))
    await vi.advanceTimersByTimeAsync(MENU_FONT_TIMEOUT_MS - 1)
    expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(2)
    await p
    expect(done).toBe(true)
  })
  it('load が返らなくても上限内に完了する', async () => {
    const p = loadMenuFont(
      { ensure: () => Promise.resolve(), load: () => new Promise<unknown>(() => undefined) },
      'F',
      'あ',
      '',
      500
    )
    await vi.advanceTimersByTimeAsync(501)
    await expect(p).resolves.toBeUndefined()
  })
  it('失敗（reject）は握り、待たずに完了する', async () => {
    const p = loadMenuFont(
      { ensure: () => Promise.reject(new Error('x')), load: () => Promise.reject(new Error('y')) },
      'F',
      'あ'
    )
    await expect(p).resolves.toBeUndefined()
  })
  it('見本に、そのとき出す字を足して load へ渡す', async () => {
    const load = vi.fn(() => Promise.resolve())
    await loadMenuFont(
      { ensure: () => Promise.resolve(), load },
      "'F', sans-serif",
      '現在地',
      '寺町円0'
    )
    expect(load).toHaveBeenCalledWith("16px 'F', sans-serif", '現在地寺町円0')
  })
})
