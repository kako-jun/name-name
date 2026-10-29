/**
 * 大道具・背景板の面の切り替え (#704) のディレクティブ配線。
 * `flip_from` がある `Prop` / `BackgroundBoard` だけ `replace` を呼び、無いものは従来どおり `add`。
 * スキップ中かどうか・回転時間・depth の既定が layer へ渡る。
 */
import { describe, expect, it, vi } from 'vitest'
import type { Event } from '../../types'
import { dispatchDirective, type DirectiveContext } from './index'

const E = (e: unknown): Event => e as Event

function ctxWith(skipMode: boolean) {
  const prop = { add: vi.fn(), replace: vi.fn(), clear: vi.fn() }
  const backgroundBoard = { add: vi.fn(), replace: vi.fn(), clear: vi.fn() }
  const ctx = {
    layers: { prop, backgroundBoard },
    env: { skipMode, assetBaseUrl: '/a' },
    hooks: { deferToStageTurn: () => false },
  } as unknown as DirectiveContext
  return { ctx, prop, backgroundBoard }
}

describe.each([
  ['Prop', 'prop'],
  ['BackgroundBoard', 'backgroundBoard'],
] as const)('%s の flip_from (#704)', (key, layerKey) => {
  it('flip_from が無ければ add（従来どおり）。replace は呼ばない', () => {
    const c = ctxWith(false)
    dispatchDirective(E({ [key]: { path: 'a.png', depth: 2 } }), c.ctx)
    expect(c[layerKey].add).toHaveBeenCalledWith('a.png', 2, '/a')
    expect(c[layerKey].replace).not.toHaveBeenCalled()
  })

  it('flip_from が null / 空文字なら add', () => {
    for (const flip_from of [null, '']) {
      const c = ctxWith(false)
      dispatchDirective(E({ [key]: { path: 'a.png', depth: 0, flip_from, flip_ms: 500 } }), c.ctx)
      expect(c[layerKey].add).toHaveBeenCalledTimes(1)
      expect(c[layerKey].replace).not.toHaveBeenCalled()
    }
  })

  it('flip_from があれば replace。回転時間とスキップ状態が渡る', () => {
    const c = ctxWith(false)
    dispatchDirective(
      E({ [key]: { path: 'back.png', depth: 3, flip_from: 'front.png', flip_ms: 900 } }),
      c.ctx
    )
    expect(c[layerKey].replace).toHaveBeenCalledWith('back.png', 3, 'front.png', '/a', {
      flipMs: 900,
      skip: false,
    })
    expect(c[layerKey].add).not.toHaveBeenCalled()
  })

  it('スキップ中は skip: true を渡す。depth 省略は 0、flip_ms 省略は undefined', () => {
    const c = ctxWith(true)
    dispatchDirective(E({ [key]: { path: 'back.png', flip_from: 'front.png' } }), c.ctx)
    expect(c[layerKey].replace).toHaveBeenCalledWith('back.png', 0, 'front.png', '/a', {
      flipMs: undefined,
      skip: true,
    })
  })
})
