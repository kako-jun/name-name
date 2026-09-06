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
 *  - `[テロップ:]` は `ensureFontLoaded()` 完了を待ってから show() する（非同期・本文進行はブロック
 *    しない）。待機中に scene切替/destroy/skip が起きたら show しない (#679 レビューS3)
 *
 * 観測は既存の NovelRenderer 系テスト（NovelRenderer.eventImage.test.ts と同形）: `playScript`
 * で駆動し、telopLayer/dialogBox の private フィールドへ internals キャストでアクセスして spy する。
 *
 * フォントロード待ちの扱い: 既定では `ensureFontLoaded` を即時 resolve するようモックする
 * （`CharacterLayer.test.ts` の「モジュール境界での spyOn」方針と同じ。`__setDocumentForTest(null)`
 * 経由の no-op resolve と違い、resolve タイミングを手で制御できるため S3 の競合テストに使える）。
 * 既定の即時 resolve でも実際には microtask を挟むため、show() の呼び出しを確認するテストは
 * `flushPromises()` で解決を待ってから assert する。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NovelRenderer } from './NovelRenderer'
import type { Event, EventScene, TelopPosition } from '../types'
import { computeTelopBottomReserveHeight } from './novelLayout'
import { DEFAULT_BAR_FILL_COLOR } from './SeekBar'
import * as FontLoader from './FontLoader'

/** ensureFontLoaded の `.catch().then()` チェーンが解決しきるまで待つ（マクロタスク1つぶん）。 */
const flushPromises = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

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
  initialized: boolean
  app: { canvas: unknown; destroy: (...args: unknown[]) => void }
  syncTelopBottomMarginToButtons: () => void
}
function internals(r: NovelRenderer): RendererInternals {
  return r as unknown as RendererInternals
}

/**
 * `init()` 完了後の状態を模す（`NovelRenderer.playScript.test.ts` の `markInitialized` と同じ
 * パターン）。`render()`（延いては telopLayer.show() の完了ガード、#679 レビューS3）は
 * `this.initialized` を見るため、init() を呼ばないテストでは既定 false のまま
 * ——telopLayer.show() が実際に呼ばれることを検証するテストではこれを呼んでおく必要がある。
 */
function markInitialized(r: NovelRenderer): void {
  internals(r).initialized = true
}

describe('NovelRenderer テロップディレクティブ処理 (#674)', () => {
  beforeEach(() => {
    // 既定は即時 resolve（フォントロード待ちの有無に関わらず既存テストの挙動を保つ）。
    // S3 の競合テストはこれを個別に `mockReturnValueOnce` で上書きしてタイミングを制御する。
    vi.spyOn(FontLoader, 'ensureFontLoaded').mockResolvedValue(undefined)
  })
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
    markInitialized(r) // render()/telopLayer.show() の完了ガード (#679 レビューS3) を通す
    await r.playScript([{ type: 'advance' }])
    await flushPromises() // ensureFontLoaded() 完了を待つ (#679 レビューS3)

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
    markInitialized(r) // render()/telopLayer.show() の完了ガード (#679 レビューS3) を通す
    await r.playScript([{ type: 'advance' }]) // x -> telop(show) -> y
    await flushPromises() // ensureFontLoaded() 完了を待つ (#679 レビューS3)

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
    markInitialized(r) // render()/telopLayer.show() の完了ガード (#679 レビューS3) を通す
    const showSpy = vi.spyOn(internals(r).telopLayer, 'show')

    await r.playScript([{ type: 'advance' }]) // one -> telop(show) -> two
    await flushPromises() // ensureFontLoaded() 完了を待つ (#679 レビューS3)
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
    markInitialized(r) // render()/telopLayer.show() の完了ガード (#679 レビューS3) を通す
    await r.playScript([{ type: 'advance' }])
    await flushPromises() // ensureFontLoaded() 完了を待つ (#679 レビューS3)

    expect(showSpy).toHaveBeenCalledWith(expect.objectContaining({ accentColor: 0x1a4a7a }))
  })

  it('36b: setSeekBarColor を呼ばない（既定）なら accentColor は SeekBar の既定色 DEFAULT_BAR_FILL_COLOR になる', async () => {
    const r = makeRenderer([scene('a', [narration('x'), telop('通知'), narration('y')])])
    const showSpy = vi.spyOn(internals(r).telopLayer, 'show')

    r.startFrom({ sceneId: 'a' })
    markInitialized(r) // render()/telopLayer.show() の完了ガード (#679 レビューS3) を通す
    await r.playScript([{ type: 'advance' }])
    await flushPromises() // ensureFontLoaded() 完了を待つ (#679 レビューS3)

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
    markInitialized(r) // render()/telopLayer.show() の完了ガード (#679 レビューS3) を通す
    await r.playScript([{ type: 'advance' }]) // x -> telop(show) -> y（表示中の段が1つある状態）
    await flushPromises() // ensureFontLoaded() 完了を待つ (#679 レビューS3)

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

  // #679 レビューS3: フォント未ロードのまま show() すると折り返し行数が確定してしまう問題の修正。
  // 他レイヤー（Dialog/Narration）と同じ ensureFontLoaded() 完了を待ってから telopLayer.show() する。
  // 待ち自体は fire-and-forget（本文の進行はブロックしない）。以下は resolve タイミングを手で
  // 制御して、待機中/完了後の挙動と、待機中に scene切替・destroy・skip が起きた場合のガードを検証する。
  //
  // 各テストは `r.startFrom(...)` で最初のテキスト（'x'）の描画（＝1回目の ensureFontLoaded 呼び出し、
  // beforeEach の既定 mockResolvedValue で即解決）を先に消化してから `mockReturnValueOnce(pending)` を
  // 差し込む。これにより「次の1回」＝ telop 自身の呼び出しだけを手で制御できる（telop の directive は
  // playScript の advance 内で他の directive より先に処理されるため、この1回が確実に telop の呼び出しになる）。

  // 40(最重要): フォントロード待ち中は show されず、完了後に初めて show される。
  it('40: [テロップ:] はフォントロード完了まで telopLayer.show() を呼ばず、完了後に呼ばれる（同期には呼ばれない）', async () => {
    const r = makeRenderer([scene('a', [narration('x'), telop('通知'), narration('y')])])
    const showSpy = vi.spyOn(internals(r).telopLayer, 'show')
    r.startFrom({ sceneId: 'a' })
    markInitialized(r) // render()/telopLayer.show() の完了ガード (#679 レビューS3) を通す

    let resolveFont!: () => void
    const pending = new Promise<void>((resolve) => {
      resolveFont = resolve
    })
    vi.spyOn(FontLoader, 'ensureFontLoaded').mockReturnValueOnce(pending)

    await r.playScript([{ type: 'advance' }]) // x -> telop(directive処理・ensureFontLoaded待ち) -> y
    expect(showSpy).not.toHaveBeenCalled() // フォント未解決の間は show しない

    resolveFont()
    await flushPromises()

    expect(showSpy).toHaveBeenCalledTimes(1)
  })

  // 41: フォントロード待ち中に destroy() されたら show されない。
  it('41: フォントロード待ち中に destroy() されると telopLayer.show() は呼ばれない', async () => {
    const r = makeRenderer([scene('a', [narration('x'), telop('通知'), narration('y')])])
    const showSpy = vi.spyOn(internals(r).telopLayer, 'show')
    r.startFrom({ sceneId: 'a' })
    markInitialized(r) // destroy() が initialized を false に戻すことが show ブロックの原因だと示す
    stubDestroyableApp(r)

    let resolveFont!: () => void
    const pending = new Promise<void>((resolve) => {
      resolveFont = resolve
    })
    vi.spyOn(FontLoader, 'ensureFontLoaded').mockReturnValueOnce(pending)

    await r.playScript([{ type: 'advance' }]) // x -> telop(directive処理・ensureFontLoaded待ち) -> y

    r.destroy() // 待機中に破棄
    resolveFont()
    await flushPromises()

    expect(showSpy).not.toHaveBeenCalled()
  })

  // 42: フォントロード待ち中に scene 切替相当（setEvents、telopLayer.clear() 経由）が起きたら show されない。
  it('42: フォントロード待ち中に setEvents（新しいイベント列の開始）が呼ばれると telopLayer.show() は呼ばれない', async () => {
    const r = makeRenderer([scene('a', [narration('x'), telop('通知'), narration('y')])])
    const showSpy = vi.spyOn(internals(r).telopLayer, 'show')
    r.startFrom({ sceneId: 'a' })
    markInitialized(r) // setEvents(clearTelopLayer 経由)がブロック原因だと示す（initialized=false 起因ではない）

    let resolveFont!: () => void
    const pending = new Promise<void>((resolve) => {
      resolveFont = resolve
    })
    vi.spyOn(FontLoader, 'ensureFontLoaded').mockReturnValueOnce(pending)

    await r.playScript([{ type: 'advance' }]) // x -> telop(directive処理・ensureFontLoaded待ち) -> y

    r.setEvents([narration('z')]) // 待機中に scene 切替相当（clearTelopLayer() 経由でエポックが進む）
    resolveFont()
    await flushPromises()

    expect(showSpy).not.toHaveBeenCalled()
  })

  // 43: フォントロード待ち中にスキップモードへ入ったら show されない（ADR-0002 既存方針と同じ扱い）。
  it('43: フォントロード待ち中に setSkipMode(true) が呼ばれると telopLayer.show() は呼ばれない', async () => {
    const r = makeRenderer([scene('a', [narration('x'), telop('通知'), narration('y')])])
    const showSpy = vi.spyOn(internals(r).telopLayer, 'show')
    r.startFrom({ sceneId: 'a' })
    markInitialized(r) // setSkipMode(true) がブロック原因だと示す（initialized=false 起因ではない）

    let resolveFont!: () => void
    const pending = new Promise<void>((resolve) => {
      resolveFont = resolve
    })
    vi.spyOn(FontLoader, 'ensureFontLoaded').mockReturnValueOnce(pending)

    await r.playScript([{ type: 'advance' }]) // x -> telop(directive処理・ensureFontLoaded待ち) -> y

    r.setSkipMode(true) // 待機中にスキップ開始
    resolveFont()
    await flushPromises()

    expect(showSpy).not.toHaveBeenCalled()
  })
})
