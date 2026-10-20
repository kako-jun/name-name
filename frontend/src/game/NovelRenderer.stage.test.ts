/**
 * NovelRenderer と Stage の配線 (#828 7c)。
 *
 * Stage の中身は Stage.test.ts / Stage.equivalence.test.ts に任せ、ここでは「レンダラがどの時点でどの
 * メソッドをどの順で呼ぶか」だけを見る。守る契約:
 *  - resetAndStartEvents: 立ち絵らのクリア → stage.reset(carry) → BGM 停止 → カーソル読み込み の順。
 *    stage.reset へは受け取った持ち越し方針をそのまま渡す。カメラの再配置は立ち絵のクリアより後。
 *  - applyState: stage.restore(state) は 背景板・大道具・立ち絵の復元より前。カメラ/輪郭の伝播順は
 *    輪郭（立ち絵→大道具）→ カメラ（背景板→大道具→立ち絵）。
 *  - processDirective の [カメラ:] / [紙人形輪郭:] は stage 経由で、旧実装と同じ引数・同じ伝播順。
 *  - getSnapshot の演出フィールドは stage.capture() 由来で、キー集合は不変。
 *  - destroy: stage.cancelAllTimers() が動画破棄より前、stage.release() が app.destroy より前。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NovelRenderer } from './NovelRenderer'
import type { Event, EventScene } from '../types'
import { carryPolicyFor } from './sceneEntry'
import { internals, internalsOf } from '../test/rendererInternals'
import type { Stage } from './Stage'

function scene(id: string, events: Event[]): EventScene {
  return { id, title: id, view: 'TopDown', events }
}

const SCENES = [
  scene('entry', [{ Narration: { text: ['本文'] } } as Event]),
  scene('next', [{ Narration: { text: ['次'] } } as Event]),
]

interface Layers {
  stage: Stage
  characterLayer: {
    clear(): void
    clearForSceneTransition(): void
    setCamera(...a: unknown[]): void
    setPaperDollOutline(...a: unknown[]): void
    show(...a: unknown[]): void
  }
  propLayer: {
    clear(): void
    setCamera(...a: unknown[]): void
    setPaperDollOutline(...a: unknown[]): void
    restore(...a: unknown[]): void
  }
  backgroundBoardLayer: {
    clear(): void
    setCamera(...a: unknown[]): void
    restore(...a: unknown[]): void
  }
  videoLayer: { remove(): void }
  cursor: { load(...a: unknown[]): void }
  app: { destroy: (...a: unknown[]) => void; canvas: unknown }
  appInitialized: boolean
  time: { setMode(m: 'virtual' | 'live'): void; getPendingTimerCount(): number }
  resetAndStartEvents(events: Event[], options?: Record<string, unknown>): void
}

/** 呼び出しを通したまま、共有の order 配列へ名前を積む。 */
function record(order: string[], obj: object, method: string, label: string): void {
  const orig = (obj as Record<string, (...a: unknown[]) => unknown>)[method].bind(obj)
  vi.spyOn(obj as never, method as never).mockImplementation(((...a: unknown[]) => {
    order.push(label)
    return orig(...a)
  }) as never)
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('NovelRenderer × Stage 配線 (#828 7c)', () => {
  it.each([
    ['progress', carryPolicyFor('progress')],
    ['fresh', carryPolicyFor('fresh')],
  ] as const)(
    'resetAndStartEvents(%s): 立ち絵のクリア → stage.reset(方針そのまま) → BGM → カーソル の順',
    (_name, policy) => {
      const r = new NovelRenderer()
      r.setScenes(SCENES)
      const h = internalsOf<Layers>(r)
      const order: string[] = []
      record(order, h.stage, 'reset', 'stage.reset')
      const reset = vi.spyOn(h.stage, 'reset')
      record(order, h.videoLayer, 'remove', 'video.remove')
      record(order, h.characterLayer, 'clear', 'char.clear')
      record(order, h.characterLayer, 'clearForSceneTransition', 'char.clearForTransition')
      record(order, h.characterLayer, 'setCamera', 'char.setCamera')
      record(order, h.propLayer, 'setCamera', 'prop.setCamera')
      record(order, h.backgroundBoardLayer, 'setCamera', 'bb.setCamera')
      record(order, h.cursor, 'load', 'cursor.load')
      vi.spyOn(r.getAudioManager(), 'stopBgm').mockImplementation(() => {
        order.push('stopBgm')
      })
      order.length = 0
      h.resetAndStartEvents(SCENES[0].events, { ...policy })
      expect(reset).toHaveBeenCalledTimes(1)
      expect(reset).toHaveBeenCalledWith({
        preserveBackgroundForTransition: policy.preserveBackgroundForTransition,
        carryBgm: policy.carryBgm,
      })
      const idx = (l: string) => order.indexOf(l)
      const clearLabel = policy.preserveBackgroundForTransition
        ? 'char.clearForTransition'
        : 'char.clear'
      expect(idx('video.remove')).toBeGreaterThanOrEqual(0)
      expect(idx(clearLabel)).toBeGreaterThanOrEqual(0)
      expect(idx('video.remove')).toBeLessThan(idx('stage.reset'))
      expect(idx(clearLabel)).toBeLessThan(idx('stage.reset'))
      // カメラの再配置は stage.reset の中。順序は 背景板 → 大道具 → 立ち絵、かつ立ち絵クリアより後
      expect(idx('stage.reset')).toBeLessThan(idx('bb.setCamera'))
      expect(idx('bb.setCamera')).toBeLessThan(idx('prop.setCamera'))
      expect(idx('prop.setCamera')).toBeLessThan(idx('char.setCamera'))
      expect(idx(clearLabel)).toBeLessThan(idx('char.setCamera'))
      if (!policy.carryBgm) {
        expect(idx('char.setCamera')).toBeLessThan(idx('stopBgm'))
        expect(idx('stopBgm')).toBeLessThan(idx('cursor.load'))
      }
      expect(idx('char.setCamera')).toBeLessThan(idx('cursor.load'))
    }
  )

  it('resetAndStartEvents: 進行は輪郭を解除せず(伝播なし)、新規開始は 立ち絵→大道具 の順で null を伝える', () => {
    const r = new NovelRenderer()
    r.setScenes(SCENES)
    const h = internalsOf<Layers>(r)
    internals(r).processDirective({
      PaperDollOutline: { enabled: true, color: '#abcdef', thickness: 3 },
    } as Event)
    const order: string[] = []
    record(order, h.characterLayer, 'setPaperDollOutline', 'char.outline')
    record(order, h.propLayer, 'setPaperDollOutline', 'prop.outline')
    const charO = vi.spyOn(h.characterLayer, 'setPaperDollOutline')
    const propO = vi.spyOn(h.propLayer, 'setPaperDollOutline')
    h.resetAndStartEvents(SCENES[0].events, { ...carryPolicyFor('progress') })
    expect(r.getSnapshot().paperDollOutline).toEqual({ color: '#abcdef', thickness: 3 })
    expect(order).toEqual([])
    h.resetAndStartEvents(SCENES[0].events, { ...carryPolicyFor('fresh') })
    expect(r.getSnapshot().paperDollOutline).toBeNull()
    expect(order).toEqual(['char.outline', 'prop.outline'])
    expect(charO).toHaveBeenLastCalledWith(null)
    expect(propO).toHaveBeenLastCalledWith(null)
  })

  it('resetAndStartEvents の持ち越し判定は渡された方針だけで決まる（carryBgm と preserve は独立）', () => {
    const r = new NovelRenderer()
    r.setScenes(SCENES)
    const h = internalsOf<Layers>(r)
    const reset = vi.spyOn(h.stage, 'reset')
    const stop = vi.spyOn(r.getAudioManager(), 'stopBgm').mockImplementation(() => {})
    h.resetAndStartEvents(SCENES[0].events, {
      preserveBackgroundForTransition: true,
      carryBgm: false,
    })
    expect(reset).toHaveBeenLastCalledWith({
      preserveBackgroundForTransition: true,
      carryBgm: false,
    })
    expect(stop).toHaveBeenCalledTimes(1)
    h.resetAndStartEvents(SCENES[0].events, {
      preserveBackgroundForTransition: false,
      carryBgm: true,
    })
    expect(reset).toHaveBeenLastCalledWith({
      preserveBackgroundForTransition: false,
      carryBgm: true,
    })
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('resetAndStartEvents: 方針を省略した項目は「持ち越さない」として stage.reset へ渡る', () => {
    const r = new NovelRenderer()
    r.setScenes(SCENES)
    const h = internalsOf<Layers>(r)
    const reset = vi.spyOn(h.stage, 'reset')
    vi.spyOn(r.getAudioManager(), 'stopBgm').mockImplementation(() => {})
    h.resetAndStartEvents(SCENES[0].events)
    expect(reset).toHaveBeenLastCalledWith({
      preserveBackgroundForTransition: false,
      carryBgm: false,
    })
    h.resetAndStartEvents(SCENES[0].events, { carryBgm: true })
    expect(reset).toHaveBeenLastCalledWith({
      preserveBackgroundForTransition: false,
      carryBgm: true,
    })
  })

  it('applyState: stage.restore(state) を 背景板・大道具・立ち絵の復元より前に、状態そのままで呼ぶ', () => {
    const r = new NovelRenderer()
    r.setScenes(SCENES)
    const h = internalsOf<Layers>(r)
    internals(r).processDirective({
      CameraMode: { mode: 'Theater', orientation: 'Stage', elevation: 'LookUp' },
    } as Event)
    internals(r).processDirective({
      PaperDollOutline: { enabled: true, color: '#123456', thickness: 2 },
    } as Event)
    const snap = r.getSnapshot()
    const order: string[] = []
    record(order, h.stage, 'restore', 'stage.restore')
    const restore = vi.spyOn(h.stage, 'restore')
    record(order, h.characterLayer, 'setPaperDollOutline', 'char.outline')
    record(order, h.propLayer, 'setPaperDollOutline', 'prop.outline')
    record(order, h.backgroundBoardLayer, 'setCamera', 'bb.setCamera')
    record(order, h.propLayer, 'setCamera', 'prop.setCamera')
    record(order, h.characterLayer, 'setCamera', 'char.setCamera')
    record(order, h.backgroundBoardLayer, 'restore', 'bb.restore')
    record(order, h.propLayer, 'restore', 'prop.restore')
    record(order, h.characterLayer, 'clear', 'char.clear')
    internals(r).applyState(snap)
    expect(restore).toHaveBeenCalledTimes(1)
    expect(restore).toHaveBeenCalledWith(snap)
    expect(order).toEqual([
      'stage.restore',
      'char.outline',
      'prop.outline',
      'bb.setCamera',
      'prop.setCamera',
      'char.setCamera',
      'bb.restore',
      'prop.restore',
      'char.clear',
    ])
  })

  it('[カメラ:] / [紙人形輪郭:] ディレクティブは stage.setCamera / setPaperDollOutline へ旧実装と同じ引数で渡る', () => {
    const r = new NovelRenderer()
    r.setScenes(SCENES)
    const h = internalsOf<Layers>(r)
    const cam = vi.spyOn(h.stage, 'setCamera')
    const outline = vi.spyOn(h.stage, 'setPaperDollOutline')
    const p = internals(r)
    p.processDirective({
      CameraMode: { mode: 'Theater', orientation: 'Stage', elevation: 'LookDown' },
    } as Event)
    p.processDirective({ CameraMode: { mode: 'Theater' } } as Event)
    p.processDirective({ CameraMode: { mode: 'Novel' } } as Event)
    expect(cam.mock.calls).toEqual([
      ['Theater', 'Stage', 'LookDown'],
      ['Theater', 'Audience', null],
      ['Novel', 'Audience', null],
    ])
    p.processDirective({
      PaperDollOutline: { enabled: true, color: '#111111', thickness: 4 },
    } as Event)
    p.processDirective({ PaperDollOutline: { enabled: true } } as Event)
    p.processDirective({ PaperDollOutline: { enabled: false } } as Event)
    expect(outline.mock.calls.map((c) => c[0])).toEqual([
      { color: '#111111', thickness: 4 },
      { color: '#ffffff', thickness: 2 },
      null,
    ])
  })

  it('[カメラ:] の再配置は 背景板 → 大道具 → 立ち絵 の順', () => {
    const r = new NovelRenderer()
    r.setScenes(SCENES)
    const h = internalsOf<Layers>(r)
    const order: string[] = []
    record(order, h.backgroundBoardLayer, 'setCamera', 'bb')
    record(order, h.propLayer, 'setCamera', 'prop')
    record(order, h.characterLayer, 'setCamera', 'char')
    internals(r).processDirective({ CameraMode: { mode: 'Theater' } } as Event)
    expect(order).toEqual(['bb', 'prop', 'char'])
  })

  it('getSnapshot の演出フィールドは stage.capture() 由来で、キー集合と値が一致する', () => {
    const r = new NovelRenderer()
    r.setScenes(SCENES)
    const h = internalsOf<Layers>(r)
    internals(r).processDirective({ Blackout: { action: 'On' } } as Event)
    internals(r).processDirective({
      CameraMode: { mode: 'Theater', orientation: 'Stage' },
    } as Event)
    const capture = vi.spyOn(h.stage, 'capture')
    const snap = r.getSnapshot()
    expect(capture).toHaveBeenCalledTimes(1)
    const c = capture.mock.results[0].value as Record<string, unknown>
    for (const [k, v] of Object.entries(c)) {
      expect((snap as unknown as Record<string, unknown>)[k]).toEqual(v)
    }
    // 演出フィールド9個すべてがスナップショットに載っている
    expect(Object.keys(c)).toHaveLength(9)
  })

  it('destroy: stage.cancelAllTimers は動画破棄より前、stage.release は app.destroy より前で、タイマーは残らない', () => {
    vi.useFakeTimers()
    const r = new NovelRenderer()
    const h = internalsOf<Layers>(r)
    h.time.setMode('virtual')
    h.appInitialized = true
    Object.defineProperty(h.app, 'canvas', {
      configurable: true,
      value: { removeEventListener: () => {} },
    })
    const order: string[] = []
    h.app.destroy = () => {
      order.push('app.destroy')
    }
    record(order, h.stage, 'cancelAllTimers', 'stage.cancelAllTimers')
    record(order, h.stage, 'release', 'stage.release')
    record(order, h.videoLayer, 'remove', 'video.remove')
    h.stage.effects.startShake(10, 5000)
    expect(h.time.getPendingTimerCount()).toBeGreaterThan(0)
    r.destroy()
    expect(order.filter((l) => l.startsWith('stage.'))).toEqual([
      'stage.cancelAllTimers',
      'stage.release',
    ])
    expect(order.indexOf('stage.cancelAllTimers')).toBeLessThan(order.indexOf('video.remove'))
    expect(order.indexOf('stage.release')).toBeLessThan(order.indexOf('app.destroy'))
    expect(h.time.getPendingTimerCount()).toBe(0)
  })
})
