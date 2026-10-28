/**
 * NovelRenderer 壁 (#703) の配線統合テスト。
 *
 * WallLayer 自体の画像/動画の振り分け・配置・後始末は WallLayer.test.ts、ディレクティブ→layer の
 * 受け渡しは directives.wall.test.ts でカバー済み。ここでは NovelRenderer 側の配線だけを見る:
 * settled state の蓄積と置換、`[壁: なし]`、`[場面転換]`・新規開始でのクリア、シーン間ジャンプでの持ち越し、
 * goBack / セーブ復元（最終状態）、レイヤー順（最奥）、ズームの共通適用、イベント絵での可視性、破棄。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Assets, type Texture } from 'pixi.js'
import { NovelRenderer } from './NovelRenderer'
import type { Event, EventScene } from '../types'
import type { NovelGameState } from './GameState'
import { gameStateToSaveSlot, saveSlotToGameState } from './novelLayout'
import { computeCameraProjection } from './cameraProjection'
import { WALL_DEPTH } from './WallLayer'
import { internals, internalsOf, type RendererInternals } from '../test/rendererInternals'

function narration(...lines: string[]): Event {
  return { Narration: { text: lines } }
}

function wall(path: string, loop = true, mute = true): Event {
  return { Wall: { path, loop, mute } } as Event
}

const WALL_EXIT = 'WallExit' as Event

function board(path: string, depth = 0): Event {
  return { BackgroundBoard: { path, depth } } as Event
}

function cam(mode: 'Theater' | 'Novel', extra: Record<string, unknown> = {}): Event {
  return { CameraMode: { mode, ...extra } } as Event
}

function scene(id: string, events: Event[]): EventScene {
  return { id, title: id, view: 'TopDown', events }
}

interface WallLayerForTest {
  scale: { x: number; y: number }
  position: { x: number; y: number }
  visible: boolean
  show: (...args: unknown[]) => void
  restore: (...args: unknown[]) => void
  clear: () => void
  hasImage: () => boolean
  hasVideo: () => boolean
  children: unknown[]
}
interface LocalInternals extends RendererInternals {
  wallLayer: WallLayerForTest
  backgroundBoardLayer: object
  characterLayer: object & {
    getZoomFocus(n: string): { x: number; y: number } | null
    hasCharacter(n: string): boolean
    scale: { x: number }
  }
  propLayer: object
  eventImageLayer: object
  curtainLayer: object
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

describe('NovelRenderer 壁 settled state (#703)', () => {
  it('[壁:] の無いシーンは wall が null', () => {
    const r = new NovelRenderer()
    r.setScenes([scene('a', [narration('one')])])
    expect(r.getSnapshot().wall).toBeNull()
  })

  it('[壁:] で wall が「パス＋設定」だけの状態になる', () => {
    const r = new NovelRenderer()
    r.setScenes([scene('a', [wall('glow.webp'), narration('one')])])
    expect(r.getSnapshot().wall).toEqual({ path: 'glow.webp', loop: true, mute: true })
  })

  it('設定（ループ・ミュート）が状態に載る', () => {
    const r = new NovelRenderer()
    r.setScenes([scene('a', [wall('a.webm', false, false), narration('one')])])
    expect(r.getSnapshot().wall).toEqual({ path: 'a.webm', loop: false, mute: false })
  })

  it('単一スロット: 2 回目の [壁:] が前の壁を置換する（蓄積しない）', () => {
    const r = new NovelRenderer()
    r.setScenes([scene('a', [wall('a.webp'), wall('b.webm', false), narration('one')])])
    expect(r.getSnapshot().wall).toEqual({ path: 'b.webm', loop: false, mute: true })
  })

  it('[壁: なし] で null に戻る。壁が無いところへの [壁: なし] も安全', async () => {
    const r = new NovelRenderer()
    r.setScenes([
      scene('a', [
        WALL_EXIT,
        narration('one'),
        wall('a.webp'),
        narration('two'),
        WALL_EXIT,
        narration('three'),
      ]),
    ])
    expect(r.getSnapshot().wall).toBeNull()
    await r.playScript([{ type: 'advance' }])
    expect(r.getSnapshot().wall?.path).toBe('a.webp')
    await r.playScript([{ type: 'advance' }])
    expect(r.getSnapshot().wall).toBeNull()
  })

  it('壁は背景板・単一スロット背景と独立（互いの状態を変えない）', () => {
    const r = new NovelRenderer()
    r.setScenes([
      scene('a', [
        board('sky.png', 10),
        wall('glow.webp'),
        { Background: { path: 'room.png' } } as Event,
        narration('one'),
      ]),
    ])
    const s = r.getSnapshot()
    expect(s.wall?.path).toBe('glow.webp')
    expect(s.backgroundBoards).toEqual([{ path: 'sky.png', depth: 10 }])
    expect(s.backgroundPath).toBe('room.png')
  })

  it('背景板の [場面転換] 以外（[背景板:] 追加・[動画退場] など）では壁は消えない', () => {
    const r = new NovelRenderer()
    r.setScenes([
      scene('a', [wall('glow.webp'), board('sky.png'), 'VideoExit' as Event, narration('one')]),
    ])
    expect(r.getSnapshot().wall?.path).toBe('glow.webp')
  })
})

describe('NovelRenderer 壁 のリセット・持ち越し (#703)', () => {
  it('[場面転換] で壁もクリアされる', async () => {
    const r = new NovelRenderer()
    r.setScenes([
      scene('a', [
        wall('glow.webp'),
        narration('one'),
        'SceneTransition' as Event,
        narration('two'),
      ]),
    ])
    expect(r.getSnapshot().wall?.path).toBe('glow.webp')
    await r.playScript([{ type: 'advance' }])
    expect(r.getSnapshot().wall).toBeNull()
  })

  it('[場面転換] は layer.clear を実際に呼ぶ（表示物の解放まで届く）', async () => {
    const r = new NovelRenderer()
    r.setScenes([
      scene('a', [
        wall('glow.webp'),
        narration('one'),
        'SceneTransition' as Event,
        narration('two'),
      ]),
    ])
    const clear = vi.spyOn(internals<LocalInternals>(r).wallLayer, 'clear')
    await r.playScript([{ type: 'advance' }])
    expect(clear).toHaveBeenCalled()
  })

  it('通常のシーン間ジャンプでは背景板と同じく持ち越される', () => {
    const r = new NovelRenderer()
    r.setScenes([scene('a', [wall('glow.webp'), narration('one')]), scene('b', [narration('two')])])
    r.jumpToScene('b')
    expect(r.getSnapshot().wall?.path).toBe('glow.webp')
  })

  it('setEvents()（新しいイベント列の開始）で壁はクリアされる', () => {
    const r = new NovelRenderer()
    r.setEvents([wall('glow.webp'), narration('one')])
    expect(r.getSnapshot().wall?.path).toBe('glow.webp')
    r.setEvents([narration('two')])
    expect(r.getSnapshot().wall).toBeNull()
  })

  it('goBack で [壁:] 実行前の状態に戻り、進めると再び壁がある', async () => {
    const r = new NovelRenderer()
    r.setScenes([scene('a', [narration('one'), wall('glow.webp'), narration('two')])])
    expect(r.getSnapshot().wall).toBeNull()
    await r.playScript([{ type: 'advance' }])
    expect(r.getSnapshot().wall?.path).toBe('glow.webp')
    r.goBack()
    expect(r.getSnapshot().wall).toBeNull()
  })

  it('goBack で壁を含む状態へ戻るときは restore（最終状態の即時反映）を通る', async () => {
    const r = new NovelRenderer()
    r.setScenes([scene('a', [wall('glow.webp'), narration('one'), narration('two')])])
    await r.playScript([{ type: 'advance' }])
    const restore = vi.spyOn(internals<LocalInternals>(r).wallLayer, 'restore')
    r.goBack()
    expect(restore).toHaveBeenCalledWith(
      { path: 'glow.webp', loop: true, mute: true },
      expect.any(String)
    )
  })
})

describe('NovelRenderer 壁 のセーブ・復元 (#703)', () => {
  function roundTrip(state: NovelGameState): NovelGameState {
    return saveSlotToGameState(
      JSON.parse(JSON.stringify(gameStateToSaveSlot(state, { savedAt: 0, label: 't' } as never))),
      null
    )
  }

  it('セーブ → ロードで壁（パス＋設定）が戻る。再生位置などの余計なキーは保存しない', () => {
    const r = new NovelRenderer()
    r.setScenes([scene('a', [wall('a.webm', false, false), narration('one')])])
    const snap = r.getSnapshot()
    const slot = JSON.parse(
      JSON.stringify(gameStateToSaveSlot(snap, { savedAt: 0, label: 't' } as never))
    )
    expect(slot.wall).toEqual({ path: 'a.webm', loop: false, mute: false })
    expect(saveSlotToGameState(slot, null).wall).toEqual({
      path: 'a.webm',
      loop: false,
      mute: false,
    })
  })

  it('壁なしのセーブは wall: null のまま往復する', () => {
    const r = new NovelRenderer()
    r.setScenes([scene('a', [narration('one')])])
    expect(roundTrip(r.getSnapshot()).wall).toBeNull()
  })

  it('古いセーブ（wall キーが無い）は壁なしとして読める', () => {
    const r = new NovelRenderer()
    r.setScenes([scene('a', [narration('one')])])
    const slot = JSON.parse(
      JSON.stringify(gameStateToSaveSlot(r.getSnapshot(), { savedAt: 0, label: 't' } as never))
    )
    delete slot.wall
    expect(saveSlotToGameState(slot, null).wall).toBeNull()
  })

  it('loop/mute が欠けたセーブは既定（true）に倒す', () => {
    const r = new NovelRenderer()
    r.setScenes([scene('a', [narration('one')])])
    const slot = JSON.parse(
      JSON.stringify(gameStateToSaveSlot(r.getSnapshot(), { savedAt: 0, label: 't' } as never))
    )
    slot.wall = { path: 'x.webm' }
    expect(saveSlotToGameState(slot, null).wall).toEqual({ path: 'x.webm', loop: true, mute: true })
  })

  it('applyState（復元）で別の壁のスナップショットへ宣言的に入れ替わる', () => {
    const r = new NovelRenderer()
    r.setScenes([scene('a', [wall('a.webp'), narration('one')])])
    const snap = { ...r.getSnapshot(), wall: { path: 'b.webm', loop: false, mute: true } }
    ;(r as unknown as { applyState(s: NovelGameState): void }).applyState(snap)
    expect(r.getSnapshot().wall).toEqual({ path: 'b.webm', loop: false, mute: true })
    const none = { ...r.getSnapshot(), wall: null }
    ;(r as unknown as { applyState(s: NovelGameState): void }).applyState(none)
    expect(r.getSnapshot().wall).toBeNull()
  })

  it('スキップ中に [壁:] を通過しても最終状態が残る（演出の中間状態を持たない）', async () => {
    const r = new NovelRenderer()
    r.setScenes([scene('a', [narration('one'), wall('a.webp'), wall('b.webp'), narration('two')])])
    internalsOf<{ skipMode: boolean }>(r).skipMode = true
    await r.playScript([{ type: 'advance' }])
    expect(r.getSnapshot().wall?.path).toBe('b.webp')
  })
})

describe('NovelRenderer 壁 のレイヤー順・可視性・破棄 (#703)', () => {
  it('stage 上で単一スロット背景の上・背景板の直前（最奥の板）、立ち絵・大道具・幕よりずっと奥', async () => {
    const r = new NovelRenderer()
    muteAudio(r)
    await initRenderer(r)
    const ri = internals<LocalInternals>(r)
    const ch = ri.app.stage.children
    const idx = (o: unknown) => ch.indexOf(o)
    expect(idx(ri.wallLayer)).toBeGreaterThanOrEqual(0)
    expect(idx(ri.wallLayer)).toBeLessThan(idx(ri.backgroundBoardLayer))
    expect(idx(ri.wallLayer) + 1).toBe(idx(ri.backgroundBoardLayer))
    expect(idx(ri.wallLayer)).toBeLessThan(idx(ri.characterLayer))
    expect(idx(ri.wallLayer)).toBeLessThan(idx(ri.propLayer))
    expect(idx(ri.wallLayer)).toBeLessThan(idx(ri.curtainLayer))
    expect(idx(ri.wallLayer)).toBeLessThan(idx(ri.eventImageLayer))
    // 背景（stage.attachBackground）よりは手前。
    expect(idx(ri.wallLayer)).toBeGreaterThan(0)
    expect(ch.filter((c) => c === ri.wallLayer)).toHaveLength(1)
    cleanupRenderer(r)
  })

  it('カーテンコール配置（幕を背景板の直後へ差し替え）でも壁は背景板より奥のまま', async () => {
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
    expect(ch.indexOf(ri.wallLayer)).toBeLessThan(ch.indexOf(ri.backgroundBoardLayer))
    expect(ch.indexOf(ri.wallLayer)).toBeLessThan(ch.indexOf(ri.curtainLayer))
    cleanupRenderer(r)
  })

  it('イベント絵（背面を隠す）の間は壁も隠れ、終わると戻る（他の背面レイヤーと同じトグル）', async () => {
    const r = new NovelRenderer()
    muteAudio(r)
    await initRenderer(r)
    const ri = internals<LocalInternals>(r)
    expect(ri.wallLayer.visible).toBe(true)
    const shouldHide = vi
      .spyOn(ri.eventImageLayer as { shouldHideBackLayer(): boolean }, 'shouldHideBackLayer')
      .mockReturnValue(true)
    ;(r as unknown as { applyEventImageVisibility(): void }).applyEventImageVisibility()
    expect(ri.wallLayer.visible).toBe(false)
    shouldHide.mockReturnValue(false)
    ;(r as unknown as { applyEventImageVisibility(): void }).applyEventImageVisibility()
    expect(ri.wallLayer.visible).toBe(true)
    cleanupRenderer(r)
  })

  it('destroy() で壁のテクスチャを解放し、表示物を消す', async () => {
    const r = new NovelRenderer()
    muteAudio(r)
    vi.spyOn(Assets, 'load').mockResolvedValue({
      width: 800,
      height: 450,
      source: {},
    } as unknown as Texture as never)
    const unload = vi.spyOn(Assets, 'unload').mockResolvedValue(undefined as never)
    r.setAssetBaseUrl('/assets')
    await initRenderer(r)
    r.setScenes([scene('a', [wall('glow.webp'), narration('one')])])
    await flushPromises()
    const ri = internals<LocalInternals>(r)
    expect(ri.wallLayer.hasImage()).toBe(true)
    cleanupRenderer(r)
    expect(ri.wallLayer.hasImage()).toBe(false)
    expect(unload.mock.calls.map((c) => c[0])).toContain('/assets/images/glow.webp')
  })

  it('setEvents()（テクスチャ解放の入口）でも壁の画像は Assets.unload される', async () => {
    const r = new NovelRenderer()
    vi.spyOn(Assets, 'load').mockResolvedValue({
      width: 800,
      height: 450,
      source: {},
    } as unknown as Texture as never)
    const unload = vi.spyOn(Assets, 'unload').mockResolvedValue(undefined as never)
    r.setAssetBaseUrl('/assets')
    r.setEvents([wall('glow.webp'), narration('one')])
    await flushPromises()
    r.setEvents([narration('two')])
    expect(unload.mock.calls.map((c) => c[0])).toContain('/assets/images/glow.webp')
  })
})

describe('NovelRenderer 壁 のカメラ・ズーム (#703/#702)', () => {
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

  it('ズームは壁にも背景板・大道具と同じ scale/position で掛かる', () => {
    const { r, p } = make([board('sky.png'), wall('glow.webp'), narration('one')])
    internals(r).processDirective(cam('Theater', { zoom: 'ミナ', zoom_strength: 2 }))
    p.time.tick(2000)
    const pose = p.cameraZoom.getPose()
    expect(pose.scale).toBe(2)
    const b = p.backgroundBoardLayer as unknown as WallLayerForTest
    expect(p.wallLayer.scale.x).toBe(pose.scale)
    expect(p.wallLayer.position.x).toBe(pose.x)
    expect(p.wallLayer.position.y).toBe(pose.y)
    expect(p.wallLayer.scale.x).toBe(b.scale.x)
    expect(p.wallLayer.position.x).toBe(b.position.x)
    expect(p.wallLayer.position.y).toBe(b.position.y)
  })

  it('ズームを戻すと壁も全景に戻る', () => {
    const { r, p } = make([wall('glow.webp'), narration('one')])
    internals(r).processDirective(cam('Theater', { zoom: 'ミナ', zoom_strength: 2 }))
    p.time.tick(2000)
    internals(r).processDirective(cam('Theater'))
    p.time.tick(2000)
    expect(p.wallLayer.scale.x).toBe(1)
    expect(p.wallLayer.position.x).toBe(0)
    expect(p.wallLayer.position.y).toBe(0)
  })

  it('ズーム中にスナップ復元（applyState）しても壁は最終ポーズ', () => {
    const { r, p } = make([wall('glow.webp'), narration('one')])
    internals(r).processDirective(cam('Theater', { zoom: 'ミナ', zoom_strength: 2 }))
    p.time.tick(2000)
    const snap = r.getSnapshot()
    internals(r).processDirective(cam('Theater'))
    p.time.tick(2000)
    expect(p.wallLayer.scale.x).toBe(1)
    ;(r as unknown as { applyState(s: NovelGameState): void }).applyState(snap)
    p.time.tick(16)
    expect(p.wallLayer.scale.x).toBe(2)
  })

  it('[カメラ:] のたびに壁へカメラ状態が届く（背景板・大道具と同じ applyCamera 経路）', () => {
    const { r, p } = make([wall('glow.webp'), narration('one')])
    const spy = vi.spyOn(
      p.wallLayer as unknown as { setCamera(...a: unknown[]): void },
      'setCamera'
    )
    internals(r).processDirective(cam('Theater', { elevation: 'LookUp' }))
    expect(spy).toHaveBeenLastCalledWith('Theater', 'Audience', 'LookUp')
    internals(r).processDirective(cam('Novel'))
    expect(spy).toHaveBeenLastCalledWith('Novel', 'Audience', null)
  })

  it('シーン間ジャンプでカメラが既定へリセットされるとき、持ち越した壁へもノベルのカメラが届く', () => {
    const r = new NovelRenderer()
    r.setScenes([
      scene('a', [cam('Theater', { elevation: 'LookDown' }), wall('glow.webp'), narration('one')]),
      scene('b', [narration('two')]),
    ])
    const p = internalsOf<LocalInternals>(r)
    const spy = vi.spyOn(
      p.wallLayer as unknown as { setCamera(...a: unknown[]): void },
      'setCamera'
    )
    r.jumpToScene('b')
    expect(spy).toHaveBeenLastCalledWith('Novel', 'Audience', null)
    expect(r.getSnapshot().wall?.path).toBe('glow.webp')
  })

  it('壁の frame は computeCameraProjection(WALL_DEPTH) の結果と一致し、ノベルへ戻ると原寸', () => {
    const { r, p } = make([
      cam('Theater', { elevation: 'LookUp' }),
      wall('glow.webp'),
      narration('one'),
    ])
    const frame = p.wallLayer.children[0] as { scale: { x: number }; position: { y: number } }
    const proj = computeCameraProjection('Theater', 'Audience', 'LookUp', WALL_DEPTH)
    expect(frame.scale.x).toBe(proj.scale)
    internals(r).processDirective(cam('Novel'))
    expect(frame.scale.x).toBe(1)
  })
})
