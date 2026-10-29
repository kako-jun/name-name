/**
 * RPG モード（TopDownRenderer / RaycastRenderer）の `dialog_style: ff` (#840 3本目)。
 * 決定操作（キー・タップ）がページ送りに回ること、`setDialogStyle` の値の正規化、
 * 未指定・adv・novel・未知値では従来の窓であること、ff が novel 側で壊れない（adv 相当）ことを固定する。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Container } from 'pixi.js'

vi.mock('./FontLoader', () => ({
  ensureFontLoaded: vi.fn().mockResolvedValue(undefined),
  extractPrimaryFamily: (f: string) => f.split(',')[0]?.trim() ?? f,
  resetFontLoaderCache: vi.fn(),
  __setDocumentForTest: vi.fn(),
}))
// jsdom は文字幅を測れないので 1 文字 = 10px に差し替える
vi.mock('./wordwrap', async () => {
  const actual = await vi.importActual<typeof import('./wordwrap')>('./wordwrap')
  return {
    ...actual,
    wordwrap: (text: string, maxWidth: number) =>
      actual.wrapTextWithMeasure(text, maxWidth, (s) => s.length * 10),
  }
})
// init が作る周辺 UI は jsdom で文字幅を測れず落ちるので、会話窓の配線に関係ない部分は空の Container にする
vi.mock('./TouchMenuOverlay', async () => {
  const { Container } = await import('pixi.js')
  const actual = await vi.importActual<typeof import('./TouchMenuOverlay')>('./TouchMenuOverlay')
  return { ...actual, TouchMenuOverlay: class extends Container {} }
})
vi.mock('./MinimapOverlay', async () => {
  const { Container } = await import('pixi.js')
  return { MinimapOverlay: class extends Container {} }
})
import { DialogBox } from './DialogBox'
import { TopDownRenderer } from './TopDownRenderer'
import { RaycastRenderer } from './RaycastRenderer'
import { NovelRenderer } from './NovelRenderer'
import { FF_DIALOG_MS_PER_CHAR, computeFfDialogRect } from './ffDialog'
import type { Ticker } from 'pixi.js'

interface Internals {
  app: { stage: Container }
  dialogBox: DialogBox | null
  dialogStyle: string | undefined
  initialized: boolean
  screenWidth: number
  screenHeight: number
  handleKeyDown(e: KeyboardEvent): void
  handleTap(): void
}

const TEN_TEXT = Array.from({ length: 10 }, (_, i) => `行${i + 1}`).join('\n')

function ffBox(): DialogBox {
  const box = new DialogBox({
    screenWidth: 800,
    screenHeight: 600,
    boxHeight: 132,
    fontSize: 24,
    bgColor: 0x000033,
    nameColor: 0xffe066,
    nameSeparateBox: false,
    ffWindow: true,
    msPerChar: FF_DIALOG_MS_PER_CHAR,
  })
  ;(box as unknown as { ticker: Ticker }).ticker.stop()
  return box
}

let clock = 0
function typeOut(box: DialogBox): void {
  const ticker = (box as unknown as { ticker: Ticker }).ticker
  for (let i = 0; i < 2000 && box.isTyping(); i++) {
    clock += 10
    ticker.update(clock)
  }
}

const enter = (): KeyboardEvent =>
  new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })

type Maker = () => { i: Internals }
const makers: Array<[string, Maker]> = [
  [
    'TopDownRenderer',
    () => {
      const r = new TopDownRenderer()
      const i = r as unknown as Internals
      i.app = { stage: new Container() }
      i.screenWidth = 800
      i.screenHeight = 600
      i.initialized = true
      return { i }
    },
  ],
  [
    'RaycastRenderer',
    () => {
      const r = new RaycastRenderer()
      const i = r as unknown as Internals
      i.app = { stage: new Container() }
      i.initialized = true
      return { i }
    },
  ],
]

afterEach(() => {
  vi.restoreAllMocks()
})

describe.each(makers)('%s の dialog_style: ff (#840)', (_name, make) => {
  it('setDialogStyle は ff だけを受け付け、それ以外（未指定・adv・novel・未知値）は従来の窓', () => {
    const { i } = make()
    const r = i as unknown as { setDialogStyle(s: string | null | undefined): void }
    r.setDialogStyle('ff')
    expect(i.dialogStyle).toBe('ff')
    r.setDialogStyle(' FF ')
    expect(i.dialogStyle).toBe('ff')
    for (const v of ['adv', 'novel', 'toheart', '', null, undefined]) {
      r.setDialogStyle(v)
      expect(i.dialogStyle).toBeUndefined()
    }
  })

  it('決定キー: 文字が出ている間は全文表示 → ページ待ちで次のページ → 最終ページ済で閉じる', () => {
    const { i } = make()
    const box = ffBox()
    i.dialogBox = box
    box.show('', TEN_TEXT)
    expect(box.getPageInfo()).toEqual({ page: 1, pages: 3 })
    i.handleKeyDown(enter()) // 出している途中 = 全文表示
    expect(box.isTyping()).toBe(false)
    expect(box.getPageInfo().page).toBe(1)
    i.handleKeyDown(enter()) // ページ待ち = 次のページ
    expect(box.getPageInfo().page).toBe(2)
    expect(box.isShowing).toBe(true)
    typeOut(box)
    i.handleKeyDown(enter())
    expect(box.getPageInfo().page).toBe(3)
    typeOut(box)
    expect(box.isShowing).toBe(true) // 最終ページを出し終えただけでは閉じない
    i.handleKeyDown(enter()) // 最終ページ済 = 閉じる
    expect(box.isShowing).toBe(false)
    box.dispose()
  })

  it('タップも同じ: ページ待ちなら次のページ・最終ページ済で閉じる', () => {
    const { i } = make()
    const box = ffBox()
    i.dialogBox = box
    // 開いた直後の誤爆ガード (isJustShown) を越えた時刻から始める
    const now = performance.now()
    vi.spyOn(performance, 'now').mockReturnValue(now + 10_000)
    box.show('', TEN_TEXT)
    vi.spyOn(performance, 'now').mockReturnValue(now + 20_000)
    typeOut(box)
    i.handleTap()
    expect(box.getPageInfo().page).toBe(2)
    typeOut(box)
    i.handleTap()
    typeOut(box)
    expect(box.getPageInfo().page).toBe(3)
    i.handleTap()
    expect(box.isShowing).toBe(false)
    box.dispose()
  })

  it('従来の窓（ff でない）は nextPage せず 全文表示 → 閉じる のまま', () => {
    const { i } = make()
    const box = new DialogBox({
      screenWidth: 800,
      screenHeight: 600,
      boxHeight: 120,
      fontSize: 18,
      nameSeparateBox: false,
    })
    ;(box as unknown as { ticker: Ticker }).ticker.stop()
    i.dialogBox = box
    box.show('', TEN_TEXT)
    i.handleKeyDown(enter())
    expect(box.isTyping()).toBe(false)
    expect(box.getPageInfo()).toEqual({ page: 0, pages: 0 })
    i.handleKeyDown(enter())
    expect(box.isShowing).toBe(false)
    box.dispose()
  })
})

// init() が窓を作る配線そのもの（setDialogStyle → fieldDialogOptions → new DialogBox）を固定する。
// pixi の Application は jsdom で init できないので、init が触る最小の面だけの偽物に差し替える
describe.each([
  ['TopDownRenderer', () => new TopDownRenderer()],
  ['RaycastRenderer', () => new RaycastRenderer()],
] as Array<[string, () => TopDownRenderer | RaycastRenderer]>)(
  '%s.init が作る会話窓の dialog_style (#840)',
  (_name, create) => {
    let screen = { w: 0, h: 0 }
    async function initWith(style: string | null | undefined, set = true): Promise<DialogBox> {
      const r = create()
      const i = r as unknown as Internals
      i.app = {
        init: async () => {},
        canvas: document.createElement('canvas'),
        stage: new Container(),
        ticker: { add: vi.fn(), remove: vi.fn() },
        destroy: vi.fn(),
      } as unknown as Internals['app']
      if (set) r.setDialogStyle(style)
      await r.init(document.createElement('div'))
      const box = i.dialogBox!
      screen = { w: i.screenWidth, h: i.screenHeight }
      ;(box as unknown as { ticker: Ticker }).ticker.stop()
      box.show('', 'こんにちは')
      return box
    }

    it("'ff' なら FF 風の窓（ページ情報がある・上部固定）", async () => {
      const box = await initWith('ff')
      expect(box.getPageInfo().pages).toBeGreaterThan(0)
      expect(screen.h).toBeGreaterThan(0)
      expect(box.getBoxRect().y).toBe(computeFfDialogRect(screen.w, screen.h).y)
      expect(box.getBoxRect().y).toBeLessThan(screen.h / 2)
      box.dispose()
    })
    it("'adv'・'novel'・未知値・null・未指定は従来の窓（ff にならない）", async () => {
      for (const v of ['adv', 'novel', 'toheart', null, undefined]) {
        const box = await initWith(v)
        expect(box.getPageInfo()).toEqual({ page: 0, pages: 0 })
        box.dispose()
      }
      const box = await initWith(undefined, false) // setDialogStyle を呼ばない
      expect(box.getPageInfo()).toEqual({ page: 0, pages: 0 })
      box.dispose()
    })
  }
)

describe('NovelRenderer は dialog_style: ff を adv 相当として扱う (#840)', () => {
  it('ff は novel ではなく、DialogBox も novel モード・ff 窓にならない', () => {
    const r = new NovelRenderer()
    r.setDialogStyle('ff')
    const i = r as unknown as {
      isNovelStyle(): boolean
      dialogBox: DialogBox & { isNovelMode: boolean }
    }
    expect(i.isNovelStyle()).toBe(false)
    expect(i.dialogBox.isNovelMode).toBe(false)
    expect(i.dialogBox.getPageInfo()).toEqual({ page: 0, pages: 0 })
    i.dialogBox.show('', TEN_TEXT)
    expect(i.dialogBox.isAwaitingPage()).toBe(false) // ff 窓の改ページは働かない
  })
})
