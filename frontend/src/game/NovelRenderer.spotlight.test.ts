/**
 * NovelRenderer 追うスポットライト (#693) の配線統合テスト。
 *
 * `LightingLayer` 自体の単体挙動（jsdom canvas 防御・radius/color クランプ・追従ロジック）は
 * `LightingLayer.test.ts` でカバー済み。ここでは `NovelRenderer.cameraMode.test.ts` と同じ
 * 「isBlackout と同種の宣言的 settled state」としての配線だけを検証する:
 *  - `[スポットライト: ...]`/`[スポットライト消灯]` イベントで点灯・消灯する
 *  - シーン遷移（jumpToScene 経由の resetAndStartEvents／マルチMD連結の 'SceneTransition'
 *    イベント、この2つは実装上別のクリア呼び出し箇所 #693 参照）・endStory・destroy で自動消灯する
 *  - goBack（スナップショットベースの宣言的復元）・save/load で復元される
 *  - 任意局面起動（`?debug_scene=` 相当・startFrom の eventIndex 指定経路）は
 *    イベント再生ではなく最小合成 state を使うため、常に消灯した状態で始まる
 *
 * `new NovelRenderer()` のみ（init は呼ばない）で駆動する（NovelRenderer.cameraMode.test.ts /
 * NovelRenderer.prop.test.ts と同形）。destroy() テストだけは appInitialized ガードを満たす
 * 最小スタブ（NovelRenderer.prop.test.ts の stubDestroyableApp と同じ割り切り）を使う。
 */
import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest'
import { NovelRenderer } from './NovelRenderer'
import { SaveManager, type SaveSlotData } from './SaveManager'
import type { Event, EventScene } from '../types'

// --- fixture helpers（NovelRenderer.cameraMode.test.ts と同じスタイル）---

function narration(...lines: string[]): Event {
  return { Narration: { text: lines } }
}

function spotlight(target: string | undefined, color: string, radius: number): Event {
  return { Spotlight: { target, color, radius } } as Event
}

const SPOTLIGHT_OFF: Event = 'SpotlightOff' as Event

function scene(id: string, events: Event[]): EventScene {
  return { id, title: id, view: 'TopDown', events }
}

function makeRenderer(scenes: EventScene[]): NovelRenderer {
  const r = new NovelRenderer()
  r.setScenes(scenes)
  return r
}

/** 複数シーンを 1 本の Event[] に線形連結する（NovelRenderer.restoreSnapshot.test.ts と同形）。 */
function flatten(scenes: EventScene[]): Event[] {
  const events: Event[] = []
  let first = true
  for (const s of scenes) {
    if (!first) events.push('SceneTransition' as Event)
    first = false
    events.push(...s.events)
  }
  return events
}

interface RendererInternals {
  appInitialized: boolean
  app: {
    canvas: { removeEventListener: (...args: unknown[]) => void }
    destroy: (...args: unknown[]) => void
  }
  lightingLayer: { clear: () => void }
}
function internals(r: NovelRenderer): RendererInternals {
  return r as unknown as RendererInternals
}

/** destroy() の appInitialized ガードを満たす最小スタブ（NovelRenderer.prop.test.ts と同じ）。 */
function stubDestroyableApp(r: NovelRenderer): void {
  const ri = internals(r)
  ri.appInitialized = true
  Object.defineProperty(ri.app, 'canvas', {
    configurable: true,
    value: { removeEventListener: () => {} },
  })
  ri.app.destroy = () => {}
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
    savedAt: new Date().toISOString(),
    sceneName: null,
    ...over,
  }
}

function seedQuickSave(data: SaveSlotData): void {
  new SaveManager().quickSave(data)
}

describe('NovelRenderer 追うスポットライト配線 (#693)', () => {
  beforeEach(() => {
    new SaveManager().deleteQuickSave()
  })

  afterEach(() => {
    new SaveManager().deleteQuickSave()
    vi.restoreAllMocks()
  })

  it('1: [スポットライト: ...] 実行で点灯し、getSnapshot().spotlight に target/color/radius が反映される', async () => {
    const r = makeRenderer([
      scene('a', [narration('one'), spotlight('alice', '#ff0000', 0.3), narration('two')]),
    ])
    r.startFrom({ sceneId: 'a' })
    expect(r.getSnapshot().spotlight).toBeNull()

    await r.playScript([{ type: 'advance' }]) // one -> spotlight(directive処理) -> two

    expect(r.getSnapshot().spotlight).toEqual({ target: 'alice', color: '#ff0000', radius: 0.3 })
  })

  it('2: [スポットライト消灯] 実行で消灯し、getSnapshot().spotlight が null に戻る', async () => {
    const r = makeRenderer([
      scene('a', [
        narration('one'),
        spotlight('alice', '#ff0000', 0.3),
        narration('two'),
        SPOTLIGHT_OFF,
        narration('three'),
      ]),
    ])
    r.startFrom({ sceneId: 'a' })

    await r.playScript([{ type: 'advance' }]) // one -> spotlight -> two
    expect(r.getSnapshot().spotlight).not.toBeNull()

    await r.playScript([{ type: 'advance' }]) // two -> spotlight消灯 -> three
    expect(r.getSnapshot().spotlight).toBeNull()
  })

  it('3: シーン遷移（jumpToScene、resetAndStartEvents 経由）で既定値（消灯）にリセットされる', async () => {
    const r = makeRenderer([
      scene('a', [narration('one'), spotlight('alice', '#ffffff', 0.2), narration('two')]),
      scene('b', [narration('three')]),
    ])
    r.startFrom({ sceneId: 'a' })

    await r.playScript([{ type: 'advance' }])
    expect(r.getSnapshot().spotlight).not.toBeNull()

    r.jumpToScene('b')

    expect(r.getSnapshot().spotlight).toBeNull()
  })

  it("4: マルチMD連結の 'SceneTransition' イベント（jumpToScene とは別のクリア呼び出し箇所）でも消灯される", async () => {
    const r = new NovelRenderer()
    r.setEvents(
      flatten([
        scene('a', [narration('one'), spotlight('alice', '#ffffff', 0.2), narration('two')]),
        scene('b', [narration('three')]),
      ])
    )

    await r.playScript([{ type: 'advance' }]) // one -> spotlight -> two
    expect(r.getSnapshot().spotlight).not.toBeNull()

    await r.playScript([{ type: 'advance' }]) // two -> 'SceneTransition' -> three
    expect(r.getSnapshot().spotlight).toBeNull()
    expect(r.getSnapshot().textIndex).toBe(0)
  })

  it('5: goBack すると直前のスナップショット（点灯前）に戻る（宣言的復元、isBlackout/CameraModeと同じ規律）', async () => {
    const r = makeRenderer([
      scene('a', [narration('one'), spotlight('bob', '#00ff00', 0.4), narration('two')]),
    ])
    r.startFrom({ sceneId: 'a' })
    expect(r.getSnapshot().spotlight).toBeNull()

    await r.playScript([{ type: 'advance' }])
    expect(r.getSnapshot().spotlight).toEqual({ target: 'bob', color: '#00ff00', radius: 0.4 })

    r.goBack() // two -> one（ディレクティブ実行前のスナップショットへ）

    expect(r.getSnapshot().spotlight).toBeNull()
  })

  it('6: endStory()（confinement 圏外遷移経由）で消灯する', async () => {
    const r = makeRenderer([
      scene('entry', [narration('one'), spotlight('alice', '#ffffff', 0.2), narration('two')]),
      scene('out-scene', [narration('outside')]),
    ])
    r.setConfinedSceneIds(['entry'])
    r.startFrom({ sceneId: 'entry' })

    await r.playScript([{ type: 'advance' }])
    expect(r.getSnapshot().spotlight).not.toBeNull()

    r.jumpToScene('out-scene') // 圏外 → endStory() 経由

    expect(r.getSnapshot().storyEnded).toBe(true)
    expect(r.getSnapshot().spotlight).toBeNull()
  })

  it('7: destroy() は lightingLayer.clear() を呼ぶ（ticker/テクスチャの後始末）', () => {
    const r = makeRenderer([scene('a', [narration('one')])])
    stubDestroyableApp(r)
    const clearSpy = vi.spyOn(internals(r).lightingLayer, 'clear')

    r.destroy()

    expect(clearSpy).toHaveBeenCalled()
  })

  it('8: quickSave → quickLoad で spotlight が復元される', async () => {
    const r = makeRenderer([
      scene('a', [narration('one'), spotlight('alice', '#123456', 0.5), narration('two')]),
    ])
    r.startFrom({ sceneId: 'a' })
    await r.playScript([{ type: 'advance' }])
    expect(r.getSnapshot().spotlight).toEqual({ target: 'alice', color: '#123456', radius: 0.5 })

    vi.spyOn(r.getAudioManager(), 'ensureContext').mockImplementation(() => {})
    expect(r.quickSave()).toBe(true)

    const r2 = makeRenderer([
      scene('a', [narration('one'), spotlight('alice', '#123456', 0.5), narration('two')]),
    ])
    vi.spyOn(r2.getAudioManager(), 'ensureContext').mockImplementation(() => {})
    expect(r2.quickLoad()).toBe(true)
    expect(r2.getSnapshot().spotlight).toEqual({ target: 'alice', color: '#123456', radius: 0.5 })
  })

  it('9: 旧セーブ（spotlight キー欠如）は消灯（null）として復元される（後方互換）', () => {
    const legacy = craftSave({ sceneId: 'a' }) as unknown as Record<string, unknown>
    delete legacy.spotlight
    seedQuickSave(legacy as unknown as SaveSlotData)

    const r = makeRenderer([scene('a', [narration('one')])])
    vi.spyOn(r.getAudioManager(), 'ensureContext').mockImplementation(() => {})

    expect(r.quickLoad()).toBe(true)
    expect(r.getSnapshot().spotlight).toBeNull()
  })

  it('10: 任意局面起動（startFrom の eventIndex 指定経路）は最小合成 state を使うため常に消灯で始まる', () => {
    // シーン先頭に [スポットライト: ...] があっても、eventIndex 指定（?debug_scene= 相当）は
    // イベント再生ではなく restoreToScene の宣言的復元（props/backgroundBoards と同じく
    // 空/nullに倒す最小合成 NovelGameState）を通るため、spotlight は復元されない。
    const r = makeRenderer([
      scene('a', [spotlight('alice', '#ffffff', 0.2), narration('one'), narration('two')]),
    ])

    r.startFrom({ sceneId: 'a', eventIndex: 1 })

    expect(r.getSnapshot().spotlight).toBeNull()
    expect(r.getSnapshot().eventIndex).toBe(1)
  })
})
