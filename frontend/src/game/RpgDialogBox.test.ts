/**
 * RpgDialogBox の portrait 顔枠切替のテスト。
 *
 * Issue #73 Phase 1:
 * - portrait なしで show → 顔枠（portraitFrame）が非表示
 * - portrait ありで show → 顔枠が表示され、テキスト開始 x が右にシフト
 * - hide → 顔枠も隠れる
 *
 * PIXI の Container/Graphics は jsdom 環境でもインスタンス化できるため、
 * 実際のレンダリング（WebGL）は行わずオブジェクト状態のみを検証する。
 */
import { describe, it, expect } from 'vitest'
import {
  RpgDialogBox,
  PORTRAIT_SIZE,
  PORTRAIT_MARGIN,
  PORTRAIT_X,
  TEXT_X_NO_PORTRAIT,
  TEXT_INNER_PADDING,
  SIDE_MARGIN,
} from './RpgDialogBox'

// private フィールドにアクセスするための型
interface RpgDialogBoxInternals {
  portraitFrame: { visible: boolean } | null
  nameText: { x: number } | null
  messageText: {
    x: number
    text: string
    visible: boolean
    style: { wordWrapWidth: number }
  } | null
  portraitSprite: { visible: boolean; texture: unknown } | null
  currentPortraitToken: number
}

function asInternals(box: RpgDialogBox): RpgDialogBoxInternals {
  return box as unknown as RpgDialogBoxInternals
}

// テストで使う計算ヘルパ（実装と同じ式）
const SCREEN_WIDTH = 800
const SCREEN_HEIGHT = 600
const BOX_WIDTH = SCREEN_WIDTH - SIDE_MARGIN * 2 // 760
const TEXT_X_WITH_PORTRAIT = PORTRAIT_X + PORTRAIT_SIZE + PORTRAIT_MARGIN // 140
const WORD_WRAP_WITH_PORTRAIT = BOX_WIDTH - (PORTRAIT_SIZE + PORTRAIT_MARGIN + PORTRAIT_X) // 620

describe('RpgDialogBox portrait (Issue #73 Phase 1)', () => {
  it('portrait 未指定で show すると顔枠は非表示', () => {
    const box = new RpgDialogBox(SCREEN_WIDTH, SCREEN_HEIGHT)
    box.show('長老', 'こんにちは')
    const i = asInternals(box)
    expect(i.portraitFrame).not.toBeNull()
    expect(i.portraitFrame!.visible).toBe(false)
    // テキストは従来位置（= TEXT_X_NO_PORTRAIT）
    expect(i.nameText!.x).toBe(TEXT_X_NO_PORTRAIT)
    expect(i.messageText!.x).toBe(TEXT_X_NO_PORTRAIT)
    // wordWrapWidth は boxWidth - TEXT_INNER_PADDING
    expect(i.messageText!.style.wordWrapWidth).toBe(BOX_WIDTH - TEXT_INNER_PADDING)
    box.destroy()
  })

  it('portrait 指定で show すると顔枠が表示され、テキストが右にシフト', () => {
    const box = new RpgDialogBox(SCREEN_WIDTH, SCREEN_HEIGHT)
    box.show('長老', 'こんにちは', 'elder_portrait.png')
    const i = asInternals(box)
    expect(i.portraitFrame!.visible).toBe(true)
    // 顔枠 (x=PORTRAIT_X, size=PORTRAIT_SIZE) + PORTRAIT_MARGIN = テキスト開始 x
    expect(i.nameText!.x).toBe(TEXT_X_WITH_PORTRAIT)
    expect(i.messageText!.x).toBe(TEXT_X_WITH_PORTRAIT)
    // wordWrapWidth = boxWidth - (PORTRAIT_SIZE + PORTRAIT_MARGIN + PORTRAIT_X)
    expect(i.messageText!.style.wordWrapWidth).toBe(WORD_WRAP_WITH_PORTRAIT)
    box.destroy()
  })

  it('portrait 空文字は未指定と同等扱い', () => {
    const box = new RpgDialogBox(SCREEN_WIDTH, SCREEN_HEIGHT)
    box.show('村人', 'やあ', '')
    const i = asInternals(box)
    expect(i.portraitFrame!.visible).toBe(false)
    expect(i.nameText!.x).toBe(TEXT_X_NO_PORTRAIT)
    box.destroy()
  })

  it('portrait あり → なしに切り替えるとテキスト位置が戻る', () => {
    const box = new RpgDialogBox(SCREEN_WIDTH, SCREEN_HEIGHT)
    box.show('長老', 'hi', 'elder.png')
    const i = asInternals(box)
    expect(i.nameText!.x).toBe(TEXT_X_WITH_PORTRAIT)

    box.show('村人', 'bye')
    expect(i.portraitFrame!.visible).toBe(false)
    expect(i.nameText!.x).toBe(TEXT_X_NO_PORTRAIT)
    box.destroy()
  })

  it('hide で顔枠も非表示になる', () => {
    const box = new RpgDialogBox(SCREEN_WIDTH, SCREEN_HEIGHT)
    box.show('長老', 'こんにちは', 'elder_portrait.png')
    const i = asInternals(box)
    expect(i.portraitFrame!.visible).toBe(true)

    box.hide()
    expect(i.portraitFrame!.visible).toBe(false)
    expect(box.isShowing).toBe(false)
    box.destroy()
  })

  /**
   * Q3: redraw 中に in-flight だった前の portrait ロードが後から解決しても、
   * currentPortraitToken が進んでいるため Sprite 差し替えが起きないことを確認する。
   *
   * 実際のネットワーク load を待たずに、token の変化のみを検証する（build → show →
   * redraw → もう一度 show で token が厳密に増え続けることを確認）。
   */
  it('redraw の前後で portrait token が進み、古い in-flight load は無視される', () => {
    const box = new RpgDialogBox(SCREEN_WIDTH, SCREEN_HEIGHT)
    box.show('長老', 'hi', 'elder.png')
    const i = asInternals(box)
    const tokenAfterFirstShow = i.currentPortraitToken
    expect(tokenAfterFirstShow).toBeGreaterThan(0)

    // redraw 実行（show 中なので beginPortraitLoad が再度呼ばれ token が進む）
    box.redraw(SCREEN_WIDTH, SCREEN_HEIGHT)
    const tokenAfterRedraw = i.currentPortraitToken
    expect(tokenAfterRedraw).toBeGreaterThan(tokenAfterFirstShow)

    // もう一度 show しても token が進む
    box.show('村人', 'yo', 'villager.png')
    expect(i.currentPortraitToken).toBeGreaterThan(tokenAfterRedraw)

    box.destroy()
  })
})

describe('RpgDialogBox typewriter (Issue #150)', () => {
  it('show 直後は messageText.text が空 (typewriter 開始時点)', () => {
    const box = new RpgDialogBox(SCREEN_WIDTH, SCREEN_HEIGHT)
    box.show('長老', 'こんにちは')
    const i = asInternals(box)
    expect(i.messageText!.text).toBe('')
    expect(i.messageText!.visible).toBe(true)
    expect(box.isTyping()).toBe(true)
    box.destroy()
  })

  it('skipTypewriter で全文が即座に表示される', () => {
    const box = new RpgDialogBox(SCREEN_WIDTH, SCREEN_HEIGHT)
    box.show('長老', 'こんにちは、若者よ。')
    box.skipTypewriter()
    const i = asInternals(box)
    expect(i.messageText!.text).toBe('こんにちは、若者よ。')
    expect(box.isTyping()).toBe(false)
    box.destroy()
  })

  it('hide で typewriter 状態がリセットされる', () => {
    const box = new RpgDialogBox(SCREEN_WIDTH, SCREEN_HEIGHT)
    box.show('長老', 'long message')
    expect(box.isTyping()).toBe(true)
    box.hide()
    expect(box.isTyping()).toBe(false)
    box.destroy()
  })

  it('setMsPerChar(0) で表示中なら即座に skip される', () => {
    const box = new RpgDialogBox(SCREEN_WIDTH, SCREEN_HEIGHT)
    box.show('長老', 'message')
    expect(box.isTyping()).toBe(true)
    box.setMsPerChar(0)
    const i = asInternals(box)
    expect(i.messageText!.text).toBe('message')
    expect(box.isTyping()).toBe(false)
    box.destroy()
  })

  it('skip 連打しても安定 (二回目は no-op)', () => {
    const box = new RpgDialogBox(SCREEN_WIDTH, SCREEN_HEIGHT)
    box.show('長老', 'msg')
    box.skipTypewriter()
    box.skipTypewriter()
    box.skipTypewriter()
    const i = asInternals(box)
    expect(i.messageText!.text).toBe('msg')
    expect(box.isTyping()).toBe(false)
    box.destroy()
  })

  it('別 NPC を再度 show すると typewriter が新規開始する', () => {
    const box = new RpgDialogBox(SCREEN_WIDTH, SCREEN_HEIGHT)
    box.show('長老', 'first')
    box.skipTypewriter()
    box.show('村人', 'second')
    const i = asInternals(box)
    expect(i.messageText!.text).toBe('') // 新規 typewriter 開始時点なので空
    expect(box.isTyping()).toBe(true)
    box.destroy()
  })
})
