/**
 * DialogBox の portrait 顔枠切替・typewriter・contain fit テスト。
 *
 * #194: RpgDialogBox を DialogBox に統合した後の動作確認。
 * 旧 RpgDialogBox.test.ts を DialogBox API に合わせて移行。
 *
 * #214: フォントロード非同期化（ensureFontLoaded + rubyBuildToken）のテスト。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Assets, Texture } from 'pixi.js'

// ensureFontLoaded をモック — 手動 resolve できる Promise を返す
vi.mock('./FontLoader', () => ({
  ensureFontLoaded: vi.fn(),
  extractPrimaryFamily: (f: string) =>
    f
      .split(',')[0]
      ?.trim()
      .replace(/^['"]+|['"]+$/g, '') ?? f,
  resetFontLoaderCache: vi.fn(),
  __setDocumentForTest: vi.fn(),
}))
import {
  DialogBox,
  PORTRAIT_SIZE,
  PORTRAIT_MARGIN,
  PORTRAIT_X,
  computePortraitContainFit,
  NOVEL_TEXT_MARGIN_X,
  NOVEL_TEXT_TOP_RATIO,
  NOVEL_TEXT_MARGIN_BOTTOM,
  NAME_BOX_HEIGHT,
  NAME_BOX_GAP,
  type IndicatorKind,
} from './DialogBox'
import type { LayoutRect } from './novelLayout'
import { computeSplitLayoutRegions } from './novelLayout'
import { ensureFontLoaded } from './FontLoader'

// デフォルトは即 resolve — 既存テストが影響を受けないようにする
const mockEnsureFontLoaded = vi.mocked(ensureFontLoaded)
mockEnsureFontLoaded.mockResolvedValue(undefined)

// RPG スタイル設定（TopDownRenderer / RaycastRenderer と同じ値）
const SCREEN_WIDTH = 800
const SCREEN_HEIGHT = 600
const BOX_HEIGHT = 120
const MARGIN_X = 20
const PADDING = 20

function makeRpgBox(): DialogBox {
  return new DialogBox({
    screenWidth: SCREEN_WIDTH,
    screenHeight: SCREEN_HEIGHT,
    boxHeight: BOX_HEIGHT,
    marginX: MARGIN_X,
    padding: PADDING,
    fontSize: 18,
    bgColor: 0x000033,
    nameColor: 0xffe066,
    nameSeparateBox: false,
  })
}

// portrait なし時のテキスト開始 x: boxX + padding
const TEXT_X_NO_PORTRAIT = MARGIN_X + PADDING
// portrait あり時のテキスト開始 x
const TEXT_X_WITH_PORTRAIT = PORTRAIT_X + PORTRAIT_SIZE + PORTRAIT_MARGIN

// private フィールドにアクセスするための型
interface DialogBoxInternals {
  portraitFrame: { visible: boolean } | null
  dialogText: { x: number; text: string; visible: boolean; style: { fill: unknown } }
  typewriter: { fullText: string; displayedCharCount: number; acc: number }
  indicator: { visible: boolean; x: number; y: number }
  indicatorGlyph: { visible: boolean }
  indicatorSprite: { visible: boolean; width: number; height: number }
  indicatorBaseY: number
  tickIndicatorMotion(deltaMs: number): void
  /** #413: フレームアニメ tick（frames が揃っている種別のみ index を進める）。 */
  tickIndicatorFrame(deltaMs: number): void
  /** #413: 種別ごとの確定成功フレーム。値ありなら「ロード済み」。 */
  indicatorFrameTextures: Partial<Record<IndicatorKind, unknown[]>>
  /** #413: fetch が確定失敗した種別の集合。 */
  failedIndicatorKinds: Set<IndicatorKind>
  /** #413: fetch が in-flight（結果未確定）な種別の集合。 */
  pendingIndicatorKinds: Set<IndicatorKind>
  /** 現在の表示種別。 */
  indicatorKind: IndicatorKind
  novelWrappedLines: string[]
  portraitSprite: { visible: boolean; texture: unknown } | null
  currentPortraitToken: number
  rubyEntries: Array<{ placement: unknown; text: { x: number; style: { fill: unknown } } }>
  rubyBuildToken: number
  /** タイプ完了コールバック slot (#302 / #304 follow-up)。null = 未設定。 */
  onTypingDone: (() => void) | null
}

function asInternals(box: DialogBox): DialogBoxInternals {
  return box as unknown as DialogBoxInternals
}

async function flushPromises(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('DialogBox portrait (Issue #73 / #194)', () => {
  it('portrait 未指定で show すると顔枠は非表示', () => {
    const box = makeRpgBox()
    box.show('長老', 'こんにちは')
    const i = asInternals(box)
    expect(i.portraitFrame).not.toBeNull()
    expect(i.portraitFrame!.visible).toBe(false)
    // テキストは portrait なし位置
    expect(i.dialogText.x).toBe(TEXT_X_NO_PORTRAIT)
    box.dispose()
  })

  it('portrait 指定で show すると顔枠が表示され、テキストが右にシフト', () => {
    const box = makeRpgBox()
    box.show('長老', 'こんにちは', 'elder_portrait.png')
    const i = asInternals(box)
    expect(i.portraitFrame!.visible).toBe(true)
    expect(i.dialogText.x).toBe(TEXT_X_WITH_PORTRAIT)
    box.dispose()
  })

  it('portrait 空文字は未指定と同等扱い', () => {
    const box = makeRpgBox()
    box.show('村人', 'やあ', '')
    const i = asInternals(box)
    expect(i.portraitFrame!.visible).toBe(false)
    expect(i.dialogText.x).toBe(TEXT_X_NO_PORTRAIT)
    box.dispose()
  })

  it('portrait あり → なしに切り替えるとテキスト位置が戻る', () => {
    const box = makeRpgBox()
    box.show('長老', 'hi', 'elder.png')
    const i = asInternals(box)
    expect(i.dialogText.x).toBe(TEXT_X_WITH_PORTRAIT)

    box.show('村人', 'bye')
    expect(i.portraitFrame!.visible).toBe(false)
    expect(i.dialogText.x).toBe(TEXT_X_NO_PORTRAIT)
    box.dispose()
  })

  it('hide で顔枠も非表示になる', () => {
    const box = makeRpgBox()
    box.show('長老', 'こんにちは', 'elder_portrait.png')
    const i = asInternals(box)
    expect(i.portraitFrame!.visible).toBe(true)

    box.hide()
    expect(i.portraitFrame!.visible).toBe(false)
    expect(box.isShowing).toBe(false)
    box.dispose()
  })

  it('redraw の前後で portrait token が進み、古い in-flight load は無視される', () => {
    const box = makeRpgBox()
    box.show('長老', 'hi', 'elder.png')
    const i = asInternals(box)
    const tokenAfterFirstShow = i.currentPortraitToken
    expect(tokenAfterFirstShow).toBeGreaterThan(0)

    box.redraw(SCREEN_WIDTH, SCREEN_HEIGHT)
    const tokenAfterRedraw = i.currentPortraitToken
    expect(tokenAfterRedraw).toBeGreaterThan(tokenAfterFirstShow)

    box.show('村人', 'yo', 'villager.png')
    expect(i.currentPortraitToken).toBeGreaterThan(tokenAfterRedraw)

    box.dispose()
  })
})

describe('DialogBox 本文は verbatim で描く（glyph 統一しない・#356 / 旧 #315 撤去）', () => {
  it('novel/borderless でも本文の長音符・ダッシュ・罫線を書き換えない', () => {
    // 旧 #315 は borderless で [‐‑‒–—―−ー]→─ の glyph 統一を掛け、長音符 ー(U+30FC) まで
    // 罫線 ─ に潰していた。エンジンは原稿を書き換えない（表記統一は原稿側の責務）。
    const novel = makeRpgBox()
    novel.setNovelMode(true)
    novel.setDialog(null, 'コーヒーと──余韻') // 長音符 ー ×2 + 余韻の中央罫線 ── を含む
    novel.skipTypewriter()
    expect(asInternals(novel).dialogText.text).toBe('コーヒーと──余韻') // verbatim（ー も ── もそのまま）
    novel.dispose()
  })

  it('adv でも同様に本文を書き換えない', () => {
    const adv = makeRpgBox()
    adv.setDialog(null, 'コーヒーと——余韻')
    adv.skipTypewriter()
    expect(asInternals(adv).dialogText.text).toBe('コーヒーと——余韻')
    adv.dispose()
  })
})

describe('DialogBox typewriter (Issue #150 / #194)', () => {
  it('show 直後は dialogText.text が空 (typewriter 開始時点)', () => {
    const box = makeRpgBox()
    box.show('長老', 'こんにちは')
    const i = asInternals(box)
    expect(i.dialogText.text).toBe('')
    expect(i.dialogText.visible).toBe(true)
    expect(box.isTyping()).toBe(true)
    box.dispose()
  })

  it('skipTypewriter で全文が即座に表示される', () => {
    const box = makeRpgBox()
    box.show('長老', 'こんにちは、若者よ。')
    box.skipTypewriter()
    const i = asInternals(box)
    expect(i.dialogText.text).toBe('こんにちは、若者よ。')
    expect(box.isTyping()).toBe(false)
    box.dispose()
  })

  it('hide で typewriter 状態がリセットされる', () => {
    const box = makeRpgBox()
    box.show('長老', 'long message')
    expect(box.isTyping()).toBe(true)
    box.hide()
    expect(box.isTyping()).toBe(false)
    box.dispose()
  })

  it('setMsPerChar(0) で表示中なら即座に skip される', () => {
    const box = makeRpgBox()
    box.show('長老', 'message')
    expect(box.isTyping()).toBe(true)
    box.setMsPerChar(0)
    const i = asInternals(box)
    expect(i.dialogText.text).toBe('message')
    expect(box.isTyping()).toBe(false)
    box.dispose()
  })

  it('skip 連打しても安定 (二回目は no-op)', () => {
    const box = makeRpgBox()
    box.show('長老', 'msg')
    box.skipTypewriter()
    box.skipTypewriter()
    box.skipTypewriter()
    const i = asInternals(box)
    expect(i.dialogText.text).toBe('msg')
    expect(box.isTyping()).toBe(false)
    box.dispose()
  })

  it('別 NPC を再度 show すると typewriter が新規開始する', () => {
    const box = makeRpgBox()
    box.show('長老', 'first')
    box.skipTypewriter()
    box.show('村人', 'second')
    const i = asInternals(box)
    expect(i.dialogText.text).toBe('')
    expect(box.isTyping()).toBe(true)
    box.dispose()
  })

  it('フォント変更時は表示済みプレフィックスを維持し、タイプを先頭に戻さない', () => {
    const box = makeRpgBox()
    const text = '改ページ後の表示済みプレフィックスと、まだ続く本文。'
    const visiblePrefix = '改ページ後の表示済みプレフィックス'
    box.setDialog(null, text)
    const i = asInternals(box)
    i.typewriter = { fullText: text, displayedCharCount: visiblePrefix.length, acc: 0 }
    i.dialogText.text = visiblePrefix

    box.setFontFamily('serif')

    expect(i.dialogText.text).toBe(visiblePrefix)
    expect(i.typewriter.displayedCharCount).toBe(visiblePrefix.length)
    expect(box.isTyping()).toBe(true)
    box.dispose()
  })

  it('新しい setDialog でタイプ開始した瞬間に前のインジケータを隠す', () => {
    const box = makeRpgBox()
    const i = asInternals(box)

    box.setDialog('長老', 'first')
    box.skipTypewriter()
    box.setIndicatorVisible(true)
    expect(i.indicator.visible).toBe(true)

    box.setDialog('村人', 'second')
    expect(box.isTyping()).toBe(true)
    expect(i.indicator.visible).toBe(false)
    box.dispose()
  })

  it('novel progressive で文を足した瞬間に前の位置のインジケータを隠す', () => {
    const box = makeRpgBox()
    box.setNovelMode(true)
    const i = asInternals(box)

    box.setNovelDialogProgressive(null, 'first', 0)
    box.skipTypewriter()
    box.setIndicatorVisible(true)
    expect(i.indicator.visible).toBe(true)

    box.setNovelDialogProgressive(null, 'firstsecond', 'first'.length)
    expect(box.isTyping()).toBe(true)
    expect(i.indicator.visible).toBe(false)
    box.dispose()
  })

  it('novel progressive のインジケータ再配置は ticker を待たず y へ反映される（#333）', () => {
    const box = makeRpgBox()
    box.setNovelMode(true)
    const i = asInternals(box)

    box.setNovelDialogProgressive(null, 'first', 0)
    box.skipTypewriter()
    box.setIndicatorVisible(true)
    const firstBaseY = i.indicatorBaseY
    expect(i.indicator.y).toBe(firstBaseY)

    box.setNovelDialogProgressive(null, 'firstsecond', 'first'.length)
    expect(i.indicator.visible).toBe(false)
    expect(i.indicator.y).toBe(i.indicatorBaseY)

    box.dispose()
  })

  it('novel progressive の複数行インジケータも visible 直前に現在 y へ同期する（#333）', () => {
    const box = makeRpgBox()
    box.setNovelMode(true)
    const i = asInternals(box)

    box.setNovelDialogProgressive(null, 'first', 0)
    box.skipTypewriter()
    box.setIndicatorVisible(true)
    const oneLineY = i.indicator.y

    // jsdom の canvas 可否で wordwrap 結果が揺れないよう、ここでは DialogBox 内部の
    // 「wrap 済み行」を明示し、複数行化後の positionIndicator 配線だけを検証する。
    i.novelWrappedLines = ['line 1', 'line 2', 'line 3']
    box.setIndicatorVisible(true)

    expect(i.indicator.visible).toBe(true)
    expect(i.indicator.y).toBe(i.indicatorBaseY)
    expect(i.indicator.y).toBeGreaterThan(oneLineY)

    box.dispose()
  })
})

describe('DialogBox image indicators (#320)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('assetBaseUrl があると text-next / page-turn の一般名フレームを読む', async () => {
    const load = vi.spyOn(Assets, 'load')
    load.mockImplementation(
      async () => Texture.WHITE as unknown as Awaited<ReturnType<typeof Assets.load>>
    )
    const box = makeRpgBox()

    box.setIndicatorAssetBaseUrl('/asset-base')
    await flushPromises()

    expect(load).toHaveBeenCalledTimes(4)
    expect(load).toHaveBeenNthCalledWith(1, '/asset-base/images/ui/text-next-1.webp')
    expect(load).toHaveBeenNthCalledWith(4, '/asset-base/images/ui/text-next-4.webp')

    box.setIndicatorKind('pageturn')
    await flushPromises()

    expect(load).toHaveBeenCalledTimes(8)
    expect(load).toHaveBeenNthCalledWith(5, '/asset-base/images/ui/page-turn-1.webp')
    expect(load).toHaveBeenNthCalledWith(8, '/asset-base/images/ui/page-turn-4.webp')
    box.dispose()
  })

  it('画像フレーム取得後は 32px Sprite を表示し、従来グリフを隠す', async () => {
    const load = vi.spyOn(Assets, 'load')
    load.mockImplementation(
      async () => Texture.WHITE as unknown as Awaited<ReturnType<typeof Assets.load>>
    )
    const box = makeRpgBox()
    const i = asInternals(box)

    box.setIndicatorAssetBaseUrl('/asset-base')
    await flushPromises()

    expect(i.indicatorSprite.visible).toBe(true)
    expect(i.indicatorSprite.width).toBe(32)
    expect(i.indicatorSprite.height).toBe(32)
    expect(i.indicatorGlyph.visible).toBe(false)
    box.dispose()
  })

  it('画像フレーム表示中は上下バウンスせず、基準 y に固定する', async () => {
    const load = vi.spyOn(Assets, 'load')
    load.mockImplementation(
      async () => Texture.WHITE as unknown as Awaited<ReturnType<typeof Assets.load>>
    )
    const box = makeRpgBox()
    const i = asInternals(box)

    box.setIndicatorAssetBaseUrl('/asset-base')
    await flushPromises()
    i.indicator.y = i.indicatorBaseY + 4

    i.tickIndicatorMotion(100)

    expect(i.indicatorSprite.visible).toBe(true)
    expect(i.indicator.y).toBe(i.indicatorBaseY)
    box.dispose()
  })

  it('画像フレームが無い fallback グリフでは従来どおり上下バウンスする', () => {
    const box = makeRpgBox()
    const i = asInternals(box)

    i.tickIndicatorMotion(100)

    expect(i.indicatorSprite.visible).toBe(false)
    expect(i.indicator.y).not.toBe(i.indicatorBaseY)
    box.dispose()
  })
})

// =====================================================================================
// #413: 「読み込み中は▼もsprite も出さない」ステートマシン
//   (indicatorFrameTextures 未着手/pendingIndicatorKinds/failedIndicatorKinds の3集合)。
//
// 前提: setIndicatorAssetBaseUrl 単体は、結果が確定する（fetch の then/catch）まで
//   applyIndicatorFrame() を呼ばない（pendingIndicatorKinds に載せるだけ）。pending中の
//   非表示が実際に見た目へ反映されるのは setIndicatorKind() 経由（setIndicatorKind は
//   loadIndicatorFrames() の直後に自分で applyIndicatorFrame() を呼ぶ）。実運用でも
//   NovelRenderer.setAssetBaseUrl() → dialogBox.setIndicatorAssetBaseUrl() は起動時に1回、
//   dialogBox.setIndicatorKind() は文ごとに呼ばれるため、この呼び出し順序は実際のフローと一致する。
//
// 既存の「DialogBox image indicators (#320)」ブロックは単一 mockImplementation で全呼び出しを
// 即 resolve させる流儀だが、#413 は「未解決の間」の状態そのものを検証する必要があるため、
// Assets.load の呼び出しごとに個別の手動解決 Promise を返すキュー化モックを使う。
// =====================================================================================
describe('DialogBox #413 pending中は何も出さない（画像インジケータ先読み）', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  /** Assets.load を呼び出しごとに独立した手動解決 Promise で応答するキュー化モック。 */
  function mockAssetsLoadQueue() {
    const calls: Array<{
      url: string
      resolve: (v: unknown) => void
      reject: (e: unknown) => void
    }> = []
    const load = vi.spyOn(Assets, 'load')
    load.mockImplementation(((url: string) => {
      return new Promise((resolve, reject) => {
        calls.push({ url, resolve, reject })
      })
    }) as unknown as typeof Assets.load)
    return { load, calls }
  }

  // DB-5（null/未設定・回帰防止・最重要）: setIndicatorAssetBaseUrl も setIndicatorKind も
  // 一度も呼ばれていない新規 box は、fetch を一度も試みていない＝非回帰で ▼ を即表示する（S0）。
  it('DB-5: 一度も setIndicatorAssetBaseUrl/setIndicatorKind を呼んでいない新規 box は ▼ を既定表示する（RPGモード相当・S0）', () => {
    const box = makeRpgBox()
    const i = asInternals(box)

    expect(i.indicatorGlyph.visible).toBe(true)
    expect(i.indicatorSprite.visible).toBe(false)
    box.dispose()
  })

  // DB-6（境界/同値分割）: baseUrl が空のまま setIndicatorKind だけ呼ぶ → この作品は画像を
  // 一切持たないと確定できるので、fetch を試みずに即座に確定失敗化し ▼ へフォールバックする。
  it('DB-6: baseUrl 未設定のまま setIndicatorKind を呼ぶと即座に確定失敗化され glyph 表示・pending には一切乗らない', () => {
    const { load } = mockAssetsLoadQueue()
    const box = makeRpgBox()
    const i = asInternals(box)

    box.setIndicatorKind('pageturn')

    expect(load).not.toHaveBeenCalled()
    expect(i.indicatorSprite.visible).toBe(false)
    expect(i.indicatorGlyph.visible).toBe(true)
    expect(i.pendingIndicatorKinds.has('pageturn')).toBe(false)
    expect(i.failedIndicatorKinds.has('pageturn')).toBe(true)
    box.dispose()
  })

  // DB-1（状態遷移・重点）: fetch が未解決の間は sprite/glyph ともに非表示のまま。
  it('DB-1: fetch未解決の間は sprite/glyph ともに非表示になる（pending中は何も出さない＝#413の本題）', () => {
    const { calls } = mockAssetsLoadQueue()
    const box = makeRpgBox()
    const i = asInternals(box)

    box.setIndicatorAssetBaseUrl('/asset-base')
    box.setIndicatorKind('pageturn')

    // next（baseUrl設定時の既定kind）4件 + pageturn（切替時）4件 = 8件が in-flight のはず。
    expect(calls.length).toBe(8)
    // この行 (`applyIndicatorFrame` 内の `!pendingIndicatorKinds.has(this.indicatorKind)`) が
    // 無いと Issue #413 が再発する: pending中でも ▼ が即表示されてしまう。
    expect(i.indicatorSprite.visible).toBe(false)
    expect(i.indicatorGlyph.visible).toBe(false)
    expect(i.pendingIndicatorKinds.has('pageturn')).toBe(true)
    box.dispose()
  })

  // DB-1b（タイミング/ticker干渉なし）: pending中に ticker を進めても表示状態は変化しない。
  it('DB-1b: pending中に tickIndicatorFrame/tickIndicatorMotion を複数回進めても表示状態は変化しない', () => {
    mockAssetsLoadQueue()
    const box = makeRpgBox()
    const i = asInternals(box)

    box.setIndicatorAssetBaseUrl('/asset-base')
    box.setIndicatorKind('pageturn')
    expect(i.indicatorSprite.visible).toBe(false)
    expect(i.indicatorGlyph.visible).toBe(false)

    i.tickIndicatorFrame(1000)
    i.tickIndicatorMotion(1000)
    i.tickIndicatorFrame(1000)
    i.tickIndicatorMotion(1000)

    expect(i.indicatorSprite.visible).toBe(false)
    expect(i.indicatorGlyph.visible).toBe(false)
    box.dispose()
  })

  // DB-2（状態遷移）: pending → 4/4 成功で resolve → sprite 表示・glyph 非表示へ切り替わる。
  it('DB-2: pending → 4/4 成功で resolve すると sprite 表示・glyph 非表示に遷移する', async () => {
    const { calls } = mockAssetsLoadQueue()
    const box = makeRpgBox()
    const i = asInternals(box)

    box.setIndicatorAssetBaseUrl('/asset-base')
    box.setIndicatorKind('pageturn')
    expect(i.indicatorSprite.visible).toBe(false)
    expect(i.indicatorGlyph.visible).toBe(false)

    // pageturn 用の4件（後半4件）を全て有効 Texture で resolve する。
    calls.slice(4, 8).forEach((c) => c.resolve(Texture.WHITE))
    await flushPromises()

    expect(i.indicatorSprite.visible).toBe(true)
    expect(i.indicatorGlyph.visible).toBe(false)
    box.dispose()
  })

  // DB-3（異常系・境界・最重要）: 4枚中1枚が非Texture値でresolve（3/4）
  // → failedIndicatorKinds化し、新規追加された applyIndicatorFrame() 呼び出しにより
  //   glyph が再表示される（sprite は非表示のまま）。
  it('DB-3: 4枚中1枚が非Textureで resolve（3/4）でも確定失敗として glyph へフォールバックする', async () => {
    const { calls } = mockAssetsLoadQueue()
    const box = makeRpgBox()
    const i = asInternals(box)

    box.setIndicatorAssetBaseUrl('/asset-base')
    box.setIndicatorKind('pageturn')

    const pageturnCalls = calls.slice(4, 8)
    pageturnCalls[0].resolve(Texture.WHITE)
    pageturnCalls[1].resolve(Texture.WHITE)
    pageturnCalls[2].resolve(Texture.WHITE)
    pageturnCalls[3].resolve('not-a-texture') // 無効値混入（instanceof Texture を満たさない）
    await flushPromises()

    // この行 (`if (this.indicatorKind === kind) this.applyIndicatorFrame()`) が無いと
    // Issue #413 が再発する: pendingIndicatorKinds.delete(kind) だけが実行されて
    // applyIndicatorFrame() が呼ばれず、glyph が永久に非表示のままスタックする
    // （sprite 側も false なので何も見えない状態で固まる）。
    expect(i.indicatorSprite.visible).toBe(false)
    expect(i.indicatorGlyph.visible).toBe(true)
    expect(i.failedIndicatorKinds.has('pageturn')).toBe(true)
    expect(i.pendingIndicatorKinds.has('pageturn')).toBe(false)
    box.dispose()
  })

  // DB-4（API失敗/console）: Assets.load が reject → pending解除・failed化・console.warn 1回・glyph再表示。
  it('DB-4: Assets.load が reject すると pending解除・failed化し console.warn が1回呼ばれ glyph へフォールバックする', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { calls } = mockAssetsLoadQueue()
    const box = makeRpgBox()
    const i = asInternals(box)

    box.setIndicatorAssetBaseUrl('/asset-base')
    box.setIndicatorKind('pageturn')

    calls.slice(4, 8)[0].reject(new Error('404'))
    await flushPromises()

    expect(warn).toHaveBeenCalledTimes(1)
    expect(i.indicatorSprite.visible).toBe(false)
    expect(i.indicatorGlyph.visible).toBe(true)
    expect(i.failedIndicatorKinds.has('pageturn')).toBe(true)
    expect(i.pendingIndicatorKinds.has('pageturn')).toBe(false)
    box.dispose()
  })

  // DB-7（並行実行/race）: baseUrl変更中の旧fetchが後から解決しても pending/frames を汚染しない。
  it('DB-7: baseUrl を /a→/b と切り替えた後、旧 /a 側が後から成功解決しても現在の状態を汚染しない', async () => {
    const { calls } = mockAssetsLoadQueue()
    const box = makeRpgBox()
    const i = asInternals(box)

    box.setIndicatorAssetBaseUrl('/a') // next 4件 = calls[0..3]
    box.setIndicatorAssetBaseUrl('/b') // next 4件（baseUrl差し替え）= calls[4..7]

    // 旧 /a 側が後から成功で解決しても、現在の baseUrl はもう /b なので無視されるはず。
    calls.slice(0, 4).forEach((c) => c.resolve(Texture.WHITE))
    await flushPromises()
    expect(i.indicatorFrameTextures['next']).toBeUndefined()

    // /b 側が解決すると正しく反映される。
    calls.slice(4, 8).forEach((c) => c.resolve(Texture.WHITE))
    await flushPromises()

    expect(i.indicatorFrameTextures['next']?.length).toBe(4)
    expect(i.indicatorSprite.visible).toBe(true)
    expect(i.indicatorGlyph.visible).toBe(false)
    box.dispose()
  })

  // DB-8（並行実行/race・順序反転）: DB-7の逆順（/b が先に解決、/a が後から解決）でも安全。
  it('DB-8: /b が先に成功解決した後で旧 /a 側が遅れて失敗解決しても、確定済み状態を汚染しない', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { calls } = mockAssetsLoadQueue()
    const box = makeRpgBox()
    const i = asInternals(box)

    box.setIndicatorAssetBaseUrl('/a') // calls[0..3]
    box.setIndicatorAssetBaseUrl('/b') // calls[4..7]

    calls.slice(4, 8).forEach((c) => c.resolve(Texture.WHITE))
    await flushPromises()
    expect(i.indicatorSprite.visible).toBe(true)
    expect(i.indicatorGlyph.visible).toBe(false)

    // 旧 /a 側が後から reject しても、現在の baseUrl は /b なので無視され console.warn も出ない。
    calls.slice(0, 4).forEach((c) => c.reject(new Error('stale 404')))
    await flushPromises()

    expect(warn).not.toHaveBeenCalled()
    expect(i.indicatorFrameTextures['next']?.length).toBe(4)
    expect(i.indicatorSprite.visible).toBe(true)
    expect(i.indicatorGlyph.visible).toBe(false)
    box.dispose()
  })

  // DB-9（二重送信/冪等）: pending中に同一kindへ setIndicatorKind を連打しても
  // Assets.load の呼び出し回数が増えない（setIndicatorKind 冒頭のガードで短絡する）。
  it('DB-9: pending中に同一kindへ setIndicatorKind を連打しても Assets.load の呼び出し回数が増えない', () => {
    const { load } = mockAssetsLoadQueue()
    const box = makeRpgBox()

    box.setIndicatorAssetBaseUrl('/asset-base') // next 4件
    box.setIndicatorKind('pageturn') // pageturn 4件、計8件
    expect(load).toHaveBeenCalledTimes(8)

    box.setIndicatorKind('pageturn')
    box.setIndicatorKind('pageturn')
    box.setIndicatorKind('pageturn')

    expect(load).toHaveBeenCalledTimes(8)
    box.dispose()
  })

  // DB-10（状態遷移/冪等）: 成功後（S2）に他kindを経由して同じkindへ戻っても再フェッチしない
  // （loadIndicatorFrames 冒頭の「既にロード済み」キャッシュ判定で短絡する。DB-9 の
  //   setIndicatorKind 冒頭ガードとは別の短絡経路であることを区別して確認する）。
  it('DB-10: 成功後に他kindを経由して同じkindへ戻っても再フェッチしない（ロード済みキャッシュの再適用のみ）', async () => {
    const { load, calls } = mockAssetsLoadQueue()
    const box = makeRpgBox()
    const i = asInternals(box)

    box.setIndicatorAssetBaseUrl('/asset-base') // next 4件 = calls[0..3]
    box.setIndicatorKind('pageturn') // pageturn 4件 = calls[4..7]
    calls.slice(0, 4).forEach((c) => c.resolve(Texture.WHITE))
    calls.slice(4, 8).forEach((c) => c.resolve(Texture.WHITE))
    await flushPromises()
    expect(i.indicatorFrameTextures['pageturn']?.length).toBe(4)
    expect(load).toHaveBeenCalledTimes(8)

    box.setIndicatorKind('next') // 既にロード済みの next へ（キャッシュ再適用のみ）
    box.setIndicatorKind('pageturn') // pageturn へ戻る（キャッシュ再適用のみ）

    expect(load).toHaveBeenCalledTimes(8) // 増えていない
    expect(i.indicatorSprite.visible).toBe(true)
    expect(i.indicatorGlyph.visible).toBe(false)
    box.dispose()
  })

  // DB-11（console汚染/現状仕様固定）: DB-3（枚数不一致）のケースで console.warn/error が
  // 呼ばれないことを確認する。reject経路（DB-4）との非対称は現状仕様として明記する
  // （診断ログが無く原因追跡しづらいので将来 issue 化の候補）。
  it('DB-11: 枚数不一致の確定失敗では console.warn/error を呼ばない（reject経路との非対称・現状仕様）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { calls } = mockAssetsLoadQueue()
    const box = makeRpgBox()

    box.setIndicatorAssetBaseUrl('/asset-base')
    box.setIndicatorKind('pageturn')

    const pageturnCalls = calls.slice(4, 8)
    pageturnCalls[0].resolve(Texture.WHITE)
    pageturnCalls[1].resolve(Texture.WHITE)
    pageturnCalls[2].resolve(Texture.WHITE)
    pageturnCalls[3].resolve('not-a-texture')
    await flushPromises()

    expect(warn).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
    box.dispose()
  })

  // DB-12（回帰・独立レビュー M1）: setIndicatorKind の早期returnガードは
  // `indicatorKind === kind && glyph.text === INDICATOR_GLYPH[kind]` で判定するため、
  // コンストラクタ既定値 kind='next'/glyph='▼' と一致するセッション最初の
  // setIndicatorKind('next') 呼び出しは常にこの分岐に入る。このガードで applyIndicatorFrame()
  // を呼ばないと、直前の setIndicatorAssetBaseUrl が pendingIndicatorKinds に 'next' を
  // 積んだだけで glyph/sprite の可視状態を更新しないまま抜けてしまい、fetch 未解決の間ずっと
  // indicatorGlyph.visible が初期値 true のまま ▼ が表示され続ける（#413 が最も一般的な
  // ケース＝最初に使う kind が既定値と一致する場合に再発する）。
  it("DB-12: setIndicatorAssetBaseUrl → 既定値と一致する setIndicatorKind('next') 呼び出しでも pending 中は glyph/sprite ともに隠す（#413 M1 回帰）", () => {
    mockAssetsLoadQueue()
    const box = makeRpgBox()
    const i = asInternals(box)

    box.setIndicatorAssetBaseUrl('/asset-base') // 'next' fetch 開始（pendingIndicatorKinds に積むだけ）
    box.setIndicatorKind('next') // 既定値と一致 → 早期return分岐。ここで applyIndicatorFrame() が必須

    expect(i.pendingIndicatorKinds.has('next')).toBe(true)
    expect(i.indicatorGlyph.visible).toBe(false)
    expect(i.indicatorSprite.visible).toBe(false)
    box.dispose()
  })

  // DB-13（回帰・独立レビュー S1）: loadIndicatorFrames の最初のガードは indicatorFrameTextures /
  // failedIndicatorKinds は見るが pendingIndicatorKinds を見ていなかった。このガードが無いと、
  // 既に fetch が in-flight（未解決）な kind へ短時間で出入りするだけで Assets.load が
  // 重複発火する（next→pageturn→next と戻った時点で next はまだ未解決なのに再フェッチする）。
  it('DB-13: pending 中の kind へ他 kind を経由して戻っても Assets.load を再発火しない（#413 S1 回帰）', () => {
    const { load } = mockAssetsLoadQueue()
    const box = makeRpgBox()
    const i = asInternals(box)

    box.setIndicatorAssetBaseUrl('/asset-base') // 'next' fetch開始（4件）
    box.setIndicatorKind('pageturn') // 'pageturn' fetch開始（4件）、計8件
    expect(load).toHaveBeenCalledTimes(8)

    box.setIndicatorKind('next') // 'next' はまだ pending 中（fetch未解決）のはず

    expect(load).toHaveBeenCalledTimes(8) // pending 判定が無いと 12 件に増える
    expect(i.pendingIndicatorKinds.has('next')).toBe(true)
    expect(i.indicatorGlyph.visible).toBe(false)
    expect(i.indicatorSprite.visible).toBe(false)
    box.dispose()
  })

  // DB-14（回帰・独立レビュー2巡目 should）: setIndicatorAssetBaseUrl の「フレッシュフェッチ」
  // 分岐（indicatorFrameTextures/failedIndicatorKinds/pendingIndicatorKinds のいずれにも
  // 載っていない kind の新規 fetch を loadIndicatorFrames 内で開始するケース）は
  // applyIndicatorFrame() を同期呼びしない設計のため、旧 baseUrl で既に確定表示していた
  // スプライト（visible=true・旧テクスチャ）が新 baseUrl の fetch 解決まで残存表示されて
  // しまっていた（このPR以前から存在した既存の穴）。setIndicatorAssetBaseUrl 内で
  // loadIndicatorFrames 呼び出し直後に applyIndicatorFrame() を追加で呼ぶことで、baseUrl
  // 切替の瞬間にも「pending中は何も出さない」不変条件を同期的に適用する。
  // この行が無いと baseUrl 切替直後に旧ゲームの画像が一瞬残存表示される。
  it('DB-14: 旧baseUrlで表示済みのスプライトは、新baseUrlへ切替直後（fetch未解決の間）に残存表示されない（#413 re-review should）', async () => {
    const { calls } = mockAssetsLoadQueue()
    const box = makeRpgBox()
    const i = asInternals(box)

    // 旧baseUrlでフェッチ成功済み（sprite可視・旧テクスチャ表示）の状態を作る。
    box.setIndicatorAssetBaseUrl('/gameA') // next 4件 = calls[0..3]
    calls.slice(0, 4).forEach((c) => c.resolve(Texture.WHITE))
    await flushPromises()
    expect(i.indicatorSprite.visible).toBe(true)
    expect(i.indicatorGlyph.visible).toBe(false)

    // 新baseUrlへ切り替える（次の fetch はまだ未解決）。
    box.setIndicatorAssetBaseUrl('/gameB') // next 4件（新規fetch）= calls[4..7]、まだ未解決

    // 切り替え直後（新フェッチが未解決の間）に旧テクスチャが残存表示されないこと。
    expect(i.indicatorSprite.visible).toBe(false)
    expect(i.indicatorGlyph.visible).toBe(false)
    box.dispose()
  })
})

describe('computePortraitContainFit (Issue #104 / #194)', () => {
  const FRAME_SIZE = 80
  const FX = 40
  const FY = 100

  it('正方形の source は枠ぴったりに表示する', () => {
    const fit = computePortraitContainFit(160, 160, FX, FY, FRAME_SIZE)
    expect(fit.x).toBe(40)
    expect(fit.y).toBe(100)
    expect(fit.width).toBe(80)
    expect(fit.height).toBe(80)
  })

  it('縦長の source は中央寄せで横余白を残す', () => {
    const fit = computePortraitContainFit(100, 200, FX, FY, FRAME_SIZE)
    expect(fit.width).toBe(40)
    expect(fit.height).toBe(80)
    expect(fit.x).toBe(40 + (80 - 40) / 2)
    expect(fit.y).toBe(100)
  })

  it('横長の source は中央寄せで縦余白を残す', () => {
    const fit = computePortraitContainFit(200, 100, FX, FY, FRAME_SIZE)
    expect(fit.width).toBe(80)
    expect(fit.height).toBe(40)
    expect(fit.x).toBe(40)
    expect(fit.y).toBe(100 + (80 - 40) / 2)
  })

  it('source が 0 や非数なら枠と同じサイズへフォールバック', () => {
    const a = computePortraitContainFit(0, 100, FX, FY, FRAME_SIZE)
    expect(a).toEqual({ x: 40, y: 100, width: 80, height: 80 })
    const b = computePortraitContainFit(NaN, 100, FX, FY, FRAME_SIZE)
    expect(b).toEqual({ x: 40, y: 100, width: 80, height: 80 })
    const c = computePortraitContainFit(100, -1, FX, FY, FRAME_SIZE)
    expect(c).toEqual({ x: 40, y: 100, width: 80, height: 80 })
  })
})

// ---------------------------------------------------------------------------
// #214: フォントロード非同期化 (ensureFontLoaded + rubyBuildToken) テスト
// ---------------------------------------------------------------------------

/** テスト用手動 resolve Promise を生成する */
function makeManualPromise(): {
  promise: Promise<void>
  resolve: () => void
  reject: (e: unknown) => void
} {
  let resolve!: () => void
  let reject!: (e: unknown) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('DialogBox フォントロード非同期化 (Issue #214)', () => {
  let box: DialogBox

  beforeEach(() => {
    box = new DialogBox({
      screenWidth: 800,
      screenHeight: 600,
      boxHeight: 120,
      marginX: 20,
      padding: 20,
      fontSize: 18,
    })
  })

  afterEach(() => {
    box.dispose()
    vi.clearAllMocks()
  })

  // TC-01: フォントロード成功後に rubyEntries が構築される
  it('TC-01: フォントロード成功後に rubyEntries が構築され x 座標が設定されている', async () => {
    const { promise, resolve } = makeManualPromise()
    mockEnsureFontLoaded.mockReturnValue(promise)

    box.setDialog(null, '漢字《かんじ》のルビ')
    const i = asInternals(box)

    // .then 未解決の間は rubyEntries は空
    expect(i.rubyEntries.length).toBe(0)

    resolve()
    await promise

    // マイクロタスクキューを flush
    await Promise.resolve()

    expect(i.rubyEntries.length).toBeGreaterThan(0)
    // 各エントリの x は数値として設定されている
    for (const e of i.rubyEntries) {
      expect(typeof (e.text as { x: number }).x).toBe('number')
    }
  })

  // TC-02: setDialog 直後（.then 前）は rubyEntries が空
  it('TC-02: setDialog 呼び出し直後（フォントロード前）は rubyEntries が空', () => {
    const { promise } = makeManualPromise()
    mockEnsureFontLoaded.mockReturnValue(promise)

    box.setDialog(null, '漢字《かんじ》テスト')
    const i = asInternals(box)

    expect(i.rubyEntries.length).toBe(0)
  })

  // TC-06: ensureFontLoaded が reject した場合、rubyEntries は空のままでクラッシュしない
  it('TC-06: ensureFontLoaded が reject した場合 rebuildRubyEntries は呼ばれず rubyEntries は空のまま', async () => {
    mockEnsureFontLoaded.mockRejectedValueOnce(new Error('font load failed'))

    box.setDialog(null, '漢字《かんじ》テスト')
    const i = asInternals(box)

    // マイクロタスクキューを flush
    await Promise.resolve()
    await Promise.resolve()

    expect(i.rubyEntries.length).toBe(0)
  })

  // TC-08: setDialog を連続2回呼んだとき、1回目の stale .then は無視される
  it('TC-08: setDialog 連続2回呼び出し時、stale な 1回目の .then は無視され rubyEntries は2回目の内容', async () => {
    const first = makeManualPromise()
    const second = makeManualPromise()

    // 1回目と2回目で別の Promise を返す
    mockEnsureFontLoaded.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)

    box.setDialog(null, '一回目《いっかいめ》')
    box.setDialog(null, '二回目《にかいめ》のテキスト')

    const i = asInternals(box)

    // 2回目の resolve を先に行う
    second.resolve()
    await second.promise
    await Promise.resolve()

    const entriesAfterSecond = i.rubyEntries.length
    expect(entriesAfterSecond).toBeGreaterThan(0)
    // 追加: 2回目のルビ文字列が含まれるか確認
    expect(i.rubyEntries.some((e) => (e.placement as { ruby: string }).ruby === 'にかいめ')).toBe(
      true
    )

    // 1回目を後から resolve しても rubyEntries は変わらない（stale token で弾かれる）
    first.resolve()
    await first.promise
    await Promise.resolve()

    expect(i.rubyEntries.length).toBe(entriesAfterSecond)
  })

  // TC-12: setDialog → clearText → .then 解決の順で stale callback は無視される
  it('TC-12: setDialog → clearText → フォントロード解決の順で stale callback は無視される', async () => {
    const { promise, resolve } = makeManualPromise()
    mockEnsureFontLoaded.mockReturnValue(promise)

    box.setDialog(null, '漢字《かんじ》')
    box.clearText()

    const i = asInternals(box)

    resolve()
    await promise
    await Promise.resolve()

    // clearText が rubyBuildToken を進めているため stale .then は無視される
    expect(i.rubyEntries.length).toBe(0)
  })

  // TC-15: ルビ記法なしのテキストで .then 解決後も rubyEntries が空のまま
  it('TC-15: ルビ記法を含まないテキストは .then 解決後も rubyEntries が空のまま', async () => {
    const { promise, resolve } = makeManualPromise()
    mockEnsureFontLoaded.mockReturnValue(promise)

    box.setDialog(null, 'ルビなしのシンプルなテキスト')
    const i = asInternals(box)

    resolve()
    await promise
    await Promise.resolve()

    expect(i.rubyEntries.length).toBe(0)
  })
})

describe('isJustShown ガード (メニュー → tryTalk → dialog.show 直後の二重 tap 防御)', () => {
  let box: DialogBox

  beforeEach(() => {
    box = makeRpgBox()
  })

  afterEach(() => {
    box.destroy()
  })

  it('show 直後は guardMs 内で true', () => {
    box.show('NPC', 'やあ', undefined)
    expect(box.isJustShown(300)).toBe(true)
  })

  it('show 前は false（showing が false なのでガード非対象）', () => {
    expect(box.isJustShown(300)).toBe(false)
  })

  it('guardMs を 0 にすると常に false（差分 < 0 にならないため）', () => {
    box.show('NPC', 'やあ', undefined)
    expect(box.isJustShown(0)).toBe(false)
  })

  it('hide 後は showing=false なので false（時刻記録はリセットしないが showing で弾く）', () => {
    box.show('NPC', 'やあ', undefined)
    box.hide()
    expect(box.isJustShown(99999)).toBe(false)
  })

  it('再度 show すると時刻が更新されてガード復活', () => {
    box.show('A', '1', undefined)
    box.hide()
    box.show('B', '2', undefined)
    expect(box.isJustShown(300)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// #283: novel mode（全画面ノベル描画）
// ---------------------------------------------------------------------------
//
// setNovelMode(true) で borderless 相当（枠・背景・名札なし、白文字 + DropShadow）にし、
// テキスト域を画面の大半へ拡張する。adv へ戻すと下部 ADV 箱の幾何に復帰する。
//
// 期待値は実装と同じく export 定数（NOVEL_TEXT_MARGIN_X / NOVEL_TEXT_TOP_RATIO /
// NOVEL_TEXT_MARGIN_BOTTOM）から算出する（値は直書きしない。実装が定数を変えても追従する）。
// スクリム・退避フェード・描画反映は NovelRenderer 側 + 実機検証に委ねる（jsdom 観測不能）。
describe('DialogBox novel mode (#283)', () => {
  const W = 800
  const H = 600
  const FONT_SIZE = 40
  const PAD = 20

  // novel 幾何を export 定数から算出する参照オラクル（実装 applyNovelGeometry と同形）。
  function expectedNovelGeometry(screenWidth: number, screenHeight: number) {
    const topY = Math.round(screenHeight * NOVEL_TEXT_TOP_RATIO)
    return {
      boxX: NOVEL_TEXT_MARGIN_X,
      boxW: screenWidth - NOVEL_TEXT_MARGIN_X * 2,
      boxY: topY,
      boxH: screenHeight - topY - NOVEL_TEXT_MARGIN_BOTTOM,
    }
  }

  // novelMaxLinesPerPage の参照オラクル（lineHeight = fontSize * 1.6・実装と同形）。
  function expectedMaxLines(boxH: number, fontSize: number, padding: number) {
    const usable = boxH - padding * 2
    return Math.max(1, Math.floor(usable / (fontSize * 1.6)))
  }

  interface NovelInternals {
    bg: { visible: boolean }
    nameBox: { visible: boolean }
    nameText: { visible: boolean }
    boxX: number
    boxW: number
    boxY: number
    boxH: number
  }
  function novelInternals(box: DialogBox): NovelInternals {
    return box as unknown as NovelInternals
  }

  function makeBox(width = W, height = H): DialogBox {
    return new DialogBox({
      screenWidth: width,
      screenHeight: height,
      boxHeight: 180,
      marginX: 20,
      marginBottom: 20,
      padding: PAD,
      fontSize: FONT_SIZE,
    })
  }

  // 12: novel ON でセリフ表示すると背景（枠・地）が非表示になる（borderless 化）。
  //     bg.visible は setDialog 時に `!borderless` で更新される（novel は borderless 相当）ので、
  //     setNovelMode 直後でなく setDialog 経由で「枠が出ない」ことを観測する。
  it('12: novel ON でセリフ表示すると背景（枠・地）が非表示になる（borderless 化）', () => {
    const box = makeBox()
    box.setNovelMode(true)
    box.setDialog('A', 'セリフ。')
    expect(box.isNovelMode).toBe(true)
    expect(novelInternals(box).bg.visible).toBe(false)
    box.dispose()
  })

  // 12b: 対照 — adv（novel OFF）でセリフ表示すると背景（枠・地）は表示される。
  //     名札の measureText は jsdom canvas null で落ちるため、名前なし（null）で背景可視だけを観測する。
  it('12b: adv でセリフ表示すると背景は表示される（novel との対照で borderless 化を確定）', () => {
    const box = makeBox()
    box.setDialog(null, 'セリフ。')
    expect(box.isNovelMode).toBe(false)
    expect(novelInternals(box).bg.visible).toBe(true)
    box.dispose()
  })

  // 13: novel ON では名札（separate box）を表示しようとしても出ない。
  it('13: novel ON では名札ボックス・名札テキストが非表示のまま（話者名を出さない）', () => {
    const box = makeBox()
    box.setNovelMode(true)
    box.setDialog('キャラA', 'セリフ。')
    const i = novelInternals(box)
    expect(i.nameBox.visible).toBe(false)
    expect(i.nameText.visible).toBe(false)
    box.dispose()
  })

  // 14: novel 幾何が export 定数の算出値に一致する（直書きしない）。
  it('14: novel ON のテキスト域 boxX/boxW/boxY/boxH が NOVEL_* 定数の算出値に一致する', () => {
    const box = makeBox()
    box.setNovelMode(true)
    const i = novelInternals(box)
    const exp = expectedNovelGeometry(W, H)
    expect(i.boxX).toBe(exp.boxX)
    expect(i.boxW).toBe(exp.boxW)
    expect(i.boxY).toBe(exp.boxY)
    expect(i.boxH).toBe(exp.boxH)
    box.dispose()
  })

  // 15: adv → novel → adv で boxH が advBoxHeight（=180）へ戻る退行ガード。
  //     novel が boxH を全画面に広げたまま adv に残ると下部箱が巨大化する事故を撃つ。
  it('15: adv→novel→adv で boxH が元の ADV 箱高さ（advBoxHeight）に戻る', () => {
    const box = makeBox()
    const advBoxH = novelInternals(box).boxH // 初期 adv 箱高さ = 180
    expect(advBoxH).toBe(180)

    box.setNovelMode(true)
    expect(novelInternals(box).boxH).toBe(expectedNovelGeometry(W, H).boxH)

    box.setNovelMode(false)
    // adv へ戻ったら下部 ADV 箱の高さに復帰している
    expect(box.isNovelMode).toBe(false)
    expect(novelInternals(box).boxH).toBe(advBoxH)
    box.dispose()
  })

  // 16: novel↔adv を反復切替しても幾何が累積ドリフトせず冪等（同じ状態に収束する）。
  it('16: novel↔adv の反復切替は冪等（boxH が毎回同じ値に収束する）', () => {
    const box = makeBox()
    const advBoxH = novelInternals(box).boxH
    const novelBoxH = expectedNovelGeometry(W, H).boxH

    for (let n = 0; n < 5; n++) {
      box.setNovelMode(true)
      expect(novelInternals(box).boxH).toBe(novelBoxH)
      box.setNovelMode(false)
      expect(novelInternals(box).boxH).toBe(advBoxH)
    }
    box.dispose()
  })

  // 16b: novel を 2 回連続 ON しても冪等（NovelRenderer が setBorderless 後に再適用する経路を想定）。
  it('16b: novel ON を連続適用しても幾何が変わらない（冪等再適用）', () => {
    const box = makeBox()
    box.setNovelMode(true)
    const first = { ...novelInternals(box) }
    box.setNovelMode(true)
    const i = novelInternals(box)
    expect(i.boxX).toBe(first.boxX)
    expect(i.boxW).toBe(first.boxW)
    expect(i.boxY).toBe(first.boxY)
    expect(i.boxH).toBe(first.boxH)
    box.dispose()
  })

  // 17: novelMaxLinesPerPage が各アスペクト比で定数算出値に一致し、最低 1 を下回らない。
  it('17: novelMaxLinesPerPage が各アスペクト比で定数算出値・最低 1 になる', () => {
    const cases: Array<[number, number]> = [
      [800, 450], // 16:9
      [800, 600], // 4:3
      [450, 800], // 9:16（縦長 = 本文域が広い）
    ]
    for (const [w, h] of cases) {
      const box = makeBox(w, h)
      box.setNovelMode(true)
      const boxH = expectedNovelGeometry(w, h).boxH
      const exp = expectedMaxLines(boxH, FONT_SIZE, PAD)
      expect(box.novelMaxLinesPerPage()).toBe(exp)
      expect(box.novelMaxLinesPerPage()).toBeGreaterThanOrEqual(1)
      box.dispose()
    }
  })

  // 17b: 本文域が潰れる極小画面でも novelMaxLinesPerPage は最低 1 を返す（0 行ページで無限ループしない）。
  it('17b: 極端に低い画面でも novelMaxLinesPerPage は 1 以上（Math.max(1, …) 下限）', () => {
    const box = makeBox(800, 200) // boxH が小さくなり usable/行高 < 1 になり得る
    box.setNovelMode(true)
    expect(box.novelMaxLinesPerPage()).toBeGreaterThanOrEqual(1)
    box.dispose()
  })

  // 18: measureLineCount は jsdom では canvas null で wordwrap が常に 1 行を返すため、
  //     具体値に依存せず「呼べて正の整数を返す」ことだけを縛る（実描画は実機委譲）。
  it('18: measureLineCount は呼べて正の整数を返す（jsdom の 1 行値に依存しない）', () => {
    const box = makeBox()
    box.setNovelMode(true)
    const n = box.measureLineCount('適当なテキスト。')
    expect(Number.isInteger(n)).toBe(true)
    expect(n).toBeGreaterThanOrEqual(1)
    // 空文字でも 0 にはならない（wordwrap は [''] を返す）
    expect(box.measureLineCount('')).toBeGreaterThanOrEqual(1)
    box.dispose()
  })

  // 19: novel ON のまま空テキストを setDialog すると hide される（立ち絵だけの空ダイアログ）。
  //     ▼ や透明枠が残らない既存挙動を novel でも保つ。
  it('19: novel ON で空テキストの setDialog は box を隠す（showing=false）', () => {
    const box = makeBox()
    box.setNovelMode(true)
    box.setDialog(null, '   ')
    expect(box.isShowing).toBe(false)
    box.dispose()
  })

  // 20: novel ON で redraw（リサイズ）しても adv 箱に戻らず novel 幾何を維持する。
  it('20: novel ON で redraw すると novel 幾何を維持する（adv 箱へ戻らない）', () => {
    const box = makeBox()
    box.setNovelMode(true)
    const nw = 1024
    const nh = 768
    box.redraw(nw, nh)
    const i = novelInternals(box)
    const exp = expectedNovelGeometry(nw, nh)
    expect(i.boxX).toBe(exp.boxX)
    expect(i.boxW).toBe(exp.boxW)
    expect(i.boxY).toBe(exp.boxY)
    expect(i.boxH).toBe(exp.boxH)
    box.dispose()
  })

  // 21: 初期状態（setNovelMode を呼ぶ前）は adv（isNovelMode=false）。デフォルトが novel に倒れない。
  it('21: 初期状態は adv（novel ではない）', () => {
    const box = makeBox()
    expect(box.isNovelMode).toBe(false)
    box.dispose()
  })
})

// split_layout (#442) のテキスト領域固定。dialog_style（adv/novel）とは独立の軸で、
// setSplitLayoutRegion は adv・novel どちらでも渡された矩形へ boxX/Y/W/H を固定するだけで、
// 枠・名札の有無等の見た目（setBorderless/setNovelMode の管轄）には一切触れない。
// NovelRenderer.applySplitLayout() が computeSplitLayoutRegions(...).text をそのまま渡す想定。
describe('DialogBox setSplitLayoutRegion (#442)', () => {
  const W = 800
  const H = 450

  interface SplitInternals {
    bg: { visible: boolean }
    nameBox: { visible: boolean }
    boxX: number
    boxW: number
    boxY: number
    boxH: number
  }
  function splitInternals(box: DialogBox): SplitInternals {
    return box as unknown as SplitInternals
  }

  function makeBox(): DialogBox {
    return new DialogBox({
      screenWidth: W,
      screenHeight: H,
      boxHeight: 180,
      marginX: 20,
      marginBottom: 20,
      padding: 20,
      fontSize: 40,
    })
  }

  // computeSplitLayoutRegions(800, 450).text 相当（横長・右半分がテキスト領域）。
  const region: LayoutRect = { x: 400, y: 0, width: 400, height: 450 }

  // applySplitLayoutBoxGeometry と同形の参照オラクル（NOVEL_TEXT_* 定数から算出・直書きしない）。
  // #442 self-review must-1: adv（borderless=false、名札を描画する）のときだけ、drawNameBox が
  // 使う NAME_BOX_HEIGHT + NAME_BOX_GAP 分の上部クリアランスを追加で確保する。novel
  // （borderless=true）はクリアランス無しのまま（従来どおり最小余白）。
  function expectedGeometry(r: LayoutRect, opts?: { borderless?: boolean }) {
    const borderless = opts?.borderless ?? false
    const topMargin = Math.round(r.height * NOVEL_TEXT_TOP_RATIO)
    const nameBoxClearance = borderless ? 0 : NAME_BOX_HEIGHT + NAME_BOX_GAP
    const topY = r.y + topMargin + nameBoxClearance
    return {
      boxX: r.x + NOVEL_TEXT_MARGIN_X,
      boxW: r.width - NOVEL_TEXT_MARGIN_X * 2,
      boxY: topY,
      boxH: r.y + r.height - topY - NOVEL_TEXT_MARGIN_BOTTOM,
    }
  }

  it('adv（novelMode=false）で region を設定すると boxX/Y/W/H が名札クリアランス込みの region 基準幾何になる', () => {
    const box = makeBox()
    box.setSplitLayoutRegion(region)
    const i = splitInternals(box)
    const exp = expectedGeometry(region) // borderless=false（既定）＝adv
    expect(i.boxX).toBe(exp.boxX)
    expect(i.boxW).toBe(exp.boxW)
    expect(i.boxY).toBe(exp.boxY)
    expect(i.boxH).toBe(exp.boxH)
    box.dispose()
  })

  it('novel（novelMode=true）で region を設定すると boxX/Y/W/H が（クリアランス無しの）region 基準幾何になる', () => {
    const box = makeBox()
    box.setNovelMode(true)
    box.setSplitLayoutRegion(region)
    const i = splitInternals(box)
    const exp = expectedGeometry(region, { borderless: true })
    expect(i.boxX).toBe(exp.boxX)
    expect(i.boxW).toBe(exp.boxW)
    expect(i.boxY).toBe(exp.boxY)
    expect(i.boxH).toBe(exp.boxH)
    box.dispose()
  })

  // 重要: split_layout の中核契約——同一 region を adv/novel どちらに設定しても
  // boxX/boxW（横方向）は完全一致する。縦方向（boxY/boxH）は #442 self-review must-1 により
  // adv だけ名札 1 個分（NAME_BOX_HEIGHT + NAME_BOX_GAP）の上部クリアランスを追加で確保するため、
  // adv の boxY は novel よりクリアランス分だけ大きく（下）、boxH はその分小さくなる。
  it('重要: 同一 region で adv は novel より名札クリアランス分だけ boxY が下がる（boxX/boxW は不変）', () => {
    const advBox = makeBox()
    advBox.setSplitLayoutRegion(region)
    const advGeom = { ...splitInternals(advBox) }

    const novelBox = makeBox()
    novelBox.setNovelMode(true)
    novelBox.setSplitLayoutRegion(region)
    const novelGeom = { ...splitInternals(novelBox) }

    expect(novelGeom.boxX).toBe(advGeom.boxX)
    expect(novelGeom.boxW).toBe(advGeom.boxW)

    const clearance = NAME_BOX_HEIGHT + NAME_BOX_GAP
    expect(advGeom.boxY - novelGeom.boxY).toBe(clearance)
    expect(novelGeom.boxH - advGeom.boxH).toBe(clearance)

    advBox.dispose()
    novelBox.dispose()
  })

  it('setNovelMode(true)⇄(false) を往復しても region ジオメトリ（各モードのクリアランス込み期待値）を維持する', () => {
    const box = makeBox()
    box.setSplitLayoutRegion(region)
    const advExp = expectedGeometry(region) // borderless=false＝adv
    const novelExp = expectedGeometry(region, { borderless: true })

    let i = splitInternals(box)
    expect(i.boxX).toBe(advExp.boxX)
    expect(i.boxY).toBe(advExp.boxY)
    expect(i.boxW).toBe(advExp.boxW)
    expect(i.boxH).toBe(advExp.boxH)

    box.setNovelMode(true)
    i = splitInternals(box)
    expect(i.boxX).toBe(novelExp.boxX)
    expect(i.boxY).toBe(novelExp.boxY)
    expect(i.boxW).toBe(novelExp.boxW)
    expect(i.boxH).toBe(novelExp.boxH)

    box.setNovelMode(false)
    i = splitInternals(box)
    expect(i.boxX).toBe(advExp.boxX)
    expect(i.boxY).toBe(advExp.boxY)
    expect(i.boxW).toBe(advExp.boxW)
    expect(i.boxH).toBe(advExp.boxH)

    box.dispose()
  })

  it('setSplitLayoutRegion(null) で adv の従来ジオメトリ（下部 ADV 箱）に復帰する', () => {
    const box = makeBox()
    const advGeomBefore = { ...splitInternals(box) }
    box.setSplitLayoutRegion(region)
    box.setSplitLayoutRegion(null)
    const i = splitInternals(box)
    expect(i.boxX).toBe(advGeomBefore.boxX)
    expect(i.boxY).toBe(advGeomBefore.boxY)
    expect(i.boxW).toBe(advGeomBefore.boxW)
    expect(i.boxH).toBe(advGeomBefore.boxH)
    box.dispose()
  })

  it('setSplitLayoutRegion(null) で novel の従来ジオメトリ（全画面）に復帰する', () => {
    const box = makeBox()
    box.setNovelMode(true)
    const novelGeomBefore = { ...splitInternals(box) }
    box.setSplitLayoutRegion(region)
    box.setSplitLayoutRegion(null)
    const i = splitInternals(box)
    expect(i.boxX).toBe(novelGeomBefore.boxX)
    expect(i.boxY).toBe(novelGeomBefore.boxY)
    expect(i.boxW).toBe(novelGeomBefore.boxW)
    expect(i.boxH).toBe(novelGeomBefore.boxH)
    box.dispose()
  })

  it('同一 region を2回連続で設定しても冪等（値が変わらない）', () => {
    const box = makeBox()
    box.setSplitLayoutRegion(region)
    const first = { ...splitInternals(box) }
    box.setSplitLayoutRegion(region)
    const second = splitInternals(box)
    expect(second.boxX).toBe(first.boxX)
    expect(second.boxY).toBe(first.boxY)
    expect(second.boxW).toBe(first.boxW)
    expect(second.boxH).toBe(first.boxH)
    box.dispose()
  })

  // 見た目非干渉: setSplitLayoutRegion はジオメトリ（boxX/Y/W/H）だけを変え、
  // 枠・名札の可視状態（setBorderless/setDialog が管理）には触れない。
  // 名前ありで setDialog すると nameText.width の canvas 計測が jsdom で null になり落ちるため
  // （12b と同じ既知の制約）、名前なし（null）で bg.visible だけを観測する。
  it('見た目非干渉: setSplitLayoutRegion 呼び出し前後で bg.visible / nameBox.visible が変化しない', () => {
    const box = makeBox()
    box.setDialog(null, 'セリフ。')
    const bgBefore = splitInternals(box).bg.visible
    const nameBoxBefore = splitInternals(box).nameBox.visible
    box.setSplitLayoutRegion(region)
    expect(splitInternals(box).bg.visible).toBe(bgBefore)
    expect(splitInternals(box).nameBox.visible).toBe(nameBoxBefore)
    box.dispose()
  })
})

// #442 self-review must-1 の回帰テスト: adv + split_layout + 話者名ありで実際に setDialog を呼び、
// drawNameBox が描く名札の矩形（roundRect 呼び出し引数）が region 内に収まる
// （画面外に出ない・隣接するキャラ画像領域へ食い込まない）ことを検証する。
// jsdom は canvas 2d ctx が null で nameText.width の実測ができず素の setDialog(name, ...) は
// 例外を投げる（"見た目非干渉" テストのコメント参照）ため、nameText.width の getter だけを
// インスタンス単位で一時スタブし、実際に drawNameBox が通る経路のまま検証する。
describe('DialogBox split_layout + adv 名札の描画位置 (#442 self-review must-1)', () => {
  interface NameBoxRoundRectTarget {
    roundRect: (...args: number[]) => unknown
  }
  interface NameTextWidthTarget {
    width: number
  }

  function stubNameTextWidth(box: DialogBox, width: number): void {
    const nameText = (box as unknown as { nameText: NameTextWidthTarget }).nameText
    Object.defineProperty(nameText, 'width', { get: () => width, configurable: true })
  }

  /** drawNameBox が実際に roundRect へ渡した [x, y, w, h, radius] のうち最初の呼び出しを返す。 */
  function captureNameBoxY(box: DialogBox, name: string, text: string): number {
    const nameBox = (box as unknown as { nameBox: NameBoxRoundRectTarget }).nameBox
    const spy = vi.spyOn(nameBox, 'roundRect')
    stubNameTextWidth(box, 80)
    box.setDialog(name, text)
    const firstCall = spy.mock.calls[0] as unknown as number[]
    spy.mockRestore()
    return firstCall[1] // y 引数
  }

  it('landscape (800x450, region.y=0): nameBox が画面外(負のY)にはみ出さない', () => {
    const w = 800
    const h = 450
    const region = computeSplitLayoutRegions(w, h).text // { x: 400, y: 0, width: 400, height: 450 }
    const box = new DialogBox({ screenWidth: w, screenHeight: h })
    box.setSplitLayoutRegion(region)

    const nameBoxY = captureNameBoxY(box, '花子', 'テスト本文。')

    // 修正前は topY=5 → boxY=5 → nameBoxY = 5-40 = -35（画面外・不可視）だった。
    const topMargin = Math.round(region.height * NOVEL_TEXT_TOP_RATIO)
    expect(nameBoxY).toBe(region.y + topMargin)
    expect(nameBoxY).toBeGreaterThanOrEqual(region.y)
    box.dispose()
  })

  it('portrait (450x800, region.y=400): nameBox がキャラ画像領域(y<400)へ食い込まない', () => {
    const w = 450
    const h = 800
    const region = computeSplitLayoutRegions(w, h).text // { x: 0, y: 400, width: 450, height: 400 }
    const box = new DialogBox({ screenWidth: w, screenHeight: h })
    box.setSplitLayoutRegion(region)

    const nameBoxY = captureNameBoxY(box, '花子', 'テスト本文。')

    // 修正前は topY=405 → boxY=405 → nameBoxY = 405-40 = 365（テキスト領域の上端400より上＝食い込み）だった。
    const topMargin = Math.round(region.height * NOVEL_TEXT_TOP_RATIO)
    expect(nameBoxY).toBe(region.y + topMargin)
    expect(nameBoxY).toBeGreaterThanOrEqual(region.y)
    box.dispose()
  })
})

// =====================================================================================
// #444: 話者別2窓（相手=上/自分=下）モード。setDualWindowRegions/setDualWindowActiveRole が
// boxX/Y/W/H を正しいサブ領域へ配置し、常に無枠・名札なし（effectiveBorderless()）で描くことを縛る。
// region 値は computeSplitLayoutRegions(800,450).text（{x:400,y:0,width:400,height:450}）を
// splitTextRegionForDualWindow したもの（novelLayout.test.ts NL-1 と同じ値）。
// =====================================================================================
describe('DialogBox 話者別2窓モード dualWindowRegions (#444)', () => {
  const W = 800
  const H = 450
  const opponent: LayoutRect = { x: 400, y: 0, width: 400, height: 225 }
  const self_: LayoutRect = { x: 400, y: 225, width: 400, height: 225 }

  interface DualWindowInternals {
    bg: { visible: boolean }
    nameBox: { visible: boolean }
    nameText: { visible: boolean }
    boxX: number
    boxW: number
    boxY: number
    boxH: number
  }
  function dwInternals(box: DialogBox): DualWindowInternals {
    return box as unknown as DualWindowInternals
  }

  function makeBox(): DialogBox {
    return new DialogBox({
      screenWidth: W,
      screenHeight: H,
      boxHeight: 180,
      marginX: 20,
      marginBottom: 20,
      padding: 20,
      fontSize: 40,
    })
  }

  // applyDualWindowBoxGeometry と同形の参照オラクル（NOVEL_TEXT_* 定数から算出・直書きしない）。
  // 2窓モードは常に無枠・名札なしなので、setSplitLayoutRegion と違い nameBoxClearance は加えない。
  function expectedDualGeometry(r: LayoutRect) {
    const topMargin = Math.round(r.height * NOVEL_TEXT_TOP_RATIO)
    return {
      boxX: r.x + NOVEL_TEXT_MARGIN_X,
      boxW: r.width - NOVEL_TEXT_MARGIN_X * 2,
      boxY: r.y + topMargin,
      boxH: r.height - topMargin - NOVEL_TEXT_MARGIN_BOTTOM,
    }
  }

  it('DB-1: setDualWindowRegions 設定後、既定ロール self で box が self 領域に配置される', () => {
    const box = makeBox()
    box.setDualWindowRegions({ opponent, self: self_ })
    const i = dwInternals(box)
    const exp = expectedDualGeometry(self_)
    expect(i.boxX).toBe(exp.boxX)
    expect(i.boxY).toBe(exp.boxY)
    expect(i.boxW).toBe(exp.boxW)
    expect(i.boxH).toBe(exp.boxH)
    box.dispose()
  })

  it('DB-2: setDualWindowActiveRole(opponent) で box が opponent 領域に再配置される', () => {
    const box = makeBox()
    box.setDualWindowRegions({ opponent, self: self_ })
    box.setDualWindowActiveRole('opponent')
    const i = dwInternals(box)
    const exp = expectedDualGeometry(opponent)
    expect(i.boxX).toBe(exp.boxX)
    expect(i.boxY).toBe(exp.boxY)
    expect(i.boxW).toBe(exp.boxW)
    expect(i.boxH).toBe(exp.boxH)
    box.dispose()
  })

  it('DB-3: 冪等性 — 同一ロールを連続 setDualWindowActiveRole しても座標が変化しない', () => {
    const box = makeBox()
    box.setDualWindowRegions({ opponent, self: self_ })
    box.setDualWindowActiveRole('opponent')
    const first = { ...dwInternals(box) }
    box.setDualWindowActiveRole('opponent')
    const second = dwInternals(box)
    expect(second.boxX).toBe(first.boxX)
    expect(second.boxY).toBe(first.boxY)
    expect(second.boxW).toBe(first.boxW)
    expect(second.boxH).toBe(first.boxH)
    box.dispose()
  })

  it('DB-4: self→opponent→self と往復しても座標がドリフトしない', () => {
    const box = makeBox()
    box.setDualWindowRegions({ opponent, self: self_ })
    const selfExp = expectedDualGeometry(self_)

    box.setDualWindowActiveRole('opponent')
    box.setDualWindowActiveRole('self')
    const i = dwInternals(box)
    expect(i.boxX).toBe(selfExp.boxX)
    expect(i.boxY).toBe(selfExp.boxY)
    expect(i.boxW).toBe(selfExp.boxW)
    expect(i.boxH).toBe(selfExp.boxH)
    box.dispose()
  })

  it('DB-6: setDualWindowRegions(null) で従来ジオメトリ（adv 下部バー）に復帰する', () => {
    const box = makeBox()
    const advGeomBefore = { ...dwInternals(box) }
    box.setDualWindowRegions({ opponent, self: self_ })
    box.setDualWindowRegions(null)
    const i = dwInternals(box)
    expect(i.boxX).toBe(advGeomBefore.boxX)
    expect(i.boxY).toBe(advGeomBefore.boxY)
    expect(i.boxW).toBe(advGeomBefore.boxW)
    expect(i.boxH).toBe(advGeomBefore.boxH)
    box.dispose()
  })

  it('DB-8: dualWindowRegions 未設定のまま setDualWindowActiveRole を呼んでも no-op（例外なし・座標不変）', () => {
    const box = makeBox()
    const before = { ...dwInternals(box) }
    expect(() => box.setDualWindowActiveRole('opponent')).not.toThrow()
    const i = dwInternals(box)
    expect(i.boxX).toBe(before.boxX)
    expect(i.boxY).toBe(before.boxY)
    expect(i.boxW).toBe(before.boxW)
    expect(i.boxH).toBe(before.boxH)
    box.dispose()
  })

  // 見た目: 2窓モードは dialog_style（adv/novel）に関わらず常に無枠・名札なしで描く（Issue #444 確定仕様）。
  // adv（novelMode=false, borderless=false 既定）で検証することで「adv 本来は枠・名札ありのはずが
  // 強制的に消える」ことを示す。名前ありでも安全（effectiveBorderless()===true で
  // updateNameDisplay が drawNameBox/measureText に到達する前に早期 return するため）。
  it('DB-9: setDualWindowRegions 設定後、adv(novelMode=false, borderless=false既定) でも bg.visible===false（強制無枠）', () => {
    const box = makeBox()
    box.setDualWindowRegions({ opponent, self: self_ })
    box.setDialog(null, 'セリフ。')
    expect(box.isNovelMode).toBe(false)
    expect(dwInternals(box).bg.visible).toBe(false)
    box.dispose()
  })

  it('DB-10: 同条件で nameBox.visible / nameText.visible も強制的に非表示になる（話者名指定時も含む）', () => {
    const box = makeBox()
    box.setDualWindowRegions({ opponent, self: self_ })
    box.setDialog('せお', 'セリフ。')
    const i = dwInternals(box)
    expect(i.nameBox.visible).toBe(false)
    expect(i.nameText.visible).toBe(false)
    box.dispose()
  })

  it('DB-11: 台詞表示中に動的2窓化 — setDialog で nameBox.visible=true にしてから setDualWindowRegions を呼ぶと、次の setDialog を待たず即座に nameBox.visible/nameText.visible が false になる（self-review S2 回帰pin）', () => {
    const box = makeBox()
    // jsdom は canvas 2d ctx が null で nameText.width の実測ができず、非2窓状態での素の
    // setDialog(name, ...) は例外を投げる（#442 self-review must-1 の stubNameTextWidth と同じ手当て）。
    const nameTextTarget = (box as unknown as { nameText: { width: number } }).nameText
    Object.defineProperty(nameTextTarget, 'width', { get: () => 80, configurable: true })

    box.setDialog('せお', 'セリフ。')
    const before = dwInternals(box)
    expect(before.nameBox.visible).toBe(true)
    expect(before.nameText.visible).toBe(true)

    box.setDualWindowRegions({ opponent, self: self_ })
    const i = dwInternals(box)
    expect(i.nameBox.visible).toBe(false)
    expect(i.nameText.visible).toBe(false)
    box.dispose()
  })

  it('DB-12: 解除時の復帰 — setDualWindowRegions(null) 後、adv 本来の borderless(=false) に戻り bg.visible===true', () => {
    const box = makeBox()
    box.setDualWindowRegions({ opponent, self: self_ })
    box.setDualWindowRegions(null)
    box.setDialog(null, 'セリフ。')
    expect(dwInternals(box).bg.visible).toBe(true)
    box.dispose()
  })
})

describe('DialogBox setFontSize (#283 補遺 per-game font_size)', () => {
  const W = 800
  const H = 600

  // private fontSize / boxH を観測するための内部アクセサ。
  interface FontInternals {
    fontSize: number
    boxH: number
  }
  function fontInternals(box: DialogBox): FontInternals {
    return box as unknown as FontInternals
  }

  // novelMaxLinesPerPage の参照オラクル（lineHeight = fontSize * 1.6・実装と同形）。
  function expectedMaxLines(boxH: number, fontSize: number, padding: number) {
    const usable = boxH - padding * 2
    return Math.max(1, Math.floor(usable / (fontSize * 1.6)))
  }

  // fontSize を省略したデフォルト箱（既定 40 を確認するため明示指定しない）。
  function makeDefaultBox(): DialogBox {
    return new DialogBox({
      screenWidth: W,
      screenHeight: H,
      padding: 20,
    })
  }

  // 22: コンストラクタ既定 fontSize は 40（全ゲーム共通の DialogBox 既定が 40 に戻っていること）。
  //     #283 で一時 26 に変えた退行を per-game font_size に切り出して 40 へ復元したことの回帰防止。
  it('22: デフォルト fontSize は 40（per-game font_size 未指定時の runtime 既定）', () => {
    const box = makeDefaultBox()
    expect(fontInternals(box).fontSize).toBe(40)
    box.dispose()
  })

  // 23: setFontSize で fontSize が変わる。
  it('23: setFontSize で fontSize が更新される', () => {
    const box = makeDefaultBox()
    box.setFontSize(26)
    expect(fontInternals(box).fontSize).toBe(26)
    box.dispose()
  })

  // 24: 同値ガード — 既定 40 のまま 40 を渡しても何も壊れない（fontSize は 40 のまま）。
  it('24: 同値 setFontSize は no-op（fontSize 不変）', () => {
    const box = makeDefaultBox()
    box.setFontSize(40)
    expect(fontInternals(box).fontSize).toBe(40)
    box.dispose()
  })

  // 25: 0 / 負値は Math.max(1, ...) で 1 に丸められる（fontSize 0 で潰れるのを防ぐ防御）。
  it('25: 0 / 負値の setFontSize は 1 に丸められる', () => {
    const box = makeDefaultBox()
    box.setFontSize(0)
    expect(fontInternals(box).fontSize).toBe(1)
    box.setFontSize(-10)
    expect(fontInternals(box).fontSize).toBe(1)
    box.dispose()
  })

  // 26: setFontSize は novel 改頁の行高に効く — 小さくすると 1 ページに収まる行数が増える。
  //     novelMaxLinesPerPage = floor((boxH - pad*2) / (fontSize*1.6)) の単調性を確認。
  it('26: novel モードで fontSize を小さくすると 1 ページの最大行数が増える', () => {
    const box = makeDefaultBox()
    box.setNovelMode(true)
    box.setFontSize(40)
    const boxH = fontInternals(box).boxH
    const linesLarge = box.novelMaxLinesPerPage()
    expect(linesLarge).toBe(expectedMaxLines(boxH, 40, 20))
    box.setFontSize(20)
    const linesSmall = box.novelMaxLinesPerPage()
    expect(linesSmall).toBe(expectedMaxLines(boxH, 20, 20))
    expect(linesSmall).toBeGreaterThan(linesLarge)
    box.dispose()
  })

  // 27: 表示中テキストがあっても setFontSize でクラッシュしない（再 wordwrap・再レイアウトが走る）。
  //     msPerChar=0（即時表示）でテキストが残っていることを観測する。
  it('27: 表示中テキストありで setFontSize しても再レイアウトしてクラッシュしない', () => {
    const box = new DialogBox({
      screenWidth: W,
      screenHeight: H,
      padding: 20,
      msPerChar: 0,
    })
    box.setDialog(null, 'これは本文テキストです。')
    expect(() => box.setFontSize(26)).not.toThrow()
    expect(fontInternals(box).fontSize).toBe(26)
    box.dispose()
  })
})

describe('DialogBox setFontFamily インライン名追従 (#287 review nit)', () => {
  // setFontSize は inlineNameText を作り直すのに setFontFamily が漏らしていた非対称の回帰防止。
  // nameSeparateBox=false（インライン名モード）で per-game フォントを変えると、インライン名も追従する。
  it('setFontFamily が inlineNameText のフォントも更新する（nameSeparateBox=false）', () => {
    const box = new DialogBox({
      screenWidth: 800,
      screenHeight: 600,
      nameSeparateBox: false,
    })
    const internals = box as unknown as {
      inlineNameText: { style: { fontFamily: string | string[] } } | null
    }
    expect(internals.inlineNameText).not.toBeNull()
    box.setFontFamily("'Hina Mincho', serif")
    const fam = internals.inlineNameText!.style.fontFamily
    const famStr = Array.isArray(fam) ? fam.join(',') : String(fam)
    expect(famStr).toContain('Hina Mincho')
    box.dispose()
  })
})

// ===== #305: 本文テキスト色（setBodyTextColor） =====
//
// NovelRenderer が話者から導出した本文色（主人公=やや暖かいアイボリー #FFF0D8 / 住人=白）を DialogBox に
// 渡す受け渡し経路の検証。dialogText.style.fill に反映され、表示中ルビにも当たることを確認する。
describe('DialogBox setBodyTextColor (#305)', () => {
  it('既定の本文色は純白 0xffffff', () => {
    const box = makeRpgBox()
    expect(box.getBodyTextColor()).toBe(0xffffff)
    box.dispose()
  })

  it('setBodyTextColor(#FFF0D8 相当の数値) で dialogText.style.fill が更新される', () => {
    const box = makeRpgBox()
    box.setBodyTextColor(0xfff0d8)
    expect(box.getBodyTextColor()).toBe(0xfff0d8)
    expect(asInternals(box).dialogText.style.fill).toBe(0xfff0d8)
    box.dispose()
  })

  it('住人色（純白）に戻せる', () => {
    const box = makeRpgBox()
    box.setBodyTextColor(0xfff0d8)
    box.setBodyTextColor(0xffffff)
    expect(box.getBodyTextColor()).toBe(0xffffff)
    expect(asInternals(box).dialogText.style.fill).toBe(0xffffff)
    box.dispose()
  })

  // DB-14 (#444): 2窓モードの相手側本文色 0x9ad4e8（水色）も、既存の setBodyTextColor 配線
  // （getBodyTextColor / dialogText.style.fill）にそのまま乗ることを確認する。
  it('setBodyTextColor(0x9ad4e8 相当・#444 2窓モード相手側色) でも getBodyTextColor/dialogText.style.fill が更新される', () => {
    const box = makeRpgBox()
    box.setBodyTextColor(0x9ad4e8)
    expect(box.getBodyTextColor()).toBe(0x9ad4e8)
    expect(asInternals(box).dialogText.style.fill).toBe(0x9ad4e8)
    box.dispose()
  })

  it('同じ色の再設定は no-op（getBodyTextColor は維持）', () => {
    const box = makeRpgBox()
    box.setBodyTextColor(0xfff0d8)
    box.setBodyTextColor(0xfff0d8)
    expect(box.getBodyTextColor()).toBe(0xfff0d8)
    box.dispose()
  })

  it('表示中ルビにも本文色が当たる（本文色変更後の rubyEntries.style.fill）', async () => {
    const box = makeRpgBox()
    box.setDialog(null, '漢字《かんじ》のルビ')
    // ルビは ensureFontLoaded().then() で構築されるため microtask を flush してから色を当てる。
    await Promise.resolve()
    await Promise.resolve()
    box.setBodyTextColor(0xfff0d8)
    const ruby = asInternals(box).rubyEntries
    expect(ruby.length).toBeGreaterThan(0)
    for (const e of ruby) {
      expect(e.text.style.fill).toBe(0xfff0d8)
    }
    box.dispose()
  })
})

// ===== #304 follow-up: setOnTypingDone の実体直接テスト =====
//
// 前 PR #304 のレビューで、setOnTypingDone は NovelRenderer 側でモック駆動されるだけで実体に
// 直接の単体テストが無いと指摘された。ここで分岐を直接踏む:
//  (a) !isTyping()（完了済み/空）で setOnTypingDone(cb) → 即 cb 1 回・slot は null。
//  (b) タイプ中に setOnTypingDone(cb) → 即時呼ばれず slot に保持。
//  (c) setOnTypingDone(null) で解除。
describe('DialogBox setOnTypingDone (#304 follow-up)', () => {
  it('(a) タイプ完了済み（skip 後）に setOnTypingDone(cb) すると即座に cb が1回呼ばれ slot は null', () => {
    const box = makeRpgBox()
    box.show('長老', 'こんにちは。')
    box.skipTypewriter() // タイプ完了 → isTyping=false
    expect(box.isTyping()).toBe(false)
    const cb = vi.fn()
    box.setOnTypingDone(cb)
    expect(cb).toHaveBeenCalledTimes(1)
    expect(asInternals(box).onTypingDone).toBeNull()
    box.dispose()
  })

  it('(a) 空ダイアログ（一度も show せず isTyping=false）でも setOnTypingDone(cb) は即時 1 回呼ぶ', () => {
    const box = makeRpgBox()
    // 一度も show していない初期状態 = makeInitialTypewriterState → isTyping=false。
    expect(box.isTyping()).toBe(false)
    const cb = vi.fn()
    box.setOnTypingDone(cb)
    expect(cb).toHaveBeenCalledTimes(1)
    expect(asInternals(box).onTypingDone).toBeNull()
    box.dispose()
  })

  it('(b) タイプ中に setOnTypingDone(cb) すると即時呼ばれず slot に保持される', () => {
    const box = makeRpgBox()
    box.show('長老', 'まだタイプ中の長いセリフ。')
    expect(box.isTyping()).toBe(true)
    const cb = vi.fn()
    box.setOnTypingDone(cb)
    expect(cb).not.toHaveBeenCalled()
    expect(asInternals(box).onTypingDone).toBe(cb)
    box.dispose()
  })

  it('(b→a) タイプ中に保持した cb は skip 完了の justFinished では発火しない（直接代入はラッチ消費せず slot は維持）', () => {
    // 仕様の境界確認: skipTypewriter は onTypingDone を null にする（auto OFF 中の誤進行防止）。
    // つまり「タイプ中に張った cb」は skip 経路では呼ばれず解除される。ticker の justFinished
    // 経路だけが消費するため、ここでは skip 後に cb 未発火・slot null を確認する。
    const box = makeRpgBox()
    box.show('長老', 'まだタイプ中の長いセリフ。')
    const cb = vi.fn()
    box.setOnTypingDone(cb)
    box.skipTypewriter()
    expect(cb).not.toHaveBeenCalled()
    expect(asInternals(box).onTypingDone).toBeNull()
    box.dispose()
  })

  it('(c) setOnTypingDone(null) で slot を解除できる（タイプ中の保持を取り消す）', () => {
    const box = makeRpgBox()
    box.show('長老', 'まだタイプ中の長いセリフ。')
    const cb = vi.fn()
    box.setOnTypingDone(cb)
    expect(asInternals(box).onTypingDone).toBe(cb)
    box.setOnTypingDone(null)
    expect(asInternals(box).onTypingDone).toBeNull()
    expect(cb).not.toHaveBeenCalled()
    box.dispose()
  })

  it('(c) 完了済みでも setOnTypingDone(null) は即時発火しない（null は cb でないため）', () => {
    const box = makeRpgBox()
    box.show('長老', 'こんにちは。')
    box.skipTypewriter()
    // null を渡すと「!isTyping かつ cb」の即時分岐に入らず、slot を null にするだけ。
    box.setOnTypingDone(null)
    expect(asInternals(box).onTypingDone).toBeNull()
    box.dispose()
  })
})

// =====================================================================================
// #447: 2窓インジケータの静止化・話者色・文末配置。テスト設計フェーズの観点表より。
// region 値は #444 ブロックと同じ computeSplitLayoutRegions(800,450).text
// （{x:400,y:0,width:400,height:450}）を splitTextRegionForDualWindow したもの。
// =====================================================================================

describe('DialogBox 2窓インジケータの静止化 tickIndicatorMotion (#447)', () => {
  const W = 800
  const H = 450
  const opponent: LayoutRect = { x: 400, y: 0, width: 400, height: 225 }
  const self_: LayoutRect = { x: 400, y: 225, width: 400, height: 225 }

  interface MotionInternals {
    indicator: { x: number; y: number }
    indicatorBaseY: number
    tickIndicatorMotion(deltaMs: number): void
  }
  function mi(box: DialogBox): MotionInternals {
    return box as unknown as MotionInternals
  }

  function makeBox(): DialogBox {
    return new DialogBox({
      screenWidth: W,
      screenHeight: H,
      boxHeight: 180,
      marginX: 20,
      marginBottom: 20,
      padding: 20,
      fontSize: 40,
    })
  }

  it('A-1: setDualWindowRegions(regions) 後、tickIndicatorMotion を複数回叩いても indicator.y === indicatorBaseY のまま変化しない', () => {
    const box = makeBox()
    box.setDualWindowRegions({ opponent, self: self_ })
    const i = mi(box)
    for (let n = 0; n < 5; n++) {
      i.tickIndicatorMotion(16)
      expect(i.indicator.y).toBe(i.indicatorBaseY)
    }
    box.dispose()
  })

  it('A-2: 非2窓では従来通りバウンスする（非回帰）', () => {
    const box = makeBox()
    const i = mi(box)
    i.tickIndicatorMotion(100)
    expect(i.indicator.y).not.toBe(i.indicatorBaseY)
    box.dispose()
  })

  it('A-3: setDualWindowRegions(regions)→静止確認→setDualWindowRegions(null)→バウンス再開（解除の回帰）', () => {
    const box = makeBox()
    box.setDualWindowRegions({ opponent, self: self_ })
    const i = mi(box)
    i.tickIndicatorMotion(16)
    expect(i.indicator.y).toBe(i.indicatorBaseY)

    box.setDualWindowRegions(null)
    i.tickIndicatorMotion(100)
    expect(i.indicator.y).not.toBe(i.indicatorBaseY)
    box.dispose()
  })
})

describe('DialogBox 2窓インジケータの話者色 indicatorGlyphColor (#447)', () => {
  const W = 800
  const H = 450
  const opponent: LayoutRect = { x: 400, y: 0, width: 400, height: 225 }
  const self_: LayoutRect = { x: 400, y: 225, width: 400, height: 225 }

  interface ColorInternals {
    indicatorGlyph: { style: { fill: unknown } }
  }
  function ci(box: DialogBox): ColorInternals {
    return box as unknown as ColorInternals
  }

  function makeBox(): DialogBox {
    return new DialogBox({
      screenWidth: W,
      screenHeight: H,
      boxHeight: 180,
      marginX: 20,
      marginBottom: 20,
      padding: 20,
      fontSize: 40,
    })
  }

  it('B-1: 既定ロール self のまま setDualWindowRegions(regions) → indicatorGlyph.style.fill === 0xffffff', () => {
    const box = makeBox()
    box.setDualWindowRegions({ opponent, self: self_ })
    expect(ci(box).indicatorGlyph.style.fill).toBe(0xffffff)
    box.dispose()
  })

  it("B-2: setDualWindowActiveRole('opponent') → indicatorGlyph.style.fill === 0x9ad4e8", () => {
    const box = makeBox()
    box.setDualWindowRegions({ opponent, self: self_ })
    box.setDualWindowActiveRole('opponent')
    expect(ci(box).indicatorGlyph.style.fill).toBe(0x9ad4e8)
    box.dispose()
  })

  it('B-3: setDualWindowRegions(null) → 既定色 0xa8dadc に復帰する', () => {
    const box = makeBox()
    box.setDualWindowRegions({ opponent, self: self_ })
    box.setDualWindowActiveRole('opponent')
    box.setDualWindowRegions(null)
    expect(ci(box).indicatorGlyph.style.fill).toBe(0xa8dadc)
    box.dispose()
  })

  it('B-4: self→opponent→self 往復で色がドリフトしない', () => {
    const box = makeBox()
    box.setDualWindowRegions({ opponent, self: self_ })
    box.setDualWindowActiveRole('opponent')
    box.setDualWindowActiveRole('self')
    expect(ci(box).indicatorGlyph.style.fill).toBe(0xffffff)
    box.dispose()
  })

  it('B-7: setFontFamily(別フォント) 前後で色が保持される（fontFamily 早期 return を踏まないよう既定と異なる family を渡す）', () => {
    const box = makeBox()
    box.setDualWindowRegions({ opponent, self: self_ })
    box.setDualWindowActiveRole('opponent')
    box.setFontFamily('serif')
    expect(ci(box).indicatorGlyph.style.fill).toBe(0x9ad4e8)
    box.dispose()
  })

  it("B-8: dualWindowRegions 未設定のまま setDualWindowActiveRole('opponent') を呼んでも例外なし・色は既定のまま", () => {
    const box = makeBox()
    expect(() => box.setDualWindowActiveRole('opponent')).not.toThrow()
    expect(ci(box).indicatorGlyph.style.fill).toBe(0xa8dadc)
    box.dispose()
  })
})

// C: positionIndicator の非novel経路。#447 で 2窓 adv だけ文末追従にしたが、kako-jun の
// 実機確認「adv なんだしカーソルは右下固定だと思っていた」を受け #450 で右下固定へ戻した。
// さらに #452 で「もうちょっと上でいい」を受けオフセットを -30 から -45 へ変更。
// 2窓の有無に関わらず adv は常に boxY+boxH-45 固定になることを縛る。
describe('DialogBox 2窓インジケータの位置 positionIndicator 非novel (#450 右下固定へ復帰)', () => {
  const W = 800
  const H = 450
  const opponent: LayoutRect = { x: 400, y: 0, width: 400, height: 225 }
  const self_: LayoutRect = { x: 400, y: 225, width: 400, height: 225 }

  interface PositionInternals {
    indicator: { x: number; y: number }
    boxX: number
    boxY: number
    boxW: number
    boxH: number
  }
  function pi(box: DialogBox): PositionInternals {
    return box as unknown as PositionInternals
  }

  function makeBox(): DialogBox {
    return new DialogBox({
      screenWidth: W,
      screenHeight: H,
      boxHeight: 180,
      marginX: 20,
      marginBottom: 20,
      padding: 20,
      fontSize: 40,
    })
  }

  it('C-1: 非novel + setDualWindowRegions(regions) 後、setDialog+skipTypewriter でも文末追従にならず indicator.y === boxY+boxH-45（#452 でオフセット調整）', () => {
    const box = makeBox()
    box.setDualWindowRegions({ opponent, self: self_ })
    box.setDialog(null, 'テスト用のセリフです。')
    box.skipTypewriter()
    const i = pi(box)
    expect(i.indicator.y).toBe(i.boxY + i.boxH - 45)
    box.dispose()
  })

  it('C-2: 非novel + 2窓未設定のまま setDialog+skipTypewriter → 従来通り indicator.y === boxY+boxH-45（非回帰）', () => {
    const box = makeBox()
    box.setDialog(null, 'テスト用のセリフです。')
    box.skipTypewriter()
    const i = pi(box)
    expect(i.indicator.y).toBe(i.boxY + i.boxH - 45)
    box.dispose()
  })
})

// D: Part 1（redraw() 巻き戻りバグ）の回帰テスト。setDualWindowActiveRole() は非novelのとき
// redraw() を呼ぶため、修正前は末尾の旧式直書きが positionIndicator() の結果を上書きしていた。
// #450 で positionIndicator() の非novel経路自体が固定式に戻ったため、redraw() 経由の値と
// positionIndicator() 直接呼び出しの値を比較するだけでは boxX/boxY/boxW/boxH が不変な限り
// 常に一致してしまい（同じ固定式を読むだけ）、「redraw() が旧式を独自に直書きしていない」の
// 確認として弱い（positionIndicator() が一度も呼ばれず indicatorBaseY が直前のロールのまま
// stale で残るケースしか検出できない）。そこで vi.spyOn で positionIndicator() 自体に
// スパイを立て、redraw() および setDualWindowActiveRole() の内部から実際に positionIndicator()
// が呼ばれていることを直接縛る（値の一致ではなく呼び出しの有無を検証する、より強い回帰pin）。
describe('DialogBox redraw() のインジケータ位置巻き戻り回帰テスト (#447 Part 1 / #450)', () => {
  const W = 800
  const H = 450
  const opponent: LayoutRect = { x: 400, y: 0, width: 400, height: 225 }
  const self_: LayoutRect = { x: 400, y: 225, width: 400, height: 225 }

  interface RedrawInternals {
    indicatorBaseY: number
    boxX: number
    boxY: number
    boxW: number
    boxH: number
    positionIndicator(): void
  }
  function ri(box: DialogBox): RedrawInternals {
    return box as unknown as RedrawInternals
  }

  function makeBox(): DialogBox {
    return new DialogBox({
      screenWidth: W,
      screenHeight: H,
      boxHeight: 180,
      marginX: 20,
      marginBottom: 20,
      padding: 20,
      fontSize: 40,
    })
  }

  it("D-1: ADV+2窓で redraw() と setDualWindowActiveRole('opponent') が実際に positionIndicator() を呼ぶ（redraw() が旧式を独自に直書きしていない回帰確認）", () => {
    const box = makeBox()
    box.setDualWindowRegions({ opponent, self: self_ })
    box.setDialog(null, 'テスト用のセリフです。')
    box.skipTypewriter()
    const i = ri(box)

    const spy = vi.spyOn(i, 'positionIndicator')

    // setDualWindowActiveRole() は非novelのとき内部で redraw() を呼ぶ経路。
    spy.mockClear()
    box.setDualWindowActiveRole('opponent')
    expect(spy).toHaveBeenCalled()

    // redraw() 単体でも positionIndicator() を呼ぶことを別途縛る（直書きへの巻き戻り検出）。
    spy.mockClear()
    box.redraw(W, H)
    expect(spy).toHaveBeenCalled()

    spy.mockRestore()
    // #450 / #452: 実値そのものも右下固定式（boxY+boxH-45）であることを併せて確認する。
    expect(i.indicatorBaseY).toBe(i.boxY + i.boxH - 45)
    box.dispose()
  })
})

// E: 2窓モードの▼機械的点滅（#447 追加要望1）。Y座標の静止（A ブロック）とは独立の軸で、
// indicatorGlyph.visible を 1 秒間隔（INDICATOR_BLINK_MS）で ON/OFF する。
describe('DialogBox 2窓インジケータの機械的点滅 tickIndicatorBlink (#447 追加要望1)', () => {
  const W = 800
  const H = 450
  const opponent: LayoutRect = { x: 400, y: 0, width: 400, height: 225 }
  const self_: LayoutRect = { x: 400, y: 225, width: 400, height: 225 }

  interface BlinkInternals {
    indicator: { visible: boolean }
    indicatorGlyph: { visible: boolean }
    tickIndicatorBlink(deltaMs: number): void
    indicatorFrameTextures: Partial<Record<IndicatorKind, unknown[]>>
    indicatorKind: IndicatorKind
  }
  function bi(box: DialogBox): BlinkInternals {
    return box as unknown as BlinkInternals
  }

  function makeBox(): DialogBox {
    return new DialogBox({
      screenWidth: W,
      screenHeight: H,
      boxHeight: 180,
      marginX: 20,
      marginBottom: 20,
      padding: 20,
      fontSize: 40,
    })
  }

  it('E-1: 2窓モードで計1000ms分 tickIndicatorBlink を進めると indicatorGlyph.visible が false へトグルされる', () => {
    const box = makeBox()
    box.setDualWindowRegions({ opponent, self: self_ })
    const i = bi(box)
    expect(i.indicatorGlyph.visible).toBe(true)
    i.tickIndicatorBlink(1000)
    expect(i.indicatorGlyph.visible).toBe(false)
    box.dispose()
  })

  it('E-2: 計2000ms経過すると indicatorGlyph.visible が true に戻る（周期性の確認）', () => {
    const box = makeBox()
    box.setDualWindowRegions({ opponent, self: self_ })
    const i = bi(box)
    i.tickIndicatorBlink(1000)
    expect(i.indicatorGlyph.visible).toBe(false)
    i.tickIndicatorBlink(1000)
    expect(i.indicatorGlyph.visible).toBe(true)
    box.dispose()
  })

  it('E-3: 非2窓モードでは何度 tickIndicatorBlink を進めても indicatorGlyph.visible は変化しない（既存の sin バウンスのみ）', () => {
    const box = makeBox()
    const i = bi(box)
    expect(i.indicatorGlyph.visible).toBe(true)
    i.tickIndicatorBlink(1000)
    i.tickIndicatorBlink(1000)
    i.tickIndicatorBlink(2500)
    expect(i.indicatorGlyph.visible).toBe(true)
    box.dispose()
  })

  it('E-4: 2窓モードでも画像フレームが揃っている場合は点滅しない（indicatorGlyph.visible に触れない）', () => {
    const box = makeBox()
    box.setDualWindowRegions({ opponent, self: self_ })
    const i = bi(box)
    i.indicatorFrameTextures[i.indicatorKind] = [{}]
    // 点滅ロジックが本当に触れていないことを示すため、あえて true のまま据え置いて確認する。
    i.indicatorGlyph.visible = true
    i.tickIndicatorBlink(1000)
    i.tickIndicatorBlink(1000)
    expect(i.indicatorGlyph.visible).toBe(true)
    box.dispose()
  })

  it('E-5: setDualWindowRegions(null) で点滅が止まり indicatorGlyph.visible が true に戻る', () => {
    const box = makeBox()
    box.setDualWindowRegions({ opponent, self: self_ })
    const i = bi(box)
    i.tickIndicatorBlink(1000)
    expect(i.indicatorGlyph.visible).toBe(false)

    box.setDualWindowRegions(null)
    expect(i.indicatorGlyph.visible).toBe(true)

    // 解除後は2窓でなくなっているため、以後 tickIndicatorBlink を進めても再点滅しない。
    i.tickIndicatorBlink(1000)
    i.tickIndicatorBlink(1000)
    expect(i.indicatorGlyph.visible).toBe(true)
    box.dispose()
  })

  // E-6〜E-8: self-review must「点滅の位相が実際に見える瞬間にリセットされない」の回帰テスト。
  // tickIndicatorBlink はタイプ表示中（indicator 自体が非表示）も無条件に呼ばれ続けるため、
  // indicatorBlinkElapsed が壁時計時間で積み上がる。タイプ完了→ indicator が実際に表示される
  // 瞬間（setDialog+skipTypewriter+setIndicatorVisible(true) で再現）に、蓄積済みの位相を
  // 無視して必ず ON から点滅を開始することを確認する。
  it('E-6: タイプ中に位相が OFF 側へずれていても、タイプ完了→インジケータ表示の瞬間は indicatorGlyph.visible が true にリセットされる', () => {
    const box = makeBox()
    box.setDualWindowRegions({ opponent, self: self_ })
    const i = bi(box)

    // タイプ表示中に壁時計時間が経過し、位相が OFF 側へずれていた状態を再現する
    // （この時点では indicator コンテナ自体は非表示なので、実プレイでは見えない）。
    i.tickIndicatorBlink(1200)
    expect(i.indicatorGlyph.visible).toBe(false)

    // タイプ完了 → インジケータ表示。setDialog が indicator.visible を明示的に false へ戻し、
    // skipTypewriter でタイプ完了、setIndicatorVisible(true) が「非表示→表示」の遷移点になる。
    box.setDialog(null, 'テスト用のセリフです。')
    box.skipTypewriter()
    box.setIndicatorVisible(true)

    expect(i.indicator.visible).toBe(true)
    // 壁時計上の位相（OFF 側）に関わらず、表示開始時は必ず ON から始まる（位相リセットの確認）。
    expect(i.indicatorGlyph.visible).toBe(true)
    box.dispose()
  })

  it('E-7: リセット後も 1000ms 経過で false になる（周期は保たれる）', () => {
    const box = makeBox()
    box.setDualWindowRegions({ opponent, self: self_ })
    const i = bi(box)

    i.tickIndicatorBlink(1200)
    box.setDialog(null, 'テスト用のセリフです。')
    box.skipTypewriter()
    box.setIndicatorVisible(true)
    expect(i.indicatorGlyph.visible).toBe(true)

    i.tickIndicatorBlink(1000)
    expect(i.indicatorGlyph.visible).toBe(false)
    box.dispose()
  })

  it('E-8: リセット後さらに 1000ms 経過で true に戻る（周期は保たれる）', () => {
    const box = makeBox()
    box.setDualWindowRegions({ opponent, self: self_ })
    const i = bi(box)

    i.tickIndicatorBlink(1200)
    box.setDialog(null, 'テスト用のセリフです。')
    box.skipTypewriter()
    box.setIndicatorVisible(true)

    i.tickIndicatorBlink(1000)
    expect(i.indicatorGlyph.visible).toBe(false)
    i.tickIndicatorBlink(1000)
    expect(i.indicatorGlyph.visible).toBe(true)
    box.dispose()
  })
})

// F: ▼グリフの縦方向スケール（#447 追加要望2）。2窓モード限定ではなく全ゲーム共通・常時適用。
describe('DialogBox ▼グリフの縦スケール (#447 追加要望2)', () => {
  interface ScaleInternals {
    indicatorGlyph: { scale: { y: number } }
  }
  function si(box: DialogBox): ScaleInternals {
    return box as unknown as ScaleInternals
  }

  it('F-1: コンストラクタ直後、indicatorGlyph.scale.y が 1 未満に設定されている', () => {
    const box = makeRpgBox()
    expect(si(box).indicatorGlyph.scale.y).toBeLessThan(1)
    box.dispose()
  })

  it('F-2: setIndicatorKind で種別を切り替えて text/style を再設定した後も indicatorGlyph.scale.y が保持される', () => {
    const box = makeRpgBox()
    const before = si(box).indicatorGlyph.scale.y
    box.setIndicatorKind('pageturn')
    expect(si(box).indicatorGlyph.scale.y).toBe(before)
    expect(si(box).indicatorGlyph.scale.y).toBeLessThan(1)
    box.dispose()
  })
})
