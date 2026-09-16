/**
 * NovelRenderer 幕 (#697) の永続化往復・持続規律の統合テスト。
 *
 * z-order 切り替えそのものの検証は NovelRenderer.curtainZOrder.test.ts、CurtainLayer 自体の
 * 幾何・race は CurtainLayer.test.ts でカバー済み。ここでは「settled state としての curtain の
 * 保存/復元」と、#716 型の事故（curtain 値の持ち越しと z-order の持ち越しが別コードパスで、
 * 片方だけ実装漏れになる）の再発防止を検証する（NovelRenderer.spotlight.test.ts と同形）。
 */
import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest'
import { NovelRenderer } from './NovelRenderer'
import { SaveManager, type SaveSlotData } from './SaveManager'
import type { Event, EventScene } from '../types'

// --- fixture helpers（NovelRenderer.spotlight.test.ts と同じスタイル）---

function narration(...lines: string[]): Event {
  return { Narration: { text: lines } }
}

function curtain(path: string, charactersInFront?: boolean): Event {
  return { Curtain: { path, characters_in_front: charactersInFront ?? false } } as Event
}

const CURTAIN_UP: Event = 'CurtainUp' as Event

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

interface CurtainLayerForTest {
  show: (
    path: string,
    charactersInFront: boolean,
    assetBaseUrl: string,
    opts?: { instant?: boolean }
  ) => void
}
interface RendererInternals {
  appInitialized: boolean
  app: {
    init: (...args: unknown[]) => Promise<void>
    stage: { children: unknown[] }
    canvas: unknown
    renderer?: { resolution: number }
    destroy: (...args: unknown[]) => void
  }
  curtainLayer: CurtainLayerForTest
  backgroundBoardLayer: object
  propLayer: object
}
function internals(r: NovelRenderer): RendererInternals {
  return r as unknown as RendererInternals
}

/** `Application.init` をスタブ化して `NovelRenderer.init()` 本体を実際に通す
 *  (NovelRenderer.prop.test.ts / NovelRenderer.curtainZOrder.test.ts と同形)。
 *  z-order（stage.children の並び）の検証にのみ使う。 */
async function initRenderer(r: NovelRenderer): Promise<void> {
  const ri = internals(r)
  vi.spyOn(ri.app, 'init').mockResolvedValue()
  Object.defineProperty(ri.app, 'canvas', {
    configurable: true,
    value: document.createElement('canvas'),
  })
  Object.defineProperty(ri.app, 'renderer', {
    configurable: true,
    value: { resolution: 1 },
  })
  await r.init(document.createElement('div'))
}

function curtainRightAfter(r: NovelRenderer, referenceLayer: object): boolean {
  const ri = internals(r)
  const children = ri.app.stage.children
  const refIndex = children.indexOf(referenceLayer)
  const curtainIndex = children.indexOf(ri.curtainLayer as unknown as object)
  return refIndex >= 0 && curtainIndex === refIndex + 1
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

describe('NovelRenderer 幕の settled state (#697)', () => {
  beforeEach(() => {
    new SaveManager().deleteQuickSave()
  })

  afterEach(() => {
    new SaveManager().deleteQuickSave()
    vi.restoreAllMocks()
  })

  it('1: [幕: a.png] 実行後、getSnapshot().curtain が {path, charactersInFront:false} になる', async () => {
    const r = makeRenderer([scene('a', [narration('one'), curtain('a.png'), narration('two')])])
    expect(r.getSnapshot().curtain).toBeNull()

    await r.playScript([{ type: 'advance' }])

    expect(r.getSnapshot().curtain).toEqual({ path: 'a.png', charactersInFront: false })
  })

  it('2: [幕: a.png, 手前にキャラ] 実行後、charactersInFront: true が反映される', async () => {
    const r = makeRenderer([
      scene('a', [narration('one'), curtain('a.png', true), narration('two')]),
    ])
    await r.playScript([{ type: 'advance' }])
    expect(r.getSnapshot().curtain).toEqual({ path: 'a.png', charactersInFront: true })
  })

  it('3: [幕: 上げる]（CurtainUp）実行後、getSnapshot().curtain が null に戻る', async () => {
    const r = makeRenderer([
      scene('a', [
        narration('one'),
        curtain('a.png'),
        narration('two'),
        CURTAIN_UP,
        narration('three'),
      ]),
    ])
    await r.playScript([{ type: 'advance' }]) // one -> curtain -> two
    expect(r.getSnapshot().curtain).not.toBeNull()

    await r.playScript([{ type: 'advance' }]) // two -> CurtainUp -> three
    expect(r.getSnapshot().curtain).toBeNull()
  })

  it("4: マルチMD連結の 'SceneTransition' イベント実行でcurtainがnullにクリアされる", () => {
    const r = new NovelRenderer()
    r.setEvents(
      flatten([
        scene('a', [curtain('a.png', true), narration('one')]),
        scene('b', [narration('two')]),
      ])
    )
    expect(r.getSnapshot().curtain).toEqual({ path: 'a.png', charactersInFront: true })

    return r.playScript([{ type: 'advance' }]).then(() => {
      // one -> 'SceneTransition'(clear) -> two
      expect(r.getSnapshot().curtain).toBeNull()
    })
  })
})

describe('NovelRenderer 幕: quickSave/quickLoad往復 (#697)', () => {
  beforeEach(() => {
    new SaveManager().deleteQuickSave()
  })

  afterEach(() => {
    new SaveManager().deleteQuickSave()
    vi.restoreAllMocks()
  })

  it('5: quickSave -> quickLoad で curtain が復元される', async () => {
    const r = makeRenderer([
      scene('a', [narration('one'), curtain('a.png', true), narration('two')]),
    ])
    await r.playScript([{ type: 'advance' }])
    expect(r.getSnapshot().curtain).toEqual({ path: 'a.png', charactersInFront: true })

    vi.spyOn(r.getAudioManager(), 'ensureContext').mockImplementation(() => {})
    expect(r.quickSave()).toBe(true)

    const r2 = makeRenderer([
      scene('a', [narration('one'), curtain('a.png', true), narration('two')]),
    ])
    vi.spyOn(r2.getAudioManager(), 'ensureContext').mockImplementation(() => {})
    expect(r2.quickLoad()).toBe(true)
    expect(r2.getSnapshot().curtain).toEqual({ path: 'a.png', charactersInFront: true })
  })

  it('6: 旧セーブ（curtain キー欠如）は幕なし（null）として復元される（後方互換）', () => {
    const legacy = craftSave({ sceneId: 'a' }) as unknown as Record<string, unknown>
    delete legacy.curtain
    seedQuickSave(legacy as unknown as SaveSlotData)

    const r = makeRenderer([scene('a', [narration('one')])])
    vi.spyOn(r.getAudioManager(), 'ensureContext').mockImplementation(() => {})

    expect(r.quickLoad()).toBe(true)
    expect(r.getSnapshot().curtain).toBeNull()
  })
})

describe('NovelRenderer 幕: curtain値とz-orderの同時持ち越し (#697、#716型再発防止)', () => {
  // #716 型の事故パターン: curtain 値の持ち越しと z-order の持ち越しは別コードパス
  // （getSnapshot/applyState 経由の settled state 復元 vs stage.setChildIndex 経由の
  // 見た目の配置）なので、片方だけ実装漏れが起こりうる。ここでは両方を同時に確認する。
  it('[幕: a.png, 手前にキャラ] 表示中に通常のシーン間ジャンプ（jumpToScene、[場面転換]を経由しない）をしても、curtain値だけでなくz-order（true）も一緒に持ち越される', async () => {
    const r = new NovelRenderer()
    await initRenderer(r)
    r.setScenes([
      scene('a', [curtain('a.png', true), narration('one')]),
      scene('b', [narration('two')]),
    ])
    expect(r.getSnapshot().curtain).toEqual({ path: 'a.png', charactersInFront: true })
    expect(curtainRightAfter(r, internals(r).backgroundBoardLayer)).toBe(true)

    r.jumpToScene('b') // resetAndStartEvents(preserveBackgroundForTransition=true) 経由。
    // [場面転換] は経由しない — props/backgroundBoards と同じ「持ち越し」規律のシーン間ジャンプ。

    // (a) curtain 値の持ち越し。
    expect(r.getSnapshot().curtain).toEqual({ path: 'a.png', charactersInFront: true })
    // (b) z-order の持ち越し（curtain 値だけ正しくて z-order が既定に戻ってしまう、
    //     あるいはその逆という #716 型の片側欠落が無いことを直接確認する）。
    expect(curtainRightAfter(r, internals(r).backgroundBoardLayer)).toBe(true)

    const ri = internals(r)
    ri.app.destroy = () => {}
    r.destroy()
  })

  it('[幕: a.png]（false）表示中に通常のシーン間ジャンプをしても、curtain値・z-order（propLayerの直後）ともに持ち越される', async () => {
    const r = new NovelRenderer()
    await initRenderer(r)
    r.setScenes([
      scene('a', [curtain('a.png', false), narration('one')]),
      scene('b', [narration('two')]),
    ])
    expect(r.getSnapshot().curtain).toEqual({ path: 'a.png', charactersInFront: false })
    expect(curtainRightAfter(r, internals(r).propLayer)).toBe(true)

    r.jumpToScene('b')

    expect(r.getSnapshot().curtain).toEqual({ path: 'a.png', charactersInFront: false })
    expect(curtainRightAfter(r, internals(r).propLayer)).toBe(true)

    const ri = internals(r)
    ri.app.destroy = () => {}
    r.destroy()
  })
})

describe('NovelRenderer 幕: goBack/seekToの宣言的復元 (#697)', () => {
  beforeEach(() => {
    new SaveManager().deleteQuickSave()
  })

  afterEach(() => {
    new SaveManager().deleteQuickSave()
    vi.restoreAllMocks()
  })

  it('7: goBackすると直前のスナップショット（幕を降ろす前）に戻る', async () => {
    const r = makeRenderer([
      scene('a', [narration('one'), curtain('a.png', true), narration('two')]),
    ])
    expect(r.getSnapshot().curtain).toBeNull()
    await r.playScript([{ type: 'advance' }])
    expect(r.getSnapshot().curtain).toEqual({ path: 'a.png', charactersInFront: true })

    r.goBack() // two -> one（幕実行前のスナップショットへ）

    expect(r.getSnapshot().curtain).toBeNull()
  })

  it('8: goBackで幕を含むスナップショットへ戻る際は instant:true で復元されスライドインしない（ADR-0002）', async () => {
    const r = makeRenderer([
      scene('a', [curtain('a.png', true), narration('one'), narration('two')]),
    ])
    // setScenes の自動開始で [幕:] directive が実行済み、'one' で停止。
    await r.playScript([{ type: 'advance' }]) // one -> two
    const layer = internals(r).curtainLayer
    const showSpy = vi.spyOn(layer, 'show')

    r.goBack() // two -> one（curtain={a.png,true} のまま）

    expect(showSpy).toHaveBeenCalledWith('a.png', true, '', { instant: true })
  })

  it('9: seekTo で幕状態が正しい局面へ即座に復元される（アニメーションを起こさない）', async () => {
    const r = makeRenderer([
      scene('a', [
        narration('p0'),
        curtain('a.png', false),
        narration('p1'),
        curtain('b.png', true),
        narration('p2'),
      ]),
    ])
    r.startFrom({ sceneId: 'a' })
    // history[0]: p0 到達時点のスナップショット（curtain 未実行 = null）
    await r.playScript([{ type: 'advance' }])
    // history[1]: p1 到達時点のスナップショット（curtain={a.png,false} 実行済み）
    await r.playScript([{ type: 'advance' }])
    // 現在地は p2（curtain={b.png,true} 実行済み）
    expect(r.getSnapshot().curtain).toEqual({ path: 'b.png', charactersInFront: true })

    r.seekTo(1) // p1 到達時点へ戻る
    expect(r.getSnapshot().curtain).toEqual({ path: 'a.png', charactersInFront: false })

    r.seekTo(0) // p0 到達時点へ戻る（curtain 未実行）
    expect(r.getSnapshot().curtain).toBeNull()
  })
})
