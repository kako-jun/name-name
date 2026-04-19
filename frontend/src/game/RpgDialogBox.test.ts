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
import { RpgDialogBox } from './RpgDialogBox'

// private フィールドにアクセスするための型
interface RpgDialogBoxInternals {
  portraitFrame: { visible: boolean } | null
  nameText: { x: number } | null
  messageText: { x: number; style: { wordWrapWidth: number } } | null
}

function asInternals(box: RpgDialogBox): RpgDialogBoxInternals {
  return box as unknown as RpgDialogBoxInternals
}

describe('RpgDialogBox portrait (Issue #73 Phase 1)', () => {
  it('portrait 未指定で show すると顔枠は非表示', () => {
    const box = new RpgDialogBox(800, 600)
    box.show('長老', 'こんにちは')
    const i = asInternals(box)
    expect(i.portraitFrame).not.toBeNull()
    expect(i.portraitFrame!.visible).toBe(false)
    // テキストは従来位置（x=40）
    expect(i.nameText!.x).toBe(40)
    expect(i.messageText!.x).toBe(40)
    box.destroy()
  })

  it('portrait 指定で show すると顔枠が表示され、テキストが右にシフト', () => {
    const box = new RpgDialogBox(800, 600)
    box.show('長老', 'こんにちは', 'elder_portrait.png')
    const i = asInternals(box)
    expect(i.portraitFrame!.visible).toBe(true)
    // 顔枠 (x=40, size=80) + padding 20 = 140 からテキスト開始
    expect(i.nameText!.x).toBe(140)
    expect(i.messageText!.x).toBe(140)
    // wordWrapWidth は boxWidth (800-40=760) - (80+20+40) = 620
    expect(i.messageText!.style.wordWrapWidth).toBe(620)
    box.destroy()
  })

  it('portrait 空文字は未指定と同等扱い', () => {
    const box = new RpgDialogBox(800, 600)
    box.show('村人', 'やあ', '')
    const i = asInternals(box)
    expect(i.portraitFrame!.visible).toBe(false)
    expect(i.nameText!.x).toBe(40)
    box.destroy()
  })

  it('portrait あり → なしに切り替えるとテキスト位置が戻る', () => {
    const box = new RpgDialogBox(800, 600)
    box.show('長老', 'hi', 'elder.png')
    const i = asInternals(box)
    expect(i.nameText!.x).toBe(140)

    box.show('村人', 'bye')
    expect(i.portraitFrame!.visible).toBe(false)
    expect(i.nameText!.x).toBe(40)
    box.destroy()
  })

  it('hide で顔枠も非表示になる', () => {
    const box = new RpgDialogBox(800, 600)
    box.show('長老', 'こんにちは', 'elder_portrait.png')
    const i = asInternals(box)
    expect(i.portraitFrame!.visible).toBe(true)

    box.hide()
    expect(i.portraitFrame!.visible).toBe(false)
    expect(box.isShowing).toBe(false)
    box.destroy()
  })
})
