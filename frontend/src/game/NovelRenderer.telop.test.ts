/**
 * NovelRenderer テロップ配線統合テスト (#674)。
 *
 * TelopLayer/computeTelopBandHeight 自体の単体挙動は TelopLayer.test.ts / novelLayout.test.ts で
 * カバー済み。ここでは NovelRenderer 側の配線だけを検証する:
 *  - `[テロップ:]` ディレクティブ処理（processDirective）→ telopLayer.show() へ渡す引数
 *  - skipMode 中は show されない
 *  - setEvents / [場面転換] / destroy でのクリア（telopLayer.clear()）
 *  - goBack/seekTo 経由の復元でクリアされ、show が再発火しない
 *  - setSeekBarColor と同じ色解決を共有するアクセント色
 *  - setTelopReserve → dialogBox.setNovelBottomReserve の配線
 *
 * 観測は既存の NovelRenderer 系テスト（NovelRenderer.eventImage.test.ts と同形）: `playScript`
 * で駆動し、telopLayer/dialogBox の private フィールドへ internals キャストでアクセスして spy する。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NovelRenderer } from './NovelRenderer'
import type { Event, EventScene, TelopPosition } from '../types'
import { computeTelopBottomReserveHeight } from './novelLayout'
import { DEFAULT_BAR_FILL_COLOR } from './SeekBar'

// --- fixture helpers（NovelRenderer.eventImage.test.ts と同じスタイル）---

function narration(...lines: string[]): Event {
  return { Narration: { text: lines } }
}

function telop(
  text: string,
  opts?: { position?: TelopPosition; seconds?: number; kind?: string | null }
): Event {
  return {
    Telop: { text, position: opts?.position, seconds: opts?.seconds, kind: opts?.kind },
  } as Event
}

function scene(id: string, events: Event[]): EventScene {
  return { id, title: id, view: 'TopDown', events }
}

function makeRenderer(scenes: EventScene[]): NovelRenderer {
  const r = new NovelRenderer()
  r.setScenes(scenes)
  return r
}

/** destroy() の appInitialized ガードを満たすための最小スタブ（eventImage.test.ts と同じ割り切り）。*/
function stubDestroyableApp(r: NovelRenderer): void {
  const appInternals = internals(r)
  appInternals.appInitialized = true
  Object.defineProperty(appInternals.app, 'canvas', {
    configurable: true,
    value: { removeEventListener: () => {} },
  })
  appInternals.app.destroy = () => {}
}

interface TelopLayerForTest {
  show(options: {
    text: string
    position: TelopPosition
    seconds: number
    kind?: string | null
    fontFamily: string
    fontSize: number
    accentColor: number
  }): void
  clear(): void
  setAccentColor(color: number): void
}
interface DialogBoxForTest {
  setNovelBottomReserve(px: number): void
}
interface RendererInternals {
  telopLayer: TelopLayerForTest
  dialogBox: DialogBoxForTest
  appInitialized: boolean
  app: { canvas: unknown; destroy: (...args: unknown[]) => void }
  syncTelopBottomMarginToButtons: () => void
}
function internals(r: NovelRenderer): RendererInternals {
  return r as unknown as RendererInternals
}

describe('NovelRenderer テロップディレクティブ処理 (#674)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  // 32: [テロップ:] を advance で処理 → telopLayer.show() が全フィールド正しい引数で呼ばれる。
  it('32: [テロップ: 実績解除, 位置=右上, 秒=6, 種別=note] を処理 → telopLayer.show() が正しい引数で呼ばれる', async () => {
    const r = makeRenderer([
      scene('a', [
        narration('x'),
        telop('実績解除', { position: 'TopRight', seconds: 6, kind: 'note' }),
        narration('y'),
      ]),
    ])
    r.setFontFamily('MyTestFont')
    r.setFontSize(28)
    const showSpy = vi.spyOn(internals(r).telopLayer, 'show')

    r.startFrom({ sceneId: 'a' })
    await r.playScript([{ type: 'advance' }])

    expect(showSpy).toHaveBeenCalledWith({
      text: '実績解除',
      position: 'TopRight',
      seconds: 6,
      kind: 'note',
      fontFamily: 'MyTestFont',
      fontSize: 28,
      accentColor: DEFAULT_BAR_FILL_COLOR, // setSeekBarColor 未指定なら既定色。色解決の一致は 36 で個別に検証する
    })
  })

  // 33: skipMode 中は telopLayer.show() が呼ばれない（ADR-0002: 演出の中間状態を作らない既存方針）。
  it('33: skipMode 中は [テロップ:] を処理しても telopLayer.show() が呼ばれない', async () => {
    const r = makeRenderer([scene('a', [narration('x'), telop('通知'), narration('y')])])
    const showSpy = vi.spyOn(internals(r).telopLayer, 'show')

    r.startFrom({ sceneId: 'a' })
    r.setSkipMode(true)
    await r.playScript([{ type: 'advance' }])

    expect(showSpy).not.toHaveBeenCalled()
  })

  // 34a: setEvents は前シーンの表示中テロップを引き継がない（新しいイベント列の開始で常にクリア）。
  it('34a: setEvents で telopLayer.clear() が呼ばれる', () => {
    const r = makeRenderer([scene('a', [narration('x'), telop('通知'), narration('y')])])
    r.startFrom({ sceneId: 'a' })
    const clearSpy = vi.spyOn(internals(r).telopLayer, 'clear')

    r.setEvents([narration('z')])

    expect(clearSpy).toHaveBeenCalled()
  })

  // 34b: [場面転換] は eventImageLayer と同じ防御でテロップもクリアする。
  it('34b: [場面転換] (SceneTransition) を処理すると telopLayer.clear() が呼ばれる', async () => {
    const r = makeRenderer([
      scene('a', [
        narration('x'),
        telop('通知'),
        narration('y'),
        'SceneTransition' as Event,
        narration('z'),
      ]),
    ])
    r.startFrom({ sceneId: 'a' })
    await r.playScript([{ type: 'advance' }]) // x -> telop(show) -> y

    const clearSpy = vi.spyOn(internals(r).telopLayer, 'clear')
    await r.playScript([{ type: 'advance' }]) // y -> SceneTransition(clear) -> z

    expect(clearSpy).toHaveBeenCalled()
  })

  // 34c: destroy() でも表示中の段・タイマーを破棄する（eventImageLayer.disposeTextures と同じ規律）。
  it('34c: destroy() を呼ぶと telopLayer.clear() が呼ばれる', () => {
    const r = makeRenderer([scene('a', [narration('x'), telop('通知'), narration('y')])])
    r.startFrom({ sceneId: 'a' })
    stubDestroyableApp(r)
    const clearSpy = vi.spyOn(internals(r).telopLayer, 'clear')

    r.destroy()

    expect(clearSpy).toHaveBeenCalled()
  })

  // 35(最重要): goBack 経由の復元は演出の中間状態を持たない（ADR-0002）。applyState が
  // telopLayer.clear() を呼ぶが、Telop イベント自体を再生し直すわけではないので show は再発火しない。
  it('35: goBack 経由の復元で telopLayer.clear() が呼ばれ、telopLayer.show() は再発火しない', async () => {
    const r = makeRenderer([scene('a', [narration('one'), telop('通知'), narration('two')])])
    r.startFrom({ sceneId: 'a' })
    const showSpy = vi.spyOn(internals(r).telopLayer, 'show')

    await r.playScript([{ type: 'advance' }]) // one -> telop(show) -> two
    expect(showSpy).toHaveBeenCalledTimes(1)

    const clearSpy = vi.spyOn(internals(r).telopLayer, 'clear')
    r.goBack() // two -> one へ戻る（applyState 経由）

    expect(clearSpy).toHaveBeenCalled()
    expect(showSpy).toHaveBeenCalledTimes(1) // goBack で再発火しない
  })

  // 36: テロップのアクセント縦線色は setSeekBarColor と同じ色解決を共有する
  // （NovelRenderer.setSeekBarColor のコメント「アクセント色は SeekBar と同じ色解決」）。
  it('36: setSeekBarColor("#1a4a7a") 後の show 引数の accentColor が SeekBar と同じ色解決 (0x1a4a7a) になる', async () => {
    const r = makeRenderer([scene('a', [narration('x'), telop('通知'), narration('y')])])
    r.setSeekBarColor('#1a4a7a')
    const showSpy = vi.spyOn(internals(r).telopLayer, 'show')

    r.startFrom({ sceneId: 'a' })
    await r.playScript([{ type: 'advance' }])

    expect(showSpy).toHaveBeenCalledWith(expect.objectContaining({ accentColor: 0x1a4a7a }))
  })

  it('36b: setSeekBarColor を呼ばない（既定）なら accentColor は SeekBar の既定色 DEFAULT_BAR_FILL_COLOR になる', async () => {
    const r = makeRenderer([scene('a', [narration('x'), telop('通知'), narration('y')])])
    const showSpy = vi.spyOn(internals(r).telopLayer, 'show')

    r.startFrom({ sceneId: 'a' })
    await r.playScript([{ type: 'advance' }])

    expect(showSpy).toHaveBeenCalledWith(
      expect.objectContaining({ accentColor: DEFAULT_BAR_FILL_COLOR })
    )
  })

  // 37: setTelopReserve(true) は dialogBox.setNovelBottomReserve(computeTelopBottomReserveHeight(fontSize, ...)) を呼ぶ。
  // canvas 未マウント（clientHeight 未測定）のため telopButtonRowHeightPx は表示倍率1:1の既定値のまま
  // （syncTelopBottomMarginToButtons が一度も走らない、#677）。
  it('37a: setTelopReserve(true) → dialogBox.setNovelBottomReserve(computeTelopBottomReserveHeight(fontSize))', () => {
    const r = new NovelRenderer()
    r.setFontSize(28)
    const spy = vi.spyOn(internals(r).dialogBox, 'setNovelBottomReserve')

    r.setTelopReserve(true)

    expect(spy).toHaveBeenCalledWith(computeTelopBottomReserveHeight(28))
  })

  it('37b: setTelopReserve(false) → dialogBox.setNovelBottomReserve(0)', () => {
    const r = new NovelRenderer()
    const spy = vi.spyOn(internals(r).dialogBox, 'setNovelBottomReserve')

    r.setTelopReserve(false)

    expect(spy).toHaveBeenCalledWith(0)
  })

  it('37c: setTelopReserve(null) → dialogBox.setNovelBottomReserve(0)', () => {
    const r = new NovelRenderer()
    const spy = vi.spyOn(internals(r).dialogBox, 'setNovelBottomReserve')

    r.setTelopReserve(null)

    expect(spy).toHaveBeenCalledWith(0)
  })

  it('37d: setTelopReserve(undefined) → dialogBox.setNovelBottomReserve(0)', () => {
    const r = new NovelRenderer()
    const spy = vi.spyOn(internals(r).dialogBox, 'setNovelBottomReserve')

    r.setTelopReserve(undefined)

    expect(spy).toHaveBeenCalledWith(0)
  })

  // 38: 表示中に setSeekBarColor を呼ぶと、次回以降の show() だけでなく、既に表示中の段の
  // アクセント縦線も telopLayer.setAccentColor(新色) で即座に更新される (#674 セルフレビュー Q1)。
  it('38: 表示中に setSeekBarColor を呼ぶと telopLayer.setAccentColor が新色で呼ばれる', async () => {
    const r = makeRenderer([scene('a', [narration('x'), telop('通知'), narration('y')])])
    r.startFrom({ sceneId: 'a' })
    await r.playScript([{ type: 'advance' }]) // x -> telop(show) -> y（表示中の段が1つある状態）

    const setAccentColorSpy = vi.spyOn(internals(r).telopLayer, 'setAccentColor')

    r.setSeekBarColor('#1a4a7a')

    expect(setAccentColorSpy).toHaveBeenCalledWith(0x1a4a7a)
  })

  // 39: telop_reserve 無効（既定）な作品では、ResizeObserver 由来の表示倍率同期
  // （syncTelopBottomMarginToButtons、#677）が走っても dialogBox.setNovelBottomReserve は
  // 呼ばれない（telopReserveEnabled が false のときは applyTelopReserve 自体を呼ばないガード、#678）。
  it('39: telop_reserve 無効時は ResizeObserver 同期で dialogBox.setNovelBottomReserve が呼ばれない', () => {
    const r = new NovelRenderer()
    const spy = vi.spyOn(internals(r).dialogBox, 'setNovelBottomReserve')
    // canvas.clientHeight を測定済みにして syncTelopBottomMarginToButtons の early return を回避する
    // （stubDestroyableApp と同じく Application.canvas は getter のみなので defineProperty で上書きする）。
    Object.defineProperty(internals(r).app, 'canvas', {
      configurable: true,
      value: { clientHeight: 800 },
    })

    internals(r).syncTelopBottomMarginToButtons()

    expect(spy).not.toHaveBeenCalled()
  })
})
