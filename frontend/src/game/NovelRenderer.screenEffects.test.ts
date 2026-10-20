/**
 * NovelRenderer と ScreenEffectsController の配線 (#828 7b)。
 *
 * 画面効果の中身は ScreenEffectsController.test.ts に任せ、ここでは「レンダラがどの時点でどのメソッドを
 * どの順で呼ぶか」だけを見る。守る契約:
 *  - resetAndStartEvents: 画面効果の消去（スクリム退避リセットを含む）は BGM 停止より前、かつ stage 位置は戻さない
 *  - applyState: 効果の停止 → stage 位置リセット → スクリム退避リセット → 暗転復元 の順
 *  - getSnapshot の isBlackout は ScreenEffectsController.capture 由来で、セーブ形式は変わらない
 *  - processDirective の Shake/Flash/Fade/Blackout は引数をそのまま渡す
 *  - destroy は全 timer を止める
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NovelRenderer } from './NovelRenderer'
import type { Event, EventScene } from '../types'
import { confineForTest } from '../test/confinement'
import { internals, internalsOf, screenEffectsControllerOf } from '../test/rendererInternals'

function scene(id: string, events: Event[]): EventScene {
  return { id, title: id, view: 'TopDown', events }
}

const SCENES = [
  scene('entry', [{ Narration: { text: ['本文'] } } as Event]),
  scene('out', [{ Narration: { text: ['外'] } } as Event]),
]

interface Hooks {
  resetAndStartEvents(events: Event[], options?: Record<string, unknown>): void
  app: {
    stage: { position: { x: number; y: number; set(x: number, y: number): void } }
    destroy: (...a: unknown[]) => void
    canvas: unknown
  }
  appInitialized: boolean
  time: { setMode(m: 'virtual' | 'live'): void; getPendingTimerCount(): number }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('NovelRenderer × ScreenEffectsController 配線 (#828 7b)', () => {
  it('processDirective の Shake/Flash/Fade/Blackout は引数をそのまま ScreenEffectsController へ渡す', () => {
    const r = new NovelRenderer()
    const fx = screenEffectsControllerOf(r)
    const shake = vi.spyOn(fx, 'startShake').mockImplementation(() => {})
    const flash = vi.spyOn(fx, 'startFlash').mockImplementation(() => {})
    const fade = vi.spyOn(fx, 'startFade').mockImplementation(() => {})
    const black = vi.spyOn(fx, 'setBlackout')
    const p = internals(r)
    p.processDirective({ Shake: { intensity_px: 7, duration_ms: 300 } } as Event)
    p.processDirective({
      Flash: {
        color: '#ff0000',
        alpha: 0.5,
        duration_ms: 200,
        area: { x: 0, y: 0, w: 1, h: 1 },
        strobe: 3,
        interval_ms: 90,
      },
    } as Event)
    p.processDirective({
      Flash: { color: '#00ff00', alpha: 1, duration_ms: 100, strobe: 1 },
    } as Event)
    p.processDirective({
      Fade: { target: 'all', color: '#000000', from_alpha: 0, to_alpha: 1, duration_ms: 500 },
    } as Event)
    p.processDirective({ Blackout: { action: 'On' } } as Event)
    p.processDirective({ Blackout: { action: 'Off' } } as Event)
    expect(shake).toHaveBeenCalledWith(7, 300)
    expect(flash).toHaveBeenNthCalledWith(1, '#ff0000', 0.5, 200, { x: 0, y: 0, w: 1, h: 1 }, 3, 90)
    expect(flash).toHaveBeenNthCalledWith(2, '#00ff00', 1, 100, null, 1, null)
    expect(fade).toHaveBeenCalledWith('all', '#000000', 0, 1, 500)
    expect(black.mock.calls).toEqual([[true], [false]])
  })

  it('getSnapshot().isBlackout は暗転オーバーレイの状態、applyState で復元され、セーブ形式のキーは変わらない', () => {
    const r = new NovelRenderer()
    r.setScenes(SCENES)
    const keysBefore = Object.keys(r.getSnapshot()).sort()
    expect(keysBefore).toContain('isBlackout')
    internals(r).processDirective({ Blackout: { action: 'On' } } as Event)
    expect(r.getSnapshot().isBlackout).toBe(true)
    const snap = r.getSnapshot()
    internals(r).processDirective({ Blackout: { action: 'Off' } } as Event)
    expect(r.getSnapshot().isBlackout).toBe(false)
    internals(r).applyState(snap)
    expect(r.getSnapshot().isBlackout).toBe(true)
    expect(Object.keys(r.getSnapshot()).sort()).toEqual(keysBefore)
  })

  it('applyState は 効果停止 → stage 位置リセット → スクリム退避リセット → 暗転復元 の順で呼ぶ', () => {
    const r = new NovelRenderer()
    r.setScenes(SCENES)
    const fx = screenEffectsControllerOf(r)
    const order: string[] = []
    for (const name of [
      'reset',
      'resetStagePosition',
      'resetNovelScrimState',
      'restore',
    ] as const) {
      const orig = fx[name].bind(fx) as (...a: unknown[]) => unknown
      vi.spyOn(fx, name).mockImplementation(((...a: unknown[]) => {
        order.push(name)
        return orig(...a)
      }) as never)
    }
    internals(r).applyState({ ...r.getSnapshot(), isBlackout: true })
    expect(order).toEqual(['reset', 'resetStagePosition', 'resetNovelScrimState', 'restore'])
    expect(r.getSnapshot().isBlackout).toBe(true)
  })

  it('applyState は進行中の揺れ・フェードを止めて stage を原点へ戻し、以後 timer が復活しない', () => {
    vi.useFakeTimers()
    const r = new NovelRenderer()
    r.setScenes(SCENES)
    const h = internalsOf<Hooks>(r)
    h.time.setMode('virtual')
    const fx = screenEffectsControllerOf(r)
    fx.startShake(30, 1000)
    h.app.stage.position.set(5, 5)
    const pendingWithShake = h.time.getPendingTimerCount()
    expect(pendingWithShake).toBeGreaterThan(0)
    internals(r).applyState(r.getSnapshot())
    expect(h.app.stage.position.x).toBe(0)
    expect(h.app.stage.position.y).toBe(0)
    expect(h.time.getPendingTimerCount()).toBeLessThan(pendingWithShake)
    expect((fx as unknown as { shakeTimer: number | null }).shakeTimer).toBeNull()
  })

  it('resetAndStartEvents は効果消去を BGM 停止より先に行い、stage 位置は戻さない', () => {
    const r = new NovelRenderer()
    r.setScenes(SCENES)
    const h = internalsOf<Hooks>(r)
    const fx = screenEffectsControllerOf(r)
    const order: string[] = []
    const origReset = fx.reset.bind(fx)
    vi.spyOn(fx, 'reset').mockImplementation(() => {
      order.push('reset')
      origReset()
    })
    const stagePos = vi.spyOn(fx, 'resetStagePosition')
    vi.spyOn(fx, 'resetNovelScrimState').mockImplementation(() => {
      order.push('resetNovelScrimState')
    })
    vi.spyOn(r.getAudioManager(), 'stopBgm').mockImplementation(() => {
      order.push('stopBgm')
    })
    h.app.stage.position.set(9, 9)
    h.resetAndStartEvents(SCENES[0].events)
    expect(order.indexOf('reset')).toBeGreaterThanOrEqual(0)
    expect(order.indexOf('reset')).toBeLessThan(order.indexOf('stopBgm'))
    // 旧実装どおり: 新しいイベント列の開始では stage 位置を戻さない（原点リセットは applyState / endStory のみ）
    expect(stagePos).not.toHaveBeenCalled()
    expect(h.app.stage.position.x).toBe(9)
    // 7c: スクリム退避リセットは Stage.reset の末尾（演出消去のひとかたまり）で行う。旧実装では BGM 停止の後だったが、
    // 音声と独立で同期区間内なので観測できる差はない。Issue #828 の順序（タイマー停止 → 演出消去 → BGM）に揃えた。
    expect(order.indexOf('resetNovelScrimState')).toBeGreaterThan(order.indexOf('reset'))
    expect(order.indexOf('resetNovelScrimState')).toBeLessThan(order.indexOf('stopBgm'))
  })

  it('endStory（confinement 外への遷移）は揺れを止めて stage を原点へ戻し、終劇フェードを startEndStoryBlackoutFade に任せる', () => {
    vi.useFakeTimers()
    const r = new NovelRenderer()
    r.setScenes(SCENES)
    const h = internalsOf<Hooks>(r)
    h.app.stage.position.set(4, 4)
    const fx = screenEffectsControllerOf(r)
    const endFade = vi.spyOn(fx, 'startEndStoryBlackoutFade')
    const reset = vi.spyOn(fx, 'reset')
    const stagePos = vi.spyOn(fx, 'resetStagePosition')
    confineForTest(r, ['entry'])
    r.jumpToScene('out')
    expect(reset).toHaveBeenCalled()
    expect(stagePos).toHaveBeenCalled()
    expect(h.app.stage.position.x).toBe(0)
    expect(endFade).toHaveBeenCalledTimes(1)
  })

  it('resetAndStartEvents の carryBgm では BGM を止めないが、効果は消す', () => {
    const r = new NovelRenderer()
    r.setScenes(SCENES)
    const h = internalsOf<Hooks>(r)
    const fx = screenEffectsControllerOf(r)
    const reset = vi.spyOn(fx, 'reset')
    const stop = vi.spyOn(r.getAudioManager(), 'stopBgm').mockImplementation(() => {})
    h.resetAndStartEvents(SCENES[0].events, { carryBgm: true })
    expect(reset).toHaveBeenCalledTimes(1)
    expect(stop).not.toHaveBeenCalled()
  })

  it('destroy は 揺れ・効果・スクリムの timer をすべて止める', () => {
    vi.useFakeTimers()
    const r = new NovelRenderer()
    const h = internalsOf<Hooks>(r)
    h.time.setMode('virtual')
    h.appInitialized = true
    Object.defineProperty(h.app, 'canvas', {
      configurable: true,
      value: { removeEventListener: () => {} },
    })
    h.app.destroy = () => {}
    const fx = screenEffectsControllerOf(r)
    const stop = vi.spyOn(fx, 'stopAllTimers')
    ;(fx as unknown as { effectOverlay: unknown }).effectOverlay = {
      alpha: 0,
      visible: false,
      clear: () => {},
      rect: () => {},
      fill: () => {},
    }
    fx.startShake(10, 5000)
    fx.startFade('all', '#000000', 0, 1, 5000)
    expect(h.time.getPendingTimerCount()).toBeGreaterThanOrEqual(2)
    r.destroy()
    expect(stop).toHaveBeenCalledTimes(1)
    expect(h.time.getPendingTimerCount()).toBe(0)
  })

  it('intermission のタブロー描画タイマーが発火すると hideEffectOverlay が呼ばれる', () => {
    vi.useFakeTimers()
    const r = new NovelRenderer()
    r.setScenes(SCENES)
    const h = internalsOf<Hooks & { initialized: boolean }>(r)
    h.time.setMode('virtual')
    h.initialized = true
    const fx = screenEffectsControllerOf(r)
    const hide = vi.spyOn(fx, 'hideEffectOverlay')
    r.setIntermissionScene([{ Narration: { text: ['幕間'] } } as Event], {
      backgroundFadeMs: 10,
      characterFadeMs: 10,
    })
    confineForTest(r, ['entry'])
    r.jumpToScene('out')
    // endStory 時点でも別経路（reset 等）が呼ぶので、タイマー発火による増分で見る
    const before = hide.mock.calls.length
    r.getTimeController().tick(10)
    expect(hide.mock.calls.length).toBe(before + 1)
  })

  it('setDialogStyle("adv") は hideNovelScrim を呼び、"novel" では呼ばない', () => {
    const r = new NovelRenderer()
    const fx = screenEffectsControllerOf(r)
    const hide = vi.spyOn(fx, 'hideNovelScrim')
    r.setDialogStyle('novel')
    expect(hide).not.toHaveBeenCalled()
    r.setDialogStyle('adv')
    expect(hide).toHaveBeenCalledTimes(1)
  })
})
