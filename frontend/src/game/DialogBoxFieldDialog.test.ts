/**
 * 一枚絵フィールドの設計どおりの会話窓 (#1153) の DialogBox 側。
 * ffPlacement を渡した窓: 上下の決定と固定・150ms スライド・窓内左上の名前・1 ページの行数・redraw 後の位置。
 */
import { describe, it, expect, vi } from 'vitest'
import type { Ticker } from 'pixi.js'

vi.mock('./FontLoader', () => ({
  ensureFontLoaded: vi.fn().mockResolvedValue(undefined),
  extractPrimaryFamily: (f: string) => f.split(',')[0]?.trim() ?? f,
  resetFontLoaderCache: vi.fn(),
  __setDocumentForTest: vi.fn(),
}))
// jsdom は canvas の文字幅を測れないので、1 文字 = 10px の決定論的な計測に差し替える
vi.mock('./wordwrap', async () => {
  const actual = await vi.importActual<typeof import('./wordwrap')>('./wordwrap')
  return {
    ...actual,
    wordwrap: (text: string, maxWidth: number) =>
      actual.wrapTextWithMeasure(text, maxWidth, (s) => s.length * 10),
  }
})
import { DialogBox, type FfPlacement } from './DialogBox'
import {
  FIELD_DIALOG_SLIDE_MS,
  FIELD_DIALOG_TIMED_NAME_X_RATIO,
  computeFieldDialogRect,
  fieldDialogFontSize,
  fieldDialogOptions,
  pickDialogSide,
} from './ffDialog'
import { FF_BLUE_TEXT_SHADOW } from './windowStyle'
import startFieldGameSrc from '../field/startFieldGame.ts?raw'

interface Internals {
  ticker: Ticker
  nameText: {
    text: string
    x: number
    y: number
    visible: boolean
    style: { fill: unknown; dropShadow: unknown }
  }
  nameBox: { visible: boolean }
  dialogText: { y: number }
}
const internals = (b: DialogBox): Internals => b as unknown as Internals

const W = 800
const H = 600
// 800x600: 窓 752x168・下側 y=414・上側 y=18・文字 20px・行高 32・余白 12
const BOTTOM = computeFieldDialogRect(W, H, 'bottom')
const TOP = computeFieldDialogRect(W, H, 'top')

function make(
  place: () => FfPlacement,
  extra: { ffWindowStyle?: 'dark' | 'ff-blue'; w?: number; h?: number } = {}
): DialogBox {
  const w = extra.w ?? W
  const h = extra.h ?? H
  const box = new DialogBox({
    screenWidth: w,
    screenHeight: h,
    boxHeight: Math.round(h * 0.22),
    fontSize: fieldDialogFontSize(h),
    bgColor: 0x000033,
    nameColor: 0xffe066,
    nameSeparateBox: false,
    ...fieldDialogOptions({ windowStyle: extra.ffWindowStyle ?? 'ff-blue' }),
    ffPlacement: place,
  })
  box.hide()
  internals(box).ticker.stop()
  return box
}

let clock = 0
function advance(box: DialogBox, ms: number): void {
  for (let left = ms; left > 0; left -= 10) {
    clock += Math.min(10, left)
    internals(box).ticker.update(clock)
  }
}
/** Ticker の基準時刻を揃える（構築時の performance.now() との差で偽の経過が出るのを防ぐ） */
function prime(box: DialogBox): void {
  const ticker = internals(box).ticker
  clock += 1000
  ticker.lastTime = clock
  ticker.update(clock)
}
function typeOut(box: DialogBox): void {
  for (let i = 0; i < 2000 && box.isTyping(); i++) advance(box, 10)
}

describe('pickDialogSide の境界 (#1153)', () => {
  it('H/2 の ±1 と ちょうど中央（下側）', () => {
    expect(pickDialogSide(H / 2 + 1, W, H, null)).toBe('top')
    expect(pickDialogSide(H / 2, W, H, null)).toBe('bottom')
    expect(pickDialogSide(H / 2 - 1, W, H, null)).toBe('bottom')
  })
  it('画面の端（0 と H）', () => {
    expect(pickDialogSide(0, W, H, null)).toBe('bottom')
    expect(pickDialogSide(H, W, H, null)).toBe('top')
  })
  it('奇数の高さでも H/2 を境にする', () => {
    expect(pickDialogSide(150, 100, 301, null)).toBe('bottom') // 150 < 150.5
    expect(pickDialogSide(151, 100, 301, null)).toBe('top')
  })
  it('極小画面でも落ちず、窓が重なっても決定的', () => {
    expect(pickDialogSide(1, 1, 1, null)).toBe('top')
    expect(pickDialogSide(0, 0, 0, null)).toBe('bottom')
    expect(pickDialogSide(5, 10, 10, { x: 0, y: 0, width: 10, height: 10 })).toBe('bottom')
  })
  it('アクスタが辺で接するだけ（重ならない）なら反転しない', () => {
    // 下側の窓の上端 y=414 にアクスタの下端がちょうど接する
    const touching = { x: 400, y: 314, width: 100, height: 100 }
    expect(pickDialogSide(300, W, H, touching)).toBe('bottom')
    const overlapping = { x: 400, y: 313, width: 100, height: 102 }
    expect(pickDialogSide(300, W, H, overlapping)).toBe('top')
  })
  it('上側を選んだ場合に上側の窓と重なるなら下側へ', () => {
    const atTop = { x: 400, y: 0, width: 100, height: 100 } // 上側の窓と重なる
    expect(pickDialogSide(500, W, H, atTop)).toBe('bottom')
  })
  it('アクスタが窓の左右の外なら反転しない', () => {
    const outside = { x: 0, y: 400, width: 20, height: 150 } // 窓の x=24 より左
    expect(pickDialogSide(300, W, H, outside)).toBe('bottom')
  })
})

describe('computeFieldDialogRect の対称性・極小画面 (#1153)', () => {
  it('上側と下側は上下対称（上の余白 = 下の余白）で同じ幅・高さ・x', () => {
    for (const [w, h] of [
      [800, 600],
      [1280, 720],
      [641, 361],
    ] as const) {
      const t = computeFieldDialogRect(w, h, 'top')
      const b = computeFieldDialogRect(w, h, 'bottom')
      expect(t.y).toBe(h - (b.y + b.height))
      expect([t.x, t.width, t.height]).toEqual([b.x, b.width, b.height])
      expect(Math.abs(t.x + t.width / 2 - w / 2)).toBeLessThanOrEqual(1) // 丸めで 1px まで
    }
  })
  it('極小・0・非有限の画面でも画面内に収まる（NaN を出さない）', () => {
    for (const [w, h] of [
      [1, 1],
      [0, 0],
      [Number.NaN, -5],
      [Infinity, 10],
    ] as const) {
      for (const side of ['top', 'bottom'] as const) {
        const r = computeFieldDialogRect(w, h, side)
        for (const v of [r.x, r.y, r.width, r.height, r.padding])
          expect(Number.isFinite(v)).toBe(true)
        expect(r.y).toBeGreaterThanOrEqual(0)
      }
    }
  })
  it('fieldDialogFontSize は下限 14・非有限は下限', () => {
    expect(fieldDialogFontSize(100)).toBe(14)
    expect(fieldDialogFontSize(Number.NaN)).toBe(14)
    expect(fieldDialogFontSize(1000)).toBe(34)
  })
})

describe('DialogBox ffPlacement: 上下の決定と固定 (#1153)', () => {
  it('会話の開始時に足元 y から上下を決め、即その位置（スライドなし）', () => {
    const lowFoot = make(() => ({ footY: 450, avatar: null }))
    lowFoot.show('', 'テキスト')
    expect(lowFoot.getPlacedSide()).toBe('top')
    expect(lowFoot.getBoxRect().y).toBe(TOP.y)
    const highFoot = make(() => ({ footY: 100, avatar: null }))
    highFoot.show('', 'テキスト')
    expect(highFoot.getPlacedSide()).toBe('bottom')
    expect(highFoot.getBoxRect().y).toBe(BOTTOM.y)
    lowFoot.dispose()
    highFoot.dispose()
  })
  it('ちょうど中央は下側', () => {
    const box = make(() => ({ footY: H / 2, avatar: null }))
    box.show('', 'テキスト')
    expect(box.getPlacedSide()).toBe('bottom')
    box.dispose()
  })
  it('アクスタが下側の窓と重なる（足元は下半分でなく上半分）なら上側へ', () => {
    const box = make(() => ({
      footY: 300,
      avatar: { x: 400, y: 400, width: 100, height: 150 },
    }))
    box.show('', 'テキスト')
    expect(box.getPlacedSide()).toBe('top')
    box.dispose()
  })
  it('両側とも重なるなら上下判定のまま', () => {
    const box = make(() => ({
      footY: 300,
      avatar: { x: 400, y: 0, width: 100, height: H },
    }))
    box.show('', 'テキスト')
    expect(box.getPlacedSide()).toBe('bottom')
    box.dispose()
  })
  it('会話中に足元 y が動かなければ、アクスタ矩形が変わっても固定（再判定しない）', () => {
    const state: FfPlacement = { footY: 100, avatar: null }
    const box = make(() => state)
    prime(box)
    box.show('', Array.from({ length: 10 }, (_, i) => `行${i}`).join('\n'))
    typeOut(box)
    state.avatar = { x: 400, y: 400, width: 100, height: 150 } // 足元は同じ
    expect(box.nextPage()).toBe(true)
    advance(box, FIELD_DIALOG_SLIDE_MS * 2)
    expect(box.getPlacedSide()).toBe('bottom')
    expect(box.getBoxRect().y).toBe(BOTTOM.y)
    box.dispose()
  })
  it('ffPlacement なしの ffWindow は従来どおり上部固定（getPlacedSide は bottom のまま・y のずれなし）', () => {
    const box = new DialogBox({
      screenWidth: W,
      screenHeight: H,
      boxHeight: 132,
      fontSize: 24,
      bgColor: 0x000033,
      nameSeparateBox: false,
      ffWindow: true,
    })
    box.hide()
    internals(box).ticker.stop()
    box.show('名前', 'テキスト')
    expect(box.y).toBe(0)
    expect(box.getPlacedSide()).toBe('bottom')
    expect(internals(box).nameText.visible).toBe(false)
    box.dispose()
  })
  it('ffWindow でなければ ffPlacement を渡しても無視される', () => {
    const place = vi.fn(() => ({ footY: 500, avatar: null }))
    const box = new DialogBox({
      screenWidth: W,
      screenHeight: H,
      boxHeight: 132,
      fontSize: 24,
      bgColor: 0x000033,
      nameSeparateBox: false,
      ffPlacement: place,
    })
    box.hide()
    internals(box).ticker.stop()
    box.show('', 'テキスト')
    expect(place).not.toHaveBeenCalled()
    expect(box.y).toBe(0)
    box.dispose()
  })
})

describe('DialogBox ffPlacement: スライド (#1153)', () => {
  /** 2 ページになる台詞 */
  const LONG = Array.from({ length: 6 }, (_, i) => `行${i}`).join('\n')
  function setup(initialFoot: number) {
    const state: FfPlacement = { footY: initialFoot, avatar: null }
    const box = make(() => state)
    prime(box)
    box.show('', LONG)
    typeOut(box)
    return { state, box }
  }
  it('ページ送りで足元 y が動き側が変わると、150ms で到達し、途中は補間', () => {
    const { state, box } = setup(100)
    expect(box.getBoxRect().y).toBe(BOTTOM.y)
    state.footY = 500
    expect(box.nextPage()).toBe(true)
    expect(box.getPlacedSide()).toBe('top')
    expect(box.getBoxRect().y).toBe(BOTTOM.y) // まだ動き出していない
    advance(box, FIELD_DIALOG_SLIDE_MS / 2)
    const mid = box.getBoxRect().y
    expect(mid).toBeLessThan(BOTTOM.y)
    expect(mid).toBeGreaterThan(TOP.y)
    advance(box, FIELD_DIALOG_SLIDE_MS / 2 + 10)
    expect(box.getBoxRect().y).toBe(TOP.y)
    box.dispose()
  })
  it('150ms 未満では到達していない', () => {
    const { state, box } = setup(100)
    state.footY = 500
    box.nextPage()
    advance(box, FIELD_DIALOG_SLIDE_MS - 30)
    expect(box.getBoxRect().y).toBeGreaterThan(TOP.y)
    box.dispose()
  })
  it('足元 y が動いても側が変わらなければスライドしない', () => {
    const { state, box } = setup(100)
    state.footY = 200
    box.nextPage()
    advance(box, 20)
    expect(box.getPlacedSide()).toBe('bottom')
    expect(box.getBoxRect().y).toBe(BOTTOM.y)
    box.dispose()
  })
  it('足元 y が動かなければ再判定しない（固定のまま）', () => {
    const { box } = setup(500)
    box.nextPage()
    advance(box, FIELD_DIALOG_SLIDE_MS * 2)
    expect(box.getBoxRect().y).toBe(TOP.y)
    box.dispose()
  })
  it('hide のあとの再開は、前回の側に関わらず即その位置（スライドなし）', () => {
    const state: FfPlacement = { footY: 500, avatar: null }
    const box = make(() => state)
    box.show('', 'テキスト')
    expect(box.getBoxRect().y).toBe(TOP.y)
    box.hide()
    state.footY = 100
    box.show('', 'テキスト')
    expect(box.getPlacedSide()).toBe('bottom')
    expect(box.getBoxRect().y).toBe(BOTTOM.y) // 時間を進めなくても即
    box.dispose()
  })
  it('スライド中に redraw しても到達先に確定する', () => {
    const { state, box } = setup(100)
    state.footY = 500
    box.nextPage()
    advance(box, 30)
    box.redraw(W, H)
    expect(box.getBoxRect().y).toBe(TOP.y)
    advance(box, FIELD_DIALOG_SLIDE_MS)
    expect(box.getBoxRect().y).toBe(TOP.y)
    box.dispose()
  })
})

describe('DialogBox ffPlacement: 話者名と行数 (#1153)', () => {
  it('名前は窓内の左上に 1 行・白文字・外側タブ（nameBox）は出ない', () => {
    const box = make(() => ({ footY: 100, avatar: null }))
    box.show('ペー子', 'テキスト')
    const n = internals(box).nameText
    expect(n.visible).toBe(true)
    expect(n.text).toBe('ペー子')
    expect(n.style.fill).toBe(0xffffff)
    expect(internals(box).nameBox.visible).toBe(false)
    expect(n.x).toBe(BOTTOM.x + BOTTOM.padding)
    expect(n.y).toBe(BOTTOM.y + BOTTOM.padding)
    box.dispose()
  })
  it('本文は名前の 1 行下（行高 32）から始まる。名前なしは余白の直下', () => {
    const named = make(() => ({ footY: 100, avatar: null }))
    named.show('ペー子', 'テキスト')
    const plain = make(() => ({ footY: 100, avatar: null }))
    plain.show('', 'テキスト')
    expect(internals(named).dialogText.y - internals(plain).dialogText.y).toBe(
      fieldDialogFontSize(H) * 1.6
    )
    expect(internals(plain).dialogText.y).toBe(BOTTOM.y + BOTTOM.padding)
    named.dispose()
    plain.dispose()
  })
  it('名前の位置は上側でも窓に付いてくる（座標は基準＋Container の y）', () => {
    const box = make(() => ({ footY: 500, avatar: null }))
    box.show('ペー子', 'テキスト')
    expect(box.getBoxRect().y + BOTTOM.padding).toBe(TOP.y + TOP.padding)
    expect(internals(box).nameText.y + box.y).toBe(TOP.y + TOP.padding)
    box.dispose()
  })
  it('1 ページの行数: 名前あり = 本文 3 行・名前なし = 4 行', () => {
    const TEN = Array.from({ length: 10 }, (_, i) => `行${i + 1}`).join('\n')
    const named = make(() => ({ footY: 100, avatar: null }))
    named.show('ペー子', TEN)
    expect(named.getPageInfo()).toEqual({ page: 1, pages: 4 }) // 3+3+3+1
    const plain = make(() => ({ footY: 100, avatar: null }))
    plain.show('', TEN)
    expect(plain.getPageInfo()).toEqual({ page: 1, pages: 3 }) // 4+4+2
    named.dispose()
    plain.dispose()
  })
  it('名前ありのページは 3 行目までが出て 4 行目は次ページ', () => {
    const box = make(() => ({ footY: 100, avatar: null }))
    prime(box)
    box.show('ペー子', 'あ\nい\nう\nえ')
    typeOut(box)
    expect(box.getVisibleText()).toBe('あ\nい\nう')
    expect(box.isAwaitingPage()).toBe(true)
    box.dispose()
  })
  it('名前の有無は台詞ごとに切り替わる（名前なしの台詞に前の名前が残らない・行数も戻る）', () => {
    const box = make(() => ({ footY: 100, avatar: null }))
    box.show('ペー子', 'あ\nい\nう\nえ')
    expect(box.getPageInfo().pages).toBe(2)
    box.show('', 'あ\nい\nう\nえ')
    expect(internals(box).nameText.visible).toBe(false)
    expect(box.getPageInfo().pages).toBe(1)
    box.dispose()
  })
  it('名前の影: dark はなし・ff-blue は本文と同じ影', () => {
    const dark = make(() => ({ footY: 100, avatar: null }), { ffWindowStyle: 'dark' })
    dark.show('ペー子', 'テキスト')
    expect(internals(dark).nameText.style.dropShadow).toBeFalsy()
    const blue = make(() => ({ footY: 100, avatar: null }), { ffWindowStyle: 'ff-blue' })
    blue.show('ペー子', 'テキスト')
    expect(internals(blue).nameText.style.dropShadow).toMatchObject({
      color: FF_BLUE_TEXT_SHADOW.color,
    })
    dark.dispose()
    blue.dispose()
  })
  it('時間制限中かつ上側: 名前は 16%W 以降から。下側・時間制限なしは窓の左上', () => {
    const minX = Math.round(W * FIELD_DIALOG_TIMED_NAME_X_RATIO)
    const timedTop = make(() => ({ footY: 500, avatar: null, timed: true }))
    timedTop.show('ペー子', 'テキスト')
    expect(internals(timedTop).nameText.x).toBe(minX)
    const timedBottom = make(() => ({ footY: 100, avatar: null, timed: true }))
    timedBottom.show('ペー子', 'テキスト')
    expect(internals(timedBottom).nameText.x).toBe(BOTTOM.x + BOTTOM.padding)
    const untimedTop = make(() => ({ footY: 500, avatar: null, timed: false }))
    untimedTop.show('ペー子', 'テキスト')
    expect(internals(untimedTop).nameText.x).toBe(BOTTOM.x + BOTTOM.padding)
    timedTop.dispose()
    timedBottom.dispose()
    untimedTop.dispose()
  })
  it('16%W が窓の左余白より内側に来ない極小画面でも名前は窓内（余白以上）', () => {
    const box = make(() => ({ footY: 90, avatar: null, timed: true }), { w: 100, h: 100 })
    box.show('ペー子', 'テキスト')
    const r = computeFieldDialogRect(100, 100, 'bottom')
    expect(internals(box).nameText.x).toBeGreaterThanOrEqual(r.x + r.padding)
    box.dispose()
  })
})

describe('DialogBox ffPlacement: redraw (#1153)', () => {
  it('リサイズ後も現在の側が保たれ、新しい画面の矩形に追従する', () => {
    const box = make(() => ({ footY: 450, avatar: null }))
    box.show('ペー子', 'テキスト')
    box.redraw(1280, 720)
    const top = computeFieldDialogRect(1280, 720, 'top')
    expect(box.getPlacedSide()).toBe('top')
    expect(box.getBoxRect()).toEqual({
      x: top.x,
      y: top.y,
      width: top.width,
      height: top.height,
    })
    box.dispose()
  })
  it('下側もリサイズで下側のまま', () => {
    const box = make(() => ({ footY: 100, avatar: null }))
    box.show('', 'テキスト')
    box.redraw(1280, 720)
    const bottom = computeFieldDialogRect(1280, 720, 'bottom')
    expect(box.getPlacedSide()).toBe('bottom')
    expect(box.getBoxRect().y).toBe(bottom.y)
    box.dispose()
  })
})

describe('startFieldGame の配線（静的検査・脆さを承知で最小限） (#1153)', () => {
  // startFieldGame は PixiJS の Application 起動に依存し単体で呼べない。退行（未指定の作品に設計どおりの窓が出る）だけをソースで固定する
  it('ffPlacement は battle.windowStyle がある作品にだけ渡される', () => {
    expect(startFieldGameSrc).toMatch(/config\.battle\.windowStyle\s*\?\s*\{\s*ffPlacement:/)
  })
  it('感情吹き出しの層は、設計どおりの窓の表示中だけ隠す', () => {
    expect(startFieldGameSrc).toMatch(
      /emotionLayerBox\.visible\s*=\s*!\(designedDialog\s*&&\s*dialogBox\.isShowing\)/
    )
  })
})
