/**
 * NovelRenderer 床 (#706 第2弾) の配線統合テスト。
 *
 * FloorLayer 自体の読み込み・配置・復元判定・後始末は FloorLayer.test.ts、ディレクティブ→layer の
 * 受け渡しは directives.floor.test.ts でカバー済み。ここでは NovelRenderer 側の配線だけを見る:
 * settled state（パス＋高さ）の蓄積と置換、`[床: なし]`、`[場面転換]`・新規開始・終劇でのクリア、シーン間ジャンプでの持ち越し、
 * goBack / セーブ復元（最終状態）、レイヤー順（背景板・動画より手前、キャラ・大道具より奥）、
 * イベント絵の背面隠しの対象、ズームは背景板と同じに受け・カメラ射影は受けないこと、破棄。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Assets, type Texture } from 'pixi.js'
import { NovelRenderer } from './NovelRenderer'
import type { Event, EventScene } from '../types'
import type { NovelGameState } from './GameState'
import { gameStateToSaveSlot, saveSlotToGameState } from './novelLayout'
import { internals, internalsOf, type RendererInternals } from '../test/rendererInternals'

function narration(...lines: string[]): Event {
  return { Narration: { text: lines } }
}

function floor(path: string, height = 0.25): Event {
  return { Floor: { path, height } } as Event
}

const FLOOR_EXIT = 'FloorExit' as Event

function board(path: string, depth = 0): Event {
  return { BackgroundBoard: { path, depth } } as Event
}

function cam(mode: 'Theater' | 'Novel', extra: Record<string, unknown> = {}): Event {
  return { CameraMode: { mode, ...extra } } as Event
}

function scene(id: string, events: Event[]): EventScene {
  return { id, title: id, view: 'TopDown', events }
}

interface LayerForTest {
  scale: { x: number; y: number }
  position: { x: number; y: number }
  visible: boolean
  show: (...args: unknown[]) => void
  restore: (...args: unknown[]) => void
  clear: () => void
  hasImage: () => boolean
  children: Array<{ x: number; y: number; width: number; height: number; anchor?: unknown }>
}
interface LocalInternals extends RendererInternals {
  floorLayer: LayerForTest
  stageFrontLayer: LayerForTest
  wallLayer: LayerForTest
  videoLayer: object
  backgroundBoardLayer: LayerForTest
  characterLayer: object & {
    getZoomFocus(n: string): { x: number; y: number } | null
    hasCharacter(n: string): boolean
  }
  propLayer: LayerForTest
  lightingLayer: LayerForTest
  eventImageLayer: object
  curtainLayer: object
  dialogBox: object
  telopLayer: object
  cameraZoom: { getPose(): { scale: number; x: number; y: number } }
  time: { setMode(m: string): void; tick(ms: number): void }
  app: {
    init: (...args: unknown[]) => Promise<void>
    stage: { children: unknown[] }
    canvas: unknown
    renderer?: { resolution: number }
    destroy: (...args: unknown[]) => void
  }
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

const flushPromises = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

afterEach(() => {
  vi.restoreAllMocks()
})

const TEX = { width: 64, height: 32, source: {} } as unknown as Texture

describe('NovelRenderer 床 settled state (#706 第2弾)', () => {
  it('[床:] の無いシーンは floor が null', () => {
    const r = new NovelRenderer()
    r.setScenes([scene('a', [narration('one')])])
    expect(r.getSnapshot().floor).toBeNull()
  })

  it('[床:] で floor が「パス＋高さ」だけの状態になる', () => {
    const r = new NovelRenderer()
    r.setScenes([scene('a', [floor('wood.png', 0.4), narration('one')])])
    expect(r.getSnapshot().floor).toEqual({ path: 'wood.png', height: 0.4 })
  })

  it('高さ省略（既定）は 0.25 で保存される', () => {
    const r = new NovelRenderer()
    r.setScenes([scene('a', [{ Floor: { path: 'wood.png' } } as Event, narration('one')])])
    expect(r.getSnapshot().floor).toEqual({ path: 'wood.png', height: 0.25 })
  })

  it('単一スロット: 2 回目の [床:] が前の床を置換する（蓄積しない・高さも置換）', () => {
    const r = new NovelRenderer()
    r.setScenes([scene('a', [floor('a.png', 0.3), floor('b.png', 0.5), narration('one')])])
    expect(r.getSnapshot().floor).toEqual({ path: 'b.png', height: 0.5 })
  })

  it('[床: なし] で null に戻る。無いところへの [床: なし] も安全', async () => {
    const r = new NovelRenderer()
    r.setScenes([
      scene('a', [
        FLOOR_EXIT,
        narration('one'),
        floor('a.png'),
        narration('two'),
        FLOOR_EXIT,
        narration('three'),
      ]),
    ])
    expect(r.getSnapshot().floor).toBeNull()
    await r.playScript([{ type: 'advance' }])
    expect(r.getSnapshot().floor?.path).toBe('a.png')
    await r.playScript([{ type: 'advance' }])
    expect(r.getSnapshot().floor).toBeNull()
  })

  it('壁・背景板・舞台前面・天候・単一スロット背景と独立（互いの状態を変えない）', () => {
    const r = new NovelRenderer()
    r.setScenes([
      scene('a', [
        board('sky.png', 10),
        { Wall: { path: 'glow.webp', loop: true, mute: true } } as Event,
        { StageFront: { path: 'hall.png' } } as Event,
        { Weather: { kind: 'Rain', intensity: 1 } } as Event,
        floor('wood.png', 0.3),
        { Background: { path: 'room.png' } } as Event,
        narration('one'),
      ]),
    ])
    const s = r.getSnapshot()
    expect(s.floor).toEqual({ path: 'wood.png', height: 0.3 })
    expect(s.stageFront?.path).toBe('hall.png')
    expect(s.weather?.kind).toBe('Rain')
    expect(s.wall?.path).toBe('glow.webp')
    expect(s.backgroundBoards).toEqual([{ path: 'sky.png', depth: 10 }])
    expect(s.backgroundPath).toBe('room.png')
  })

  it('[壁: なし]・[舞台前面: なし]・[天候: なし]・[動画退場] など他のクリアでは床は消えない', () => {
    const r = new NovelRenderer()
    r.setScenes([
      scene('a', [
        floor('wood.png'),
        'WallExit' as Event,
        'StageFrontExit' as Event,
        'WeatherExit' as Event,
        'VideoExit' as Event,
        narration('one'),
      ]),
    ])
    expect(r.getSnapshot().floor?.path).toBe('wood.png')
  })
})

describe('NovelRenderer 床 のリセット・持ち越し (#706 第2弾)', () => {
  it('[場面転換] で床もクリアされる', async () => {
    const r = new NovelRenderer()
    r.setScenes([
      scene('a', [
        floor('wood.png'),
        narration('one'),
        'SceneTransition' as Event,
        narration('two'),
      ]),
    ])
    expect(r.getSnapshot().floor?.path).toBe('wood.png')
    await r.playScript([{ type: 'advance' }])
    expect(r.getSnapshot().floor).toBeNull()
  })

  it('[場面転換] は layer.clear を実際に呼ぶ（表示物の解放まで届く）', async () => {
    const r = new NovelRenderer()
    r.setScenes([
      scene('a', [
        floor('wood.png'),
        narration('one'),
        'SceneTransition' as Event,
        narration('two'),
      ]),
    ])
    const clear = vi.spyOn(internals<LocalInternals>(r).floorLayer, 'clear')
    await r.playScript([{ type: 'advance' }])
    expect(clear).toHaveBeenCalled()
  })

  it('通常のシーン間ジャンプでは背景板と同じく持ち越される', () => {
    const r = new NovelRenderer()
    r.setScenes([scene('a', [floor('wood.png'), narration('one')]), scene('b', [narration('two')])])
    r.jumpToScene('b')
    expect(r.getSnapshot().floor?.path).toBe('wood.png')
  })

  it('setEvents()（新しいイベント列の開始）で床はクリアされる', () => {
    const r = new NovelRenderer()
    r.setEvents([floor('wood.png'), narration('one')])
    expect(r.getSnapshot().floor?.path).toBe('wood.png')
    r.setEvents([narration('two')])
    expect(r.getSnapshot().floor).toBeNull()
  })

  it('goBack で [床:] 実行前の状態に戻る', async () => {
    const r = new NovelRenderer()
    r.setScenes([scene('a', [narration('one'), floor('wood.png'), narration('two')])])
    expect(r.getSnapshot().floor).toBeNull()
    await r.playScript([{ type: 'advance' }])
    expect(r.getSnapshot().floor?.path).toBe('wood.png')
    r.goBack()
    expect(r.getSnapshot().floor).toBeNull()
  })

  it('goBack で床を含む状態へ戻るときは restore（最終状態の即時反映）を通る', async () => {
    const r = new NovelRenderer()
    r.setScenes([scene('a', [floor('wood.png', 0.4), narration('one'), narration('two')])])
    await r.playScript([{ type: 'advance' }])
    const restore = vi.spyOn(internals<LocalInternals>(r).floorLayer, 'restore')
    r.goBack()
    expect(restore).toHaveBeenCalledWith({ path: 'wood.png', height: 0.4 }, expect.any(String))
  })

  it('終劇で床もクリアされ、goBack（復元）で戻る', () => {
    const r = new NovelRenderer()
    r.setScenes([scene('a', [floor('wood.png', 0.4), narration('one'), narration('two')])])
    const before = r.getSnapshot()
    const clear = vi.spyOn(internals<LocalInternals>(r).floorLayer, 'clear')
    internalsOf<{ endStory(): void }>(r).endStory()
    expect(clear).toHaveBeenCalled()
    expect(r.getSnapshot().floor).toBeNull()
    const show = vi.spyOn(internals<LocalInternals>(r).floorLayer, 'show')
    ;(r as unknown as { applyState(s: NovelGameState): void }).applyState(before)
    expect(show).toHaveBeenCalledWith('wood.png', 0.4, expect.any(String))
    expect(r.getSnapshot().floor).toEqual({ path: 'wood.png', height: 0.4 })
  })
})

describe('NovelRenderer 床 のセーブ・復元 (#706 第2弾)', () => {
  function roundTrip(state: NovelGameState): NovelGameState {
    return saveSlotToGameState(
      JSON.parse(JSON.stringify(gameStateToSaveSlot(state, { savedAt: 0, label: 't' } as never))),
      null
    )
  }

  it('セーブ → ロードで床（パス＋高さだけ）が戻る。余計なキーは保存しない', () => {
    const r = new NovelRenderer()
    r.setScenes([scene('a', [floor('wood.png', 0.4), narration('one')])])
    const slot = JSON.parse(
      JSON.stringify(gameStateToSaveSlot(r.getSnapshot(), { savedAt: 0, label: 't' } as never))
    )
    expect(slot.floor).toEqual({ path: 'wood.png', height: 0.4 })
    expect(saveSlotToGameState(slot, null).floor).toEqual({ path: 'wood.png', height: 0.4 })
  })

  it('床なしのセーブは floor: null のまま往復する', () => {
    const r = new NovelRenderer()
    r.setScenes([scene('a', [narration('one')])])
    expect(roundTrip(r.getSnapshot()).floor).toBeNull()
  })

  it('古いセーブ（floor キーが無い）は床なしとして読める', () => {
    const r = new NovelRenderer()
    r.setScenes([scene('a', [narration('one')])])
    const slot = JSON.parse(
      JSON.stringify(gameStateToSaveSlot(r.getSnapshot(), { savedAt: 0, label: 't' } as never))
    )
    delete slot.floor
    expect(saveSlotToGameState(slot, null).floor).toBeNull()
  })

  it('applyState（復元）で別の床のスナップショットへ宣言的に入れ替わる', () => {
    const r = new NovelRenderer()
    r.setScenes([scene('a', [floor('a.png'), narration('one')])])
    const apply = (s: NovelGameState) =>
      (r as unknown as { applyState(s: NovelGameState): void }).applyState(s)
    apply({ ...r.getSnapshot(), floor: { path: 'b.png', height: 0.5 } })
    expect(r.getSnapshot().floor).toEqual({ path: 'b.png', height: 0.5 })
    apply({ ...r.getSnapshot(), floor: null })
    expect(r.getSnapshot().floor).toBeNull()
  })

  it('同じ床の applyState は再読み込みしない（床の画像への Assets.load を呼び直さない）', async () => {
    const load = vi.spyOn(Assets, 'load').mockResolvedValue(TEX as never)
    const r = new NovelRenderer()
    r.setAssetBaseUrl('/assets')
    r.setScenes([scene('a', [floor('wood.png', 0.4), narration('one')])])
    await flushPromises()
    const floorLoads = () =>
      load.mock.calls.filter((c) => String(c[0]) === '/assets/images/wood.png').length
    const before = floorLoads()
    expect(before).toBeGreaterThanOrEqual(1)
    ;(r as unknown as { applyState(s: NovelGameState): void }).applyState(r.getSnapshot())
    await flushPromises()
    expect(floorLoads()).toBe(before)
  })

  it('スキップ中に [床:] を通過しても最終状態が残る（演出の中間状態を持たない）', async () => {
    const r = new NovelRenderer()
    r.setScenes([
      scene('a', [narration('one'), floor('a.png'), floor('b.png', 0.5), narration('two')]),
    ])
    internalsOf<{ skipMode: boolean }>(r).skipMode = true
    await r.playScript([{ type: 'advance' }])
    expect(r.getSnapshot().floor).toEqual({ path: 'b.png', height: 0.5 })
  })

  it('シーク（seekTo）でも指定位置の床に追従する', async () => {
    const r = new NovelRenderer()
    r.setScenes([
      scene('a', [
        narration('one'),
        floor('a.png'),
        narration('two'),
        FLOOR_EXIT,
        narration('three'),
      ]),
    ])
    await r.playScript([{ type: 'advance' }, { type: 'advance' }])
    expect(r.getSnapshot().floor).toBeNull()
    const seek = (i: number) =>
      internalsOf<{ seekToTextEventDisplayIndex(i: number): void }>(r).seekToTextEventDisplayIndex(
        i
      )
    seek(1)
    expect(r.getSnapshot().floor?.path).toBe('a.png')
    seek(0)
    expect(r.getSnapshot().floor).toBeNull()
  })
})

describe('NovelRenderer 床 のレイヤー順・可視性・破棄 (#706 第2弾)', () => {
  it('背景板・壁・動画より手前、キャラ・スポットライト・大道具・幕・イベント絵・舞台前面より奥', async () => {
    const r = new NovelRenderer()
    muteAudio(r)
    await initRenderer(r)
    const ri = internals<LocalInternals>(r)
    const ch = ri.app.stage.children
    const idx = (o: unknown) => ch.indexOf(o)
    const f = idx(ri.floorLayer)
    expect(f).toBeGreaterThanOrEqual(0)
    // 手前に出る側（床が上）
    expect(f).toBeGreaterThan(idx(ri.backgroundBoardLayer))
    expect(f).toBeGreaterThan(idx(ri.wallLayer))
    expect(f).toBeGreaterThan(idx(ri.videoLayer))
    // 奥に回る側（床が下）
    expect(f).toBeLessThan(idx(ri.characterLayer))
    expect(f).toBeLessThan(idx(ri.lightingLayer))
    expect(f).toBeLessThan(idx(ri.propLayer))
    expect(f).toBeLessThan(idx(ri.curtainLayer))
    expect(f).toBeLessThan(idx(ri.eventImageLayer))
    expect(f).toBeLessThan(idx(ri.stageFrontLayer))
    expect(f).toBeLessThan(idx(ri.dialogBox))
    expect(f).toBeLessThan(idx(ri.telopLayer))
    expect(ch.filter((c) => c === ri.floorLayer)).toHaveLength(1)
    cleanupRenderer(r)
  })

  it('カーテンコール配置（幕を背景板の直後へ差し替え）でも床は幕・キャラより奥のまま', async () => {
    const r = new NovelRenderer()
    muteAudio(r)
    await initRenderer(r)
    const ri = internals<LocalInternals>(r)
    r.setScenes([
      scene('a', [
        { Curtain: { path: 'c.png', characters_in_front: true } } as Event,
        narration('one'),
      ]),
    ])
    const ch = ri.app.stage.children
    expect(ch.indexOf(ri.floorLayer)).toBeLessThan(ch.indexOf(ri.characterLayer))
    expect(ch.indexOf(ri.floorLayer)).toBeGreaterThan(ch.indexOf(ri.backgroundBoardLayer))
    cleanupRenderer(r)
  })

  it('イベント絵（背面を隠す）の間は床も背面スタックの一部として隠れ、戻ると表示される', async () => {
    const r = new NovelRenderer()
    muteAudio(r)
    await initRenderer(r)
    const ri = internals<LocalInternals>(r)
    const shouldHide = vi
      .spyOn(ri.eventImageLayer as { shouldHideBackLayer(): boolean }, 'shouldHideBackLayer')
      .mockReturnValue(true)
    ;(r as unknown as { applyEventImageVisibility(): void }).applyEventImageVisibility()
    expect(ri.floorLayer.visible).toBe(false)
    expect(ri.stageFrontLayer.visible).toBe(true)
    shouldHide.mockReturnValue(false)
    ;(r as unknown as { applyEventImageVisibility(): void }).applyEventImageVisibility()
    expect(ri.floorLayer.visible).toBe(true)
    cleanupRenderer(r)
  })

  it('destroy() で床のテクスチャを解放し、表示物を消す', async () => {
    const r = new NovelRenderer()
    muteAudio(r)
    vi.spyOn(Assets, 'load').mockResolvedValue(TEX as never)
    const unload = vi.spyOn(Assets, 'unload').mockResolvedValue(undefined as never)
    r.setAssetBaseUrl('/assets')
    await initRenderer(r)
    r.setScenes([scene('a', [floor('wood.png'), narration('one')])])
    await flushPromises()
    const ri = internals<LocalInternals>(r)
    expect(ri.floorLayer.hasImage()).toBe(true)
    cleanupRenderer(r)
    expect(ri.floorLayer.hasImage()).toBe(false)
    expect(unload.mock.calls.map((c) => c[0])).toContain('/assets/images/wood.png')
  })

  it('setEvents()（テクスチャ解放の入口）でも床の画像は Assets.unload される', async () => {
    const r = new NovelRenderer()
    vi.spyOn(Assets, 'load').mockResolvedValue(TEX as never)
    const unload = vi.spyOn(Assets, 'unload').mockResolvedValue(undefined as never)
    r.setAssetBaseUrl('/assets')
    r.setEvents([floor('wood.png'), narration('one')])
    await flushPromises()
    r.setEvents([narration('two')])
    expect(unload.mock.calls.map((c) => c[0])).toContain('/assets/images/wood.png')
  })
})

describe('NovelRenderer 床 のカメラ・ズーム (#706 第2弾)', () => {
  function make(events: Event[]) {
    const r = new NovelRenderer()
    r.setScenes([scene('a', events)])
    const p = internalsOf<LocalInternals>(r)
    p.time.setMode('live')
    p.time.setMode('virtual')
    vi.spyOn(p.characterLayer, 'getZoomFocus').mockImplementation(() => ({ x: 100, y: 100 }))
    vi.spyOn(p.characterLayer, 'hasCharacter').mockImplementation(() => true)
    return { r, p }
  }

  it('ズームすると床は背景板・壁と同じ倍率・同じ位置の変換を受ける。舞台前面だけは動かない', () => {
    const { r, p } = make([
      board('sky.png'),
      { Wall: { path: 'glow.webp', loop: true, mute: true } } as Event,
      { StageFront: { path: 'hall.png' } } as Event,
      floor('wood.png'),
      narration('one'),
    ])
    internals(r).processDirective(cam('Theater', { zoom: 'ミナ', zoom_strength: 2 }))
    p.time.tick(2000)
    expect(p.cameraZoom.getPose().scale).toBe(2)
    expect(p.floorLayer.scale.x).toBe(2)
    expect(p.floorLayer.scale.y).toBe(2)
    // 背景板・壁と完全に同じ変換
    expect(p.floorLayer.scale.x).toBe(p.backgroundBoardLayer.scale.x)
    expect(p.floorLayer.position.x).toBe(p.backgroundBoardLayer.position.x)
    expect(p.floorLayer.position.y).toBe(p.backgroundBoardLayer.position.y)
    expect(p.floorLayer.scale.x).toBe(p.wallLayer.scale.x)
    // 動かない側の対照
    expect(p.stageFrontLayer.scale.x).toBe(1)
    expect(p.stageFrontLayer.position.x).toBe(0)
  })

  it('ズーム中にスナップ復元（applyState）しても床は背景板と同じ変換のまま', () => {
    const { r, p } = make([floor('wood.png'), narration('one')])
    internals(r).processDirective(cam('Theater', { zoom: 'ミナ', zoom_strength: 2 }))
    p.time.tick(2000)
    const snap = r.getSnapshot()
    ;(r as unknown as { applyState(s: NovelGameState): void }).applyState(snap)
    p.time.tick(16)
    expect(p.floorLayer.scale.x).toBe(2)
    expect(p.floorLayer.position.x).toBe(p.backgroundBoardLayer.position.x)
    expect(p.floorLayer.position.y).toBe(p.backgroundBoardLayer.position.y)
  })

  it('ズームを戻すと床も原寸・原点に戻る', () => {
    const { r, p } = make([floor('wood.png'), narration('one')])
    internals(r).processDirective(cam('Theater', { zoom: 'ミナ', zoom_strength: 2 }))
    p.time.tick(2000)
    expect(p.floorLayer.scale.x).toBe(2)
    internals(r).processDirective(cam('Theater', { zoom: null }))
    p.time.tick(2000)
    expect(p.floorLayer.scale.x).toBe(1)
    expect(p.floorLayer.position.x).toBe(0)
    expect(p.floorLayer.position.y).toBe(0)
  })

  it('シアターの仰角 LookUp/LookDown・ノベルでも帯の配置は変わらない（射影を受けない・下端揃え）', async () => {
    const r = new NovelRenderer()
    muteAudio(r)
    vi.spyOn(Assets, 'load').mockResolvedValue(TEX as never)
    r.setAssetBaseUrl('/assets')
    await initRenderer(r)
    r.setScenes([
      scene('a', [
        cam('Theater', { elevation: 'LookUp' }),
        floor('wood.png', 0.5),
        narration('one'),
      ]),
    ])
    await flushPromises()
    const p = internals<LocalInternals>(r)
    let reference: number[] | null = null
    for (const ev of [
      cam('Theater', { elevation: 'LookUp' }),
      cam('Theater', { elevation: 'LookDown' }),
      cam('Novel'),
    ]) {
      internals(r).processDirective(ev)
      const sprite = p.floorLayer.children[0]
      expect(sprite).toBeDefined()
      expect(p.floorLayer.scale.x).toBe(1)
      expect(p.floorLayer.position.y).toBe(0)
      const geom = [sprite.x, sprite.y, sprite.width, sprite.height]
      // 帯は画面下端に揃い、横幅は画面幅いっぱい。仰角で動かない。
      expect(geom[0]).toBe(0)
      expect(geom[1] + geom[3]).toBeCloseTo(450, 5)
      reference ??= geom
      expect(geom).toEqual(reference)
    }
    cleanupRenderer(r)
  })
})
