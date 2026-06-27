/**
 * NovelRenderer 立ち絵とテキストの表示順序同期 (#293) 単体テスト。
 *
 * 観察された不具合: novel /play で「文字が少し出てから立ち絵が遅れて出る」順序逆転。
 * 根因: テキスト reveal（render → DialogBox typewriter）は同期開始するのに対し、立ち絵は
 * CharacterLayer が Assets.load で非同期にテクスチャ取得するため、呼び出し順が立ち絵先でも
 * 見た目が逆転していた。
 *
 * 修正: forward novel パスでは、立ち絵テクスチャの用意完了（CharacterLayer.show の onReady）まで
 * render（テキスト reveal）を遅延し、「立ち絵 →（同時/直後に）テキスト」の順序を保証する。
 * adv / skip / 立ち絵なし Dialog は従来どおり同期描画＝非回帰。
 *
 * テスト設計（jsdom・canvas 非依存）:
 *   - init() を呼ばず、private `render` を spy で**差し替える**（実 body は PixiJS 依存なので走らせない）。
 *     `initialized` を true に立てて renderOnce のガードを通し、render が「呼ばれた回数とタイミング」を観測する。
 *   - `Assets.load` を遅延 Promise でモックし、立ち絵テクスチャの用意完了タイミングを手で制御する。
 *   - 立ち絵 show は `characterLayer.show` を spy して「テキスト（render）より先に呼ばれる」ことを確認する。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { Assets } from 'pixi.js'
import { NovelRenderer } from './NovelRenderer'
import type { Event, EventScene } from '../types'

// 解決済み Promise の .then/.finally チェーンを 1 巡消化する。
const flushPromises = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))
// #293: 立ち絵 ready 後、rAF 2 回で「立ち絵だけの frame」を通してから本文 reveal する。
const flushDeferredTextRender = async (): Promise<void> => {
  await flushPromises()
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  })
  await flushPromises()
}

function dialog(character: string, ...lines: string[]): Event {
  return {
    Dialog: {
      character,
      expression: 'normal',
      position: '中央',
      text: lines,
      voice_path: null,
      font_family: null,
    },
  }
}

/** 立ち絵情報を持たない Dialog（expression/position を欠く＝立ち絵 show されない）。 */
function dialogNoPortrait(character: string, ...lines: string[]): Event {
  return {
    Dialog: {
      character,
      expression: null,
      position: null,
      text: lines,
      voice_path: null,
      font_family: null,
    },
  }
}

/** position だけを差し替えた Dialog（同一 character・同表情で位置のみ変更するケース用）。 */
function dialogAt(character: string, position: string, ...lines: string[]): Event {
  return {
    Dialog: {
      character,
      expression: 'normal',
      position,
      text: lines,
      voice_path: null,
      font_family: null,
    },
  }
}

function scene(id: string, events: Event[]): EventScene {
  return { id, title: id, view: 'TopDown', events }
}

interface RendererTestHooks {
  render(): void
  advance(): void
  initialized: boolean
  characterLayer: { show: (...args: unknown[]) => void }
  eventIndex: number
  resolvedEvents: Event[]
}
function hooks(r: NovelRenderer): RendererTestHooks {
  return r as unknown as RendererTestHooks
}

/** fake texture（loadTexture 内の texture.width/height を読む経路を満たす最小形）。 */
function fakeTexture(): unknown {
  return { width: 100, height: 200, destroyed: false }
}

describe('NovelRenderer 立ち絵→テキスト 表示順序の同期 (#293)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  // 1: novel forward — 立ち絵テクスチャ load が保留中はテキスト reveal（render）を出さず、
  //    load 完了後に初めて render する。立ち絵 show はテキストより先に呼ばれている。
  it('1: novel は立ち絵テクスチャの用意完了まで render を遅延する（load 完了で初めて reveal）', async () => {
    // Assets.load を手動解決の遅延 Promise にする。
    let resolveLoad: (t: unknown) => void = () => {}
    const loadPromise = new Promise<unknown>((res) => {
      resolveLoad = res
    })
    const loadSpy = vi.spyOn(Assets, 'load').mockReturnValue(loadPromise as never)
    // setEvents 経路の Assets.unload も呼ばれるのでモックして握り潰す。
    vi.spyOn(Assets, 'unload').mockResolvedValue(undefined as never)

    const r = new NovelRenderer()
    r.setDialogStyle('novel')
    r.setAssetBaseUrl('/assets')
    const h = hooks(r)
    // render の実 body は PixiJS 依存なので差し替え、呼び出しタイミングだけ観測する。
    const renderSpy = vi.spyOn(h, 'render').mockImplementation(() => {})
    // renderOnce のガード `if (!this.initialized) return` を通すため initialized を立てる。
    h.initialized = true
    const showSpy = vi.spyOn(h.characterLayer, 'show')

    // 最初のテキストイベント（novel・立ち絵あり）から開始する。
    r.setScenes([scene('s', [dialog('ひな', 'こんにちは。')])])

    // 立ち絵 show は同期で呼ばれている（sprite 生成は同期）。
    expect(showSpy).toHaveBeenCalledTimes(1)
    expect(loadSpy).toHaveBeenCalledTimes(1)
    // だがテキスト reveal（render）はテクスチャ load 保留中なので**まだ出ていない**＝順序逆転を防止。
    expect(renderSpy).not.toHaveBeenCalled()

    // テクスチャ load 完了 → onReady（.finally）→ renderOnce が render を呼ぶ。
    resolveLoad(fakeTexture())
    await flushPromises()
    // load 完了直後にはまだ本文 reveal しない。立ち絵だけの frame を先に通す。
    expect(renderSpy).not.toHaveBeenCalled()
    await flushDeferredTextRender()

    expect(renderSpy).toHaveBeenCalledTimes(1)
  })

  // 2: 立ち絵なし Dialog（expression/position 欠落）は texture load を待たず、
  //    立ち絵 ready 後の本文 reveal 遅延だけ通す（テキストが永久に出ない事故を防ぐ）。
  it('2: 立ち絵なし Dialog は load を待たず render される（テキストが詰まらない）', async () => {
    vi.spyOn(Assets, 'unload').mockResolvedValue(undefined as never)
    const loadSpy = vi.spyOn(Assets, 'load')

    const r = new NovelRenderer()
    r.setDialogStyle('novel')
    r.setAssetBaseUrl('/assets')
    const h = hooks(r)
    const renderSpy = vi.spyOn(h, 'render').mockImplementation(() => {})
    h.initialized = true

    r.setScenes([scene('s', [dialogNoPortrait('ナレ', '地の文。')])])

    // 立ち絵が無いので Assets.load は呼ばれず、本文 reveal 遅延後に render が1回呼ばれる。
    expect(loadSpy).not.toHaveBeenCalled()
    await flushDeferredTextRender()
    expect(renderSpy).toHaveBeenCalledTimes(1)
  })

  // 3: adv（dialog_style 非 novel）は #293 の対象外。立ち絵 load の保留に関わらず render を
  //    同期実行する＝従来どおり（非回帰）。
  it('3: adv は立ち絵 load 保留中でも render を同期実行する（非回帰）', () => {
    // 解決しない（永久保留）load にしても adv は待たない。
    vi.spyOn(Assets, 'load').mockReturnValue(new Promise<unknown>(() => {}) as never)
    vi.spyOn(Assets, 'unload').mockResolvedValue(undefined as never)

    const r = new NovelRenderer() // setDialogStyle を呼ばない＝adv
    r.setAssetBaseUrl('/assets')
    const h = hooks(r)
    const renderSpy = vi.spyOn(h, 'render').mockImplementation(() => {})
    h.initialized = true

    r.setScenes([scene('s', [dialog('ひな', 'こんにちは。')])])

    // adv は onReady を待たず同期 render（load は保留のまま）。
    expect(renderSpy).toHaveBeenCalledTimes(1)
  })

  // 4: novel forward — 立ち絵が出ている状態で次の同一立ち絵（表情・位置同じ＝no-op）へ前進すると、
  //    texture を再ロードせず、本文 reveal 遅延だけ通して render される。
  it('4: novel で同一立ち絵（no-op）への前進は再ロードしない', async () => {
    let resolveLoad: (t: unknown) => void = () => {}
    const loadPromise = new Promise<unknown>((res) => {
      resolveLoad = res
    })
    const loadSpy = vi.spyOn(Assets, 'load').mockReturnValue(loadPromise as never)
    vi.spyOn(Assets, 'unload').mockResolvedValue(undefined as never)

    const r = new NovelRenderer()
    r.setDialogStyle('novel')
    r.setAssetBaseUrl('/assets')
    const h = hooks(r)
    const renderSpy = vi.spyOn(h, 'render').mockImplementation(() => {})
    h.initialized = true

    // event0/event1 とも ひな・同表情・同位置（2 つ目は no-op になる）。
    r.setScenes([scene('s', [dialog('ひな', 'a。'), dialog('ひな', 'b。')])])

    // event0: 立ち絵 load 保留 → render 未発火。
    expect(renderSpy).not.toHaveBeenCalled()
    // event0 のテクスチャ load を完了させて1回目の reveal を解禁する。
    resolveLoad(fakeTexture())
    await flushDeferredTextRender()
    expect(renderSpy).toHaveBeenCalledTimes(1)
    expect(loadSpy).toHaveBeenCalledTimes(1)

    // event1 へ前進。同一立ち絵なので show は no-op → onReady 発火 → 本文 reveal 遅延後に render。
    h.advance()
    // 再ロードは起きない（load 呼び出し回数は 1 のまま）。
    expect(loadSpy).toHaveBeenCalledTimes(1)
    await flushDeferredTextRender()
    expect(renderSpy).toHaveBeenCalledTimes(2)
  })

  // 5: novel forward — テクスチャ load 保留中に更に advance で別イベントへ進んだら、
  //    古い（stale）onReady では render しない（eventIndex 照合のトークンガード）。
  it('5: load 保留中に別イベントへ進んだら stale な onReady では render しない', async () => {
    // 2 つの load を別々に制御する。
    const resolvers: Array<(t: unknown) => void> = []
    vi.spyOn(Assets, 'load').mockImplementation(
      () => new Promise<unknown>((res) => resolvers.push(res)) as never
    )
    vi.spyOn(Assets, 'unload').mockResolvedValue(undefined as never)

    const r = new NovelRenderer()
    r.setDialogStyle('novel')
    r.setAssetBaseUrl('/assets')
    const h = hooks(r)
    const renderSpy = vi.spyOn(h, 'render').mockImplementation(() => {})
    h.initialized = true

    // event0 ひな / event1 せお（別話者・別立ち絵）。
    r.setScenes([scene('s', [dialog('ひな', 'a。'), dialog('せお', 'b。')])])
    // event0 の load 保留中。render 未発火。
    expect(renderSpy).not.toHaveBeenCalled()

    // load 完了を待たずに次イベントへ前進する（連続クリック相当）。
    // これで eventIndex が 1 になり、event0 の onReady は stale になる。
    h.advance()
    expect(h.eventIndex).toBe(1)

    // event0（古い）の load を今さら完了させても、eventIndex 不一致で render しない。
    resolvers[0]?.(fakeTexture())
    await flushDeferredTextRender()
    expect(renderSpy).not.toHaveBeenCalled()

    // event1（現在）の load を完了させると render が 1 回だけ呼ばれる。
    resolvers[1]?.(fakeTexture())
    await flushDeferredTextRender()
    expect(renderSpy).toHaveBeenCalledTimes(1)
  })

  // 6: 立ち絵テクスチャ load が失敗（reject）してもテキストは出る（onReady は .finally で発火）。
  it('6: 立ち絵 load 失敗でも render は出る（テキストが詰まらない）', async () => {
    let rejectLoad: (e: unknown) => void = () => {}
    const loadPromise = new Promise<unknown>((_res, rej) => {
      rejectLoad = rej
    })
    vi.spyOn(Assets, 'load').mockReturnValue(loadPromise as never)
    vi.spyOn(Assets, 'unload').mockResolvedValue(undefined as never)
    // 失敗時の console.warn を握り潰す。
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const r = new NovelRenderer()
    r.setDialogStyle('novel')
    r.setAssetBaseUrl('/assets')
    const h = hooks(r)
    const renderSpy = vi.spyOn(h, 'render').mockImplementation(() => {})
    h.initialized = true

    r.setScenes([scene('s', [dialog('ひな', 'a。')])])
    expect(renderSpy).not.toHaveBeenCalled()

    rejectLoad(new Error('not found'))
    await flushDeferredTextRender()

    // .finally(onReady) が走り、ロード失敗でもテキスト reveal は出る。
    expect(renderSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy).toHaveBeenCalled()
  })

  // 7: novel forward — assetBaseUrl 空（描画不能）では texture を取りに行けないので、
  //    CharacterLayer の loadTexture が `if (!assetBaseUrl)` で即 onReady → 本文 reveal 遅延だけ通す
  //    （テクスチャ load を待たない＝テキストが詰まらない）。
  it('7: assetBaseUrl 空では立ち絵あり Dialog でも load を待たない', async () => {
    // 解決しない load にしても、assetBaseUrl 空なら Assets.load 自体が呼ばれない想定。
    const loadSpy = vi
      .spyOn(Assets, 'load')
      .mockReturnValue(new Promise<unknown>(() => {}) as never)
    vi.spyOn(Assets, 'unload').mockResolvedValue(undefined as never)

    const r = new NovelRenderer()
    r.setDialogStyle('novel')
    // assetBaseUrl を明示的に空にする（描画不能状態）。
    r.setAssetBaseUrl('')
    const h = hooks(r)
    const renderSpy = vi.spyOn(h, 'render').mockImplementation(() => {})
    h.initialized = true

    r.setScenes([scene('s', [dialog('ひな', 'こんにちは。')])])

    // assetBaseUrl 空なので texture load には進まず（Assets.load 未呼出）、本文 reveal 遅延後に render。
    expect(loadSpy).not.toHaveBeenCalled()
    await flushDeferredTextRender()
    expect(renderSpy).toHaveBeenCalledTimes(1)
  })

  // 8: novel forward — 表示中の同一立ち絵（同 character・同表情）を別位置で再 show すると、
  //    texture は据え置き（再ロードなし）で位置だけ更新され、本文 reveal 遅延だけ通して render される。
  it('8: novel で位置のみ変更（texture 据え置き）は再ロードしない', async () => {
    let resolveLoad: (t: unknown) => void = () => {}
    const loadPromise = new Promise<unknown>((res) => {
      resolveLoad = res
    })
    const loadSpy = vi.spyOn(Assets, 'load').mockReturnValue(loadPromise as never)
    vi.spyOn(Assets, 'unload').mockResolvedValue(undefined as never)

    const r = new NovelRenderer()
    r.setDialogStyle('novel')
    r.setAssetBaseUrl('/assets')
    const h = hooks(r)
    const renderSpy = vi.spyOn(h, 'render').mockImplementation(() => {})
    h.initialized = true

    // event0: 中央 / event1: 右（同 character・同表情 normal、位置だけ違う）。
    r.setScenes([scene('s', [dialog('ひな', 'a。'), dialogAt('ひな', '右', 'b。')])])

    // event0: 新規立ち絵の load 保留 → render 未発火。
    expect(renderSpy).not.toHaveBeenCalled()
    // event0 の texture load を完了させて1回目の reveal を解禁する。
    resolveLoad(fakeTexture())
    await flushDeferredTextRender()
    expect(renderSpy).toHaveBeenCalledTimes(1)
    expect(loadSpy).toHaveBeenCalledTimes(1)

    // event1 へ前進。位置のみ変更（texture 据え置き）なので再ロードせず、本文 reveal 遅延後に render。
    h.advance()
    // 再ロードは起きない（load 呼び出し回数は 1 のまま）。
    expect(loadSpy).toHaveBeenCalledTimes(1)
    await flushDeferredTextRender()
    expect(renderSpy).toHaveBeenCalledTimes(2)
  })
})
