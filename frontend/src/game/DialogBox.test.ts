/**
 * DialogBox の portrait 顔枠切替・typewriter・contain fit テスト。
 *
 * #194: RpgDialogBox を DialogBox に統合した後の動作確認。
 * 旧 RpgDialogBox.test.ts を DialogBox API に合わせて移行。
 */
import { describe, it, expect } from 'vitest'
import {
  DialogBox,
  PORTRAIT_SIZE,
  PORTRAIT_MARGIN,
  PORTRAIT_X,
  computePortraitContainFit,
} from './DialogBox'

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
