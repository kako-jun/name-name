/**
 * 壁 (#703) のディレクティブ配線。`Wall` は単一スロットの `show`、`WallExit` は `clear`。
 * 設定（ループ・ミュート）と assetBaseUrl が layer へ渡る。
 */
import { describe, expect, it, vi } from 'vitest'
import type { Event } from '../../types'
import { dispatchDirective, type DirectiveContext } from './index'

const E = (e: unknown): Event => e as Event

function ctxWith(assetBaseUrl = '/a') {
  const wall = { show: vi.fn(), clear: vi.fn() }
  const ctx = {
    layers: { wall },
    env: { assetBaseUrl },
  } as unknown as DirectiveContext
  return { ctx, wall }
}

describe('Wall / WallExit ディレクティブ (#703)', () => {
  it('Wall は show(path, {loop, mute}, assetBaseUrl) を呼ぶ。clear は呼ばない（置換は layer の責務）', () => {
    const c = ctxWith()
    expect(
      dispatchDirective(E({ Wall: { path: 'glow.webp', loop: true, mute: true } }), c.ctx)
    ).toBe(true)
    expect(c.wall.show).toHaveBeenCalledTimes(1)
    expect(c.wall.show).toHaveBeenCalledWith('glow.webp', { loop: true, mute: true }, '/a')
    expect(c.wall.clear).not.toHaveBeenCalled()
  })

  it('loop/mute=false がそのまま渡る（既定の true に化けない）', () => {
    const c = ctxWith()
    dispatchDirective(E({ Wall: { path: 'a.webm', loop: false, mute: false } }), c.ctx)
    expect(c.wall.show).toHaveBeenCalledWith('a.webm', { loop: false, mute: false }, '/a')
  })

  it('2 回続けて Wall を発火すると 2 回 show（置換は layer 側の単一スロットが担う）', () => {
    const c = ctxWith()
    dispatchDirective(E({ Wall: { path: 'a.webp', loop: true, mute: true } }), c.ctx)
    dispatchDirective(E({ Wall: { path: 'b.webp', loop: true, mute: true } }), c.ctx)
    expect(c.wall.show.mock.calls.map((x) => x[0])).toEqual(['a.webp', 'b.webp'])
  })

  it('WallExit は clear だけを呼ぶ', () => {
    const c = ctxWith()
    expect(dispatchDirective(E('WallExit'), c.ctx)).toBe(true)
    expect(c.wall.clear).toHaveBeenCalledTimes(1)
    expect(c.wall.show).not.toHaveBeenCalled()
  })

  it('assetBaseUrl が空でも show は呼ばれ、読み込みの可否は layer が決める', () => {
    const c = ctxWith('')
    dispatchDirective(E({ Wall: { path: 'a.webp', loop: true, mute: true } }), c.ctx)
    expect(c.wall.show).toHaveBeenCalledWith('a.webp', { loop: true, mute: true }, '')
  })
})
