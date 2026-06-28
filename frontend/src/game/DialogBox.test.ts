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
  NOVEL_TEXT_MARGIN_X,
  NOVEL_TEXT_TOP_RATIO,
  NOVEL_TEXT_MARGIN_BOTTOM,
  normalizeDashGlyphsForDisplay,
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
  dialogText: { x: number; text: string; visible: boolean; style: { fill: unknown } }
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

describe('DialogBox dash glyph display normalization (#315)', () => {
  it('表示用に下寄りのダッシュ・罫線系を中央線 glyph に寄せる', () => {
    expect(normalizeDashGlyphsForDisplay('あ——い−−うーーえ')).toBe('あ──い──う──え')
  })

  it('novel/borderless だけ本文表示のダッシュを中央線 glyph に寄せ、adv は原文のまま', () => {
    const novel = makeRpgBox()
    novel.setNovelMode(true)
    novel.setDialog(null, 'あ——い')
    novel.skipTypewriter()
    expect(asInternals(novel).dialogText.text).toBe('あ──い')
    novel.dispose()

    const adv = makeRpgBox()
    adv.setDialog(null, 'あ——い')
    adv.skipTypewriter()
    expect(asInternals(adv).dialogText.text).toBe('あ——い')
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
// NovelRenderer が話者から導出した本文色（主人公=暖アイボリー #FFF6E6 / 住人=白）を DialogBox に
// 渡す受け渡し経路の検証。dialogText.style.fill に反映され、表示中ルビにも当たることを確認する。
describe('DialogBox setBodyTextColor (#305)', () => {
  it('既定の本文色は純白 0xffffff', () => {
    const box = makeRpgBox()
    expect(box.getBodyTextColor()).toBe(0xffffff)
    box.dispose()
  })

  it('setBodyTextColor(#FFF6E6 相当の数値) で dialogText.style.fill が更新される', () => {
    const box = makeRpgBox()
    box.setBodyTextColor(0xfff6e6)
    expect(box.getBodyTextColor()).toBe(0xfff6e6)
    expect(asInternals(box).dialogText.style.fill).toBe(0xfff6e6)
    box.dispose()
  })

  it('住人色（純白）に戻せる', () => {
    const box = makeRpgBox()
    box.setBodyTextColor(0xfff6e6)
    box.setBodyTextColor(0xffffff)
    expect(box.getBodyTextColor()).toBe(0xffffff)
    expect(asInternals(box).dialogText.style.fill).toBe(0xffffff)
    box.dispose()
  })

  it('同じ色の再設定は no-op（getBodyTextColor は維持）', () => {
    const box = makeRpgBox()
    box.setBodyTextColor(0xfff6e6)
    box.setBodyTextColor(0xfff6e6)
    expect(box.getBodyTextColor()).toBe(0xfff6e6)
    box.dispose()
  })

  it('表示中ルビにも本文色が当たる（本文色変更後の rubyEntries.style.fill）', async () => {
    const box = makeRpgBox()
    box.setDialog(null, '漢字《かんじ》のルビ')
    // ルビは ensureFontLoaded().then() で構築されるため microtask を flush してから色を当てる。
    await Promise.resolve()
    await Promise.resolve()
    box.setBodyTextColor(0xfff6e6)
    const ruby = asInternals(box).rubyEntries
    expect(ruby.length).toBeGreaterThan(0)
    for (const e of ruby) {
      expect(e.text.style.fill).toBe(0xfff6e6)
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
