/**
 * 天候 (#706) のディレクティブ配線。`Weather` は単一スロットの `set(kind, intensity)`、`WeatherExit` は `clear`。
 * `SceneTransition` は天候もクリアする（directives.test.ts の順序固定で別途検証）。
 */
import { describe, expect, it, vi } from 'vitest'
import type { Event } from '../../types'
import { dispatchDirective, type DirectiveContext } from './index'

const E = (e: unknown): Event => e as Event

function ctxWith() {
  const weather = { set: vi.fn(), clear: vi.fn() }
  const ctx = { layers: { weather }, env: { assetBaseUrl: '/a' } } as unknown as DirectiveContext
  return { ctx, weather }
}

describe('Weather / WeatherExit ディレクティブ (#706)', () => {
  it('Weather は set(kind, intensity) を呼ぶ。clear は呼ばない（置換は layer の責務）', () => {
    const c = ctxWith()
    expect(dispatchDirective(E({ Weather: { kind: 'Snow', intensity: 1.5 } }), c.ctx)).toBe(true)
    expect(c.weather.set).toHaveBeenCalledWith('Snow', 1.5)
    expect(c.weather.clear).not.toHaveBeenCalled()
  })

  it('強さ省略（wasm は既定値を載せない）は 1 として渡す', () => {
    const c = ctxWith()
    dispatchDirective(E({ Weather: { kind: 'Rain' } }), c.ctx)
    expect(c.weather.set).toHaveBeenCalledWith('Rain', 1)
  })

  it('2 回続けて発火すると 2 回 set（単一スロットの置換は layer 側）', () => {
    const c = ctxWith()
    dispatchDirective(E({ Weather: { kind: 'Rain' } }), c.ctx)
    dispatchDirective(E({ Weather: { kind: 'Sakura' } }), c.ctx)
    expect(c.weather.set.mock.calls.map((x) => x[0])).toEqual(['Rain', 'Sakura'])
  })

  it('WeatherExit は clear だけを呼ぶ', () => {
    const c = ctxWith()
    expect(dispatchDirective(E('WeatherExit'), c.ctx)).toBe(true)
    expect(c.weather.clear).toHaveBeenCalledTimes(1)
    expect(c.weather.set).not.toHaveBeenCalled()
  })
})
