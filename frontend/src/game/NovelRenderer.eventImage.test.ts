/**
 * NovelRenderer イベント絵レイヤー統合テスト (#351)。
 *
 * EventImageLayer 自体の単体挙動（フェード進行・pending 判定・getState/restore）は
 * EventImageLayer.test.ts でカバー済み。ここでは NovelRenderer 側の配線を検証する:
 *  - `[イベント絵:]` / `[イベント絵終了:]` ディレクティブ処理（processDirective）
 *  - `applyEventImageVisibility()`（back=Hide/Keep による背景・立ち絵の可視性トグル）
 *  - save/load・seek での復元
 *  - 場面転換・新シーン開始でのクリア
 *  - `[待機: 表示完了]`（hasPendingVisualTransition）への統合
 *
 * 観測は既存の NovelRenderer 系テスト（NovelRenderer.backgroundColor.test.ts /
 * NovelRenderer.waitDisplayComplete.test.ts）と同じ流儀: `getSnapshot()` と
 * internals キャストによる private フィールド直読み、駆動は `startFrom` + `playScript(advance)`。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Assets, Texture } from 'pixi.js'
import { NovelRenderer } from './NovelRenderer'
import type { Event, EventScene } from '../types'
import type { NovelGameState } from './GameState'
import { SaveManager, SaveSlotData } from './SaveManager'

// --- fixture helpers（既存 NovelRenderer 系テストと同じスタイル）---

function narration(...lines: string[]): Event {
  return { Narration: { text: lines } }
}

function eventImage(path: string, opts?: { back?: 'Hide' | 'Keep'; fadeMs?: number }): Event {
  // parser の Event union と同形（[イベント絵: path, 背面=…, フェード=…] → EventImage { … }）。
  return { EventImage: { path, back: opts?.back, fade_ms: opts?.fadeMs ?? null } } as Event
}

function eventImageExit(fadeMs?: number): Event {
  return { EventImageExit: { fade_ms: fadeMs ?? null } } as Event
}

function scene(id: string, events: Event[]): EventScene {
  return { id, title: id, view: 'TopDown', events }
}

function makeRenderer(scenes: EventScene[]): NovelRenderer {
  const r = new NovelRenderer()
  r.setAssetBaseUrl('/assets')
  r.setScenes(scenes)
  return r
}

/** private メソッド/フィールドへ到達するための内部アクセサ（既存テストと同じ cast 流儀） */
interface EventImageLayerForTest {
  getState(): { path: string; back: 'Hide' | 'Keep' } | null
  hasPendingVisualTransition(): boolean
}
interface RendererInternals {
  applyState(state: NovelGameState): void
  eventImageLayer: EventImageLayerForTest
  bgGraphics: { visible: boolean }
  bgContainer: { visible: boolean }
  characterLayer: { visible: boolean; hasPendingVisualTransition: () => boolean }
  eventIndex: number
  waitingForWait: boolean
  initialized: boolean
  render(): void
}
function internals(r: NovelRenderer): RendererInternals {
  return r as unknown as RendererInternals
}

function craftSave(over: Partial<SaveSlotData>): SaveSlotData {
  return {
    slot: -1,
    sceneId: 'a',
    eventIndex: 0,
    textIndex: 0,
    flags: {},
    backgroundPath: null,
    isBlackout: false,
    characters: [],
    currentBgmPath: null,
    savedAt: '2026-01-01T00:00:00.000Z',
    sceneName: null,
    ...over,
  }
}

/** 指定キーを欠落させた「旧フォーマット」セーブ（後方互換テスト用）。 */
function craftLegacy(omit: keyof SaveSlotData): SaveSlotData {
  const legacy = craftSave({ sceneId: 'a' }) as unknown as Record<string, unknown>
  delete legacy[omit]
  return legacy as unknown as SaveSlotData
}

function seedQuickSave(data: SaveSlotData): void {
  new SaveManager().quickSave(data)
}

describe('NovelRenderer イベント絵ディレクティブ処理・可視性トグル (#351)', () => {
  beforeEach(() => {
    vi.spyOn(Assets, 'load').mockResolvedValue(Texture.WHITE as never)
    new SaveManager().deleteQuickSave()
    localStorage.clear()
  })
  afterEach(() => {
    new SaveManager().deleteQuickSave()
    localStorage.clear()
    vi.restoreAllMocks()
  })

  // EI1: [イベント絵:] を advance で処理 → eventImageLayer.getState() / snapshot.eventImage に乗る。
  it('EI1: [イベント絵: story/x.webp] を処理 → eventImageLayer.getState() と snapshot.eventImage に反映される', async () => {
    const r = makeRenderer([
      scene('a', [narration('x'), eventImage('story/x.webp'), narration('y')]),
    ])
    r.startFrom({ sceneId: 'a' })
    expect(internals(r).eventImageLayer.getState()).toBeNull()

    await r.playScript([{ type: 'advance' }])

    expect(internals(r).eventImageLayer.getState()).toEqual({ path: 'story/x.webp', back: 'Hide' })
    expect(r.getSnapshot().eventImage).toEqual({ path: 'story/x.webp', back: 'Hide' })
  })

  // EI2: 背面省略（既定 Hide）→ 背景・立ち絵が全部 visible=false になる。
  it('EI2: 背面省略（既定 Hide）で処理すると背景・立ち絵が隠れる', async () => {
    const r = makeRenderer([
      scene('a', [narration('x'), eventImage('story/x.webp'), narration('y')]),
    ])
    r.startFrom({ sceneId: 'a' })
    await r.playScript([{ type: 'advance' }])

    expect(internals(r).bgGraphics.visible).toBe(false)
    expect(internals(r).bgContainer.visible).toBe(false)
    expect(internals(r).characterLayer.visible).toBe(false)
  })

  // EI3: 背面=keep で処理すると背景・立ち絵は表示されたまま。
  it('EI3: 背面=keep で処理すると背景・立ち絵は隠れない', async () => {
    const r = makeRenderer([
      scene('a', [narration('x'), eventImage('story/x.webp', { back: 'Keep' }), narration('y')]),
    ])
    r.startFrom({ sceneId: 'a' })
    await r.playScript([{ type: 'advance' }])

    expect(internals(r).eventImageLayer.getState()).toEqual({ path: 'story/x.webp', back: 'Keep' })
    expect(internals(r).bgGraphics.visible).toBe(true)
    expect(internals(r).bgContainer.visible).toBe(true)
    expect(internals(r).characterLayer.visible).toBe(true)
  })

  // EI4: [イベント絵終了] で eventImageLayer がクリアされ、back=Hide で隠れていた背景・立ち絵が戻る。
  it('EI4: [イベント絵終了] を処理すると eventImage がクリアされ、隠れていた背景・立ち絵が再表示される', async () => {
    const r = makeRenderer([
      scene('a', [
        narration('x'),
        eventImage('story/x.webp'),
        narration('y'),
        eventImageExit(),
        narration('z'),
      ]),
    ])
    r.startFrom({ sceneId: 'a' })
    await r.playScript([{ type: 'advance' }])
    expect(internals(r).bgGraphics.visible).toBe(false)

    await r.playScript([{ type: 'advance' }])

    expect(internals(r).eventImageLayer.getState()).toBeNull()
    expect(r.getSnapshot().eventImage).toBeNull()
    expect(internals(r).bgGraphics.visible).toBe(true)
    expect(internals(r).bgContainer.visible).toBe(true)
    expect(internals(r).characterLayer.visible).toBe(true)
  })

  // ===== save/load 往復 =====

  // EI5: eventImage セット後 quickSave→quickLoad で eventImage（path/back）が往復する。
  it('EI5: イベント絵セット後 quickSave→quickLoad で eventImage が往復する', async () => {
    const scenes = [
      scene('a', [narration('x'), eventImage('story/x.webp', { back: 'Keep' }), narration('y')]),
    ]
    const r = makeRenderer(scenes)
    r.startFrom({ sceneId: 'a' })
    await r.playScript([{ type: 'advance' }])
    expect(r.quickSave()).toBe(true)

    const r2 = makeRenderer(scenes)
    r2.startFrom({ sceneId: 'a' })
    expect(r2.getSnapshot().eventImage).toBeNull()
    expect(r2.quickLoad()).toBe(true)

    expect(r2.getSnapshot().eventImage).toEqual({ path: 'story/x.webp', back: 'Keep' })
    expect(internals(r2).eventImageLayer.getState()).toEqual({ path: 'story/x.webp', back: 'Keep' })
    // back=Keep なので背景・立ち絵は隠れない。
    expect(internals(r2).bgGraphics.visible).toBe(true)
  })

  // EI6: eventImage キー欠落の旧セーブ → 落ちず eventImage===null（後方互換）。
  it('EI6: eventImage キー欠落の旧セーブを quickLoad → 落ちず eventImage===null', () => {
    seedQuickSave(craftLegacy('eventImage'))
    const r = makeRenderer([scene('a', [narration('x')])])
    expect(r.quickLoad()).toBe(true)
    expect(r.getSnapshot().eventImage).toBeNull()
    expect(internals(r).eventImageLayer.getState()).toBeNull()
  })

  // EI7: スロットセーブ（slot≥0）でも eventImage が往復する。
  it('EI7: スロットセーブ（slot 0）でも eventImage が往復する', () => {
    const sm = new SaveManager()
    sm.save(0, craftSave({ slot: 0, eventImage: { path: 'story/x.webp', back: 'Hide' } }))
    const loaded = sm.load(0)
    expect(loaded).not.toBeNull()
    expect(loaded!.eventImage).toEqual({ path: 'story/x.webp', back: 'Hide' })

    const r = makeRenderer([scene('a', [narration('x')])])
    seedQuickSave(loaded!)
    r.quickLoad()
    expect(r.getSnapshot().eventImage).toEqual({ path: 'story/x.webp', back: 'Hide' })
    expect(internals(r).bgGraphics.visible).toBe(false)
  })

  // ===== seek 復元 =====

  // EI8: seekTo で「イベント絵表示中」の履歴位置に戻ると eventImage と可視性トグルが復元される。
  //      逆方向（イベント絵なしの履歴へ）でも可視性が正しく戻る。
  it('EI8: seekTo でイベント絵表示中/非表示の履歴位置を行き来すると、状態と可視性が両方復元される', async () => {
    const r = makeRenderer([
      scene('a', [
        narration('p0'),
        eventImage('story/x.webp'),
        narration('p1'),
        eventImageExit(),
        narration('p2'),
      ]),
    ])
    r.startFrom({ sceneId: 'a' })
    // history[0]: p0 到達時点のスナップショット（eventImage 未処理 = null）
    await r.playScript([{ type: 'advance' }])
    // history[1]: p1 到達時点のスナップショット（eventImage セット済み = Hide）
    await r.playScript([{ type: 'advance' }])
    // 現在地は p2（イベント絵終了済み）
    expect(internals(r).eventImageLayer.getState()).toBeNull()
    expect(internals(r).bgGraphics.visible).toBe(true)

    // イベント絵表示中の履歴位置（1）へ戻る。
    r.seekTo(1)
    expect(internals(r).eventImageLayer.getState()).toEqual({ path: 'story/x.webp', back: 'Hide' })
    expect(internals(r).bgGraphics.visible).toBe(false)
    expect(internals(r).characterLayer.visible).toBe(false)

    // イベント絵なしの履歴位置（0）へ戻る。
    r.seekTo(0)
    expect(internals(r).eventImageLayer.getState()).toBeNull()
    expect(internals(r).bgGraphics.visible).toBe(true)
    expect(internals(r).characterLayer.visible).toBe(true)
  })

  // ===== シーン遷移・新シーン開始でのクリア =====

  // EI9: [場面転換] を挟むとイベント絵がクリアされ、可視性も戻る（作者の書き忘れ防御）。
  it('EI9: [場面転換] を処理するとイベント絵がクリアされ、隠れていた背景・立ち絵が戻る', async () => {
    const r = makeRenderer([
      scene('a', [
        narration('x'),
        eventImage('story/x.webp'),
        narration('y'),
        'SceneTransition',
        narration('z'),
      ]),
    ])
    r.startFrom({ sceneId: 'a' })
    await r.playScript([{ type: 'advance' }])
    expect(internals(r).bgGraphics.visible).toBe(false)

    await r.playScript([{ type: 'advance' }])

    expect(internals(r).eventImageLayer.getState()).toBeNull()
    expect(internals(r).bgGraphics.visible).toBe(true)
    expect(internals(r).characterLayer.visible).toBe(true)
  })

  // EI10: 別シーンへの jumpToScene（新しいイベント列の開始）でも前シーンのイベント絵は引き継がれない。
  it('EI10: jumpToScene で新シーンへ移ると前シーンのイベント絵は引き継がれない', async () => {
    const r = makeRenderer([
      scene('a', [narration('x'), eventImage('story/x.webp'), narration('y')]),
      scene('b', [narration('z')]),
    ])
    r.startFrom({ sceneId: 'a' })
    await r.playScript([{ type: 'advance' }])
    expect(internals(r).eventImageLayer.getState()).not.toBeNull()
    expect(internals(r).bgGraphics.visible).toBe(false)

    r.jumpToScene('b')

    expect(internals(r).eventImageLayer.getState()).toBeNull()
    expect(internals(r).bgGraphics.visible).toBe(true)
    expect(internals(r).characterLayer.visible).toBe(true)
  })
})

describe('NovelRenderer WaitDisplayComplete とイベント絵の統合 (#351)', () => {
  // waitDisplayComplete.test.ts と同じ駆動方式: setScenes のみ（先頭シーンが自動再生される）。
  function makeWaitRenderer(events: Event[]): NovelRenderer {
    const r = new NovelRenderer()
    r.setAssetBaseUrl('/assets')
    r.setCharacterFadeMs(0)
    r.getTimeController().setMode('virtual')
    internals(r).initialized = true
    vi.spyOn(internals(r), 'render').mockImplementation(() => {})
    r.setScenes([scene('s', events)])
    return r
  }

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // EI11: eventImageLayer の pending 中は [待機: 表示完了] で足踏みし、解消後に進む。
  it('EI11: イベント絵の pending（ロード/フェード）中は WaitDisplayComplete で停止し、解消後に進む', () => {
    const r = makeWaitRenderer([
      eventImage('story/x.webp'),
      'WaitDisplayComplete',
      narration('after'),
    ])
    const h = internals(r)
    let pending = true
    vi.spyOn(h.eventImageLayer, 'hasPendingVisualTransition').mockImplementation(() => pending)

    expect(h.eventIndex).toBe(1)
    expect(h.waitingForWait).toBe(true)

    r.getTimeController().tick(64)
    expect(h.eventIndex).toBe(1)
    expect(h.waitingForWait).toBe(true)

    pending = false
    r.getTimeController().tick(16)
    expect(h.eventIndex).toBe(2)
    expect(h.waitingForWait).toBe(false)
  })
})
