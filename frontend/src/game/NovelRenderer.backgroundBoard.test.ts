/**
 * NovelRenderer BackgroundBoard 配線統合テスト (#683)。
 *
 * BackgroundBoardLayer 自体の幾何・スライドイン挙動は BackgroundBoardLayer.test.ts でカバー済み。
 * ここでは NovelRenderer 側の配線（settled state としての蓄積・[場面転換]でのクリア・
 * シーン間ジャンプでの持ち越し・goBack の宣言的復元）だけを検証する
 * （NovelRenderer.cameraMode.test.ts と同形。`getSnapshot()` の backgroundBoards を直接読む）。
 *
 * `setScenes()` はそれ自体が scenes[0] を自動開始する（内部で `setEvents()` → 冒頭の非テキスト
 * ディレクティブを最初のテキストイベントまで即時実行する、#293/#409 と同じ規律）。scenes[0] を
 * 対象にした `startFrom({sceneId: scenes[0].id})` を setScenes 直後に重ねて呼ぶと、冒頭の
 * ディレクティブが二重に実行されてしまう（Background 等の単一スロット状態では上書きなので
 * 無害だが、BackgroundBoard は加算的なため二重登録として顕在化する）。このファイルでは
 * scenes[0] を対象にした冒頭ディレクティブの検証は `setScenes()` の自動開始結果をそのまま読み、
 * 別シーンへの遷移が必要な検証だけ `jumpToScene`/`goBack`/`playScript` を使う。
 *
 * `assetBaseUrl` を設定しないため `Assets.load` は呼ばれない（BackgroundBoardLayer.add() の
 * ガード。NovelRenderer.cameraMode.test.ts と同じ流儀で、状態配線だけを軽量に検証できる）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Assets, type Texture } from 'pixi.js'
import { NovelRenderer } from './NovelRenderer'
import type { Event, EventScene } from '../types'
import { GAME_WIDTH } from './constants'
import { THEATER_CAMERA_REFERENCE_DEPTH } from './cameraProjection'

function narration(...lines: string[]): Event {
  return { Narration: { text: lines } }
}

function backgroundBoard(path: string, depth?: number): Event {
  return { BackgroundBoard: { path, depth } } as Event
}

/** 既存の単一スロット背景（`Background`。`backgroundBoard` の加算的な仕組みとは独立）。 */
function background(path: string): Event {
  return { Background: { path } } as Event
}

/** カメラモード切替（#681/#682。orientation/elevation は既定のまま mode だけ変える）。 */
function cameraDirective(mode: 'Novel' | 'Theater'): Event {
  return { CameraMode: { mode, orientation: undefined, elevation: undefined } } as Event
}

function scene(id: string, events: Event[]): EventScene {
  return { id, title: id, view: 'TopDown', events }
}

/** private フィールドへ到達するための内部アクセサ（NovelRenderer.eventImage.test.ts と同じ流儀）。 */
interface BackgroundBoardLayerForTest {
  clear(): void
  disposeTextures(): void
  add(path: string, depth: number, assetBaseUrl: string, opts?: { instant?: boolean }): void
  restore(boards: readonly { path: string; depth: number }[], assetBaseUrl: string): void
  // entries はカメラ射影が実際にどう反映されたかをスプライトの幾何で検証するために読む
  // （BackgroundBoardLayer.test.ts と同じ internals キャストの流儀）。
  entries: {
    path: string
    depth: number
    sprite: { x: number; y: number; width: number; height: number } | null
  }[]
}
interface RendererInternals {
  backgroundBoardLayer: BackgroundBoardLayerForTest
  appInitialized: boolean
  app: { canvas: unknown; destroy: (...args: unknown[]) => void }
}
function internals(r: NovelRenderer): RendererInternals {
  return r as unknown as RendererInternals
}

/**
 * destroy() の appInitialized ガード（PixiJS 実 init 未完了時の early-return）を満たすための
 * 最小スタブ（NovelRenderer.eventImage.test.ts の stubDestroyableApp と同じ割り切り）。
 */
function stubDestroyableApp(r: NovelRenderer): void {
  const appInternals = internals(r)
  appInternals.appInitialized = true
  Object.defineProperty(appInternals.app, 'canvas', {
    configurable: true,
    value: { removeEventListener: () => {} },
  })
  appInternals.app.destroy = () => {}
}

describe('NovelRenderer BackgroundBoard 配線 (#683)', () => {
  it('本文しかないシーンは backgroundBoards が空配列のまま', () => {
    const r = new NovelRenderer()
    r.setScenes([scene('a', [narration('one')])])
    expect(r.getSnapshot().backgroundBoards).toEqual([])
  })

  it('複数の [背景板:] が加算的に蓄積される（単一スロット背景とは異なる意味論）', () => {
    const r = new NovelRenderer()
    r.setScenes([
      scene('a', [
        backgroundBoard('sky.png', 10),
        backgroundBoard('mountain.png', 7),
        backgroundBoard('tree.png', 4),
        narration('one'),
      ]),
    ])
    // setScenes の自動開始が冒頭の3つの [背景板:] を最初のテキストイベント（'one'）まで
    // 即時実行済み（Background 等の演出ディレクティブと同じ規律）。
    expect(r.getSnapshot().backgroundBoards).toEqual([
      { path: 'sky.png', depth: 10 },
      { path: 'mountain.png', depth: 7 },
      { path: 'tree.png', depth: 4 },
    ])
  })

  it('depth 省略時は 0（最前面）として蓄積される', () => {
    const r = new NovelRenderer()
    r.setScenes([scene('a', [backgroundBoard('board.png'), narration('one')])])
    expect(r.getSnapshot().backgroundBoards).toEqual([{ path: 'board.png', depth: 0 }])
  })

  it('[場面転換] は既存の単一スロット背景と同じタイミングで背景板もクリアする', async () => {
    const r = new NovelRenderer()
    r.setScenes([
      scene('a', [
        backgroundBoard('sky.png', 10),
        narration('one'),
        'SceneTransition',
        narration('two'),
      ]),
    ])
    expect(r.getSnapshot().backgroundBoards).toEqual([{ path: 'sky.png', depth: 10 }])

    await r.playScript([{ type: 'advance' }]) // one -> SceneTransition(clear) -> two
    expect(r.getSnapshot().backgroundBoards).toEqual([])
  })

  it('通常のシーン間ジャンプ（jumpToScene）では既存の単一スロット背景と同じく持ち越される', () => {
    const r = new NovelRenderer()
    r.setScenes([
      scene('a', [backgroundBoard('sky.png', 10), narration('one')]),
      scene('b', [narration('two')]),
    ])
    expect(r.getSnapshot().backgroundBoards).toEqual([{ path: 'sky.png', depth: 10 }])

    r.jumpToScene('b')
    expect(r.getSnapshot().backgroundBoards).toEqual([{ path: 'sky.png', depth: 10 }])
  })

  it('setEvents() を再度呼ぶ（新しいイベント列の開始・非 preserve 分岐）と既存の背景板はクリアされる', () => {
    const r = new NovelRenderer()
    r.setEvents([backgroundBoard('sky.png', 10), narration('one')])
    expect(r.getSnapshot().backgroundBoards).toEqual([{ path: 'sky.png', depth: 10 }])

    r.setEvents([narration('two')])
    expect(r.getSnapshot().backgroundBoards).toEqual([])
  })

  it('goBack（スナップショットベースの宣言的復元）で [背景板:] 実行前の状態に戻る', async () => {
    const r = new NovelRenderer()
    // 'one' が先頭のテキストイベントなので、自動開始はここで停止する（冒頭ディレクティブなし）。
    r.setScenes([scene('a', [narration('one'), backgroundBoard('sky.png', 10), narration('two')])])
    expect(r.getSnapshot().backgroundBoards).toEqual([])

    await r.playScript([{ type: 'advance' }]) // one -> board(directive) -> two
    expect(r.getSnapshot().backgroundBoards).toEqual([{ path: 'sky.png', depth: 10 }])

    r.goBack() // two -> one（board 実行前のスナップショットへ）
    expect(r.getSnapshot().backgroundBoards).toEqual([])
  })
})

describe('NovelRenderer BackgroundBoard と既存の単一スロット背景の独立性 (#683)', () => {
  // テスト観点4: [背景:]（単一スロット背景。processDirective の 'Background' 分岐）は
  // backgroundBoardLayer に一切触れない実装（NovelRenderer.ts 参照）のため、
  // backgroundBoards は不変のまま。
  it('4: [背景:] の変更は backgroundBoards に一切影響しない', () => {
    const r = new NovelRenderer()
    r.setScenes([
      scene('a', [backgroundBoard('sky.png', 10), background('room.png'), narration('one')]),
    ])
    expect(r.getSnapshot().backgroundBoards).toEqual([{ path: 'sky.png', depth: 10 }])
    expect(r.getSnapshot().backgroundPath).toBe('room.png')
  })

  // テスト観点4続: 単一スロット背景を複数回差し替えても（新しい方が古い方を置換）、
  // 加算的な backgroundBoards には波及しない（意味論が完全に独立していることの追加確認）。
  it('4b: 複数回の [背景:] 差し替え（単一スロットの置換）を経ても backgroundBoards は変化しない', async () => {
    const r = new NovelRenderer()
    r.setScenes([
      scene('a', [
        backgroundBoard('sky.png', 10),
        background('room1.png'),
        narration('one'),
        background('room2.png'),
        narration('two'),
      ]),
    ])
    expect(r.getSnapshot().backgroundBoards).toEqual([{ path: 'sky.png', depth: 10 }])
    expect(r.getSnapshot().backgroundPath).toBe('room1.png')

    await r.playScript([{ type: 'advance' }]) // one -> [背景: room2.png] -> two
    expect(r.getSnapshot().backgroundPath).toBe('room2.png')
    expect(r.getSnapshot().backgroundBoards).toEqual([{ path: 'sky.png', depth: 10 }])
  })
})

describe('NovelRenderer BackgroundBoard の settled state / 破棄 / 復元経路 (#683)', () => {
  // テスト観点16: BackgroundBoardLayer.getState() は
  // `entries.map((e) => ({ path: e.path, depth: e.depth }))` のみを返す実装のため、
  // getSnapshot().backgroundBoards の各要素はスプライトやアニメーション位相などの内部状態を
  // 一切含まない、{path, depth} の2キーだけの settled state になる（ADR-0002）。
  it('16: getSnapshot().backgroundBoards の各要素は {path, depth} のみで内部状態を含まない', () => {
    const r = new NovelRenderer()
    r.setScenes([scene('a', [backgroundBoard('sky.png', 10), narration('one')])])
    const boards = r.getSnapshot().backgroundBoards
    expect(boards).toHaveLength(1)
    expect(Object.keys(boards[0]).sort()).toEqual(['depth', 'path'])
  })

  // テスト観点17: destroy() は backgroundBoardLayer.clear() と disposeTextures() の両方を呼ぶ
  // （eventImageLayer と同じ GPU テクスチャのリーク防止の流儀、NovelRenderer.eventImage.test.ts
  // の EI14 と同型）。
  it('17: destroy() は backgroundBoardLayer.clear() と disposeTextures() の両方を呼ぶ', () => {
    const r = new NovelRenderer()
    r.setScenes([scene('a', [backgroundBoard('sky.png', 10), narration('one')])])
    const layer = internals(r).backgroundBoardLayer
    const clearSpy = vi.spyOn(layer, 'clear')
    const disposeSpy = vi.spyOn(layer, 'disposeTextures')
    stubDestroyableApp(r)

    r.destroy()

    expect(clearSpy).toHaveBeenCalled()
    expect(disposeSpy).toHaveBeenCalledTimes(1)
  })

  // テスト観点18: goBack/seekTo（applyState 経由）で板を含むスナップショットへ戻る際は、
  // 常に backgroundBoardLayer.restore() 経由で `add(path, depth, assetBaseUrl, { instant: true })`
  // が呼ばれる。instant:true は add() 内で「上から降りてくる」スライドインを起こさず即座に
  // 最終位置へ配置する分岐（BackgroundBoardLayer.test.ts で直接検証済み）に対応するため、
  // この呼び出し引数を固定すれば goBack 経由でスライドインが発生しないことを保証できる。
  it('18: goBack で板を含むスナップショットへ戻る際は instant:true で復元されスライドインしない', async () => {
    const r = new NovelRenderer()
    r.setScenes([scene('a', [backgroundBoard('sky.png', 10), narration('one'), narration('two')])])
    // setScenes の自動開始で [背景板:] directive が実行済み、'one' で停止。
    await r.playScript([{ type: 'advance' }]) // one -> two
    const layer = internals(r).backgroundBoardLayer
    const addSpy = vi.spyOn(layer, 'add')

    r.goBack() // two -> one（backgroundBoards=[sky.png] のまま）

    expect(addSpy).toHaveBeenCalledWith('sky.png', 10, '', { instant: true })
  })
})

describe('NovelRenderer BackgroundBoard カメラ状態のシーン遷移同期 (PR #690 セルフレビュー must)', () => {
  // resetAndStartEvents() は cameraMode/cameraOrientation/cameraElevation を毎シーン既定値へ
  // リセットするが、backgroundBoardLayer が内部に保持するカメラ状態（setCamera() でしか
  // 同期されない）は別。この3行の直後に backgroundBoardLayer.setCamera() を呼ばないと、
  // getSnapshot().cameraMode は 'Novel' に戻るのに、持ち越された板は前シーンのカメラ射影
  // （縮小表示）のまま取り残される。この describe は幾何（sprite.width）で実際の症状を検証する
  // （BackgroundBoardLayer.test.ts が射影計算自体をカバー済みなので、ここでは配線の欠落だけを見る）。

  function mockTexture(): Texture {
    // 画面と同じアスペクト比のテクスチャ（cover-fit で screenWidth にぴったり一致させ、
    // scale 以外の要因で width が動かないようにする。BackgroundBoardLayer.test.ts と同じ流儀）。
    return { width: GAME_WIDTH, height: 450, source: { scaleMode: 'linear' } } as unknown as Texture
  }

  function mockAssetsLoadResolved(): void {
    vi.spyOn(Assets, 'load').mockResolvedValue(mockTexture() as never)
  }

  const flushPromises = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('通常のシーン間ジャンプで持ち越された板は、カメラが Novel にリセットされると原寸に戻る（Theater 射影を引きずらない）', async () => {
    const r = new NovelRenderer()
    r.getTimeController().setMode('virtual')
    mockAssetsLoadResolved()
    r.setAssetBaseUrl('/assets')
    const depth = THEATER_CAMERA_REFERENCE_DEPTH // scale = REF/(REF+REF) = 0.5 になる depth を選ぶ
    r.setScenes([
      scene('a', [cameraDirective('Theater'), backgroundBoard('sky.png', depth), narration('one')]),
      scene('b', [narration('two')]),
    ])
    await flushPromises()
    // スライドイン演出を完了させ、y と同様に interval に左右されない状態で幾何を確認する。
    r.getTimeController().tick(1000)

    const layer = internals(r).backgroundBoardLayer
    const before = layer.entries.find((e) => e.path === 'sky.png')?.sprite
    expect(before?.width).toBeCloseTo(GAME_WIDTH * 0.5) // シーンA: Theater 射影で縮小

    r.jumpToScene('b') // resetAndStartEvents（preserveBackgroundForTransition=true 分岐）

    const after = layer.entries.find((e) => e.path === 'sky.png')?.sprite
    expect(after?.width).toBe(GAME_WIDTH) // シーンB: Novel（原寸）に戻っているはず
  })

  it('カメラのみ Theater だったシーンから遷移後、新規 [背景板:] は Novel 射影（原寸）で配置される', async () => {
    const r = new NovelRenderer()
    r.getTimeController().setMode('virtual')
    mockAssetsLoadResolved()
    r.setAssetBaseUrl('/assets')
    const depth = THEATER_CAMERA_REFERENCE_DEPTH
    r.setScenes([
      scene('a', [cameraDirective('Theater'), narration('one')]),
      scene('b', [backgroundBoard('tree.png', depth), narration('two')]),
    ])
    await flushPromises()

    r.jumpToScene('b') // resetAndStartEvents 直後にシーンBの [背景板:] が実行される
    await flushPromises()

    const layer = internals(r).backgroundBoardLayer
    const sprite = layer.entries.find((e) => e.path === 'tree.png')?.sprite
    expect(sprite?.width).toBe(GAME_WIDTH) // 古い Theater 射影を引きずらず Novel（原寸）で配置される
  })

  // 注記: `[場面転換]`（processDirective の 'SceneTransition' 分岐）はシーン内の演出リセット
  // であって resetAndStartEvents を経由するシーン境界ではない。cameraMode 自体をここでは
  // リセットしない設計（#681 のスコープ、docs/architecture.md 参照）のため、`[場面転換]` の
  // 前後で backgroundBoardLayer とこの2状態が乖離することはなく、本 must 修正の対象外。
})
