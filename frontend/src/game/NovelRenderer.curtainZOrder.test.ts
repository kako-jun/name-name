/**
 * NovelRenderer 幕 (#697) の z-order 動的切り替え統合テスト。
 *
 * Issue #697 の目的そのもの: `characters_in_front` に応じて `curtainLayer` の stage 上の
 * 位置を `backgroundBoardLayer` の直後（キャラより奥＝カーテンコール）/ `propLayer` の直後
 * （最前面＝通常の閉幕）に動的に切り替える `NovelRenderer.setCurtainZOrder()` を検証する。
 *
 * `CurtainLayer` 自体の幾何・昇降アニメーション・race は `CurtainLayer.test.ts` でカバー済み。
 * ここでは NovelRenderer が実際に `stage.children` の並びをどう動かすかだけを見る。
 *
 * z-order は PixiJS の実 stage（`app.stage.addChild` 済みの子要素配列）を見て初めて検証できる
 * ため、`NovelRenderer.prop.test.ts` の「#695 の順序契約」テストと同じ手法で
 * `Application.init` だけをスタブ化し、`NovelRenderer.init()` 本体を通す
 * （jsdom には実 PixiJS canvas が無く `app.init()` 自体は最後まで実行できないため）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NovelRenderer } from './NovelRenderer'
import type { NovelGameState } from './GameState'
import type { Event, EventScene } from '../types'

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

interface RendererInternals {
  backgroundBoardLayer: object
  propLayer: object
  curtainLayer: object
  appInitialized: boolean
  app: {
    init: (...args: unknown[]) => Promise<void>
    stage: { children: unknown[] }
    canvas: unknown
    renderer?: { resolution: number }
    destroy: (...args: unknown[]) => void
  }
}
function internals(r: NovelRenderer): RendererInternals {
  return r as unknown as RendererInternals
}

/** `Application.init` をスタブ化して `NovelRenderer.init()` 本体を実際に通す (NovelRenderer.prop.test.ts と同形)。 */
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

/** destroy() の appInitialized ガードを満たす最小スタブ (NovelRenderer.prop.test.ts と同じ)。 */
function cleanupRenderer(r: NovelRenderer): void {
  const ri = internals(r)
  ri.app.destroy = () => {}
  r.destroy()
}

/** curtainLayer が referenceLayer の直後（index+1）に居るかどうか。 */
function curtainRightAfter(r: NovelRenderer, referenceLayer: object): boolean {
  const ri = internals(r)
  const children = ri.app.stage.children
  const refIndex = children.indexOf(referenceLayer)
  const curtainIndex = children.indexOf(ri.curtainLayer)
  return refIndex >= 0 && curtainIndex === refIndex + 1
}

/** stage 上に curtainLayer が重複して積まれていないか（addChildAt 差し替えの正しさ）。 */
function curtainChildCount(r: NovelRenderer): number {
  const ri = internals(r)
  return ri.app.stage.children.filter((c) => c === ri.curtainLayer).length
}

function muteAudio(r: NovelRenderer): void {
  vi.spyOn(r.getAudioManager(), 'ensureContext').mockImplementation(() => {})
}

function craftSnapshot(over: Partial<NovelGameState>): NovelGameState {
  return {
    sceneId: 'a',
    eventIndex: 0,
    textIndex: 0,
    sentenceIndex: 0,
    flags: {},
    backgroundPath: null,
    backgroundColor: null,
    backgroundFade: null,
    backgroundBrightness: null,
    video: null,
    eventImage: null,
    backgroundBoards: [],
    props: [],
    spotlight: null,
    curtain: null,
    isBlackout: false,
    characters: [],
    currentBgmPath: null,
    cameraMode: 'Novel',
    cameraOrientation: 'Audience',
    cameraElevation: null,
    paperDollOutline: null,
    storyEnded: false,
    ...over,
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('NovelRenderer 幕 z-order デシジョンテーブル (#697)', () => {
  it('幕なし（初回表示）+ characters_in_front省略(false) → propLayer の直後（最前面）', async () => {
    const r = new NovelRenderer()
    await initRenderer(r)
    r.setScenes([scene('a', [curtain('a.png'), narration('one')])])

    expect(curtainRightAfter(r, internals(r).propLayer)).toBe(true)
    expect(curtainChildCount(r)).toBe(1)

    cleanupRenderer(r)
  })

  it('幕なし（初回表示）+ characters_in_front=true → backgroundBoardLayer の直後（キャラより奥）', async () => {
    const r = new NovelRenderer()
    await initRenderer(r)
    r.setScenes([scene('a', [curtain('a.png', true), narration('one')])])

    expect(curtainRightAfter(r, internals(r).backgroundBoardLayer)).toBe(true)
    expect(curtainChildCount(r)).toBe(1)

    cleanupRenderer(r)
  })

  it('幕あり(false)→上書きtrue → backgroundBoardLayer の直後へ切り替わる', async () => {
    const r = new NovelRenderer()
    await initRenderer(r)
    r.setScenes([
      scene('a', [
        curtain('a.png', false),
        narration('one'),
        curtain('a.png', true),
        narration('two'),
      ]),
    ])
    expect(curtainRightAfter(r, internals(r).propLayer)).toBe(true)

    await r.playScript([{ type: 'advance' }]) // one -> curtain(true)directive -> two

    expect(curtainRightAfter(r, internals(r).backgroundBoardLayer)).toBe(true)
    expect(curtainChildCount(r)).toBe(1)

    cleanupRenderer(r)
  })

  it('幕あり(true)→上書きfalse → propLayer の直後へ切り替わる', async () => {
    const r = new NovelRenderer()
    await initRenderer(r)
    r.setScenes([
      scene('a', [
        curtain('a.png', true),
        narration('one'),
        curtain('a.png', false),
        narration('two'),
      ]),
    ])
    expect(curtainRightAfter(r, internals(r).backgroundBoardLayer)).toBe(true)

    await r.playScript([{ type: 'advance' }]) // one -> curtain(false)directive -> two

    expect(curtainRightAfter(r, internals(r).propLayer)).toBe(true)
    expect(curtainChildCount(r)).toBe(1)

    cleanupRenderer(r)
  })
})

describe('NovelRenderer 幕 z-order の反復切り替え・冪等性 (#697)', () => {
  it('false→true→false→true と4回切り替えても、毎回正しい位置になり累積的にインデックスがズレない', async () => {
    const r = new NovelRenderer()
    await initRenderer(r)
    r.setScenes([
      scene('a', [
        curtain('a.png', false),
        narration('one'),
        curtain('a.png', true),
        narration('two'),
        curtain('a.png', false),
        narration('three'),
        curtain('a.png', true),
        narration('four'),
      ]),
    ])
    const stageLengthBefore = internals(r).app.stage.children.length

    expect(curtainRightAfter(r, internals(r).propLayer)).toBe(true) // false
    expect(curtainChildCount(r)).toBe(1)

    await r.playScript([{ type: 'advance' }]) // one -> true -> two
    expect(curtainRightAfter(r, internals(r).backgroundBoardLayer)).toBe(true)
    expect(curtainChildCount(r)).toBe(1)
    expect(internals(r).app.stage.children.length).toBe(stageLengthBefore)

    await r.playScript([{ type: 'advance' }]) // two -> false -> three
    expect(curtainRightAfter(r, internals(r).propLayer)).toBe(true)
    expect(curtainChildCount(r)).toBe(1)
    expect(internals(r).app.stage.children.length).toBe(stageLengthBefore)

    await r.playScript([{ type: 'advance' }]) // three -> true -> four
    expect(curtainRightAfter(r, internals(r).backgroundBoardLayer)).toBe(true)
    expect(curtainChildCount(r)).toBe(1)
    expect(internals(r).app.stage.children.length).toBe(stageLengthBefore)

    cleanupRenderer(r)
  })

  it('同じ値(false→false)を連続で渡しても冪等（順序が変わらず余計な子要素が増えない）', async () => {
    const r = new NovelRenderer()
    await initRenderer(r)
    r.setScenes([
      scene('a', [
        curtain('a.png', false),
        narration('one'),
        curtain('b.png', false),
        narration('two'),
      ]),
    ])
    const before = internals(r).app.stage.children.slice()
    expect(curtainRightAfter(r, internals(r).propLayer)).toBe(true)

    await r.playScript([{ type: 'advance' }]) // one -> curtain(b.png, false) -> two

    expect(curtainRightAfter(r, internals(r).propLayer)).toBe(true)
    expect(curtainChildCount(r)).toBe(1)
    expect(internals(r).app.stage.children).toEqual(before) // 並び自体が完全に不変

    cleanupRenderer(r)
  })

  it('同じ値(true→true)を連続で渡しても冪等', async () => {
    const r = new NovelRenderer()
    await initRenderer(r)
    r.setScenes([
      scene('a', [
        curtain('a.png', true),
        narration('one'),
        curtain('b.png', true),
        narration('two'),
      ]),
    ])
    const before = internals(r).app.stage.children.slice()
    expect(curtainRightAfter(r, internals(r).backgroundBoardLayer)).toBe(true)

    await r.playScript([{ type: 'advance' }]) // one -> curtain(b.png, true) -> two

    expect(curtainRightAfter(r, internals(r).backgroundBoardLayer)).toBe(true)
    expect(curtainChildCount(r)).toBe(1)
    expect(internals(r).app.stage.children).toEqual(before)

    cleanupRenderer(r)
  })
})

describe('NovelRenderer 幕 z-order のリセット (#697)', () => {
  it('[場面転換]後は必ずz-orderが既定(false相当=propLayerの直後)に戻る', async () => {
    const r = new NovelRenderer()
    await initRenderer(r)
    r.setEvents([curtain('a.png', true), narration('one'), 'SceneTransition', narration('two')])

    expect(curtainRightAfter(r, internals(r).backgroundBoardLayer)).toBe(true)

    await r.playScript([{ type: 'advance' }]) // one -> SceneTransition(clear+resetZOrder) -> two

    expect(curtainRightAfter(r, internals(r).propLayer)).toBe(true)
    expect(curtainChildCount(r)).toBe(1)
    expect(r.getSnapshot().curtain).toBeNull()

    cleanupRenderer(r)
  })

  it('CurtainUp（幕を上げる）は幕の内容だけをクリアし、z-orderはそのまま（次に幕を降ろすときに改めて決まる）', async () => {
    const r = new NovelRenderer()
    await initRenderer(r)
    r.setScenes([
      scene('a', [curtain('a.png', true), narration('one'), CURTAIN_UP, narration('two')]),
    ])
    expect(curtainRightAfter(r, internals(r).backgroundBoardLayer)).toBe(true)

    await r.playScript([{ type: 'advance' }]) // one -> CurtainUp -> two

    expect(r.getSnapshot().curtain).toBeNull()
    // z-order 自体は明示的にリセットされない仕様（コード上の設計コメント参照）。
    expect(curtainRightAfter(r, internals(r).backgroundBoardLayer)).toBe(true)

    cleanupRenderer(r)
  })
})

describe('NovelRenderer 幕 z-order の init() 完了前ガード (#697)', () => {
  // NovelRenderer.restoreSnapshot.test.ts の「jsdom には実 PixiJS canvas が無く init() を
  // 最後まで実行できない」ケースと同じ状況を再現する: pixi の app.init() を一切呼ばず
  // （＝各レイヤーがまだ app.stage の子ではない）、curtain が非 null のスナップショットを
  // restoreSnapshot() 経由で復元しても、setCurtainZOrder() 内部で例外を投げないことを確認する。
  it('レイヤーがまだstageの子でない状態でcurtainを含むrestoreSnapshot()を呼んでも例外を投げない', () => {
    const r = new NovelRenderer()
    muteAudio(r)
    r.setScenes([scene('a', [narration('one')])])

    expect(() =>
      r.restoreSnapshot(craftSnapshot({ curtain: { path: 'a.png', charactersInFront: true } }))
    ).not.toThrow()

    // z-order の反映こそ効かない（stage未構築のため setCurtainZOrder は早期return）が、
    // settled state 自体は正しく復元される。
    expect(r.getSnapshot().curtain).toEqual({ path: 'a.png', charactersInFront: true })
  })

  it('レイヤーがまだstageの子でない状態でcurtain=falseを含むrestoreSnapshot()を呼んでも例外を投げない', () => {
    const r = new NovelRenderer()
    muteAudio(r)
    r.setScenes([scene('a', [narration('one')])])

    expect(() =>
      r.restoreSnapshot(craftSnapshot({ curtain: { path: 'b.png', charactersInFront: false } }))
    ).not.toThrow()
    expect(r.getSnapshot().curtain).toEqual({ path: 'b.png', charactersInFront: false })
  })
})
