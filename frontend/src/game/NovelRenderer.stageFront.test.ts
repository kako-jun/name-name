/**
 * NovelRenderer 舞台前面 (#705) の配線統合テスト。
 *
 * StageFrontLayer 自体の読み込み・配置・復元判定・後始末は StageFrontLayer.test.ts、ディレクティブ→layer の
 * 受け渡しは directives.stageFront.test.ts でカバー済み。ここでは NovelRenderer 側の配線だけを見る:
 * settled state の蓄積と置換、`[舞台前面: なし]`、`[場面転換]`・新規開始・終劇でのクリア、シーン間ジャンプでの持ち越し、
 * goBack / セーブ復元（最終状態）、レイヤー順（キャラ・小道具・イベント絵・幕より手前、暗転・会話窓・テロップより奥）、
 * イベント絵の背面隠しの対象外、ズーム・カメラ射影を受けないこと、破棄。
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

function front(path: string): Event {
  return { StageFront: { path } } as Event
}

const FRONT_EXIT = 'StageFrontExit' as Event

function board(path: string, depth = 0): Event {
  return { BackgroundBoard: { path, depth } } as Event
}

function cam(mode: 'Theater' | 'Novel', extra: Record<string, unknown> = {}): Event {
  return { CameraMode: { mode, ...extra } } as Event
}

function scene(id: string, events: Event[]): EventScene {
  return { id, title: id, view: 'TopDown', events }
}

interface FrontLayerForTest {
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
  stageFrontLayer: FrontLayerForTest
  wallLayer: FrontLayerForTest
  backgroundBoardLayer: FrontLayerForTest
  characterLayer: object & {
    getZoomFocus(n: string): { x: number; y: number } | null
    hasCharacter(n: string): boolean
  }
  propLayer: FrontLayerForTest
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

const TEX = { width: 800, height: 100, source: {} } as unknown as Texture

describe('NovelRenderer 舞台前面 settled state (#705)', () => {
  it('[舞台前面:] の無いシーンは stageFront が null', () => {
    const r = new NovelRenderer()
    r.setScenes([scene('a', [narration('one')])])
    expect(r.getSnapshot().stageFront).toBeNull()
  })

  it('[舞台前面:] で stageFront が「パス」だけの状態になる', () => {
    const r = new NovelRenderer()
    r.setScenes([scene('a', [front('hall.png'), narration('one')])])
    expect(r.getSnapshot().stageFront).toEqual({ path: 'hall.png' })
  })

  it('単一スロット: 2 回目の [舞台前面:] が前の舞台前面を置換する（蓄積しない）', () => {
    const r = new NovelRenderer()
    r.setScenes([scene('a', [front('a.png'), front('b.png'), narration('one')])])
    expect(r.getSnapshot().stageFront).toEqual({ path: 'b.png' })
  })

  it('[舞台前面: なし] で null に戻る。無いところへの [舞台前面: なし] も安全', async () => {
    const r = new NovelRenderer()
    r.setScenes([
      scene('a', [
        FRONT_EXIT,
        narration('one'),
        front('a.png'),
        narration('two'),
        FRONT_EXIT,
        narration('three'),
      ]),
    ])
    expect(r.getSnapshot().stageFront).toBeNull()
    await r.playScript([{ type: 'advance' }])
    expect(r.getSnapshot().stageFront?.path).toBe('a.png')
    await r.playScript([{ type: 'advance' }])
    expect(r.getSnapshot().stageFront).toBeNull()
  })

  it('壁・背景板・単一スロット背景と独立（互いの状態を変えない）', () => {
    const r = new NovelRenderer()
    r.setScenes([
      scene('a', [
        board('sky.png', 10),
        { Wall: { path: 'glow.webp', loop: true, mute: true } } as Event,
        front('hall.png'),
        { Background: { path: 'room.png' } } as Event,
        narration('one'),
      ]),
    ])
    const s = r.getSnapshot()
    expect(s.stageFront?.path).toBe('hall.png')
    expect(s.wall?.path).toBe('glow.webp')
    expect(s.backgroundBoards).toEqual([{ path: 'sky.png', depth: 10 }])
    expect(s.backgroundPath).toBe('room.png')
  })

  it('[壁: なし]・[動画退場] など他のクリアでは舞台前面は消えない', () => {
    const r = new NovelRenderer()
    r.setScenes([
      scene('a', [front('hall.png'), 'WallExit' as Event, 'VideoExit' as Event, narration('one')]),
    ])
    expect(r.getSnapshot().stageFront?.path).toBe('hall.png')
  })
})

describe('NovelRenderer 舞台前面 のリセット・持ち越し (#705)', () => {
  it('[場面転換] で舞台前面もクリアされる', async () => {
    const r = new NovelRenderer()
    r.setScenes([
      scene('a', [
        front('hall.png'),
        narration('one'),
        'SceneTransition' as Event,
        narration('two'),
      ]),
    ])
    expect(r.getSnapshot().stageFront?.path).toBe('hall.png')
    await r.playScript([{ type: 'advance' }])
    expect(r.getSnapshot().stageFront).toBeNull()
  })

  it('[場面転換] は layer.clear を実際に呼ぶ（表示物の解放まで届く）', async () => {
    const r = new NovelRenderer()
    r.setScenes([
      scene('a', [
        front('hall.png'),
        narration('one'),
        'SceneTransition' as Event,
        narration('two'),
      ]),
    ])
    const clear = vi.spyOn(internals<LocalInternals>(r).stageFrontLayer, 'clear')
    await r.playScript([{ type: 'advance' }])
    expect(clear).toHaveBeenCalled()
  })

  it('通常のシーン間ジャンプでは背景板と同じく持ち越される', () => {
    const r = new NovelRenderer()
    r.setScenes([scene('a', [front('hall.png'), narration('one')]), scene('b', [narration('two')])])
    r.jumpToScene('b')
    expect(r.getSnapshot().stageFront?.path).toBe('hall.png')
  })

  it('setEvents()（新しいイベント列の開始）で舞台前面はクリアされる', () => {
    const r = new NovelRenderer()
    r.setEvents([front('hall.png'), narration('one')])
    expect(r.getSnapshot().stageFront?.path).toBe('hall.png')
    r.setEvents([narration('two')])
    expect(r.getSnapshot().stageFront).toBeNull()
  })

  it('goBack で [舞台前面:] 実行前の状態に戻り、進めると再び舞台前面がある', async () => {
    const r = new NovelRenderer()
    r.setScenes([scene('a', [narration('one'), front('hall.png'), narration('two')])])
    expect(r.getSnapshot().stageFront).toBeNull()
    await r.playScript([{ type: 'advance' }])
    expect(r.getSnapshot().stageFront?.path).toBe('hall.png')
    r.goBack()
    expect(r.getSnapshot().stageFront).toBeNull()
  })

  it('goBack で舞台前面を含む状態へ戻るときは restore（最終状態の即時反映）を通る', async () => {
    const r = new NovelRenderer()
    r.setScenes([scene('a', [front('hall.png'), narration('one'), narration('two')])])
    await r.playScript([{ type: 'advance' }])
    const restore = vi.spyOn(internals<LocalInternals>(r).stageFrontLayer, 'restore')
    r.goBack()
    expect(restore).toHaveBeenCalledWith({ path: 'hall.png' }, expect.any(String))
  })

  it('終劇で舞台前面もクリアされ、goBack（復元）で戻る', () => {
    const r = new NovelRenderer()
    r.setScenes([scene('a', [front('hall.png'), narration('one'), narration('two')])])
    const before = r.getSnapshot()
    const clear = vi.spyOn(internals<LocalInternals>(r).stageFrontLayer, 'clear')
    internalsOf<{ endStory(): void }>(r).endStory()
    expect(clear).toHaveBeenCalled()
    expect(r.getSnapshot().stageFront).toBeNull()
    const show = vi.spyOn(internals<LocalInternals>(r).stageFrontLayer, 'show')
    ;(r as unknown as { applyState(s: NovelGameState): void }).applyState(before)
    expect(show).toHaveBeenCalledWith('hall.png', expect.any(String))
    expect(r.getSnapshot().stageFront).toEqual({ path: 'hall.png' })
  })
})

describe('NovelRenderer 舞台前面 のセーブ・復元 (#705)', () => {
  function roundTrip(state: NovelGameState): NovelGameState {
    return saveSlotToGameState(
      JSON.parse(JSON.stringify(gameStateToSaveSlot(state, { savedAt: 0, label: 't' } as never))),
      null
    )
  }

  it('セーブ → ロードで舞台前面（パスだけ）が戻る。余計なキーは保存しない', () => {
    const r = new NovelRenderer()
    r.setScenes([scene('a', [front('hall.png'), narration('one')])])
    const slot = JSON.parse(
      JSON.stringify(gameStateToSaveSlot(r.getSnapshot(), { savedAt: 0, label: 't' } as never))
    )
    expect(slot.stageFront).toEqual({ path: 'hall.png' })
    expect(saveSlotToGameState(slot, null).stageFront).toEqual({ path: 'hall.png' })
  })

  it('舞台前面なしのセーブは stageFront: null のまま往復する', () => {
    const r = new NovelRenderer()
    r.setScenes([scene('a', [narration('one')])])
    expect(roundTrip(r.getSnapshot()).stageFront).toBeNull()
  })

  it('古いセーブ（stageFront キーが無い）は舞台前面なしとして読める', () => {
    const r = new NovelRenderer()
    r.setScenes([scene('a', [narration('one')])])
    const slot = JSON.parse(
      JSON.stringify(gameStateToSaveSlot(r.getSnapshot(), { savedAt: 0, label: 't' } as never))
    )
    delete slot.stageFront
    expect(saveSlotToGameState(slot, null).stageFront).toBeNull()
  })

  it('applyState（復元）で別の舞台前面のスナップショットへ宣言的に入れ替わる', () => {
    const r = new NovelRenderer()
    r.setScenes([scene('a', [front('a.png'), narration('one')])])
    const apply = (s: NovelGameState) =>
      (r as unknown as { applyState(s: NovelGameState): void }).applyState(s)
    apply({ ...r.getSnapshot(), stageFront: { path: 'b.png' } })
    expect(r.getSnapshot().stageFront).toEqual({ path: 'b.png' })
    apply({ ...r.getSnapshot(), stageFront: null })
    expect(r.getSnapshot().stageFront).toBeNull()
  })

  it('スキップ中に [舞台前面:] を通過しても最終状態が残る（演出の中間状態を持たない）', async () => {
    const r = new NovelRenderer()
    r.setScenes([scene('a', [narration('one'), front('a.png'), front('b.png'), narration('two')])])
    internalsOf<{ skipMode: boolean }>(r).skipMode = true
    await r.playScript([{ type: 'advance' }])
    expect(r.getSnapshot().stageFront?.path).toBe('b.png')
  })

  it('シーク（seekTo）でも指定位置の舞台前面に追従する', async () => {
    const r = new NovelRenderer()
    r.setScenes([
      scene('a', [
        narration('one'),
        front('a.png'),
        narration('two'),
        FRONT_EXIT,
        narration('three'),
      ]),
    ])
    await r.playScript([{ type: 'advance' }, { type: 'advance' }])
    expect(r.getSnapshot().stageFront).toBeNull()
    const seek = (i: number) =>
      internalsOf<{ seekToTextEventDisplayIndex(i: number): void }>(r).seekToTextEventDisplayIndex(
        i
      )
    seek(1)
    expect(r.getSnapshot().stageFront?.path).toBe('a.png')
    seek(0)
    expect(r.getSnapshot().stageFront).toBeNull()
  })
})

describe('NovelRenderer 舞台前面 のレイヤー順・可視性・破棄 (#705)', () => {
  it('キャラ・小道具・イベント絵・幕より手前、会話窓・テロップより奥', async () => {
    const r = new NovelRenderer()
    muteAudio(r)
    await initRenderer(r)
    const ri = internals<LocalInternals>(r)
    const ch = ri.app.stage.children
    const idx = (o: unknown) => ch.indexOf(o)
    const f = idx(ri.stageFrontLayer)
    expect(f).toBeGreaterThanOrEqual(0)
    expect(f).toBeGreaterThan(idx(ri.characterLayer))
    expect(f).toBeGreaterThan(idx(ri.propLayer))
    expect(f).toBeGreaterThan(idx(ri.curtainLayer))
    expect(f).toBeGreaterThan(idx(ri.eventImageLayer))
    expect(f).toBeGreaterThan(idx(ri.wallLayer))
    expect(f).toBeLessThan(idx(ri.dialogBox))
    expect(f).toBeLessThan(idx(ri.telopLayer))
    expect(ch.filter((c) => c === ri.stageFrontLayer)).toHaveLength(1)
    cleanupRenderer(r)
  })

  it('カーテンコール配置（幕を背景板の直後へ差し替え）でも舞台前面は幕・キャラより手前のまま', async () => {
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
    expect(ch.indexOf(ri.stageFrontLayer)).toBeGreaterThan(ch.indexOf(ri.curtainLayer))
    expect(ch.indexOf(ri.stageFrontLayer)).toBeGreaterThan(ch.indexOf(ri.characterLayer))
    expect(ch.indexOf(ri.stageFrontLayer)).toBeLessThan(ch.indexOf(ri.dialogBox))
    cleanupRenderer(r)
  })

  it('イベント絵（背面を隠す）の間も舞台前面は隠れない（手前の画面空間オーバーレイ）', async () => {
    const r = new NovelRenderer()
    muteAudio(r)
    await initRenderer(r)
    const ri = internals<LocalInternals>(r)
    const shouldHide = vi
      .spyOn(ri.eventImageLayer as { shouldHideBackLayer(): boolean }, 'shouldHideBackLayer')
      .mockReturnValue(true)
    ;(r as unknown as { applyEventImageVisibility(): void }).applyEventImageVisibility()
    expect(ri.wallLayer.visible).toBe(false)
    expect(ri.stageFrontLayer.visible).toBe(true)
    shouldHide.mockReturnValue(false)
    ;(r as unknown as { applyEventImageVisibility(): void }).applyEventImageVisibility()
    expect(ri.stageFrontLayer.visible).toBe(true)
    cleanupRenderer(r)
  })

  it('destroy() で舞台前面のテクスチャを解放し、表示物を消す', async () => {
    const r = new NovelRenderer()
    muteAudio(r)
    vi.spyOn(Assets, 'load').mockResolvedValue(TEX as never)
    const unload = vi.spyOn(Assets, 'unload').mockResolvedValue(undefined as never)
    r.setAssetBaseUrl('/assets')
    await initRenderer(r)
    r.setScenes([scene('a', [front('hall.png'), narration('one')])])
    await flushPromises()
    const ri = internals<LocalInternals>(r)
    expect(ri.stageFrontLayer.hasImage()).toBe(true)
    cleanupRenderer(r)
    expect(ri.stageFrontLayer.hasImage()).toBe(false)
    expect(unload.mock.calls.map((c) => c[0])).toContain('/assets/images/hall.png')
  })

  it('setEvents()（テクスチャ解放の入口）でも舞台前面の画像は Assets.unload される', async () => {
    const r = new NovelRenderer()
    vi.spyOn(Assets, 'load').mockResolvedValue(TEX as never)
    const unload = vi.spyOn(Assets, 'unload').mockResolvedValue(undefined as never)
    r.setAssetBaseUrl('/assets')
    r.setEvents([front('hall.png'), narration('one')])
    await flushPromises()
    r.setEvents([narration('two')])
    expect(unload.mock.calls.map((c) => c[0])).toContain('/assets/images/hall.png')
  })
})

describe('NovelRenderer 舞台前面 のカメラ・ズーム (#705)', () => {
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

  it('ズームしても舞台前面は動かない（壁・背景板・大道具は動く）', () => {
    const { r, p } = make([
      board('sky.png'),
      { Wall: { path: 'glow.webp', loop: true, mute: true } } as Event,
      front('hall.png'),
      narration('one'),
    ])
    internals(r).processDirective(cam('Theater', { zoom: 'ミナ', zoom_strength: 2 }))
    p.time.tick(2000)
    expect(p.cameraZoom.getPose().scale).toBe(2)
    // 比較対象は実際にズームされている。
    expect(p.wallLayer.scale.x).toBe(2)
    expect(p.backgroundBoardLayer.scale.x).toBe(2)
    // 舞台前面だけが原寸・原点のまま。
    expect(p.stageFrontLayer.scale.x).toBe(1)
    expect(p.stageFrontLayer.scale.y).toBe(1)
    expect(p.stageFrontLayer.position.x).toBe(0)
    expect(p.stageFrontLayer.position.y).toBe(0)
  })

  it('ズーム中にスナップ復元（applyState）しても舞台前面は原寸・原点のまま', () => {
    const { r, p } = make([front('hall.png'), narration('one')])
    internals(r).processDirective(cam('Theater', { zoom: 'ミナ', zoom_strength: 2 }))
    p.time.tick(2000)
    const snap = r.getSnapshot()
    ;(r as unknown as { applyState(s: NovelGameState): void }).applyState(snap)
    p.time.tick(16)
    expect(p.stageFrontLayer.scale.x).toBe(1)
    expect(p.stageFrontLayer.position.x).toBe(0)
    expect(p.stageFrontLayer.position.y).toBe(0)
  })

  it('シアターの仰角 LookUp/LookDown・ノベルでも配置は変わらない（下端揃え・横幅フィット）', async () => {
    const r = new NovelRenderer()
    muteAudio(r)
    vi.spyOn(Assets, 'load').mockResolvedValue(TEX as never)
    r.setAssetBaseUrl('/assets')
    await initRenderer(r)
    r.setScenes([
      scene('a', [cam('Theater', { elevation: 'LookUp' }), front('hall.png'), narration('one')]),
    ])
    await flushPromises()
    const p = internals<LocalInternals>(r)
    for (const ev of [
      cam('Theater', { elevation: 'LookUp' }),
      cam('Theater', { elevation: 'LookDown' }),
      cam('Novel'),
    ]) {
      internals(r).processDirective(ev)
      const sprite = p.stageFrontLayer.children[0]
      expect(sprite).toBeDefined()
      expect(p.stageFrontLayer.scale.x).toBe(1)
      expect(p.stageFrontLayer.position.y).toBe(0)
      // テクスチャ 800x100・画面 800x450（既定比率）→ 下端 450 に揃う。
      expect([sprite.x, sprite.y, sprite.width, sprite.height]).toEqual([0, 350, 800, 100])
    }
    cleanupRenderer(r)
  })
})
