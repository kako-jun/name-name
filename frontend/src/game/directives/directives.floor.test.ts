/**
 * 床 (#706 第2弾) のディレクティブ配線。`Floor` は単一スロットの `show(path, height, assetBaseUrl)`、
 * `FloorExit` は `clear`。`SceneTransition` は床もクリアする。
 */
import { describe, expect, it, vi } from 'vitest'
import type { Event } from '../../types'
import { dispatchDirective, type DirectiveContext } from './index'

const E = (e: unknown): Event => e as Event

function ctxWith(assetBaseUrl = '/a') {
  const floor = { show: vi.fn(), clear: vi.fn() }
  const ctx = {
    layers: { floor },
    env: { assetBaseUrl },
  } as unknown as DirectiveContext
  return { ctx, floor }
}

describe('Floor / FloorExit ディレクティブ (#706 第2弾)', () => {
  it('Floor は show(path, height, assetBaseUrl) を呼ぶ。clear は呼ばない（置換は layer の責務）', () => {
    const c = ctxWith()
    expect(dispatchDirective(E({ Floor: { path: 'wood.png', height: 0.4 } }), c.ctx)).toBe(true)
    expect(c.floor.show).toHaveBeenCalledTimes(1)
    expect(c.floor.show).toHaveBeenCalledWith('wood.png', 0.4, '/a')
    expect(c.floor.clear).not.toHaveBeenCalled()
  })

  it('高さ省略（optional）は undefined のまま layer に渡り、既定への寄せは layer の責務', () => {
    const c = ctxWith()
    dispatchDirective(E({ Floor: { path: 'wood.png' } }), c.ctx)
    expect(c.floor.show).toHaveBeenCalledWith('wood.png', undefined, '/a')
  })

  it('2 回続けて Floor を発火すると 2 回 show（置換は layer 側の単一スロットが担う）', () => {
    const c = ctxWith()
    dispatchDirective(E({ Floor: { path: 'a.png', height: 0.25 } }), c.ctx)
    dispatchDirective(E({ Floor: { path: 'b.png', height: 0.5 } }), c.ctx)
    expect(c.floor.show.mock.calls.map((x) => x[0])).toEqual(['a.png', 'b.png'])
  })

  it('FloorExit は clear だけを呼ぶ', () => {
    const c = ctxWith()
    expect(dispatchDirective(E('FloorExit'), c.ctx)).toBe(true)
    expect(c.floor.clear).toHaveBeenCalledTimes(1)
    expect(c.floor.show).not.toHaveBeenCalled()
  })

  it('assetBaseUrl が空でも show は呼ばれ、読み込みの可否は layer が決める', () => {
    const c = ctxWith('')
    dispatchDirective(E({ Floor: { path: 'a.png', height: 0.25 } }), c.ctx)
    expect(c.floor.show).toHaveBeenCalledWith('a.png', 0.25, '')
  })
})
