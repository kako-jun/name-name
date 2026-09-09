/**
 * NovelRenderer Prop（舞台構造の大道具）配線統合テスト (#692)。
 *
 * `NovelRenderer.backgroundBoard.test.ts`（#683）を Prop 向けに移植したもの。PropLayer 自体の
 * 幾何・スライドイン挙動は PropLayer.test.ts でカバー済み。ここでは NovelRenderer 側の配線
 * （settled state としての蓄積・[場面転換]でのクリア・シーン間ジャンプでの持ち越し・goBack の
 * 宣言的復元・他レイヤーとの独立性）だけを検証する（NovelRenderer.cameraMode.test.ts と同形。
 * `getSnapshot()` の props を直接読む）。
 *
 * `setScenes()` はそれ自体が scenes[0] を自動開始する（内部で `setEvents()` → 冒頭の非テキスト
 * ディレクティブを最初のテキストイベントまで即時実行する、#293/#409 と同じ規律）。scenes[0] を
 * 対象にした `startFrom({sceneId: scenes[0].id})` を setScenes 直後に重ねて呼ぶと、冒頭の
 * ディレクティブが二重に実行されてしまう（Background 等の単一スロット状態では上書きなので
 * 無害だが、Prop は加算的なため二重登録として顕在化する）。このファイルでは scenes[0] を
 * 対象にした冒頭ディレクティブの検証は `setScenes()` の自動開始結果をそのまま読み、
 * 別シーンへの遷移が必要な検証だけ `jumpToScene`/`goBack`/`playScript` を使う。
 *
 * `assetBaseUrl` を設定しないため `Assets.load` は呼ばれない（PropLayer.add() のガード。
 * NovelRenderer.cameraMode.test.ts と同じ流儀で、状態配線だけを軽量に検証できる）。
 *
 * 注記（非適用観点）: 「app.stage の子要素インデックス順が backgroundBoardLayer < propLayer <
 * characterLayer である」「BackgroundBoard/Prop の depth 数値が逆転していてもレイヤー群順が
 * 優先される」の3件は、実 PixiJS の `app.stage.addChild()` 呼び出し順（NovelRenderer.init()
 * 内、`this.app.stage.addChild(this.backgroundBoardLayer)` → `addChild(this.propLayer)` →
 * `addChild(this.characterLayer)`）でのみ決まる。jsdom には実 PixiJS canvas
 * が無く `init()` を最後まで実行できないため（`NovelRenderer.restoreSnapshot.test.ts` の
 * `markInitialized` 節・`NovelPlayer.test.tsx` の MockRenderer 節が明記する既存の環境制約）、
 * この3件はこのファイルを含む既存のどの NovelRenderer テストでも検証されていない。新たに
 * `Application.init` を丸ごと差し替えるモック基盤を作れば検証できなくはないが、この一連の
 * テスト作成の範囲外の新規インフラになるため見送る（`git grep` で NovelRenderer.ts の該当
 * addChild 3行の順序を目視確認済み: 916行目 backgroundBoardLayer → 920行目 propLayer →
 * 936行目 characterLayer）。
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

function prop(path: string, depth?: number): Event {
  return { Prop: { path, depth } } as Event
}

function backgroundBoard(path: string, depth?: number): Event {
  return { BackgroundBoard: { path, depth } } as Event
}

/** 既存の単一スロット背景（`Background`。加算的な仕組みとは独立）。 */
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
interface PropLayerForTest {
  clear(): void
  disposeTextures(): void
  add(path: string, depth: number, assetBaseUrl: string, opts?: { instant?: boolean }): void
  restore(props: readonly { path: string; depth: number }[], assetBaseUrl: string): void
  // entries はカメラ射影が実際にどう反映されたかをスプライトの幾何で検証するために読む
  // （PropLayer.test.ts と同じ internals キャストの流儀）。
  entries: {
    path: string
    depth: number
    sprite: { x: number; y: number; width: number; height: number } | null
  }[]
}
interface RendererInternals {
  propLayer: PropLayerForTest
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

describe('NovelRenderer Prop 配線 (#692)', () => {
  it('本文しかないシーンは props が空配列のまま', () => {
    const r = new NovelRenderer()
    r.setScenes([scene('a', [narration('one')])])
    expect(r.getSnapshot().props).toEqual([])
  })

  it('複数の [大道具:] が加算的に蓄積される（単一スロット背景とは異なる意味論）', () => {
    const r = new NovelRenderer()
    r.setScenes([
      scene('a', [
        prop('desk.png', 10),
        prop('chair.png', 7),
        prop('lamp.png', 4),
        narration('one'),
      ]),
    ])
    // setScenes の自動開始が冒頭の3つの [大道具:] を最初のテキストイベント（'one'）まで
    // 即時実行済み（Background 等の演出ディレクティブと同じ規律）。
    expect(r.getSnapshot().props).toEqual([
      { path: 'desk.png', depth: 10 },
      { path: 'chair.png', depth: 7 },
      { path: 'lamp.png', depth: 4 },
    ])
  })

  it('depth 省略時は 0（最前面）として蓄積される', () => {
    const r = new NovelRenderer()
    r.setScenes([scene('a', [prop('desk.png'), narration('one')])])
    expect(r.getSnapshot().props).toEqual([{ path: 'desk.png', depth: 0 }])
  })

  it('[場面転換] は backgroundBoards と同じタイミングで props もクリアする', async () => {
    const r = new NovelRenderer()
    r.setScenes([
      scene('a', [prop('desk.png', 10), narration('one'), 'SceneTransition', narration('two')]),
    ])
    expect(r.getSnapshot().props).toEqual([{ path: 'desk.png', depth: 10 }])

    await r.playScript([{ type: 'advance' }]) // one -> SceneTransition(clear) -> two
    expect(r.getSnapshot().props).toEqual([])
  })

  it('通常のシーン間ジャンプ（jumpToScene）では props も持ち越される', () => {
    const r = new NovelRenderer()
    r.setScenes([
      scene('a', [prop('desk.png', 10), narration('one')]),
      scene('b', [narration('two')]),
    ])
    expect(r.getSnapshot().props).toEqual([{ path: 'desk.png', depth: 10 }])

    r.jumpToScene('b')
    expect(r.getSnapshot().props).toEqual([{ path: 'desk.png', depth: 10 }])
  })

  it('setEvents() を再度呼ぶ（新しいイベント列の開始・非 preserve 分岐）と既存の props はクリアされる', () => {
    const r = new NovelRenderer()
    r.setEvents([prop('desk.png', 10), narration('one')])
    expect(r.getSnapshot().props).toEqual([{ path: 'desk.png', depth: 10 }])

    r.setEvents([narration('two')])
    expect(r.getSnapshot().props).toEqual([])
  })

  it('goBack（スナップショットベースの宣言的復元）で [大道具:] 実行前の状態に戻る', async () => {
    const r = new NovelRenderer()
    // 'one' が先頭のテキストイベントなので、自動開始はここで停止する（冒頭ディレクティブなし）。
    r.setScenes([scene('a', [narration('one'), prop('desk.png', 10), narration('two')])])
    expect(r.getSnapshot().props).toEqual([])

    await r.playScript([{ type: 'advance' }]) // one -> prop(directive) -> two
    expect(r.getSnapshot().props).toEqual([{ path: 'desk.png', depth: 10 }])

    r.goBack() // two -> one（prop 実行前のスナップショットへ）
    expect(r.getSnapshot().props).toEqual([])
  })
})

describe('NovelRenderer Prop と他レイヤーの独立性 (#692)', () => {
  it('[大道具:] の変更は backgroundBoards に一切影響しない', () => {
    const r = new NovelRenderer()
    r.setScenes([scene('a', [prop('desk.png', 3), narration('one')])])
    expect(r.getSnapshot().props).toEqual([{ path: 'desk.png', depth: 3 }])
    expect(r.getSnapshot().backgroundBoards).toEqual([])
  })

  it('[背景板:] の変更は props に一切影響しない', async () => {
    const r = new NovelRenderer()
    r.setScenes([
      scene('a', [
        backgroundBoard('sky.png', 10),
        prop('desk.png', 3),
        narration('one'),
        backgroundBoard('mountain.png', 7),
        narration('two'),
      ]),
    ])
    expect(r.getSnapshot().backgroundBoards).toEqual([{ path: 'sky.png', depth: 10 }])
    expect(r.getSnapshot().props).toEqual([{ path: 'desk.png', depth: 3 }])

    // 背景板をもう1枚追加で積んでも（加算的）、props は変化しない。
    await r.playScript([{ type: 'advance' }]) // one -> [背景板: mountain.png] -> two
    expect(r.getSnapshot().backgroundBoards).toEqual([
      { path: 'sky.png', depth: 10 },
      { path: 'mountain.png', depth: 7 },
    ])
    expect(r.getSnapshot().props).toEqual([{ path: 'desk.png', depth: 3 }])
  })

  it('[背景:]（単色スロット背景）の変更は props に一切影響しない', async () => {
    const r = new NovelRenderer()
    r.setScenes([
      scene('a', [
        prop('desk.png', 3),
        background('room1.png'),
        narration('one'),
        background('room2.png'),
        narration('two'),
      ]),
    ])
    expect(r.getSnapshot().props).toEqual([{ path: 'desk.png', depth: 3 }])
    expect(r.getSnapshot().backgroundPath).toBe('room1.png')

    await r.playScript([{ type: 'advance' }]) // one -> [背景: room2.png] -> two
    expect(r.getSnapshot().backgroundPath).toBe('room2.png')
    expect(r.getSnapshot().props).toEqual([{ path: 'desk.png', depth: 3 }])
  })
})

describe('NovelRenderer Prop の settled state / 破棄 / 復元経路 (#692)', () => {
  it('getSnapshot().props の各要素は {path, depth} のみで内部状態を含まない', () => {
    const r = new NovelRenderer()
    r.setScenes([scene('a', [prop('desk.png', 3), narration('one')])])
    const props = r.getSnapshot().props
    expect(props).toHaveLength(1)
    expect(Object.keys(props[0]).sort()).toEqual(['depth', 'path'])
  })

  it('destroy() は propLayer.clear() と disposeTextures() の両方を呼ぶ', () => {
    const r = new NovelRenderer()
    r.setScenes([scene('a', [prop('desk.png', 3), narration('one')])])
    const layer = internals(r).propLayer
    const clearSpy = vi.spyOn(layer, 'clear')
    const disposeSpy = vi.spyOn(layer, 'disposeTextures')
    stubDestroyableApp(r)

    r.destroy()

    expect(clearSpy).toHaveBeenCalled()
    expect(disposeSpy).toHaveBeenCalledTimes(1)
  })

  it('goBack で props を含むスナップショットへ戻る際は instant:true で復元されスライドインしない', async () => {
    const r = new NovelRenderer()
    r.setScenes([scene('a', [prop('desk.png', 3), narration('one'), narration('two')])])
    // setScenes の自動開始で [大道具:] directive が実行済み、'one' で停止。
    await r.playScript([{ type: 'advance' }]) // one -> two
    const layer = internals(r).propLayer
    const addSpy = vi.spyOn(layer, 'add')

    r.goBack() // two -> one（props=[desk.png] のまま）

    expect(addSpy).toHaveBeenCalledWith('desk.png', 3, '', { instant: true })
  })
})

describe('NovelRenderer Prop カメラ状態のシーン遷移同期 (PR #690 セルフレビュー must と同型)', () => {
  // resetAndStartEvents() は cameraMode/cameraOrientation/cameraElevation を毎シーン既定値へ
  // リセットするが、propLayer が内部に保持するカメラ状態（setCamera() でしか同期されない）は
  // 別。propLayer.setCamera() を呼ばないと、getSnapshot().cameraMode は 'Novel' に戻るのに、
  // 持ち越された大道具は前シーンのカメラ射影（縮小表示）のまま取り残される。この describe は
  // 幾何（sprite.width）で実際の症状を検証する（PropLayer.test.ts が射影計算自体をカバー
  // 済みなので、ここでは配線の欠落だけを見る。BackgroundBoard 側の同種テストと完全に対称）。

  function mockTexture(): Texture {
    // 画面と同じアスペクト比のテクスチャ（cover-fit で screenWidth にぴったり一致させ、
    // scale 以外の要因で width が動かないようにする。PropLayer.test.ts と同じ流儀）。
    return { width: GAME_WIDTH, height: 450, source: { scaleMode: 'linear' } } as unknown as Texture
  }

  function mockAssetsLoadResolved(): void {
    vi.spyOn(Assets, 'load').mockResolvedValue(mockTexture() as never)
  }

  const flushPromises = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('通常のシーン間ジャンプで持ち越された Prop は、カメラが Novel にリセットされると原寸に戻る（Theater 射影を引きずらない）', async () => {
    const r = new NovelRenderer()
    r.getTimeController().setMode('virtual')
    mockAssetsLoadResolved()
    r.setAssetBaseUrl('/assets')
    const depth = THEATER_CAMERA_REFERENCE_DEPTH // scale = REF/(REF+REF) = 0.5 になる depth を選ぶ
    r.setScenes([
      scene('a', [cameraDirective('Theater'), prop('desk.png', depth), narration('one')]),
      scene('b', [narration('two')]),
    ])
    await flushPromises()
    // スライドイン演出を完了させ、y と同様に interval に左右されない状態で幾何を確認する。
    r.getTimeController().tick(1000)

    const layer = internals(r).propLayer
    const before = layer.entries.find((e) => e.path === 'desk.png')?.sprite
    expect(before?.width).toBeCloseTo(GAME_WIDTH * 0.5) // シーンA: Theater 射影で縮小

    r.jumpToScene('b') // resetAndStartEvents（preserveBackgroundForTransition=true 分岐）

    const after = layer.entries.find((e) => e.path === 'desk.png')?.sprite
    expect(after?.width).toBe(GAME_WIDTH) // シーンB: Novel（原寸）に戻っているはず
  })

  it('カメラのみ Theater だったシーンから遷移後、新規 [大道具:] は Novel 射影（原寸）で配置される', async () => {
    const r = new NovelRenderer()
    r.getTimeController().setMode('virtual')
    mockAssetsLoadResolved()
    r.setAssetBaseUrl('/assets')
    const depth = THEATER_CAMERA_REFERENCE_DEPTH
    r.setScenes([
      scene('a', [cameraDirective('Theater'), narration('one')]),
      scene('b', [prop('chair.png', depth), narration('two')]),
    ])
    await flushPromises()

    r.jumpToScene('b') // resetAndStartEvents 直後にシーンBの [大道具:] が実行される
    await flushPromises()

    const layer = internals(r).propLayer
    const sprite = layer.entries.find((e) => e.path === 'chair.png')?.sprite
    expect(sprite?.width).toBe(GAME_WIDTH) // 古い Theater 射影を引きずらず Novel（原寸）で配置される
  })

  // 注記: `[場面転換]`（processDirective の 'SceneTransition' 分岐）はシーン内の演出リセット
  // であって resetAndStartEvents を経由するシーン境界ではない。cameraMode 自体をここでは
  // リセットしない設計（#681 のスコープ、docs/architecture.md 参照）のため、`[場面転換]` の
  // 前後で propLayer とこの2状態が乖離することはなく、本 must 修正相当の対象外
  // （BackgroundBoardLayer 側の同じ注記と対称）。
})
