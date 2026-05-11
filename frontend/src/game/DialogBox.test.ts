/**
 * DialogBox の portrait 顔枠切替・typewriter・contain fit テスト。
 *
 * #194: RpgDialogBox を DialogBox に統合した後の動作確認。
 * 旧 RpgDialogBox.test.ts を DialogBox API に合わせて移行。
 *
 * #214: フォントロード非同期化（ensureFontLoaded + rubyBuildToken）のテスト。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

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
} from './DialogBox'
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
  dialogText: { x: number; text: string; visible: boolean }
  portraitSprite: { visible: boolean; texture: unknown } | null
  currentPortraitToken: number
  rubyEntries: Array<{ placement: unknown; text: unknown }>
  rubyBuildToken: number
}

function asInternals(box: DialogBox): DialogBoxInternals {
  return box as unknown as DialogBoxInternals
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
