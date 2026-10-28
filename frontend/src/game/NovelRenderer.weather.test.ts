/**
 * NovelRenderer 天候 (#706) の配線統合テスト。
 *
 * 粒の式は weatherParticles.test.ts、WeatherLayer 自体は WeatherLayer.test.ts、ディレクティブ→layer は
 * directives.weather.test.ts でカバー済み。ここでは NovelRenderer 側の配線だけを見る:
 * settled state（種類＋強さ）の蓄積と置換、`[天候: なし]`、`[場面転換]`・新規開始・終劇でのクリア、シーン間ジャンプでの
 * 持ち越し、goBack / セーブ復元 / スキップ / シーク、レイヤー順、イベント絵の背面隠しの対象外、ズーム非対象、
 * reduced-motion、破棄でのリーク。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { NovelRenderer } from './NovelRenderer'
import type { Event, EventScene } from '../types'
import type { NovelGameState } from './GameState'
import { gameStateToSaveSlot, saveSlotToGameState } from './novelLayout'
import { computeWeatherParticle } from './weatherParticles'
import { internals, internalsOf, type RendererInternals } from '../test/rendererInternals'

function narration(...lines: string[]): Event {
  return { Narration: { text: lines } }
}
function weather(kind: 'Rain' | 'Snow' | 'Sakura', intensity?: number): Event {
  return { Weather: intensity === undefined ? { kind } : { kind, intensity } } as Event
}
const WEATHER_EXIT = 'WeatherExit' as Event
function cam(mode: 'Theater' | 'Novel', extra: Record<string, unknown> = {}): Event {
  return { CameraMode: { mode, ...extra } } as Event
}
function scene(id: string, events: Event[]): EventScene {
  return { id, title: id, view: 'TopDown', events }
}

interface WeatherLayerForTest {
  scale: { x: number; y: number }
  position: { x: number; y: number }
  visible: boolean
  set: (...args: unknown[]) => void
  restore: (...args: unknown[]) => void
  clear: () => void
  particleCount: () => number
  isParticlesVisible: () => boolean
  isRunning: () => boolean
  getParticleGraphics: () => Array<{ x: number; y: number; destroyed: boolean }>
}
interface LocalInternals extends RendererInternals {
  weatherLayer: WeatherLayerForTest
  stageFrontLayer: object
  wallLayer: WeatherLayerForTest
  backgroundBoardLayer: WeatherLayerForTest
  characterLayer: object & {
    getZoomFocus(n: string): { x: number; y: number } | null
    hasCharacter(n: string): boolean
  }
  propLayer: object
  eventImageLayer: object
  curtainLayer: object
  dialogBox: object
  telopLayer: object
  novelScrim: object
  cameraZoom: { getPose(): { scale: number; x: number; y: number } }
  time: {
    setMode(m: string): void
    tick(ms: number): void
    getPendingTimerCount(): number
  }
  app: {
    init: (...args: unknown[]) => Promise<void>
    stage: { children: unknown[] }
    canvas: unknown
    renderer?: { resolution: number }
    destroy: (...args: unknown[]) => void
  }
}

// prefersReducedMotion() は最初の呼び出しで MediaQueryList を掴んで以後 .matches を読む。
const mq = { matches: false }
beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => mq })
})
beforeEach(() => {
  mq.matches = false
})

/** 仮想時間のレンダラ。天候のタイマーを実時計に漏らさないため、最初に仮想へ切り替える。 */
function makeRenderer(): { r: NovelRenderer; p: LocalInternals } {
  const r = new NovelRenderer()
  const p = internals<LocalInternals>(r)
  // TimeController は全レンダラ共有のシングルトン（defaultTimeController）。前のテストのタイマーと仮想時刻を持ち越さない。
  p.time.setMode('live')
  p.time.setMode('virtual')
  return { r, p }
}

async function initRenderer(r: NovelRenderer): Promise<void> {
  const ri = internals<LocalInternals>(r)
  vi.spyOn(ri.app, 'init').mockResolvedValue()
  Object.defineProperty(ri.app, 'canvas', {
    configurable: true,
    value: document.createElement('canvas'),
  })
  Object.defineProperty(ri.app, 'renderer', { configurable: true, value: { resolution: 1 } })
  await r.init(document.createElement('div'))
}

function cleanupRenderer(r: NovelRenderer): void {
  internals<LocalInternals>(r).app.destroy = () => {}
  r.destroy()
}

function muteAudio(r: NovelRenderer): void {
  vi.spyOn(r.getAudioManager(), 'ensureContext').mockImplementation(() => {})
}

const apply = (r: NovelRenderer, s: NovelGameState) =>
  (r as unknown as { applyState(s: NovelGameState): void }).applyState(s)

afterEach(() => {
  vi.restoreAllMocks()
})

describe('NovelRenderer 天候 settled state (#706)', () => {
  it('[天候:] の無いシーンは weather が null', () => {
    const { r } = makeRenderer()
    r.setScenes([scene('a', [narration('one')])])
    expect(r.getSnapshot().weather).toBeNull()
  })

  it('[天候:] で weather が「種類＋強さ」だけの状態になる（強さ省略は 1）', () => {
    const { r } = makeRenderer()
    r.setScenes([scene('a', [weather('Rain'), narration('one')])])
    expect(r.getSnapshot().weather).toEqual({ kind: 'Rain', intensity: 1 })
  })

  it('強さ指定はそのまま状態に載る。範囲外はクランプされる', () => {
    const { r } = makeRenderer()
    r.setScenes([scene('a', [weather('Snow', 1.5), narration('one')])])
    expect(r.getSnapshot().weather).toEqual({ kind: 'Snow', intensity: 1.5 })
    r.setScenes([scene('a', [weather('Snow', 99), narration('one')])])
    expect(r.getSnapshot().weather).toEqual({ kind: 'Snow', intensity: 3 })
  })

  it('単一スロット: 2 回目の [天候:] が前の天候を置換する（蓄積しない）', () => {
    const { r, p } = makeRenderer()
    r.setScenes([scene('a', [weather('Rain'), weather('Sakura', 2), narration('one')])])
    expect(r.getSnapshot().weather).toEqual({ kind: 'Sakura', intensity: 2 })
    // 表示も桜の分だけ（雨の粒が残らない）
    expect(p.weatherLayer.particleCount()).toBe(80)
  })

  it('[天候: なし] で null に戻り、粒が消える。無いところへの [天候: なし] も安全', async () => {
    const { r, p } = makeRenderer()
    r.setScenes([
      scene('a', [
        WEATHER_EXIT,
        narration('one'),
        weather('Rain'),
        narration('two'),
        WEATHER_EXIT,
        narration('three'),
      ]),
    ])
    expect(r.getSnapshot().weather).toBeNull()
    await r.playScript([{ type: 'advance' }])
    expect(r.getSnapshot().weather?.kind).toBe('Rain')
    expect(p.weatherLayer.particleCount()).toBeGreaterThan(0)
    await r.playScript([{ type: 'advance' }])
    expect(r.getSnapshot().weather).toBeNull()
    expect(p.weatherLayer.particleCount()).toBe(0)
    expect(p.weatherLayer.isRunning()).toBe(false)
  })

  it('壁・舞台前面・背景板・単一スロット背景と独立（互いの状態を変えない）', () => {
    const { r } = makeRenderer()
    r.setScenes([
      scene('a', [
        { BackgroundBoard: { path: 'sky.png', depth: 10 } } as Event,
        { Wall: { path: 'glow.webp', loop: true, mute: true } } as Event,
        { StageFront: { path: 'hall.png' } } as Event,
        weather('Snow'),
        { Background: { path: 'room.png' } } as Event,
        narration('one'),
      ]),
    ])
    const s = r.getSnapshot()
    expect(s.weather?.kind).toBe('Snow')
    expect(s.stageFront?.path).toBe('hall.png')
    expect(s.wall?.path).toBe('glow.webp')
    expect(s.backgroundBoards).toEqual([{ path: 'sky.png', depth: 10 }])
    expect(s.backgroundPath).toBe('room.png')
  })

  it('[壁: なし]・[舞台前面: なし]・[動画退場] など他のクリアでは天候は消えない', () => {
    const { r } = makeRenderer()
    r.setScenes([
      scene('a', [
        weather('Rain'),
        'WallExit' as Event,
        'StageFrontExit' as Event,
        'VideoExit' as Event,
        narration('one'),
      ]),
    ])
    expect(r.getSnapshot().weather?.kind).toBe('Rain')
  })
})

describe('NovelRenderer 天候 のリセット・持ち越し (#706)', () => {
  it('[場面転換] で天候もクリアされ、粒も消える', async () => {
    const { r, p } = makeRenderer()
    r.setScenes([
      scene('a', [weather('Rain'), narration('one'), 'SceneTransition' as Event, narration('two')]),
    ])
    expect(r.getSnapshot().weather?.kind).toBe('Rain')
    const clear = vi.spyOn(p.weatherLayer, 'clear')
    await r.playScript([{ type: 'advance' }])
    expect(clear).toHaveBeenCalled()
    expect(r.getSnapshot().weather).toBeNull()
    expect(p.weatherLayer.particleCount()).toBe(0)
  })

  it('通常のシーン間ジャンプでは持ち越される', () => {
    const { r } = makeRenderer()
    r.setScenes([scene('a', [weather('Snow'), narration('one')]), scene('b', [narration('two')])])
    r.jumpToScene('b')
    expect(r.getSnapshot().weather?.kind).toBe('Snow')
  })

  it('setEvents()（新しいイベント列の開始）で天候はクリアされる', () => {
    const { r, p } = makeRenderer()
    r.setEvents([narration('zero')])
    const timersWithout = p.time.getPendingTimerCount()
    r.setEvents([weather('Sakura'), narration('one')])
    expect(r.getSnapshot().weather?.kind).toBe('Sakura')
    expect(p.time.getPendingTimerCount()).toBe(timersWithout + 1)
    r.setEvents([narration('two')])
    expect(r.getSnapshot().weather).toBeNull()
    expect(p.weatherLayer.particleCount()).toBe(0)
    expect(p.weatherLayer.isRunning()).toBe(false)
    expect(p.time.getPendingTimerCount()).toBe(timersWithout)
  })

  it('goBack で [天候:] 実行前の状態に戻る', async () => {
    const { r } = makeRenderer()
    r.setScenes([scene('a', [narration('one'), weather('Rain'), narration('two')])])
    expect(r.getSnapshot().weather).toBeNull()
    await r.playScript([{ type: 'advance' }])
    expect(r.getSnapshot().weather?.kind).toBe('Rain')
    r.goBack()
    expect(r.getSnapshot().weather).toBeNull()
  })

  it('goBack で天候を含む状態へ戻るときは restore（最終状態の即時反映）を通る', async () => {
    const { r, p } = makeRenderer()
    r.setScenes([scene('a', [weather('Rain', 2), narration('one'), narration('two')])])
    await r.playScript([{ type: 'advance' }])
    const restore = vi.spyOn(p.weatherLayer, 'restore')
    r.goBack()
    expect(restore).toHaveBeenCalledWith({ kind: 'Rain', intensity: 2 })
  })

  it('終劇で天候もクリアされ（粒・タイマーも止まる）、復元で戻る', () => {
    const { r, p } = makeRenderer()
    r.setScenes([scene('a', [weather('Rain'), narration('one'), narration('two')])])
    const before = r.getSnapshot()
    internalsOf<{ endStory(): void }>(r).endStory()
    expect(r.getSnapshot().weather).toBeNull()
    expect(p.weatherLayer.particleCount()).toBe(0)
    expect(p.weatherLayer.isRunning()).toBe(false)
    apply(r, before)
    expect(r.getSnapshot().weather).toEqual({ kind: 'Rain', intensity: 1 })
    expect(p.weatherLayer.particleCount()).toBeGreaterThan(0)
  })
})

describe('NovelRenderer 天候 のセーブ・復元・決定論 (#706)', () => {
  function roundTrip(state: NovelGameState): NovelGameState {
    return saveSlotToGameState(
      JSON.parse(JSON.stringify(gameStateToSaveSlot(state, { savedAt: 0, label: 't' } as never))),
      null
    )
  }

  it('セーブ → ロードで天候（種類＋強さだけ）が戻る。粒の位置は保存しない', () => {
    const { r } = makeRenderer()
    r.setScenes([scene('a', [weather('Sakura', 1.5), narration('one')])])
    r.getSnapshot()
    const slot = JSON.parse(
      JSON.stringify(gameStateToSaveSlot(r.getSnapshot(), { savedAt: 0, label: 't' } as never))
    )
    expect(slot.weather).toEqual({ kind: 'Sakura', intensity: 1.5 })
    expect(JSON.stringify(slot)).not.toMatch(/particle|elapsed/i)
    expect(saveSlotToGameState(slot, null).weather).toEqual({ kind: 'Sakura', intensity: 1.5 })
  })

  it('天候なしのセーブは weather: null のまま往復する', () => {
    const { r } = makeRenderer()
    r.setScenes([scene('a', [narration('one')])])
    expect(roundTrip(r.getSnapshot()).weather).toBeNull()
  })

  it('古いセーブ（weather キーが無い）は天候なしとして読める。壊れた強さはクランプされる', () => {
    const { r } = makeRenderer()
    r.setScenes([scene('a', [weather('Rain'), narration('one')])])
    const slot = JSON.parse(
      JSON.stringify(gameStateToSaveSlot(r.getSnapshot(), { savedAt: 0, label: 't' } as never))
    )
    slot.weather = { kind: 'Rain', intensity: 1e9 }
    expect(saveSlotToGameState(slot, null).weather?.intensity).toBe(3)
    delete slot.weather
    expect(saveSlotToGameState(slot, null).weather).toBeNull()
  })

  it('applyState（復元）で別の天候のスナップショットへ宣言的に入れ替わる', () => {
    const { r, p } = makeRenderer()
    r.setScenes([scene('a', [weather('Rain'), narration('one')])])
    apply(r, { ...r.getSnapshot(), weather: { kind: 'Snow', intensity: 2 } })
    expect(r.getSnapshot().weather).toEqual({ kind: 'Snow', intensity: 2 })
    expect(p.weatherLayer.particleCount()).toBe(140)
    apply(r, { ...r.getSnapshot(), weather: null })
    expect(r.getSnapshot().weather).toBeNull()
    expect(p.weatherLayer.particleCount()).toBe(0)
  })

  it('スキップ中に [天候:] を通過しても最終状態が残る（演出の中間状態を持たない）', async () => {
    const { r } = makeRenderer()
    r.setScenes([
      scene('a', [narration('one'), weather('Rain'), weather('Snow', 2), narration('two')]),
    ])
    internalsOf<{ skipMode: boolean }>(r).skipMode = true
    await r.playScript([{ type: 'advance' }])
    expect(r.getSnapshot().weather).toEqual({ kind: 'Snow', intensity: 2 })
  })

  it('シーク（seekTo）でも指定位置の天候に追従する', async () => {
    const { r } = makeRenderer()
    r.setScenes([
      scene('a', [
        narration('one'),
        weather('Rain'),
        narration('two'),
        WEATHER_EXIT,
        narration('three'),
      ]),
    ])
    await r.playScript([{ type: 'advance' }, { type: 'advance' }])
    expect(r.getSnapshot().weather).toBeNull()
    const seek = (i: number) =>
      internalsOf<{ seekToTextEventDisplayIndex(i: number): void }>(r).seekToTextEventDisplayIndex(
        i
      )
    seek(1)
    expect(r.getSnapshot().weather?.kind).toBe('Rain')
    seek(0)
    expect(r.getSnapshot().weather).toBeNull()
  })

  it('同じ状態を復元して同じ時間だけ進めると、粒の位置が完全に一致する（決定論）', () => {
    const pos = (p: LocalInternals) =>
      p.weatherLayer.getParticleGraphics().map((g) => [g.x, g.y] as const)
    const a = makeRenderer()
    a.r.setScenes([scene('a', [weather('Sakura', 1.5), narration('one')])])
    a.p.time.tick(2500)
    const snap = a.r.getSnapshot()
    const posA = pos(a.p)

    const b = makeRenderer() // 時計を 0 に戻す
    b.r.setScenes([scene('a', [narration('x')])])
    b.p.time.tick(777) // 起点がずれていても
    apply(b.r, snap)
    b.p.time.tick(2500)

    // a は set 直後（経過 0）から 2500ms、b は復元（経過 0）から 2500ms
    expect(pos(b.p)).toEqual(posA)
    // 純粋関数の値とも一致する（16ms 刻みの最後のフレーム）
    const f = computeWeatherParticle('Sakura', 0, Math.floor(2500 / 16) * 16, 800, 450)
    const g0 = b.p.weatherLayer.getParticleGraphics()[0]
    expect(g0.x).toBeCloseTo(f.x, 6)
    expect(g0.y).toBeCloseTo(f.y, 6)
  })
})

describe('NovelRenderer 天候 のレイヤー順・可視性・破棄 (#706)', () => {
  it('キャラ・小道具・幕・イベント絵・舞台前面より手前、スクリム・会話窓・テロップより奥', async () => {
    const r = new NovelRenderer()
    muteAudio(r)
    await initRenderer(r)
    const ri = internals<LocalInternals>(r)
    const ch = ri.app.stage.children
    const idx = (o: unknown) => ch.indexOf(o)
    const w = idx(ri.weatherLayer)
    expect(w).toBeGreaterThanOrEqual(0)
    expect(w).toBeGreaterThan(idx(ri.characterLayer))
    expect(w).toBeGreaterThan(idx(ri.propLayer))
    expect(w).toBeGreaterThan(idx(ri.curtainLayer))
    expect(w).toBeGreaterThan(idx(ri.eventImageLayer))
    expect(w).toBeGreaterThan(idx(ri.stageFrontLayer))
    expect(w).toBeGreaterThan(idx(ri.wallLayer))
    expect(w).toBeLessThan(idx(ri.novelScrim))
    expect(w).toBeLessThan(idx(ri.dialogBox))
    expect(w).toBeLessThan(idx(ri.telopLayer))
    expect(ch.filter((c) => c === ri.weatherLayer)).toHaveLength(1)
    cleanupRenderer(r)
  })

  it('カーテンコール配置（幕を背景板の直後へ差し替え）でも天候は幕・キャラより手前のまま', async () => {
    const r = new NovelRenderer()
    muteAudio(r)
    await initRenderer(r)
    const ri = internals<LocalInternals>(r)
    ri.time.setMode('virtual')
    r.setScenes([
      scene('a', [
        { Curtain: { path: 'c.png', characters_in_front: true } } as Event,
        weather('Rain'),
        narration('one'),
      ]),
    ])
    const ch = ri.app.stage.children
    expect(ch.indexOf(ri.weatherLayer)).toBeGreaterThan(ch.indexOf(ri.curtainLayer))
    expect(ch.indexOf(ri.weatherLayer)).toBeGreaterThan(ch.indexOf(ri.characterLayer))
    expect(ch.indexOf(ri.weatherLayer)).toBeLessThan(ch.indexOf(ri.dialogBox))
    cleanupRenderer(r)
  })

  it('イベント絵（背面を隠す）の間も天候は隠れない（手前の画面空間オーバーレイ）', async () => {
    const r = new NovelRenderer()
    muteAudio(r)
    await initRenderer(r)
    const ri = internals<LocalInternals>(r)
    const shouldHide = vi
      .spyOn(ri.eventImageLayer as { shouldHideBackLayer(): boolean }, 'shouldHideBackLayer')
      .mockReturnValue(true)
    ;(r as unknown as { applyEventImageVisibility(): void }).applyEventImageVisibility()
    expect(ri.wallLayer.visible).toBe(false)
    expect(ri.weatherLayer.visible).toBe(true)
    shouldHide.mockReturnValue(false)
    ;(r as unknown as { applyEventImageVisibility(): void }).applyEventImageVisibility()
    expect(ri.weatherLayer.visible).toBe(true)
    cleanupRenderer(r)
  })

  it('destroy() でタイマーと粒の Graphics を片付ける', async () => {
    const r = new NovelRenderer()
    muteAudio(r)
    const ri = internals<LocalInternals>(r)
    ri.time.setMode('live')
    ri.time.setMode('virtual')
    await initRenderer(r)
    r.setScenes([scene('a', [weather('Rain'), narration('one')])])
    const gs = [...ri.weatherLayer.getParticleGraphics()]
    expect(gs.length).toBeGreaterThan(0)
    expect(ri.weatherLayer.isRunning()).toBe(true)
    cleanupRenderer(r)
    expect(ri.weatherLayer.particleCount()).toBe(0)
    expect(gs.every((g) => g.destroyed)).toBe(true)
    expect(ri.weatherLayer.isRunning()).toBe(false)
  })

  it('reduced-motion では粒を表示しないが状態は保つ', () => {
    mq.matches = true
    const { r, p } = makeRenderer()
    r.setScenes([scene('a', [weather('Rain'), narration('one')])])
    expect(r.getSnapshot().weather?.kind).toBe('Rain')
    expect(p.weatherLayer.isParticlesVisible()).toBe(false)
  })
})

describe('NovelRenderer 天候 のカメラ・ズーム (#706)', () => {
  function make(events: Event[]) {
    const { r, p } = makeRenderer()
    r.setScenes([scene('a', events)])
    vi.spyOn(p.characterLayer, 'getZoomFocus').mockImplementation(() => ({ x: 100, y: 100 }))
    vi.spyOn(p.characterLayer, 'hasCharacter').mockImplementation(() => true)
    return { r, p }
  }

  it('ズームしても天候レイヤーは動かない（壁・背景板は動く）', () => {
    const { r, p } = make([
      { BackgroundBoard: { path: 'sky.png', depth: 0 } } as Event,
      { Wall: { path: 'glow.webp', loop: true, mute: true } } as Event,
      weather('Rain'),
      narration('one'),
    ])
    internals(r).processDirective(cam('Theater', { zoom: 'ミナ', zoom_strength: 2 }))
    p.time.tick(2000)
    expect(p.cameraZoom.getPose().scale).toBe(2)
    expect(p.wallLayer.scale.x).toBe(2)
    expect(p.backgroundBoardLayer.scale.x).toBe(2)
    expect(p.weatherLayer.scale.x).toBe(1)
    expect(p.weatherLayer.scale.y).toBe(1)
    expect(p.weatherLayer.position.x).toBe(0)
    expect(p.weatherLayer.position.y).toBe(0)
  })

  it('ズームしても粒の位置は経過時間だけで決まる（ズームの有無で変わらない）', () => {
    const pos = (p: LocalInternals) =>
      p.weatherLayer.getParticleGraphics().map((g) => [g.x, g.y] as const)
    const noZoom = make([weather('Snow'), narration('one')])
    noZoom.p.time.tick(2000)
    const posNoZoom = pos(noZoom.p)
    const zoomed = make([weather('Snow'), narration('one')]) // 時計を 0 に戻す
    internals(zoomed.r).processDirective(cam('Theater', { zoom: 'ミナ', zoom_strength: 2 }))
    zoomed.p.time.tick(2000)
    expect(zoomed.p.cameraZoom.getPose().scale).toBe(2)
    expect(pos(zoomed.p)).toEqual(posNoZoom)
  })

  it('ズーム中にスナップ復元（applyState）しても天候レイヤーは原寸・原点のまま', () => {
    const { r, p } = make([weather('Rain'), narration('one')])
    internals(r).processDirective(cam('Theater', { zoom: 'ミナ', zoom_strength: 2 }))
    p.time.tick(2000)
    apply(r, r.getSnapshot())
    p.time.tick(16)
    expect(p.weatherLayer.scale.x).toBe(1)
    expect(p.weatherLayer.position.x).toBe(0)
    expect(p.weatherLayer.position.y).toBe(0)
  })

  it('ノベル・シアターのどちらでも降る（カメラモードに依存しない）', () => {
    for (const mode of ['Novel', 'Theater'] as const) {
      const { r, p } = makeRenderer()
      r.setScenes([scene('a', [cam(mode), weather('Rain'), narration('one')])])
      expect(p.weatherLayer.particleCount()).toBeGreaterThan(0)
      expect(p.weatherLayer.isParticlesVisible()).toBe(true)
    }
  })
})
