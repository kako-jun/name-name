/**
 * 一枚絵フィールドの会話窓の文字サイズ・高さ・話者名の見せ方 (#1184)。
 * 三つの設定が互いに独立で、未指定は従来の見た目のままであることを固定する。
 */
import { describe, it, expect, vi } from 'vitest'
import type { Ticker } from 'pixi.js'

vi.mock('./FontLoader', () => ({
  ensureFontLoaded: vi.fn().mockResolvedValue(undefined),
  extractPrimaryFamily: (f: string) => f.split(',')[0]?.trim() ?? f,
  resetFontLoaderCache: vi.fn(),
  __setDocumentForTest: vi.fn(),
}))
vi.mock('./wordwrap', async () => {
  const actual = await vi.importActual<typeof import('./wordwrap')>('./wordwrap')
  return {
    ...actual,
    wordwrap: (text: string, maxWidth: number) =>
      actual.wrapTextWithMeasure(text, maxWidth, (s) => s.length * 10),
  }
})
import { DialogBox } from './DialogBox'
import {
  FIELD_DIALOG_BATTLE_FONT_RATIO,
  FIELD_DIALOG_HEIGHT_RATIO,
  computeFieldDialogRect,
  fieldDialogFontSize,
  fieldDialogOptions,
  normalizeDialogFontSize,
  normalizeDialogNameStyle,
  normalizeDialogWindowHeight,
  pickDialogSide,
  type DialogNameStyle,
} from './ffDialog'
import { MESSAGE_WINDOW_FONT_SIZE } from './BattleScreen'
import { BATTLE_UI_BASE_HEIGHT } from './battleLogicalSize'
import startFieldGameSrc from '../field/startFieldGame.ts?raw'

interface Internals {
  ticker: Ticker
  nameText: {
    text: string
    x: number
    y: number
    visible: boolean
    style: { fill: unknown; fontSize: number; dropShadow: unknown }
  }
  nameBox: { visible: boolean }
  dialogText: { y: number }
}
const internals = (b: DialogBox): Internals => b as unknown as Internals

const W = 1920
const H = 1080

function make(
  extra: {
    fontSize?: 'normal' | 'battle'
    height?: number
    nameStyle?: DialogNameStyle
  } = {}
): DialogBox {
  const box = new DialogBox({
    screenWidth: W,
    screenHeight: H,
    boxHeight: Math.round(H * 0.22),
    fontSize: fieldDialogFontSize(H, extra.fontSize),
    bgColor: 0x000033,
    nameColor: 0xffe066,
    nameSeparateBox: false,
    ...fieldDialogOptions({ windowStyle: 'ff-blue' }),
    ffPlacement: () => ({ footY: 100, avatar: null }),
    ...(extra.height !== undefined ? { ffWindowHeightRatio: extra.height } : {}),
    ...(extra.nameStyle ? { ffNameStyle: extra.nameStyle } : {}),
  })
  box.hide()
  internals(box).ticker.stop()
  // jsdom は canvas で文字を測れないので、名前の寸法は決定論的な値に差し替える
  const n = internals(box).nameText as unknown as object
  Object.defineProperty(n, 'width', { get: () => 100, configurable: true })
  Object.defineProperty(n, 'height', { get: () => 40, configurable: true })
  return box
}

describe('dialog_font_size: battle は戦闘のメッセージ窓と同じ大きさ (#1184)', () => {
  it('比は戦闘側の定数 MESSAGE_WINDOW_FONT_SIZE / 設計高さ 450 と一致する（戦闘側が変われば落ちる）', () => {
    expect(FIELD_DIALOG_BATTLE_FONT_RATIO).toBeCloseTo(
      MESSAGE_WINDOW_FONT_SIZE / BATTLE_UI_BASE_HEIGHT,
      12
    )
  })
  it('1080 で戦闘と同じ 52.8px（22 × uiScale 2.4）→ 丸めて 53px。normal は従来の 37px', () => {
    expect(fieldDialogFontSize(1080, 'battle')).toBe(53)
    expect(fieldDialogFontSize(1080, 'normal')).toBe(37)
    expect(fieldDialogFontSize(1080)).toBe(37)
  })
  it('画面の大きさに比例する（720 で 35px）', () => {
    expect(fieldDialogFontSize(720, 'battle')).toBe(35)
  })
  it('正規化: 空白・大小を無視し、未知は undefined', () => {
    expect(normalizeDialogFontSize(' Battle ')).toBe('battle')
    expect(normalizeDialogFontSize('normal')).toBe('normal')
    expect(normalizeDialogFontSize('big')).toBeUndefined()
    expect(normalizeDialogFontSize(1)).toBeUndefined()
  })
})

describe('dialog_window_height (#1184)', () => {
  it('正規化: 0.1〜0.6 の有限数だけ', () => {
    expect(normalizeDialogWindowHeight(0.36)).toBe(0.36)
    expect(normalizeDialogWindowHeight(0.1)).toBe(0.1)
    expect(normalizeDialogWindowHeight(0.6)).toBe(0.6)
    for (const bad of [0.09, 0.61, Number.NaN, Infinity, '0.3', null, undefined])
      expect(normalizeDialogWindowHeight(bad)).toBeUndefined()
  })
  it('矩形の高さが変わり、上下の余白（端 3%H）は変わらない。省略は従来の 28%H', () => {
    const d = computeFieldDialogRect(W, H, 'bottom')
    const t = computeFieldDialogRect(W, H, 'bottom', 0.4)
    expect(d.height).toBe(Math.round(H * FIELD_DIALOG_HEIGHT_RATIO))
    expect(t.height).toBe(Math.round(H * 0.4))
    expect(t.y + t.height).toBe(d.y + d.height)
    expect(computeFieldDialogRect(W, H, 'top', 0.4).y).toBe(Math.round(H * 0.03))
  })
  it('pickDialogSide は窓の高さを使って重なりを判定する', () => {
    const avatar = { x: 800, y: 600, width: 200, height: 300 } // 画面下寄り
    // 28%H の下側窓は y=745〜 と重なる → 高さに関わらず足元で上側が優先されないとき反対側へ
    expect(pickDialogSide(300, W, H, avatar)).toBe('top')
    const tall = { x: 800, y: 690, width: 200, height: 50 }
    // 0.28 の下側窓（上端 746）には届かないが、0.6 の下側窓（上端 400）とは重なる
    expect(pickDialogSide(300, W, H, tall)).toBe('bottom')
    expect(pickDialogSide(300, W, H, tall, 0.6)).toBe('top')
  })
  it('窓の高さを大きくすると 1 ページに入る行が増え、本文の大きさ・窓の位置の基準は変わらない', () => {
    const TEN = Array.from({ length: 10 }, (_, i) => `行${i + 1}`).join('\n')
    const a = make({ fontSize: 'battle' })
    a.show('ペー子', TEN)
    const b = make({ fontSize: 'battle', height: 0.4 })
    b.show('ペー子', TEN)
    expect(b.getPageInfo().pages).toBeLessThan(a.getPageInfo().pages)
    expect(b.getBoxRect().height).toBe(Math.round(H * 0.4))
    a.dispose()
    b.dispose()
  })
  it('文字を戦闘と同じにすると既定の 28%H では本文 2 行・38%H で本文 3 行（名前 1 行）', () => {
    const TEN = Array.from({ length: 10 }, (_, i) => `行${i + 1}`).join('\n')
    const a = make({ fontSize: 'battle' })
    a.show('ペー子', TEN)
    expect(a.getPageInfo().pages).toBe(5) // 2 行ずつ
    const b = make({ fontSize: 'battle', height: 0.38 })
    b.show('ペー子', TEN)
    expect(b.getPageInfo().pages).toBe(4) // 3+3+3+1
    a.dispose()
    b.dispose()
  })
})

describe('dialog_name_style (#1184)', () => {
  it('正規化', () => {
    expect(normalizeDialogNameStyle(' PLATE ')).toBe('plate')
    expect(normalizeDialogNameStyle('large')).toBe('large')
    expect(normalizeDialogNameStyle('inline')).toBe('inline')
    expect(normalizeDialogNameStyle('x')).toBeUndefined()
  })
  it('未指定（inline）は従来どおり: 本文と同じ大きさの白・名札なし', () => {
    const box = make()
    box.show('ペー子', 'テキスト')
    const n = internals(box).nameText
    expect(n.style.fill).toBe(0xffffff)
    expect(n.style.fontSize).toBe(fieldDialogFontSize(H))
    expect(internals(box).nameBox.visible).toBe(false)
    box.dispose()
  })
  it('large: 本文の 1.2 倍・名前色（金）', () => {
    const box = make({ nameStyle: 'large' })
    box.show('ペー子', 'テキスト')
    const n = internals(box).nameText
    expect(n.style.fontSize).toBe(Math.round(fieldDialogFontSize(H) * 1.2))
    expect(n.style.fill).toBe(0xffe066)
    expect(internals(box).nameBox.visible).toBe(false)
    box.dispose()
  })
  it('plate: 金の名札（nameBox）を出し、文字は暗色・影なし。名前なしの台詞では名札が消える', () => {
    const box = make({ nameStyle: 'plate' })
    box.show('ペー子', 'テキスト')
    expect(internals(box).nameBox.visible).toBe(true)
    expect(internals(box).nameText.style.fill).toBe(0x1a1a2e)
    expect(internals(box).nameText.style.dropShadow).toBeFalsy()
    box.show('', 'テキスト')
    expect(internals(box).nameBox.visible).toBe(false)
    box.dispose()
  })
  it('三つの値で本文の位置・窓の矩形・1 ページの行数が変わらない（名前の見せ方は他に影響しない）', () => {
    const TEN = Array.from({ length: 10 }, (_, i) => `行${i + 1}`).join('\n')
    const sig = (s: DialogNameStyle) => {
      const box = make({ nameStyle: s })
      box.show('ペー子', TEN)
      const r = {
        y: internals(box).dialogText.y,
        pages: box.getPageInfo().pages,
        rect: box.getBoxRect(),
      }
      box.dispose()
      return r
    }
    expect(sig('large')).toEqual(sig('inline'))
    expect(sig('plate')).toEqual(sig('inline'))
  })
})

describe('配線 (#1184)', () => {
  it('startFieldGame は三つの設定を窓に渡す。未指定のときはキーを足さない', () => {
    expect(startFieldGameSrc).toMatch(
      /fieldDialogFontSize\(scene\.mask\.height, config\.dialogFontSize\)/
    )
    expect(startFieldGameSrc).toMatch(/fieldDialogFontSize\(height, config\.dialogFontSize\)/)
    expect(startFieldGameSrc).toMatch(/ffWindowHeightRatio: config\.dialogWindowHeight/)
    expect(startFieldGameSrc).toMatch(/ffNameStyle: config\.dialogNameStyle/)
  })
})
