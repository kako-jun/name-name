/**
 * DialogBox の FF 風の窓の改ページ (#840 2本目)。窓に収まらない台詞はページに分かれ、
 * 文字が出きったら ▼ を点滅して止まり、決定操作でページ送りする。ff 以外は従来どおり。
 */
import { describe, it, expect, vi } from 'vitest'
import type { Ticker } from 'pixi.js'

// フォント読み込み完了「後」に文字幅が変わる状況を作る（null = フォント名で決める）
const wrapState = vi.hoisted(() => ({ px: null as number | null }))
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
    // フォント名に wide を含むと 1 文字 20px（フォント変更で折り返しが変わる状況を作る）
    wordwrap: (text: string, maxWidth: number, font: string) =>
      actual.wrapTextWithMeasure(
        text,
        maxWidth,
        (s) => s.length * (wrapState.px ?? (font.includes('wide') ? 20 : 10))
      ),
  }
})
import { DialogBox } from './DialogBox'
import { ensureFontLoaded } from './FontLoader'
import { FF_CURSOR_BLINK_MS, FF_DIALOG_MS_PER_CHAR } from './ffDialog'
import { FieldConversation } from './fieldScript'
import { EventRunner } from './eventRunner'
import type { NpcMover } from './eventRunner'

interface Internals {
  ticker: Ticker
  ffCursor: { visible: boolean } | null
  indicator: { visible: boolean }
}
const internals = (b: DialogBox): Internals => b as unknown as Internals

function make(ff: boolean, w = 800, h = 600): DialogBox {
  const box = new DialogBox({
    screenWidth: w,
    screenHeight: h,
    boxHeight: Math.round(h * 0.22),
    fontSize: Math.max(16, Math.round(h * 0.04)),
    bgColor: 0x000033,
    nameColor: 0xffe066,
    nameSeparateBox: false,
    ...(ff ? { ffWindow: true, msPerChar: FF_DIALOG_MS_PER_CHAR } : {}),
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
/** 初回の巨大な経過時間を捨てる。show の前に呼ぶ（show 後だと最初の tick で数文字進んでしまう） */
function prime(box: DialogBox): void {
  clock += 1000
  internals(box).ticker.update(clock)
}
/** いまのページを最後まで出す（時間で進める） */
function typeOut(box: DialogBox): void {
  for (let i = 0; i < 2000 && box.isTyping(); i++) advance(box, 10)
}
const cursorShown = (b: DialogBox): boolean => internals(b).ffCursor?.visible === true

/** 800x600 の ff は 1 ページ 4 行。10 行 = 4 + 4 + 2 の 3 ページ */
const TEN = Array.from({ length: 10 }, (_, i) => `行${i + 1}`)
const TEN_TEXT = TEN.join('\n')

describe('DialogBox ff の改ページ (#840)', () => {
  it('長文は窓に入る行数ごとのページに分かれ、最初のページだけが出る', () => {
    const box = make(true)
    box.show('', TEN_TEXT)
    expect(box.getPageInfo()).toEqual({ page: 1, pages: 3 })
    typeOut(box)
    expect(box.getVisibleText()).toBe(TEN.slice(0, 4).join('\n'))
    box.dispose()
  })
  it('ページが出きったら ▼ が点滅して止まる（最終ページでは出ない）', () => {
    const box = make(true)
    prime(box)
    box.show('', TEN_TEXT)
    advance(box, FF_DIALOG_MS_PER_CHAR * 2)
    expect(cursorShown(box)).toBe(false) // 出ている途中は ▼ なし
    typeOut(box)
    expect(box.isTyping()).toBe(false)
    expect(box.isAwaitingPage()).toBe(true)
    expect(cursorShown(box)).toBe(true)
    advance(box, FF_CURSOR_BLINK_MS) // 点滅: 次の半周期は消える
    expect(cursorShown(box)).toBe(false)
    advance(box, FF_CURSOR_BLINK_MS)
    expect(cursorShown(box)).toBe(true)
    // 待っている間も文字は増えない・ページも勝手に進まない
    advance(box, 5000)
    expect(box.getPageInfo().page).toBe(1)
    expect(box.getVisibleText()).toBe(TEN.slice(0, 4).join('\n'))
    box.dispose()
  })
  it('nextPage: 前のページの文字は消えて次のページを 1 文字ずつ出す。最終ページでは ▼ なし・進まない', () => {
    const box = make(true)
    box.show('', TEN_TEXT)
    typeOut(box)
    expect(box.nextPage()).toBe(true)
    expect(box.getPageInfo().page).toBe(2)
    expect(box.getVisibleText()).toBe('') // 消えている
    advance(box, FF_DIALOG_MS_PER_CHAR + 1)
    expect(box.getVisibleText()).toBe('行')
    expect(box.isTyping()).toBe(true)
    expect(box.nextPage()).toBe(false) // 表示中は進めない
    typeOut(box)
    expect(box.getVisibleText()).toBe(TEN.slice(4, 8).join('\n'))
    expect(box.nextPage()).toBe(true)
    typeOut(box)
    expect(box.getPageInfo()).toEqual({ page: 3, pages: 3 })
    expect(box.getVisibleText()).toBe(TEN.slice(8).join('\n'))
    expect(box.isAwaitingPage()).toBe(false)
    expect(cursorShown(box)).toBe(false)
    expect(box.nextPage()).toBe(false)
    box.dispose()
  })
  it('短い台詞は 1 ページで ▼ なし', () => {
    const box = make(true)
    box.show('', 'こんにちは')
    expect(box.getPageInfo()).toEqual({ page: 1, pages: 1 })
    typeOut(box)
    expect(box.isAwaitingPage()).toBe(false)
    expect(cursorShown(box)).toBe(false)
    expect(box.nextPage()).toBe(false)
    box.dispose()
  })
  it('長い 1 段落も窓の幅で折り返してページに分かれる', () => {
    const box = make(true)
    box.show('', 'あ'.repeat(69 * 5)) // 1 行 69 字 x 5 行 → 4 + 1
    expect(box.getPageInfo().pages).toBe(2)
    box.dispose()
  })
  it('段落（改行）ごとに折り返す: 改行後の行が直前の残り幅で折り返されない', () => {
    const box = make(true)
    const text = `${'あ'.repeat(40)}\n${'い'.repeat(40)}`
    box.show('', text)
    box.skipTypewriter()
    expect(box.getVisibleText()).toBe(text)
    expect(box.getPageInfo().pages).toBe(1)
    box.dispose()
  })
  it('hide / clearText で状態が空に戻る（会話の中断・破棄）', () => {
    const box = make(true)
    box.show('', TEN_TEXT)
    typeOut(box)
    expect(cursorShown(box)).toBe(true)
    box.hide()
    expect(box.getPageInfo()).toEqual({ page: 0, pages: 0 })
    expect(box.isAwaitingPage()).toBe(false)
    expect(cursorShown(box)).toBe(false)
    expect(box.nextPage()).toBe(false)
    // 次の台詞は 1 ページ目から
    box.show('', TEN_TEXT)
    expect(box.getPageInfo()).toEqual({ page: 1, pages: 3 })
    box.dispose()
  })
  it('リサイズでページ数が変わっても、読んでいる位置を含むページに追従する', () => {
    const box = make(true) // 4 行/ページ
    box.show('', TEN_TEXT)
    typeOut(box)
    box.nextPage()
    typeOut(box) // 2 ページ目（行5-8）を出しきった
    expect(box.getPageInfo()).toEqual({ page: 2, pages: 3 })
    box.redraw(640, 360) // 窓が低くなる → 2 行/ページ
    const info = box.getPageInfo()
    expect(info.pages).toBe(5)
    expect(info.page).toBe(3) // 行5 を含むページ（行5-6）
    expect(box.getVisibleText()).toBe('行5\n行6') // 出きっていたので出きった状態を維持
    expect(box.isAwaitingPage()).toBe(true)
    box.redraw(800, 600) // 戻す
    expect(box.getPageInfo()).toEqual({ page: 2, pages: 3 })
    box.dispose()
  })
  it('リサイズで折り返しが変わらなければ表示中の文字送りは止まらない', () => {
    const box = make(true)
    prime(box)
    box.show('', TEN_TEXT)
    advance(box, FF_DIALOG_MS_PER_CHAR * 2 + 1)
    const before = box.getVisibleText()
    box.redraw(800, 600)
    expect(box.getVisibleText()).toBe(before)
    expect(box.isTyping()).toBe(true)
    box.dispose()
  })
  it('文字送りの途中のリサイズ: 同じページ内の出た文字数を引き継いで続きを出す', () => {
    const box = make(true)
    prime(box)
    box.show('', TEN_TEXT)
    advance(box, FF_DIALOG_MS_PER_CHAR * 3 + 1)
    expect(box.getVisibleText()).toBe('行1\n') // 3 文字
    box.redraw(640, 360) // 2 行/ページ
    expect(box.getPageInfo().page).toBe(1)
    expect(box.getVisibleText()).toBe('行1\n')
    expect(box.isTyping()).toBe(true)
    box.dispose()
  })
  it('文字サイズの変更（setFontSize）でも本文を折り返し直す', () => {
    const box = make(true)
    box.show('', TEN_TEXT)
    typeOut(box)
    box.setFontSize(48) // 行が高くなり 1 ページの行数が減る
    expect(box.getPageInfo().pages).toBeGreaterThan(3)
    box.dispose()
  })
})

describe('DialogBox ff のフォント変更・予約幅・▼の位置 (#840 3本目)', () => {
  interface Geo {
    boxX: number
    boxY: number
    boxW: number
    boxH: number
    padding: number
    ffCursor: { x: number; y: number; style: { fontSize: number; fontFamily: string } }
    maxTextWidth(): number
  }
  const geo = (b: DialogBox): Geo => b as unknown as Geo
  // 窓の幅で何行にも折り返される 1 段落（10px/文字なら 5 行 = 2 ページ、20px/文字なら 9 行 = 3 ページ）
  const LONG = 'あ'.repeat(300)
  const cursorAtCorner = (b: DialogBox): void => {
    const g = geo(b)
    expect(g.ffCursor.x).toBe(g.boxX + g.boxW - g.padding)
    expect(g.ffCursor.y).toBe(g.boxY + g.boxH - g.padding)
  }

  it('setFontFamily: 表示中の本文を折り返し直してページを取り直す（全文を 1 ページに出さない）', () => {
    const box = make(true)
    box.show('', LONG)
    typeOut(box)
    expect(box.getPageInfo()).toEqual({ page: 1, pages: 2 })
    box.setFontFamily('wide, sans-serif') // 1 文字が 20px になる = 折り返しが増える
    expect(box.getPageInfo().pages).toBeGreaterThan(2)
    // 出ているのは 1 ページ分だけで、全文ではない
    expect(box.getVisibleText().replace(/\n/g, '').length).toBeLessThan(LONG.length)
    expect(box.getVisibleText().split('\n').length).toBeLessThanOrEqual(4)
    // ▼ のフォントも追従する
    expect(geo(box).ffCursor.style.fontFamily).toBe('wide, sans-serif')
    box.dispose()
  })
  it('setFontFamily: 変更後もページ待ち・ページ送りが働く', () => {
    const box = make(true)
    box.show('', LONG)
    typeOut(box)
    box.setFontFamily('wide, sans-serif')
    typeOut(box)
    expect(box.isAwaitingPage()).toBe(true)
    expect(box.nextPage()).toBe(true)
    box.dispose()
  })
  it('setFontFamily: 変更後に最後まで出しても、見えるのは 1 ページ分（従来の折り返しへ落ちて全ページ分が溢れない）', () => {
    const box = make(true)
    box.show('', LONG)
    typeOut(box)
    box.setFontFamily('wide, sans-serif')
    typeOut(box)
    expect(box.getPageInfo().pages).toBeGreaterThan(2)
    expect(box.getVisibleText().split('\n').length).toBeLessThanOrEqual(4) // 800x600 の ff は 1 ページ 4 行
    expect(box.getVisibleText().replace(/\n/g, '').length).toBeLessThan(LONG.length)
    box.dispose()
  })
  it('setFontFamily: フォントの読み込みが終わって文字幅が変わったら、折り返しとページを取り直す', async () => {
    const box = make(true)
    box.show('', LONG)
    typeOut(box)
    expect(box.getPageInfo().pages).toBe(2)
    let done!: () => void
    vi.mocked(ensureFontLoaded).mockReturnValueOnce(new Promise<void>((r) => (done = r)))
    try {
      box.setFontFamily('later, sans-serif') // 読み込み前の文字幅 (10px) では 2 ページのまま
      expect(box.getPageInfo().pages).toBe(2)
      wrapState.px = 20 // 読み込みが終わると文字幅が変わる
      done()
      await Promise.resolve()
      await Promise.resolve()
      expect(box.getPageInfo().pages).toBeGreaterThan(2)
    } finally {
      wrapState.px = null
    }
    box.dispose()
  })
  it('▼の予約幅 (ffCursorReserve) が折り返し幅から引かれる: ちょうど満杯の行は ▼ を避けて折り返す', () => {
    const box = make(true)
    const full = 'あ'.repeat(Math.floor(geo(box).maxTextWidth() / 10)) // 本文幅いっぱい（予約なしなら 1 行に収まる）
    box.show('', full)
    typeOut(box)
    expect(box.getVisibleText()).toContain('\n')
    box.dispose()
  })
  it('▼は redraw・setFontSize の後も窓の右下（パディングの内側）にある', () => {
    const box = make(true)
    cursorAtCorner(box)
    box.redraw(640, 360)
    cursorAtCorner(box)
    box.show('', TEN_TEXT)
    typeOut(box)
    box.setFontSize(30)
    cursorAtCorner(box)
    expect(geo(box).ffCursor.style.fontSize).toBe(Math.round(30 * 0.6))
    box.redraw(1024, 768)
    cursorAtCorner(box)
    box.dispose()
  })
})

describe('DialogBox 非 ff は改ページしない (#840)', () => {
  it('ページ情報なし・▼ なし・nextPage は常に false。本文は従来どおり全部出す', () => {
    const box = make(false)
    expect(internals(box).ffCursor).toBeNull()
    box.show('', TEN_TEXT)
    box.skipTypewriter()
    expect(box.getPageInfo()).toEqual({ page: 0, pages: 0 })
    expect(box.isAwaitingPage()).toBe(false)
    expect(box.nextPage()).toBe(false)
    // 従来の折り返し: 改行は 1 段落として扱われ、全文が 1 ページに出る（行数で切らない）
    expect(box.getVisibleText().replace(/\n/g, '')).toBe(TEN.join(''))
    box.dispose()
  })
})

describe('決定操作とページ送り (#840)', () => {
  it('FieldConversation: 表示中=全文 → ページ送り → … → 最終ページ済で閉じる', () => {
    const box = make(true)
    const runner = { run: vi.fn(), advance: vi.fn(), isRunning: false, destroy: vi.fn() }
    const conv = new FieldConversation(box, runner)
    const onEnd = vi.fn()
    prime(box)
    conv.start('', TEN_TEXT, undefined, onEnd)
    advance(box, FF_DIALOG_MS_PER_CHAR * 2 + 1)
    conv.advance() // 表示中の決定 = そのページを全文表示（ページは進まない）
    expect(box.getPageInfo().page).toBe(1)
    expect(box.getVisibleText()).toBe(TEN.slice(0, 4).join('\n'))
    expect(box.isTyping()).toBe(false)
    conv.advance() // 済 → 次のページ
    expect(box.getPageInfo().page).toBe(2)
    expect(box.isShowing).toBe(true)
    typeOut(box)
    conv.advance() // 次のページ
    expect(box.getPageInfo().page).toBe(3)
    expect(onEnd).not.toHaveBeenCalled()
    conv.advance() // 最終ページを出している途中 = 全文表示
    expect(box.isShowing).toBe(true)
    expect(onEnd).not.toHaveBeenCalled()
    conv.advance() // 最終ページ済 → 閉じる
    expect(box.isShowing).toBe(false)
    expect(onEnd).toHaveBeenCalledTimes(1)
    expect(conv.active).toBe(false)
    box.dispose()
  })
  it('FieldConversation: 短い台詞は従来どおり 全文 → 閉じる', () => {
    const box = make(true)
    const runner = { run: vi.fn(), advance: vi.fn(), isRunning: false, destroy: vi.fn() }
    const conv = new FieldConversation(box, runner)
    const onEnd = vi.fn()
    prime(box)
    conv.start('', 'こんにちは、旅の人', undefined, onEnd)
    advance(box, FF_DIALOG_MS_PER_CHAR * 2 + 1)
    conv.advance()
    expect(onEnd).not.toHaveBeenCalled()
    conv.advance()
    expect(onEnd).toHaveBeenCalledTimes(1)
    box.dispose()
  })
  it('EventRunner: 長い台詞はページ送りしてから次のコマンドへ進む', () => {
    const box = make(true)
    const mover: NpcMover = { moveNpcTo: vi.fn().mockResolvedValue(undefined) }
    const runner = new EventRunner(box, mover)
    const done = vi.fn()
    runner.run(
      [
        { type: 'Dialog', character: '', text: TEN, expression: null },
        { type: 'Dialog', character: '', text: ['次の台詞'], expression: null },
      ] as never,
      done
    )
    expect(box.getPageInfo()).toEqual({ page: 1, pages: 3 })
    runner.advance() // 全文表示
    runner.advance() // 2 ページ目
    expect(box.getPageInfo().page).toBe(2)
    runner.advance() // 全文表示
    runner.advance() // 3 ページ目
    expect(box.getPageInfo().page).toBe(3)
    runner.advance() // 全文表示
    expect(box.getVisibleText()).toBe(TEN.slice(8).join('\n'))
    runner.advance() // 最終ページ済 → 次の台詞（窓は 1 ページ目から）
    expect(box.getPageInfo()).toEqual({ page: 1, pages: 1 })
    box.skipTypewriter()
    expect(box.getVisibleText()).toBe('次の台詞')
    runner.advance() // 閉じて完了
    expect(done).toHaveBeenCalledTimes(1)
    box.dispose()
  })
})
