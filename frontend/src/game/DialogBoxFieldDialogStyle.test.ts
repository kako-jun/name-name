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
  fieldDialogMinHeightRatio,
  minHeightRatioForFont,
  fieldDialogStyleOptions,
  normalizeDialogWindowHeight,
  FF_DIALOG_LINE_HEIGHT_RATIO,
  pickDialogSide,
  type DialogNameStyle,
} from './ffDialog'
import { BATTLE_UI_BASE_HEIGHT, MESSAGE_WINDOW_FONT_SIZE } from './battleLogicalSize'
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
  it('正規化: 文字サイズごとの下限〜0.6 の有限数だけ', () => {
    expect(normalizeDialogWindowHeight(0.36)).toBe(0.36)
    const min = fieldDialogMinHeightRatio('normal')
    expect(normalizeDialogWindowHeight(min)).toBe(min)
    expect(normalizeDialogWindowHeight(min - 0.001)).toBeUndefined()
    expect(normalizeDialogWindowHeight(0.6)).toBe(0.6)
    for (const bad of [0.05, 0.61, Number.NaN, Infinity, '0.3', null, undefined])
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

describe('dialog_window_height の下限は文字サイズで決まる (#1184)', () => {
  it('下限は話者名 1 行 + 本文 1 行と余白が入る高さ。battle は normal より高い', () => {
    const n = fieldDialogMinHeightRatio('normal')
    const b = fieldDialogMinHeightRatio('battle')
    expect(b).toBeGreaterThan(n)
    expect(n).toBeGreaterThanOrEqual(0.04 + 2 * FF_DIALOG_LINE_HEIGHT_RATIO * 0.034)
    expect(b).toBeGreaterThanOrEqual(
      0.04 + 2 * FF_DIALOG_LINE_HEIGHT_RATIO * FIELD_DIALOG_BATTLE_FONT_RATIO
    )
    expect(normalizeDialogWindowHeight(b - 0.001, 'battle')).toBeUndefined()
    expect(normalizeDialogWindowHeight(b, 'battle')).toBe(b)
    // normal では通る高さでも battle では下限未満のことがある（文字が大きいと要る高さも増える）
    expect(normalizeDialogWindowHeight(n, 'normal')).toBe(n)
    expect(normalizeDialogWindowHeight(n, 'battle')).toBeUndefined()
  })
  it('下限の高さで、話者名 + 本文 1 行が窓の外にはみ出さない（1080・battle / normal・複数の画面高さ）', () => {
    for (const [size, h] of [
      ['battle', 1080],
      ['normal', 1080],
      ['battle', 720],
      ['battle', 481],
    ] as const) {
      const ratio = fieldDialogMinHeightRatio(size)
      const fs = fieldDialogFontSize(h, size)
      const r = computeFieldDialogRect(h * (16 / 9), h, 'bottom', ratio)
      expect(r.padding * 2 + fs * FF_DIALOG_LINE_HEIGHT_RATIO * 2).toBeLessThanOrEqual(r.height)
    }
  })
  it('下限の高さの窓でも本文 1 行が入り、1 ページ 1 行になる', () => {
    const b = fieldDialogMinHeightRatio('battle')
    const box = make({ fontSize: 'battle', height: b })
    box.show('ペー子', 'あ\nい\nう')
    expect(box.getPageInfo().pages).toBe(3)
    box.dispose()
  })
})

describe('下限は最小文字サイズ 14px も含めて計算する (#1184)', () => {
  it('小さい画面（文字が 14px の下限に張り付く）では画面比だけの下限より高くなる', () => {
    expect(fieldDialogFontSize(300, 'normal')).toBe(14)
    expect(fieldDialogMinHeightRatio('normal', 300)).toBeGreaterThan(
      fieldDialogMinHeightRatio('normal')
    )
    expect(fieldDialogMinHeightRatio('battle', 200)).toBeGreaterThan(
      fieldDialogMinHeightRatio('battle')
    )
    // 大きい画面では画面比だけの下限と（切り上げの範囲で）同じ
    expect(
      Math.abs(fieldDialogMinHeightRatio('battle', 1080) - fieldDialogMinHeightRatio('battle'))
    ).toBeLessThan(0.002)
  })
  it('その下限の高さで、実際の文字サイズ(14px 下限込み)の名前 1 行 + 本文 1 行が窓に収まる', () => {
    for (const [size, h] of [
      ['normal', 300],
      ['normal', 400],
      ['battle', 200],
      ['battle', 280],
    ] as const) {
      const r = computeFieldDialogRect(
        h * (16 / 9),
        h,
        'bottom',
        fieldDialogMinHeightRatio(size, h)
      )
      const fs = fieldDialogFontSize(h, size)
      expect(r.padding * 2 + fs * FF_DIALOG_LINE_HEIGHT_RATIO * 2).toBeLessThanOrEqual(r.height)
    }
  })
  it('DialogBox は窓の高さを実際の文字サイズの最小の高さまで持ち上げる（指定が低すぎても本文が出る）', () => {
    const box = new DialogBox({
      screenWidth: 533,
      screenHeight: 300,
      boxHeight: 66,
      fontSize: fieldDialogFontSize(300, 'normal'),
      nameColor: 0xffe066,
      nameSeparateBox: false,
      ...fieldDialogOptions({ windowStyle: 'ff-blue' }),
      ffPlacement: () => ({ footY: 100, avatar: null }),
      ffWindowHeightRatio: 0.1,
    })
    box.hide()
    expect(box.getBoxRect().height).toBeGreaterThanOrEqual(
      Math.floor(300 * minHeightRatioForFont(300, 14))
    )
    box.dispose()
  })
})

describe('window_style が無い作品では三つのキーは無視される (#1184)', () => {
  const all = {
    dialogFontSize: 'battle' as const,
    dialogWindowHeight: 0.4,
    dialogNameStyle: 'plate' as const,
  }
  it('windowStyle 未指定は空（従来の見た目のまま）', () => {
    expect(fieldDialogStyleOptions({ ...all })).toEqual({})
    expect(fieldDialogStyleOptions({ ...all, windowStyle: undefined })).toEqual({})
  })
  it('windowStyle ありは指定したキーだけを渡す（未指定のキーは出さない）', () => {
    expect(fieldDialogStyleOptions({ ...all, windowStyle: 'dark' })).toEqual({
      ffWindowHeightRatio: 0.4,
      ffNameStyle: 'plate',
    })
    expect(fieldDialogStyleOptions({ windowStyle: 'ff-blue' })).toEqual({})
    expect(fieldDialogStyleOptions({ windowStyle: 'ff-blue', dialogNameStyle: 'large' })).toEqual({
      ffNameStyle: 'large',
    })
  })
})

describe('リサイズ・フォント変更後も名前スタイルが保たれる (#1184)', () => {
  it('setFontSize → redraw で large は新しい本文サイズの 1.2 倍・金色のまま', () => {
    const box = make({ nameStyle: 'large' })
    box.show('ペー子', 'テキスト')
    box.setFontSize(40)
    box.redraw(W, H)
    const n = internals(box).nameText
    expect(n.style.fontSize).toBe(48)
    expect(n.style.fill).toBe(0xffe066)
    box.dispose()
  })
  it('setFontSize → redraw で plate は名札と暗色の文字のまま、inline は白・本文と同じ大きさ', () => {
    const p = make({ nameStyle: 'plate' })
    p.show('ペー子', 'テキスト')
    p.setFontSize(40)
    p.redraw(W, H)
    expect(internals(p).nameBox.visible).toBe(true)
    expect(internals(p).nameText.style.fill).toBe(0x1a1a2e)
    const i = make()
    i.show('ペー子', 'テキスト')
    i.setFontSize(40)
    i.redraw(W, H)
    expect(internals(i).nameText.style.fill).toBe(0xffffff)
    expect(internals(i).nameText.style.fontSize).toBe(40)
    expect(internals(i).nameBox.visible).toBe(false)
    p.dispose()
    i.dispose()
  })
})

describe('配線 (#1184)', () => {
  it('startFieldGame は文字サイズを設定から渡し、高さ・名前の見せ方は windowStyle で絞る純関数 fieldDialogStyleOptions 経由で渡す', () => {
    expect(startFieldGameSrc).toMatch(
      /fieldDialogFontSize\(scene\.mask\.height, config\.dialogFontSize\)/
    )
    expect(startFieldGameSrc).toMatch(/fieldDialogFontSize\(height, config\.dialogFontSize\)/)
    expect(startFieldGameSrc).toMatch(
      /fieldDialogStyleOptions\(\{\s*\.\.\.config,\s*windowStyle:\s*config\.battle\.windowStyle\s*\}\)/
    )
  })
})
