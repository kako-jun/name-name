/**
 * 回転舞台 `[舞台回転]` (#704 第2弾) のディレクティブ配線。
 *  - `StageTurn` は範囲を開く（所要時間をそのまま渡す）
 *  - 範囲が開いている間、`Wall` `WallExit` `BackgroundBoard` `Prop` `Floor` `FloorExit` はレイヤーを直接触らず、
 *    ためた処理（後で流し込まれる）になる。範囲外は従来どおり即時。
 *  - `SceneTransition` は範囲を捨てる
 *  - 立ち絵・舞台前面・天候・照明・幕・背景（単一スロット）の指示は範囲に関係なく即時（回さないもの）
 */
import { describe, expect, it, vi } from 'vitest'
import type { Event } from '../../types'
import { dispatchDirective, type DirectiveContext } from './index'

const E = (e: unknown): Event => e as Event

function ctxWith(open: boolean) {
  const queue: Array<() => void> = []
  const layers = {
    wall: { show: vi.fn(), clear: vi.fn() },
    backgroundBoard: { add: vi.fn(), replace: vi.fn(), clear: vi.fn() },
    prop: { add: vi.fn(), replace: vi.fn(), clear: vi.fn() },
    floor: { show: vi.fn(), clear: vi.fn() },
    stageFront: { show: vi.fn(), clear: vi.fn() },
    weather: { set: vi.fn(), clear: vi.fn() },
    lighting: { set: vi.fn(), clear: vi.fn() },
    curtain: { show: vi.fn(), raise: vi.fn(), clear: vi.fn() },
    video: { show: vi.fn(), remove: vi.fn() },
    eventImage: { show: vi.fn(), remove: vi.fn() },
  }
  const hooks = {
    beginStageTurn: vi.fn(),
    deferToStageTurn: vi.fn((fn: () => void) => {
      if (!open) return false
      queue.push(fn)
      return true
    }),
    cancelStageTurn: vi.fn(),
    setCurtainZOrder: vi.fn(),
    applyEventImageVisibility: vi.fn(),
    clearTelopLayer: vi.fn(),
  }
  const stage = {
    background: { setBackground: vi.fn(), clearBackground: vi.fn() },
    effects: { setBlackout: vi.fn(), retreatNovelScrim: vi.fn() },
  }
  const ctx = {
    stage,
    layers,
    hooks,
    env: { assetBaseUrl: '/a', skipMode: false },
  } as unknown as DirectiveContext
  return { ctx, layers, hooks, queue, stage }
}

describe('StageTurn ディレクティブ (#704 第2弾)', () => {
  it('範囲を開く。所要時間はそのまま渡り、省略は null / undefined のまま', () => {
    const c = ctxWith(false)
    expect(dispatchDirective(E({ StageTurn: { duration_ms: 900 } }), c.ctx)).toBe(true)
    expect(c.hooks.beginStageTurn).toHaveBeenLastCalledWith(900)
    dispatchDirective(E({ StageTurn: { duration_ms: null } }), c.ctx)
    expect(c.hooks.beginStageTurn).toHaveBeenLastCalledWith(null)
    dispatchDirective(E({ StageTurn: {} }), c.ctx)
    expect(c.hooks.beginStageTurn).toHaveBeenLastCalledWith(undefined)
    dispatchDirective(E({ StageTurn: { duration_ms: 0 } }), c.ctx)
    expect(c.hooks.beginStageTurn).toHaveBeenLastCalledWith(0)
  })

  it('StageTurn 自身はレイヤーを触らない', () => {
    const c = ctxWith(true)
    dispatchDirective(E({ StageTurn: { duration_ms: 500 } }), c.ctx)
    for (const l of Object.values(c.layers)) {
      for (const fn of Object.values(l)) expect(fn).not.toHaveBeenCalled()
    }
  })
})

describe('範囲が開いている間の 4 種（壁・背景板・大道具・床）', () => {
  const events: Array<[string, Event]> = [
    ['Wall', E({ Wall: { path: 'w.png', loop: true, mute: true } })],
    ['WallExit', 'WallExit' as Event],
    ['BackgroundBoard', E({ BackgroundBoard: { path: 'b.png', depth: 3 } })],
    [
      'BackgroundBoard(回転:)',
      E({ BackgroundBoard: { path: 'b.png', depth: 3, flip_from: 'o.png' } }),
    ],
    ['Prop', E({ Prop: { path: 'p.png', depth: 2 } })],
    ['Prop(回転:)', E({ Prop: { path: 'p.png', depth: 2, flip_from: 'o.png' } })],
    ['Floor', E({ Floor: { path: 'f.png', height: 0.3 } })],
    ['FloorExit', 'FloorExit' as Event],
  ]

  it.each(events)(
    '%s: 開いている間はレイヤーを直接触らず、ためた処理を流し込むと従来どおりの呼び出しになる',
    (_n, ev) => {
      const open = ctxWith(true)
      expect(dispatchDirective(ev, open.ctx)).toBe(true)
      const all = Object.values(open.layers).flatMap((l) => Object.values(l))
      expect(all.every((fn) => fn.mock.calls.length === 0)).toBe(true)
      expect(open.queue).toHaveLength(1)
      // 流し込み後の呼び出し列は、範囲外で即時に実行したときと同じ。
      const closed = ctxWith(false)
      dispatchDirective(ev, closed.ctx)
      open.queue[0]()
      for (const key of Object.keys(open.layers) as Array<keyof typeof open.layers>) {
        for (const name of Object.keys(open.layers[key])) {
          const a = (open.layers[key] as unknown as Record<string, ReturnType<typeof vi.fn>>)[name]
          const b = (closed.layers[key] as unknown as Record<string, ReturnType<typeof vi.fn>>)[
            name
          ]
          expect(a.mock.calls, `${key}.${name}`).toEqual(b.mock.calls)
        }
      }
    }
  )

  it.each(events)('%s: 範囲外は今まで通り即時に実行する（ためない）', (_n, ev) => {
    const c = ctxWith(false)
    dispatchDirective(ev, c.ctx)
    expect(c.queue).toHaveLength(0)
    const all = Object.values(c.layers).flatMap((l) => Object.values(l))
    expect(all.some((fn) => fn.mock.calls.length > 0)).toBe(true)
  })
})

describe('回さないものは範囲に関係なく即時', () => {
  it('StageFront / Weather / Spotlight / Curtain / Background は範囲が開いていてもためない', () => {
    const c = ctxWith(true)
    dispatchDirective(E({ StageFront: { path: 'hall.png' } }), c.ctx)
    dispatchDirective(E({ Weather: { kind: 'Rain', intensity: 1 } }), c.ctx)
    dispatchDirective(E({ Spotlight: { target: null, color: '#fff', radius: 1 } }), c.ctx)
    dispatchDirective(E({ Curtain: { path: 'c.png', characters_in_front: false } }), c.ctx)
    dispatchDirective(E({ Background: { path: 'bg.png' } }), c.ctx)
    dispatchDirective('StageFrontExit' as Event, c.ctx)
    dispatchDirective('WeatherExit' as Event, c.ctx)
    expect(c.queue).toHaveLength(0)
    expect(c.hooks.deferToStageTurn).not.toHaveBeenCalled()
    expect(c.layers.stageFront.show).toHaveBeenCalledTimes(1)
    expect(c.layers.stageFront.clear).toHaveBeenCalledTimes(1)
    expect(c.layers.weather.set).toHaveBeenCalledTimes(1)
    expect(c.layers.weather.clear).toHaveBeenCalledTimes(1)
    expect(c.layers.lighting.set).toHaveBeenCalledTimes(1)
    expect(c.layers.curtain.show).toHaveBeenCalledTimes(1)
    expect(c.stage.background.setBackground).toHaveBeenCalledTimes(1)
  })
})

describe('SceneTransition', () => {
  it('範囲を捨ててからクリアする', () => {
    const c = ctxWith(true)
    const order: string[] = []
    c.hooks.cancelStageTurn.mockImplementation(() => order.push('cancel'))
    c.layers.prop.clear.mockImplementation(() => order.push('prop.clear'))
    dispatchDirective('SceneTransition' as Event, c.ctx)
    expect(order[0]).toBe('cancel')
    expect(order).toContain('prop.clear')
  })
})
