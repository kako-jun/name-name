/**
 * DialogBox の FF 風の窓 (#840 1本目)。ffWindow: true で画面上部固定・ff-blue・1 文字ずつ、
 * 未指定は従来どおり（下部・紺の単色）であることを確認する。
 */
import { describe, it, expect, vi } from 'vitest'
import type { Ticker } from 'pixi.js'

vi.mock('./FontLoader', () => ({
  ensureFontLoaded: vi.fn().mockResolvedValue(undefined),
  extractPrimaryFamily: (f: string) => f.split(',')[0]?.trim() ?? f,
  resetFontLoaderCache: vi.fn(),
  __setDocumentForTest: vi.fn(),
}))
import { DialogBox } from './DialogBox'
import { FF_DIALOG_MS_PER_CHAR, computeFfDialogRect } from './ffDialog'
import { FieldConversation } from './fieldScript'
import { FF_BLUE_TEXT_SHADOW } from './windowStyle'

interface Internals {
  ticker: Ticker
  dialogText: { text: string; x: number; y: number; style: { dropShadow: unknown } }
  inlineNameText: { text: string; visible: boolean } | null
  nameText: { visible: boolean }
  nameBox: { visible: boolean }
  ffBands: { visible: boolean } | null
  bg: { visible: boolean }
}
const internals = (b: DialogBox): Internals => b as unknown as Internals

function make(ff: boolean, w = 800, h = 600, extra: { msPerChar?: number } = {}): DialogBox {
  const box = new DialogBox({
    screenWidth: w,
    screenHeight: h,
    boxHeight: Math.round(h * 0.22),
    fontSize: Math.max(16, Math.round(h * 0.04)),
    bgColor: 0x000033,
    nameColor: 0xffe066,
    nameSeparateBox: false,
    ...(ff ? { ffWindow: true } : {}),
    ...extra,
  })
  box.hide()
  // 実時間でなく手動で進める
  internals(box).ticker.stop()
  return box
}

/** ticker を ms だけ進める（update は絶対時刻を取るので累積する） */
let clock = 0
function advance(box: DialogBox, ms: number): void {
  // Ticker は 1 フレームの経過を maxElapsedMS(100ms) で頭打ちにするので、刻んで進める
  for (let left = ms; left > 0; left -= 10) {
    clock += Math.min(10, left)
    internals(box).ticker.update(clock)
  }
}
/**
 * 基準時刻を現在の clock に揃え、以降の update の経過時間を 0 から数える。
 * Ticker の lastTime は構築時の performance.now() なので、揃えないと最初の update で
 * 実時間との差（maxElapsedMS=100ms で頭打ち）ぶん typewriter が進み、実行環境の速さで結果が変わる。
 */
function prime(box: DialogBox): void {
  const ticker = internals(box).ticker
  clock += 1000
  ticker.lastTime = clock
  ticker.update(clock)
  const t = (box as unknown as { typewriter: { acc: number } }).typewriter
  t.acc = 0
}

describe('DialogBox ffWindow (#840)', () => {
  it('窓は画面上部に固定（純粋関数と同じ矩形）で、画面の上半分に収まる', () => {
    for (const [w, h] of [
      [640, 360],
      [1280, 720],
    ] as const) {
      const box = make(true, w, h)
      const r = computeFfDialogRect(w, h)
      expect(box.getBoxRect()).toEqual({ x: r.x, y: r.y, width: r.width, height: r.height })
      expect(box.getBoxRect().y + box.getBoxRect().height).toBeLessThanOrEqual(h / 2)
      box.dispose()
    }
  })
  it('話者・台詞が変わっても位置は動かない', () => {
    const box = make(true)
    const before = box.getBoxRect()
    box.show('おばあさん', 'こんにちは')
    box.show('少年', 'ながいながいながい台詞'.repeat(5))
    expect(box.getBoxRect()).toEqual(before)
    box.dispose()
  })
  it('シーンの大きさが変わって redraw / setFontSize されても上部固定のまま追従する', () => {
    const box = make(true, 640, 360)
    box.setFontSize(29)
    box.redraw(1280, 720)
    const r = computeFfDialogRect(1280, 720)
    expect(box.getBoxRect()).toEqual({ x: r.x, y: r.y, width: r.width, height: r.height })
    box.dispose()
  })
  it('1 文字ずつ増え、全文に達したら止まる', () => {
    const box = make(true)
    box.show('', 'あいうえお')
    prime(box)
    expect(box.getVisibleText()).toBe('')
    advance(box, FF_DIALOG_MS_PER_CHAR + 1)
    expect(box.getVisibleText()).toBe('あ')
    advance(box, FF_DIALOG_MS_PER_CHAR)
    expect(box.getVisibleText()).toBe('あい')
    expect(box.isTyping()).toBe(true)
    advance(box, FF_DIALOG_MS_PER_CHAR * 10)
    expect(box.getVisibleText()).toBe('あいうえお')
    expect(box.isTyping()).toBe(false)
    box.dispose()
  })
  it('msPerChar を設定で変えられる（0 = 即時表示）', () => {
    const slow = make(true, 800, 600, { msPerChar: 200 })
    slow.show('', 'あいう')
    prime(slow)
    advance(slow, FF_DIALOG_MS_PER_CHAR * 3)
    expect(slow.getVisibleText()).toBe('')
    advance(slow, 200)
    expect(slow.getVisibleText()).toBe('あ')
    slow.dispose()
    const instant = make(true, 800, 600, { msPerChar: 0 })
    instant.show('', 'あいう')
    advance(instant, 50)
    expect(instant.getVisibleText()).toBe('あいう')
    instant.dispose()
  })
  it('FieldConversation の決定操作: 表示中は全文表示、全文表示済みなら閉じる', () => {
    const box = make(true)
    const runner = { run: vi.fn(), advance: vi.fn(), isRunning: false, destroy: vi.fn() }
    const conv = new FieldConversation(box, runner)
    const onEnd = vi.fn()
    conv.start('おばあさん', 'こんにちは、旅の人', undefined, onEnd)
    prime(box)
    advance(box, FF_DIALOG_MS_PER_CHAR * 2 + 1)
    expect(box.isTyping()).toBe(true)
    conv.advance() // 1 回目: 全文表示（閉じない）
    expect(box.getVisibleText()).toBe('こんにちは、旅の人')
    expect(box.isShowing).toBe(true)
    expect(onEnd).not.toHaveBeenCalled()
    conv.advance() // 2 回目: 閉じる
    expect(box.isShowing).toBe(false)
    expect(onEnd).toHaveBeenCalledTimes(1)
    expect(conv.active).toBe(false)
    box.dispose()
  })
  it('ff-blue の見た目: 帯が表示・文字に黒い影。hide で帯も隠れる', () => {
    const box = make(true)
    box.show('', 'テキスト')
    expect(internals(box).ffBands?.visible).toBe(true)
    expect(box.isBackgroundVisible).toBe(true)
    expect(internals(box).dialogText.style.dropShadow).toMatchObject({
      color: FF_BLUE_TEXT_SHADOW.color,
      distance: FF_BLUE_TEXT_SHADOW.distance,
    })
    box.hide()
    expect(internals(box).ffBands?.visible).toBe(false)
    expect(box.isBackgroundVisible).toBe(false)
    box.dispose()
  })
})

describe('DialogBox ff は発話者名を出さない (#840)', () => {
  it('名前を渡しても名札・インライン名とも出ない', () => {
    const box = make(true)
    box.show('おばあさん', 'こんにちは')
    const i = internals(box)
    expect(i.inlineNameText?.visible).toBe(false)
    expect(i.inlineNameText?.text ?? '').toBe('')
    expect(i.nameText.visible).toBe(false)
    expect(i.nameBox.visible).toBe(false)
    box.dispose()
  })
  it('名前ありでも名前なしでも本文の位置・折り返しが同じ（名前分の余白なし）', () => {
    const named = make(true)
    const anon = make(true)
    const text = 'ながいながい台詞です。'.repeat(8)
    named.show('おばあさん', text)
    anon.show('', text)
    named.skipTypewriter()
    anon.skipTypewriter()
    expect(internals(named).dialogText.x).toBe(internals(anon).dialogText.x)
    expect(internals(named).dialogText.y).toBe(internals(anon).dialogText.y)
    expect(named.getVisibleText()).toBe(anon.getVisibleText())
    // 本文は窓の上端 + パディングから始まる（名前 1 行分の余白を取らない）
    const r = computeFfDialogRect(800, 600)
    expect(internals(named).dialogText.y).toBe(r.y + r.padding)
    named.dispose()
    anon.dispose()
  })
  it('固定 1 行・ナレーション（名前なし）・脚本の台詞のどの経路でも名前は出ない', () => {
    const box = make(true)
    const runner = { run: vi.fn(), advance: vi.fn(), isRunning: false, destroy: vi.fn() }
    new FieldConversation(box, runner).start('近所の子', '固定の一行', undefined, () => {})
    expect(internals(box).inlineNameText?.visible).toBe(false)
    box.show('', 'ナレーション')
    expect(internals(box).inlineNameText?.visible).toBe(false)
    box.show('近所の子', '台詞')
    expect(internals(box).inlineNameText?.visible).toBe(false)
    box.dispose()
  })
  it('未指定（従来の窓）では名前が出て、本文は名前の下から始まる', () => {
    const box = make(false)
    box.show('おばあさん', 'こんにちは')
    const i = internals(box)
    expect(i.inlineNameText?.visible).toBe(true)
    expect(i.inlineNameText?.text).toBe('おばあさん')
    const anon = make(false)
    anon.show('', 'こんにちは')
    expect(i.dialogText.y).toBe(internals(anon).dialogText.y) // 既存: 余白は名前の有無で変わらない
    box.dispose()
    anon.dispose()
  })
})

describe('DialogBox 非 ff は従来どおり (#840)', () => {
  it('窓は下部。影なし。既定の速さ 30ms は従来と同じ', () => {
    const box = make(false, 800, 600)
    const r = box.getBoxRect()
    expect(r.y).toBe(600 - Math.round(600 * 0.22) - 20)
    expect(r.y + r.height).toBe(580)
    expect(box.getMsPerChar()).toBe(30)
    box.show('', 'テキスト')
    expect(internals(box).dialogText.style.dropShadow).toBeFalsy()
    expect(internals(box).ffBands).toBeNull() // 非 ff は帯・mask を作らない（従来の子構成のまま）
    box.redraw(1280, 720)
    expect(box.getBoxRect().y).toBe(720 - Math.round(600 * 0.22) - 20)
    box.dispose()
  })
})
