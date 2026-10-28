/**
 * 舞台前面 (#705) のディレクティブ配線。`StageFront` は単一スロットの `show`、`StageFrontExit` は `clear`。
 * `SceneTransition` は舞台前面もクリアする。
 */
import { describe, expect, it, vi } from 'vitest'
import type { Event } from '../../types'
import { dispatchDirective, type DirectiveContext } from './index'

const E = (e: unknown): Event => e as Event

function ctxWith(assetBaseUrl = '/a') {
  const stageFront = { show: vi.fn(), clear: vi.fn() }
  const ctx = {
    layers: { stageFront },
    env: { assetBaseUrl },
  } as unknown as DirectiveContext
  return { ctx, stageFront }
}

describe('StageFront / StageFrontExit ディレクティブ (#705)', () => {
  it('StageFront は show(path, assetBaseUrl) を呼ぶ。clear は呼ばない（置換は layer の責務）', () => {
    const c = ctxWith()
    expect(dispatchDirective(E({ StageFront: { path: 'apron.png' } }), c.ctx)).toBe(true)
    expect(c.stageFront.show).toHaveBeenCalledTimes(1)
    expect(c.stageFront.show).toHaveBeenCalledWith('apron.png', '/a')
    expect(c.stageFront.clear).not.toHaveBeenCalled()
  })

  it('2 回続けて StageFront を発火すると 2 回 show（置換は layer 側の単一スロットが担う）', () => {
    const c = ctxWith()
    dispatchDirective(E({ StageFront: { path: 'a.png' } }), c.ctx)
    dispatchDirective(E({ StageFront: { path: 'b.png' } }), c.ctx)
    expect(c.stageFront.show.mock.calls.map((x) => x[0])).toEqual(['a.png', 'b.png'])
  })

  it('StageFrontExit は clear だけを呼ぶ', () => {
    const c = ctxWith()
    expect(dispatchDirective(E('StageFrontExit'), c.ctx)).toBe(true)
    expect(c.stageFront.clear).toHaveBeenCalledTimes(1)
    expect(c.stageFront.show).not.toHaveBeenCalled()
  })

  it('assetBaseUrl が空でも show は呼ばれ、読み込みの可否は layer が決める', () => {
    const c = ctxWith('')
    dispatchDirective(E({ StageFront: { path: 'a.png' } }), c.ctx)
    expect(c.stageFront.show).toHaveBeenCalledWith('a.png', '')
  })
})
